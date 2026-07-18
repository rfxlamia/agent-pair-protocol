import {
  type SessionStateMachine,
  type SessionStatus,
  type TestReport,
  createSessionStateMachine,
  defaultEnvelopeTtl,
  parseEnvelopeBody,
  publicKeyToAgentId,
} from "@agentpair/protocol";
import { utf8ToBytes } from "@noble/ciphers/utils.js";
import {
  approvalChannelUnavailableResult,
  isApprovalChannelError,
  withPendingApprovalSurface,
} from "./approval-surface.js";
import { sendEnvelopeWithSpill } from "./inbox-spill.js";
import { type AgentContext, ensureAllowlistReady, ensurePendingApprovalReady } from "./pair.js";
import { nextThreadSeq, recordSentSeq } from "./thread-seq.js";
import {
  LOCKED_SECTION_ID_CAP_BYTES,
  assertNoSecrets,
  toolTextResult,
  wrapUntrustedPeerContent,
} from "./util.js";

const sessionMachines = new WeakMap<AgentContext, SessionStateMachine>();

export async function expireSessions(ctx: AgentContext): Promise<void> {
  const machine = sessionMachines.get(ctx);
  if (machine) {
    await machine.handleExpireSessions();
  }
}

export async function resolveSessionOpenPendingId(
  ctx: AgentContext,
  thread: string,
): Promise<string | undefined> {
  const machine = sessionMachines.get(ctx);
  if (!machine) {
    return undefined;
  }
  return machine.resolveOpenPendingId(thread);
}

export async function resolveRatifyPendingId(
  ctx: AgentContext,
  thread: string,
): Promise<string | undefined> {
  const machine = sessionMachines.get(ctx);
  if (!machine) {
    return undefined;
  }
  return machine.resolveRatifyPendingId(thread);
}

export function peekSessionOpenStatus(
  ctx: AgentContext,
  thread: string,
): SessionStatus | undefined {
  const machine = sessionMachines.get(ctx);
  if (!machine) {
    return undefined;
  }
  return machine.peekSessionOpenStatus(thread);
}

async function getSessionMachine(ctx: AgentContext): Promise<SessionStateMachine> {
  const cached = sessionMachines.get(ctx);
  if (cached) {
    return cached;
  }

  await ensureAllowlistReady(ctx);
  await ensurePendingApprovalReady(ctx);
  const keyPair = await ctx.keyStore.loadOrCreate();
  const agentId = publicKeyToAgentId(keyPair.publicKey);
  const machine = createSessionStateMachine(
    {
      agentId,
      keyPair,
      pending: ctx.pending,
      allowlist: ctx.allowlist,
      bonds: ctx.bonds,
      relay: {
        async send(input) {
          if (ctx.closedThreads.isClosed(input.thread)) {
            return { ok: false, error: "thread_closed" };
          }
          const sent = await sendEnvelopeWithSpill(ctx, {
            sender: keyPair,
            to: input.to,
            type: input.type,
            thread: input.thread,
            seq: input.seq ?? nextThreadSeq(ctx, input.thread),
            ttl: defaultEnvelopeTtl(),
            payload: utf8ToBytes(input.payload),
          });
          if (!sent.ok) {
            return { ok: false, error: sent.error };
          }
          recordSentSeq(ctx, input.thread, parseEnvelopeBody(sent.outer).seq);
          return { ok: true };
        },
      },
    },
    ctx.sessionStore,
  );
  sessionMachines.set(ctx, machine);
  return machine;
}

function presentSessionStatusForModel(
  ctx: AgentContext,
  thread: string,
  result: Record<string, unknown>,
): Record<string, unknown> {
  const cap = ctx.peerContentCapBytes;

  if (Array.isArray(result.peer_messages)) {
    result.peer_messages = (result.peer_messages as Array<Record<string, unknown>>).map((row) => ({
      ...row,
      body: wrapUntrustedPeerContent(row.body, cap),
    }));
  }

  const role = ctx.sessionStore.get(thread)?.role;
  if (role === "recipient" && typeof result.goal === "string") {
    result.goal = wrapUntrustedPeerContent(result.goal, cap);
  }

  if (typeof result.reject_reason === "string") {
    result.reject_reason = wrapUntrustedPeerContent(result.reject_reason, cap);
  } else {
    // biome-ignore lint/performance/noDelete: omit absent reject_reason from structuredContent
    delete result.reject_reason;
  }

  if (Array.isArray(result.locked_sections)) {
    result.locked_sections = (result.locked_sections as unknown[]).map((id) =>
      wrapUntrustedPeerContent(id, LOCKED_SECTION_ID_CAP_BYTES),
    );
  }

  return result;
}

async function withSessionMachine<T extends Record<string, unknown>>(
  ctx: AgentContext,
  fn: (machine: SessionStateMachine) => Promise<T>,
  transform?: (result: T) => T,
) {
  try {
    const machine = await getSessionMachine(ctx);
    let result = withPendingApprovalSurface(ctx, await fn(machine));
    if (transform) {
      result = transform(result);
    }
    assertNoSecrets(result);
    return toolTextResult(result);
  } catch (error) {
    if (isApprovalChannelError(error)) {
      const result = approvalChannelUnavailableResult();
      assertNoSecrets(result);
      return toolTextResult(result);
    }
    throw error;
  }
}

export async function handleSessionOpen(
  ctx: AgentContext,
  input: {
    to: string;
    goal: string;
    acceptance: Array<{
      id: string;
      test: "executable" | "judgment";
      desc: string;
      runner?: string;
    }>;
    budget: { max_turns: number; deadline: string };
    mandate: {
      agent_may: string[];
      human_required: string[];
      escalate_on?: string[];
    };
  },
) {
  return withSessionMachine(ctx, (machine) => machine.handleOpen(input));
}

export async function handleSessionMsg(
  ctx: AgentContext,
  input: { thread: string; type: string; body: string },
) {
  return withSessionMachine(ctx, (machine) => machine.handleMsg(input));
}

export async function recordSessionTestReport(
  ctx: AgentContext,
  input: { thread: string; report: TestReport },
) {
  return withSessionMachine(ctx, (machine) => machine.recordTestReport(input));
}

export async function handleSessionSign(
  ctx: AgentContext,
  input: { thread: string; artifact_hash: string },
) {
  return withSessionMachine(ctx, (machine) => machine.handleSign(input));
}

export async function handleSessionStatus(ctx: AgentContext, input: { thread: string }) {
  await expireSessions(ctx);
  return withSessionMachine(
    ctx,
    (machine) => machine.handleStatus(input),
    (result) => presentSessionStatusForModel(ctx, input.thread, result) as typeof result,
  );
}

export async function handleSessionApproveOpen(
  ctx: AgentContext,
  input: { pending_id: string; via_human?: boolean },
) {
  return withSessionMachine(ctx, (machine) => machine.handleApproveOpen(input));
}

export async function handleSessionRejectOpen(
  ctx: AgentContext,
  input: { pending_id: string; reason: string; via_human?: boolean },
) {
  return withSessionMachine(ctx, (machine) => machine.handleRejectOpen(input));
}

export async function handleSessionRatify(
  ctx: AgentContext,
  input: {
    pending_id?: string;
    thread?: string;
    artifact_hash?: string;
    via_human?: boolean;
  },
) {
  return withSessionMachine(ctx, (machine) => machine.handleRatify(input));
}

export async function processSessionInboxEnvelope(
  ctx: AgentContext,
  input: { from: string; type: string; thread: string; payload: string },
) {
  return withSessionMachine(ctx, (machine) => machine.handleIncomingEnvelope(input));
}

export async function processThreadClose(
  ctx: AgentContext,
  thread: string,
  reason?: string,
): Promise<void> {
  const machine = await getSessionMachine(ctx);
  await machine.handleThreadClose(thread, reason);
}

export async function processBondRevoke(ctx: AgentContext, peer: string): Promise<void> {
  const machine = await getSessionMachine(ctx);
  machine.handleBondRevoke(peer);
}
