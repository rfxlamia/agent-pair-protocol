import {
  codesEqual,
  deriveApprovalMacKey,
  hmacApprovalCode,
  isWellFormedApprovalCode,
  normalizeApprovalCode,
} from "../store/approval-code.js";
import { scheduleAgentContextFlush } from "../store/flush-context.js";
import { type PendingItem, parseHumanDecision } from "../store/pending.js";
import { classifyApprovalOutcome } from "./approval-outcome.js";
import type { HumanApproveInput } from "./human-approve-schema.js";
import type { AgentContext } from "./pair.js";
import {
  ensurePendingApprovalReady,
  executePairJoinApproval,
  handlePairInitComplete,
} from "./pair.js";
import {
  handleSessionApproveOpen,
  handleSessionRatify,
  handleSessionRejectOpen,
} from "./session.js";
import { assertNoSecrets, toolTextResult } from "./util.js";

const MAX_APPROVAL_ATTEMPTS = 5;
const TRANSIENT_RETRY_HINT = "Retry human_approve with the same code.";

const pendingChains = new Map<string, Promise<unknown>>();

export async function handleHumanApprove(ctx: AgentContext, input: HumanApproveInput) {
  const prior = pendingChains.get(input.pending_id) ?? Promise.resolve();
  const run = prior.then(() => executeHumanApprove(ctx, input));
  const next = run.finally(() => {
    if (pendingChains.get(input.pending_id) === next) {
      pendingChains.delete(input.pending_id);
    }
  });
  pendingChains.set(input.pending_id, next);
  return run;
}

async function executeHumanApprove(ctx: AgentContext, input: HumanApproveInput) {
  const pending = ctx.pending.get(input.pending_id);
  if (!pending || !isPendingLive(pending)) {
    if (pending) {
      ctx.pending.remove(pending.id);
      scheduleAgentContextFlush(ctx);
    }
    const result = { ok: false, error: "pending_not_found" };
    assertNoSecrets(result);
    return toolTextResult(result);
  }

  // pair_join: registry consumed/TTL gate before approval-code attempt accounting.
  // isPendingLive always returns true for pair_join — check registry explicitly.
  if (pending.kind === "pair_join") {
    if (ctx.registry.isConsumed(pending.code)) {
      ctx.pending.remove(pending.id);
      scheduleAgentContextFlush(ctx);
      const result = { ok: false, error: "expired" };
      assertNoSecrets(result);
      return toolTextResult(result);
    }
    const registryEntry = ctx.registry.lookup(pending.code);
    if (!registryEntry || registryEntry.expiresAt < Date.now()) {
      // Tombstone so past-TTL rows do not linger unbounded; purge may clear isConsumed.
      ctx.registry.consume(pending.code);
      ctx.pending.remove(pending.id);
      scheduleAgentContextFlush(ctx);
      const result = { ok: false, error: "expired" };
      assertNoSecrets(result);
      return toolTextResult(result);
    }
  }

  const normalized = normalizeApprovalCode(input.approval_code);
  if (normalized === null) {
    const result = { ok: false, error: "self_approval_forbidden" };
    assertNoSecrets(result);
    return toolTextResult(result);
  }

  if (!isWellFormedApprovalCode(normalized)) {
    const result = { ok: false, error: "invalid_approval_code", malformed: true };
    assertNoSecrets(result);
    return toolTextResult(result);
  }

  await ensurePendingApprovalReady(ctx);
  const keyPair = await ctx.keyStore.loadOrCreate();
  const macKey = deriveApprovalMacKey(keyPair.secretKey);
  const candidate = hmacApprovalCode(macKey, normalized);
  const verifier = Buffer.from(pending.approvalCodeVerifier, "base64url");

  if (!codesEqual(candidate, verifier)) {
    const newAttempts = pending.approvalAttempts + 1;
    ctx.pending.setApprovalAttempts(pending.id, newAttempts);

    if (newAttempts >= MAX_APPROVAL_ATTEMPTS) {
      if (pending.kind === "pair_join") {
        // Capture sessionId BEFORE any mutation; never consume before post.
        const sessionId = ctx.registry.lookup(pending.code)?.sessionId;
        ctx.pending.remove(pending.id);
        scheduleAgentContextFlush(ctx);
        if (sessionId) {
          await ctx.relay.postPakeMessage(
            sessionId,
            JSON.stringify({ phase: "reject", reason: "approval_declined" }),
          );
        }
        ctx.registry.consume(pending.code);
      } else {
        ctx.pending.remove(pending.id);
        scheduleAgentContextFlush(ctx);
      }
      const result = {
        ok: false,
        error: "invalid_approval_code",
        attempts_exhausted: true,
        attempts_remaining: 0,
      };
      assertNoSecrets(result);
      return toolTextResult(result);
    }

    const result = {
      ok: false,
      error: "invalid_approval_code",
      attempts_remaining: MAX_APPROVAL_ATTEMPTS - newAttempts,
    };
    assertNoSecrets(result);
    return toolTextResult(result);
  }

  const parsed = parseHumanDecision(input.decision);
  if ("error" in parsed) {
    const result = { ok: false, error: parsed.error };
    assertNoSecrets(result);
    return toolTextResult(result);
  }

  let dispatchResult: Record<string, unknown>;
  try {
    dispatchResult = await dispatchHumanDecision(ctx, pending, parsed, input.profiles);
  } catch {
    dispatchResult = {
      ok: false,
      error: "relay_unavailable",
      hint: TRANSIENT_RETRY_HINT,
    };
  }

  const outcomeClass = classifyApprovalOutcome(pending.kind, dispatchResult);
  if (outcomeClass === "terminal") {
    ctx.pending.remove(pending.id);
    scheduleAgentContextFlush(ctx);
  } else if (outcomeClass === "transient" && !dispatchResult.hint) {
    dispatchResult = { ...dispatchResult, hint: TRANSIENT_RETRY_HINT };
  }

  assertNoSecrets(dispatchResult);
  return toolTextResult(dispatchResult);
}

function isPendingLive(pending: PendingItem): boolean {
  if (pending.kind === "session_open") {
    return pending.expiresAt > Date.now();
  }
  return true;
}

async function dispatchHumanDecision(
  ctx: AgentContext,
  pending: PendingItem,
  decision: { approve: true } | { reject: string },
  profiles?: string[],
): Promise<Record<string, unknown>> {
  if (pending.kind === "budget_extend") {
    return { ok: false, error: "unsupported_pending_kind" };
  }

  if (pending.kind === "pair_join") {
    const flow = await executePairJoinApproval(ctx, {
      code: pending.code,
      decision,
      profiles,
    });

    if (flow.status === "bonded") {
      const keyPair = await ctx.keyStore.loadOrCreate();
      const { publicKeyToAgentId } = await import("@agentpair/protocol");
      const agentId = publicKeyToAgentId(keyPair.publicKey);
      ctx.bonds.add(agentId, flow.bond);
      return { ok: true, status: flow.status, bond: flow.bond };
    }

    return {
      ok: false,
      status: flow.status,
      ...(flow.status === "rejected" || flow.status === "rolled_back"
        ? { reason: flow.reason }
        : {}),
    };
  }

  if (pending.kind === "session_open") {
    if ("reject" in decision) {
      return structured(
        await handleSessionRejectOpen(ctx, {
          pending_id: pending.id,
          reason: decision.reject,
          via_human: true,
        }),
      );
    }
    return structured(
      await handleSessionApproveOpen(ctx, {
        pending_id: pending.id,
        via_human: true,
      }),
    );
  }

  if (pending.kind === "ratify") {
    if ("reject" in decision) {
      return {
        ok: true,
        status: "ratify_rejected",
        thread: pending.thread,
      };
    }
    return structured(
      await handleSessionRatify(ctx, {
        pending_id: pending.id,
        via_human: true,
      }),
    );
  }

  return { ok: false, error: "unsupported_pending_kind" };
}

function structured(result: { structuredContent: Record<string, unknown> }) {
  return result.structuredContent;
}

export async function completeInitiatorPairing(ctx: AgentContext, code: string) {
  return handlePairInitComplete(ctx, { code });
}
