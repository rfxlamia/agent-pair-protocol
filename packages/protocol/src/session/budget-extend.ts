import { utf8ToBytes } from "@noble/ciphers/utils.js";
import { decodeBase64UrlStrict, encodeBase64Url } from "../crypto/base64url.js";
import { parseNegoBudgetExtendPayload, parseNegoBudgetRejectPayload } from "../envelope/schema.js";
import type { BudgetExtendPendingItem, SessionStateMachineDeps } from "./deps.js";
import type { SessionStore } from "./store.js";
import type { SessionExtension, SessionExtensionDecided, SessionRecord } from "./types.js";

export type BudgetExtendContext = {
  deps: SessionStateMachineDeps;
  store: SessionStore;
  now: () => number;
  upsert: (session: SessionRecord) => SessionRecord;
  getOrError: (
    thread: string,
  ) => { ok: true; session: SessionRecord } | { ok: false; error: string };
  ensureLiveNotExpired: (session: SessionRecord) => SessionRecord;
  notifyPeer: (
    session: SessionRecord,
    type: string,
    payload: Record<string, unknown>,
  ) => Promise<void>;
  peerFor: (session: SessionRecord, agentId: string) => string;
  roleFor: (session: SessionRecord, agentId: string) => "initiator" | "recipient";
  assertParticipant: (
    session: SessionRecord,
    from: string,
  ) => { ok: true; role: "initiator" | "recipient" } | { ok: false; error: "not_a_participant" };
};

function encodePayloadBytes(payload: Record<string, unknown>): string {
  return encodeBase64Url(utf8ToBytes(JSON.stringify(payload)));
}

function decodePayloadBytes(envelopeBytes: string): string {
  return new TextDecoder().decode(decodeBase64UrlStrict(envelopeBytes));
}

function appendExtensionDecided(
  session: SessionRecord,
  proposalId: string,
  decision: SessionExtensionDecided["decision"],
): SessionExtensionDecided[] {
  const existing = session.extensionDecided ?? [];
  if (existing.some((entry) => entry.proposal_id === proposalId)) {
    return existing;
  }
  return [...existing, { proposal_id: proposalId, decision }];
}

function isProposalDecided(session: SessionRecord, proposalId: string): boolean {
  return (session.extensionDecided ?? []).some((entry) => entry.proposal_id === proposalId);
}

function findBudgetExtendPending(
  thread: string,
  ctx: BudgetExtendContext,
): BudgetExtendPendingItem | undefined {
  return ctx.deps.pending
    .list()
    .find(
      (item): item is BudgetExtendPendingItem =>
        item.kind === "budget_extend" && item.thread === thread,
    );
}

export function removeBudgetExtendPendingForThread(thread: string, ctx: BudgetExtendContext) {
  for (const pending of ctx.deps.pending.list()) {
    if (pending.kind === "budget_extend" && pending.thread === thread) {
      ctx.deps.pending.remove(pending.id);
    }
  }
}

function hasPeerProposalPending(session: SessionRecord, ctx: BudgetExtendContext): boolean {
  const myRole = ctx.roleFor(session, ctx.deps.agentId);
  const pending = findBudgetExtendPending(session.thread, ctx);
  return Boolean(
    pending?.proposal_id && pending.proposed_by !== undefined && pending.proposed_by !== myRole,
  );
}

function hasExtensionOutstanding(session: SessionRecord, ctx: BudgetExtendContext): boolean {
  return Boolean(session.extension) || hasPeerProposalPending(session, ctx);
}

export function sweepBudgetExtendOnLeaveLive(
  session: SessionRecord,
  ctx: BudgetExtendContext,
): SessionRecord {
  removeBudgetExtendPendingForThread(session.thread, ctx);
  if (!session.extension) {
    return session;
  }
  const { extension: _, ...rest } = session;
  return rest;
}

export function guardTurnBudgetWithExtension(
  session: SessionRecord,
  ctx: BudgetExtendContext,
): { ok: true } | { ok: false; error: "budget_exhausted" } {
  if (session.turnCount < session.budget.max_turns) {
    return { ok: true };
  }
  if (!session.extension) {
    const existing = findBudgetExtendPending(session.thread, ctx);
    if (!existing) {
      ctx.deps.pending.addBudgetExtend({
        thread: session.thread,
        peer: ctx.peerFor(session, ctx.deps.agentId),
      });
    }
  }
  return { ok: false, error: "budget_exhausted" };
}

function crossCheckThread(
  bodyThread: string,
  payload: { thread: string },
): { ok: true } | { ok: false; error: "invalid_payload" } {
  if (payload.thread !== bodyThread) {
    return { ok: false, error: "invalid_payload" };
  }
  return { ok: true };
}

async function emitBudgetEnvelope(
  session: SessionRecord,
  ctx: BudgetExtendContext,
  input: {
    type: "nego.budget_propose" | "nego.budget_approved" | "nego.budget_reject";
    payload: Record<string, unknown>;
    extension: SessionExtension;
    onSuccess: (session: SessionRecord) => SessionRecord;
  },
) {
  const payloadStr = JSON.stringify(input.payload);
  const envelopeBytes = encodePayloadBytes(input.payload);
  const withEmitting = ctx.upsert({
    ...session,
    extension: { ...input.extension, envelope_bytes: envelopeBytes },
  });
  const sendResult = await ctx.deps.relay.send({
    to: ctx.peerFor(session, ctx.deps.agentId),
    type: input.type,
    payload: payloadStr,
    thread: session.thread,
  });
  if (!sendResult.ok) {
    return { ok: true as const, thread: session.thread, emit_pending: true as const };
  }
  ctx.upsert(input.onSuccess(withEmitting));
  return { ok: true as const, thread: session.thread };
}

export function createBudgetExtendHandlers(ctx: BudgetExtendContext) {
  async function handleExtendBudget(input: { thread: string; new_max_turns: number }) {
    const found = ctx.getOrError(input.thread);
    if (!found.ok) {
      return found;
    }
    const session = ctx.ensureLiveNotExpired(found.session);
    if (session.status !== "live") {
      return { ok: false as const, error: "session_not_live" as const };
    }
    if (hasExtensionOutstanding(session, ctx)) {
      return {
        ok: false as const,
        error: "extension_outstanding" as const,
        outstanding: session.extension
          ? { awaiting: "peer" as const }
          : { awaiting: "local_human" as const },
      };
    }
    if (!Number.isInteger(input.new_max_turns) || input.new_max_turns <= session.budget.max_turns) {
      return { ok: false as const, error: "invalid_payload" as const };
    }

    const proposalId = crypto.randomUUID();
    const role = ctx.roleFor(session, ctx.deps.agentId);
    removeBudgetExtendPendingForThread(session.thread, ctx);
    const pending = ctx.deps.pending.addBudgetExtend({
      thread: session.thread,
      peer: ctx.peerFor(session, ctx.deps.agentId),
      new_max_turns: input.new_max_turns,
      proposal_id: proposalId,
      proposed_by: role,
    });

    return {
      ok: true as const,
      thread: session.thread,
      pending_id: pending.id,
      proposal_id: proposalId,
      new_max_turns: input.new_max_turns,
    };
  }

  async function handleApproveBudgetExtend(input: { pending_id: string; via_human?: boolean }) {
    if (!input.via_human) {
      return { ok: false as const, error: "human_required" as const };
    }

    const pending = ctx.deps.pending.get(input.pending_id);
    if (!pending || pending.kind !== "budget_extend") {
      return { ok: false as const, error: "pending_not_found" as const };
    }
    const budgetPending = pending;

    if (!budgetPending.new_max_turns || !budgetPending.proposal_id) {
      return { ok: false as const, error: "proposal_required" as const };
    }
    const proposalId = budgetPending.proposal_id;
    const newMaxTurns = budgetPending.new_max_turns;

    const found = ctx.getOrError(budgetPending.thread);
    if (!found.ok) {
      return found;
    }
    const session = ctx.ensureLiveNotExpired(found.session);
    if (session.status !== "live") {
      return { ok: false as const, error: "session_not_live" as const };
    }

    const myRole = ctx.roleFor(session, ctx.deps.agentId);
    const isLocalDraft = budgetPending.proposed_by === myRole;

    ctx.deps.pending.remove(budgetPending.id);

    if (isLocalDraft) {
      const extension: SessionExtension = {
        proposal_id: proposalId,
        new_max_turns: newMaxTurns,
        proposed_by: myRole,
        status: "emitting",
      };
      const payload = {
        thread: session.thread,
        proposal_id: proposalId,
        new_max_turns: newMaxTurns,
      };
      return emitBudgetEnvelope(session, ctx, {
        type: "nego.budget_propose",
        payload,
        extension,
        onSuccess: (current) => ({
          ...current,
          extension: {
            proposal_id: proposalId,
            new_max_turns: newMaxTurns,
            proposed_by: myRole,
            status: "awaiting_peer",
          },
        }),
      });
    }

    const newBudget = { ...session.budget, max_turns: newMaxTurns };
    const extensionDecided = appendExtensionDecided(session, proposalId, "approved");
    const extension: SessionExtension = {
      proposal_id: proposalId,
      new_max_turns: newMaxTurns,
      proposed_by: budgetPending.proposed_by as "initiator" | "recipient",
      status: "approved_emitting",
    };
    const payload = {
      thread: session.thread,
      proposal_id: proposalId,
      new_max_turns: newMaxTurns,
    };
    const withBudget = ctx.upsert({
      ...session,
      budget: newBudget,
      extensionDecided,
      extension,
    });
    const result = await emitBudgetEnvelope(withBudget, ctx, {
      type: "nego.budget_approved",
      payload,
      extension,
      onSuccess: (current) => {
        const { extension: _, ...rest } = current;
        return rest;
      },
    });
    if (result.ok) {
      return { ...result, max_turns: newMaxTurns };
    }
    return result;
  }

  async function handleRejectBudgetExtend(input: {
    pending_id: string;
    via_human?: boolean;
    reason?: string;
  }) {
    if (!input.via_human) {
      return { ok: false as const, error: "human_required" as const };
    }

    const pending = ctx.deps.pending.get(input.pending_id);
    if (!pending || pending.kind !== "budget_extend") {
      return { ok: false as const, error: "pending_not_found" as const };
    }

    const found = ctx.getOrError(pending.thread);
    if (!found.ok) {
      return found;
    }
    const session = ctx.ensureLiveNotExpired(found.session);
    if (session.status !== "live") {
      return { ok: false as const, error: "session_not_live" as const };
    }

    ctx.deps.pending.remove(pending.id);

    if (!pending.proposal_id || !pending.new_max_turns) {
      return { ok: true as const, thread: session.thread, status: "live" as const };
    }

    const myRole = ctx.roleFor(session, ctx.deps.agentId);
    if (pending.proposed_by === myRole) {
      return { ok: true as const, thread: session.thread, status: "live" as const };
    }

    const extensionDecided = appendExtensionDecided(session, pending.proposal_id, "rejected");
    const extension: SessionExtension = {
      proposal_id: pending.proposal_id,
      new_max_turns: pending.new_max_turns,
      proposed_by: pending.proposed_by as "initiator" | "recipient",
      status: "rejected_emitting",
    };
    const payload = {
      thread: session.thread,
      proposal_id: pending.proposal_id,
      new_max_turns: pending.new_max_turns,
      reason: input.reason ?? "rejected",
    };
    const withDecided = ctx.upsert({ ...session, extensionDecided, extension });
    return emitBudgetEnvelope(withDecided, ctx, {
      type: "nego.budget_reject",
      payload,
      extension,
      onSuccess: (current) => {
        const { extension: _, ...rest } = current;
        return rest;
      },
    });
  }

  async function retryBudgetExtendEmit(thread: string) {
    const found = ctx.getOrError(thread);
    if (!found.ok) {
      return found;
    }
    const session = found.session;
    const extension = session.extension;
    if (!extension?.envelope_bytes) {
      return { ok: false as const, error: "invalid_payload" as const };
    }

    const payloadStr = decodePayloadBytes(extension.envelope_bytes);
    let type: "nego.budget_propose" | "nego.budget_approved" | "nego.budget_reject";
    switch (extension.status) {
      case "emitting":
        type = "nego.budget_propose";
        break;
      case "approved_emitting":
        type = "nego.budget_approved";
        break;
      case "rejected_emitting":
        type = "nego.budget_reject";
        break;
      default:
        return { ok: false as const, error: "invalid_payload" as const };
    }

    const sendResult = await ctx.deps.relay.send({
      to: ctx.peerFor(session, ctx.deps.agentId),
      type,
      payload: payloadStr,
      thread,
    });
    if (!sendResult.ok) {
      return { ok: false as const, error: sendResult.error ?? "relay_unavailable" };
    }

    const onSuccess = (): SessionRecord => {
      switch (extension.status) {
        case "emitting":
          return ctx.upsert({
            ...session,
            extension: {
              proposal_id: extension.proposal_id,
              new_max_turns: extension.new_max_turns,
              proposed_by: extension.proposed_by,
              status: "awaiting_peer",
            },
          });
        case "approved_emitting":
        case "rejected_emitting": {
          const { extension: _, ...rest } = session;
          return ctx.upsert(rest);
        }
        default:
          return session;
      }
    };
    onSuccess();
    return { ok: true as const, thread };
  }

  function queuePeerProposalPending(
    session: SessionRecord,
    input: {
      proposal_id: string;
      new_max_turns: number;
      proposed_by: "initiator" | "recipient";
    },
  ) {
    removeBudgetExtendPendingForThread(session.thread, ctx);
    return ctx.deps.pending.addBudgetExtend({
      thread: session.thread,
      peer: ctx.peerFor(session, ctx.deps.agentId),
      new_max_turns: input.new_max_turns,
      proposal_id: input.proposal_id,
      proposed_by: input.proposed_by,
    });
  }

  async function handleIncomingBudgetPropose(input: {
    thread: string;
    from: string;
    payload: Record<string, unknown>;
  }) {
    const found = ctx.getOrError(input.thread);
    if (!found.ok) {
      return found;
    }
    const session = ctx.ensureLiveNotExpired(found.session);
    if (session.status !== "live") {
      return { ok: false as const, error: "session_not_live" as const };
    }

    const parsed = parseNegoBudgetExtendPayload(input.payload);
    if (!parsed.ok) {
      return parsed;
    }
    const crossCheck = crossCheckThread(input.thread, parsed.data);
    if (!crossCheck.ok) {
      return crossCheck;
    }

    const participant = ctx.assertParticipant(session, input.from);
    if (!participant.ok) {
      return participant;
    }

    if (parsed.data.new_max_turns <= session.budget.max_turns) {
      return { ok: true as const, thread: input.thread, dropped: true as const };
    }

    if (isProposalDecided(session, parsed.data.proposal_id)) {
      return { ok: true as const, thread: input.thread, dropped: true as const };
    }

    const existingPending = findBudgetExtendPending(session.thread, ctx);
    if (
      existingPending?.proposal_id === parsed.data.proposal_id &&
      existingPending.new_max_turns === parsed.data.new_max_turns
    ) {
      return { ok: true as const, thread: input.thread, noop: true as const };
    }

    const myRole = ctx.roleFor(session, ctx.deps.agentId);
    const peerRole = participant.role;

    if (session.extension?.proposal_id === parsed.data.proposal_id) {
      if (session.extension.status === "awaiting_peer") {
        return { ok: true as const, thread: input.thread, noop: true as const };
      }
    }

    if (session.extension && session.extension.proposed_by === myRole) {
      if (session.initiator === ctx.deps.agentId) {
        const payload = {
          thread: session.thread,
          proposal_id: parsed.data.proposal_id,
          new_max_turns: parsed.data.new_max_turns,
          reason: "superseded",
        };
        await ctx.deps.relay.send({
          to: ctx.peerFor(session, ctx.deps.agentId),
          type: "nego.budget_reject",
          payload: JSON.stringify(payload),
          thread: session.thread,
        });
        ctx.upsert({
          ...session,
          extensionDecided: appendExtensionDecided(session, parsed.data.proposal_id, "rejected"),
        });
        return {
          ok: true as const,
          thread: input.thread,
          race: "initiator_wins" as const,
        };
      }
      const cleared = ctx.upsert({
        ...session,
        extension: undefined,
        extensionDecided: appendExtensionDecided(
          session,
          session.extension.proposal_id,
          "rejected",
        ),
      });
      queuePeerProposalPending(cleared, {
        proposal_id: parsed.data.proposal_id,
        new_max_turns: parsed.data.new_max_turns,
        proposed_by: peerRole,
      });
      return {
        ok: true as const,
        thread: input.thread,
        superseded: true as const,
        inbox_event: "budget_extend_superseded" as const,
      };
    }

    if (existingPending?.proposed_by === myRole) {
      queuePeerProposalPending(session, {
        proposal_id: parsed.data.proposal_id,
        new_max_turns: parsed.data.new_max_turns,
        proposed_by: peerRole,
      });
      return {
        ok: true as const,
        thread: input.thread,
        superseded: true as const,
        inbox_event: "budget_extend_superseded" as const,
      };
    }

    queuePeerProposalPending(session, {
      proposal_id: parsed.data.proposal_id,
      new_max_turns: parsed.data.new_max_turns,
      proposed_by: peerRole,
    });
    return { ok: true as const, thread: input.thread, pending: true as const };
  }

  async function handleIncomingBudgetApproved(input: {
    thread: string;
    from: string;
    payload: Record<string, unknown>;
  }) {
    const found = ctx.getOrError(input.thread);
    if (!found.ok) {
      return found;
    }
    const session = ctx.ensureLiveNotExpired(found.session);
    if (session.status !== "live") {
      return { ok: false as const, error: "session_not_live" as const };
    }

    const parsed = parseNegoBudgetExtendPayload(input.payload);
    if (!parsed.ok) {
      return parsed;
    }
    const crossCheck = crossCheckThread(input.thread, parsed.data);
    if (!crossCheck.ok) {
      return crossCheck;
    }

    const participant = ctx.assertParticipant(session, input.from);
    if (!participant.ok) {
      return participant;
    }

    if (session.budget.max_turns >= parsed.data.new_max_turns) {
      return { ok: true as const, thread: input.thread, dropped: true as const };
    }

    const extension = session.extension;
    if (!extension || extension.proposal_id !== parsed.data.proposal_id) {
      return { ok: true as const, thread: input.thread, dropped: true as const };
    }

    if (extension.status !== "awaiting_peer") {
      return { ok: true as const, thread: input.thread, dropped: true as const };
    }

    const extensionDecided = appendExtensionDecided(session, parsed.data.proposal_id, "approved");
    const { extension: _, ...rest } = session;
    ctx.upsert({
      ...rest,
      budget: { ...session.budget, max_turns: parsed.data.new_max_turns },
      extensionDecided,
    });
    return { ok: true as const, thread: input.thread, max_turns: parsed.data.new_max_turns };
  }

  async function handleIncomingBudgetReject(input: {
    thread: string;
    from: string;
    payload: Record<string, unknown>;
  }) {
    const found = ctx.getOrError(input.thread);
    if (!found.ok) {
      return found;
    }
    const session = ctx.ensureLiveNotExpired(found.session);
    if (session.status !== "live") {
      return { ok: false as const, error: "session_not_live" as const };
    }

    const parsed = parseNegoBudgetRejectPayload(input.payload);
    if (!parsed.ok) {
      return parsed;
    }
    const crossCheck = crossCheckThread(input.thread, parsed.data);
    if (!crossCheck.ok) {
      return crossCheck;
    }

    const participant = ctx.assertParticipant(session, input.from);
    if (!participant.ok) {
      return participant;
    }

    const extension = session.extension;
    if (!extension || extension.proposal_id !== parsed.data.proposal_id) {
      return { ok: true as const, thread: input.thread, dropped: true as const };
    }

    const extensionDecided = appendExtensionDecided(session, parsed.data.proposal_id, "rejected");
    const { extension: __, ...rest } = session;
    ctx.upsert({ ...rest, extensionDecided });
    return { ok: true as const, thread: input.thread };
  }

  return {
    handleExtendBudget,
    handleApproveBudgetExtend,
    handleRejectBudgetExtend,
    retryBudgetExtendEmit,
    handleIncomingBudgetPropose,
    handleIncomingBudgetApproved,
    handleIncomingBudgetReject,
  };
}

export type BudgetExtendHandlers = ReturnType<typeof createBudgetExtendHandlers>;

export function isNumberedBudgetExtendPending(
  pending: BudgetExtendPendingItem | undefined,
): boolean {
  return Boolean(pending?.proposal_id && pending.new_max_turns !== undefined);
}
