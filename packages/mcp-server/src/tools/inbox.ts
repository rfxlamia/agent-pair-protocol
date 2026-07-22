import {
  REFERENCE_PROFILES,
  defaultEnvelopeTtl,
  isKnownEnvelopeType,
  isProfileInBond,
  isSessionDispatchType,
  parseEnvelopeBody,
  parseEnvelopePayload,
  publicKeyToAgentId,
  receiveEnvelope,
  resolveSpillover,
} from "@agentpair/protocol";
import { utf8ToBytes } from "@noble/ciphers/utils.js";
import {
  APPROVAL_CHANNEL_UNAVAILABLE_HINT,
  PENDING_APPROVAL_SUGGESTED_NEXT,
  approvalPathForPending,
} from "./approval-surface.js";
import { sendEnvelopeWithSpill } from "./inbox-spill.js";
import type { AgentContext } from "./pair.js";
import { ensureAllowlistReady } from "./pair.js";
import {
  expireSessions,
  peekSessionOpenStatus,
  processSessionInboxEnvelope,
  processThreadClose,
  resolveRatifyPendingId,
  resolveSessionOpenPendingId,
  retryBudgetExtendEmitForSessions,
} from "./session.js";
import { detectClientThreadGaps, nextThreadSeq, recordSentSeq } from "./thread-seq.js";
import { assertNoSecrets, stripSecrets, toolTextResult, wrapUntrustedPeerContent } from "./util.js";

const processedEnvelopeIds = new WeakMap<AgentContext, Set<string>>();

function parseStructuredInboxPayload(rawPayload: string): unknown {
  try {
    return JSON.parse(rawPayload);
  } catch {
    return rawPayload;
  }
}

function isThreadCloseAuthorized(ctx: AgentContext, thread: string, senderId: string): boolean {
  const session = ctx.sessionStore.get(thread);
  if (!session) {
    return true;
  }
  return session.initiator === senderId || session.recipient === senderId;
}

function closeReasonFromPayload(inboxPayload: unknown): string | undefined {
  if (typeof inboxPayload !== "object" || inboxPayload === null || Array.isArray(inboxPayload)) {
    return undefined;
  }
  const reason = (inboxPayload as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : undefined;
}

function resolveAllowedPeers(
  ctx: AgentContext,
  agentId: string,
): {
  peers: string[];
  bondsEmpty: boolean;
} {
  const allowlist = ctx.allowlist.get(agentId);
  const bonds = ctx.bonds.get(agentId);
  if (bonds.length > 0) {
    const bondPeers = bonds.map((bond) => bond.peer);
    if (allowlist.length === 0) {
      return { peers: bondPeers, bondsEmpty: false };
    }
    const allowSet = new Set(allowlist);
    const peers = bondPeers.filter((peer) => allowSet.has(peer));
    return { peers, bondsEmpty: false };
  }
  return { peers: allowlist, bondsEmpty: true };
}

export function filterBondedWires(
  wires: string[],
  rowids: number[],
  bondedPeers: Set<string>,
  includeHistory: boolean,
): { wires: string[]; rowids: number[]; filteredCount: number } {
  if (includeHistory) {
    return { wires, rowids, filteredCount: 0 };
  }
  const filteredWires: string[] = [];
  const filteredRowids: number[] = [];
  for (let i = 0; i < wires.length; i += 1) {
    const wire = wires[i];
    const rowid = rowids[i];
    if (wire === undefined || rowid === undefined) {
      continue;
    }
    const parsed = JSON.parse(wire) as { from?: string };
    if (parsed.from !== undefined && bondedPeers.has(parsed.from)) {
      filteredWires.push(wire);
      filteredRowids.push(rowid);
    }
  }
  return {
    wires: filteredWires,
    rowids: filteredRowids,
    filteredCount: wires.length - filteredWires.length,
  };
}

export async function handleInbox(
  ctx: AgentContext,
  input: { since?: number; include_history?: boolean },
) {
  await expireSessions(ctx);
  await retryBudgetExtendEmitForSessions(ctx);
  await ensureAllowlistReady(ctx);

  const keyPair = await ctx.keyStore.loadOrCreate();
  const agentId = publicKeyToAgentId(keyPair.publicKey);
  await ctx.inboxCursor.init(agentId);
  await ctx.envelopeSeq.init(agentId);

  const includeHistory = input.include_history ?? false;
  let cursorReset = false;
  let sinceUsed: number;
  if (input.since !== undefined) {
    sinceUsed = input.since;
  } else {
    const loaded = ctx.inboxCursor.load();
    sinceUsed = loaded.cursor;
    cursorReset = loaded.wasReset;
  }

  const { peers: bondedPeers, bondsEmpty } = resolveAllowedPeers(ctx, agentId);
  const bondedPeerSet = new Set(bondedPeers);

  const pull = await ctx.relay.pullInbox(keyPair, sinceUsed, {
    bonded_only: !includeHistory,
    senders: !includeHistory && bondedPeers.length > 0 ? bondedPeers : undefined,
  });

  if (!pull.ok) {
    assertNoSecrets(pull);
    return toolTextResult(pull);
  }

  const pullWires = pull.wires;
  const pullRowids = pull.rowids;
  const {
    wires: wiresToProcess,
    rowids: rowidsToProcess,
    filteredCount,
  } = filterBondedWires(pullWires, pullRowids, bondedPeerSet, includeHistory);

  const seen = processedEnvelopeIds.get(ctx) ?? new Set<string>();
  processedEnvelopeIds.set(ctx, seen);

  const envelopes = [];
  const rejected: Array<{
    id?: string;
    error: string;
    cursor?: number;
    retryable?: boolean;
    suggested_next?: string;
  }> = [];

  for (let i = 0; i < wiresToProcess.length; i += 1) {
    const wire = wiresToProcess[i];
    const rowid = rowidsToProcess[i];
    if (wire === undefined || rowid === undefined) {
      continue;
    }

    const received = await receiveEnvelope(wire, agentId, {
      isBonded: (from) => bondedPeerSet.has(from),
      selfKeyPair: keyPair,
      seqStore: ctx.envelopeSeq,
      resolvePayload: async (plaintext) =>
        resolveSpillover(plaintext, {
          getArtifact: (hash, size) => ctx.relay.getArtifact(hash, size),
        }),
      dispatch: async (body, plaintext) => {
        if (!isKnownEnvelopeType(body.type)) {
          return { ok: false as const, error: "unsupported_envelope_type" };
        }
        const bond = ctx.bonds.find(agentId, body.from);
        const contract = bond?.profiles ?? [...REFERENCE_PROFILES];
        if (!isProfileInBond(body.type, contract)) {
          return { ok: false as const, error: "profile_not_supported" };
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(new TextDecoder().decode(plaintext));
        } catch {
          return { ok: false as const, error: "invalid_payload" };
        }
        const payloadResult = parseEnvelopePayload(body.type, parsed);
        if (!payloadResult.ok) {
          return payloadResult;
        }
        if (body.type === "core.close" && !isThreadCloseAuthorized(ctx, body.thread, body.from)) {
          return { ok: false as const, error: "not_a_participant" };
        }
        return payloadResult;
      },
    });

    if (!received.ok) {
      rejected.push({
        ...(received.body ? { id: received.body.id } : {}),
        error: received.error,
        cursor: rowid,
        ...(received.error === "artifact_fetch_failed" ? { retryable: true } : {}),
      });
      continue;
    }

    const { body, outer, plaintext } = received;
    // receiveEnvelope already committed seq; cursor advances at pull end, so this
    // envelope won't be redelivered (stale_seq would reject if it were). Session
    // side effects may still fail after commit — in-process `seen` dedupes by body.id.
    const payload = new TextDecoder().decode(plaintext);
    const inboxPayload = parseStructuredInboxPayload(payload);

    let pendingId: string | undefined;
    let sessionStatus: string | undefined;
    let inboxEvent: string | undefined;

    if (isSessionDispatchType(body.type) && !seen.has(body.id)) {
      const processed = await processSessionInboxEnvelope(ctx, {
        from: body.from,
        type: body.type,
        thread: body.thread,
        payload,
      });
      const effect = processed.structuredContent;
      if (effect.ok === false && effect.error === "approval_channel_unavailable") {
        const suggestedNext =
          "suggested_next" in effect && typeof effect.suggested_next === "string"
            ? effect.suggested_next
            : APPROVAL_CHANNEL_UNAVAILABLE_HINT;
        rejected.push({
          id: body.id,
          error: "approval_channel_unavailable",
          cursor: rowid,
          retryable: true,
          suggested_next: suggestedNext,
        });
        continue;
      }
      if (effect.ok === true) {
        seen.add(body.id);
      }
      if (effect.ok === true && typeof effect.pending_id === "string") {
        pendingId = effect.pending_id;
      }
      if (effect.ok === true && typeof effect.inbox_event === "string") {
        inboxEvent = effect.inbox_event;
      }
    }

    if (body.type === "nego.open" && !pendingId) {
      pendingId = await resolveSessionOpenPendingId(ctx, body.thread);
    }

    if (body.type === "nego.signed" && !pendingId) {
      pendingId = await resolveRatifyPendingId(ctx, body.thread);
    }

    if (body.type === "nego.open") {
      sessionStatus = peekSessionOpenStatus(ctx, body.thread);
    }

    if (
      body.type === "core.close" &&
      !ctx.closedThreads.isClosed(body.thread) &&
      isThreadCloseAuthorized(ctx, body.thread, body.from)
    ) {
      const reason = closeReasonFromPayload(inboxPayload);
      ctx.closedThreads.markClosed(body.thread, {
        closed_at: Math.floor(Date.now() / 1000),
        reason,
        by: body.from,
      });
      await ctx.closedThreads.flush();
      await processThreadClose(ctx, body.thread, reason);
    }

    const approvalPath = pendingId ? approvalPathForPending(ctx, pendingId) : undefined;

    envelopes.push({
      id: body.id,
      from: body.from,
      to: body.to,
      type: body.type,
      thread: body.thread,
      seq: body.seq,
      ttl: body.ttl,
      payload: wrapUntrustedPeerContent(stripSecrets(inboxPayload), ctx.peerContentCapBytes),
      sig: outer.sig,
      signature_valid: true,
      ...(pendingId
        ? {
            pending_id: pendingId,
            ...(approvalPath
              ? {
                  approval_path: approvalPath,
                  suggested_next: PENDING_APPROVAL_SUGGESTED_NEXT,
                }
              : {}),
          }
        : {}),
      ...(sessionStatus ? { session_status: sessionStatus } : {}),
      ...(inboxEvent ? { inbox_event: inboxEvent } : {}),
    });
  }

  const gapWarnings = detectClientThreadGaps(ctx);
  const cursor = pull.cursor ?? sinceUsed;
  ctx.inboxCursor.set(cursor);
  await ctx.inboxCursor.flush();
  await ctx.envelopeSeq.flush();
  const relayFilteredCount = pull.filtered_count ?? 0;
  const totalFilteredCount = relayFilteredCount + filteredCount;

  const result = {
    ok: true,
    since: sinceUsed,
    since_used: sinceUsed,
    cursor,
    new_count: envelopes.length,
    filtered_count: totalFilteredCount,
    ...(relayFilteredCount > 0 ? { relay_filtered_count: relayFilteredCount } : {}),
    ...(filteredCount > 0 ? { mcp_filtered_count: filteredCount } : {}),
    bonded_peers: bondedPeers,
    envelopes,
    ...(rejected.length > 0 ? { rejected } : {}),
    ...(bondsEmpty ? { bonds_empty: true } : {}),
    ...(cursorReset ? { cursor_reset: true } : {}),
    ...(gapWarnings.length > 0 ? { gap_warnings: gapWarnings } : {}),
    ...(pull.relay_gaps && pull.relay_gaps.length > 0 ? { relay_gaps: pull.relay_gaps } : {}),
  };
  assertNoSecrets(result);
  return toolTextResult(result);
}

export async function handleSend(
  ctx: AgentContext,
  input: {
    to: string;
    body: string;
    kind?: string;
    thread?: string;
    seq?: number;
    ttl?: number;
  },
) {
  const thread = input.thread ?? crypto.randomUUID();
  if (ctx.closedThreads.isClosed(thread)) {
    return toolTextResult({ ok: false, error: "thread_closed" });
  }

  const payloadObj: { body: string; kind?: string } = { body: input.body };
  if (input.kind !== undefined) {
    payloadObj.kind = input.kind;
  }

  const keyPair = await ctx.keyStore.loadOrCreate();
  const senderId = publicKeyToAgentId(keyPair.publicKey);
  const allowed = ctx.allowlist.get(senderId);
  if (!allowed.includes(input.to)) {
    return toolTextResult({ ok: false, error: "recipient_not_allowed" });
  }

  const seq = input.seq ?? nextThreadSeq(ctx, thread);
  const sent = await sendEnvelopeWithSpill(ctx, {
    sender: keyPair,
    to: input.to,
    type: "core.msg",
    thread,
    seq,
    ttl: defaultEnvelopeTtl(input.ttl),
    payload: utf8ToBytes(JSON.stringify(payloadObj)),
  });
  if (!sent.ok) {
    return toolTextResult({ ok: false, error: sent.error });
  }
  const body = parseEnvelopeBody(sent.outer);
  recordSentSeq(ctx, thread, body.seq);

  const result = {
    ok: true,
    id: body.id,
    thread: body.thread,
    seq: body.seq,
  };
  assertNoSecrets(result);
  return toolTextResult(result);
}

export async function handleClose(
  ctx: AgentContext,
  input: { thread: string; to?: string; reason?: string },
) {
  if (ctx.closedThreads.isClosed(input.thread)) {
    return toolTextResult({ ok: false, error: "thread_closed" });
  }

  const keyPair = await ctx.keyStore.loadOrCreate();
  const senderId = publicKeyToAgentId(keyPair.publicKey);
  const session = ctx.sessionStore.get(input.thread);
  if (session && session.initiator !== senderId && session.recipient !== senderId) {
    return toolTextResult({ ok: false, error: "not_a_participant" });
  }

  let to = input.to;
  if (!to) {
    if (session) {
      to = session.initiator === senderId ? session.recipient : session.initiator;
    }
  }
  if (!to) {
    return toolTextResult({ ok: false, error: "recipient_not_allowed" });
  }

  const allowed = ctx.allowlist.get(senderId);
  if (!allowed.includes(to)) {
    return toolTextResult({ ok: false, error: "recipient_not_allowed" });
  }

  const payloadObj = input.reason !== undefined ? { reason: input.reason } : {};
  const seq = nextThreadSeq(ctx, input.thread);
  const sent = await sendEnvelopeWithSpill(ctx, {
    sender: keyPair,
    to,
    type: "core.close",
    thread: input.thread,
    seq,
    ttl: defaultEnvelopeTtl(),
    payload: utf8ToBytes(JSON.stringify(payloadObj)),
  });
  if (!sent.ok) {
    return toolTextResult({ ok: false, error: sent.error });
  }
  const body = parseEnvelopeBody(sent.outer);
  recordSentSeq(ctx, input.thread, body.seq);

  ctx.closedThreads.markClosed(input.thread, {
    closed_at: Math.floor(Date.now() / 1000),
    reason: input.reason,
    by: senderId,
  });
  await ctx.closedThreads.flush();
  await processThreadClose(ctx, input.thread, input.reason);

  const result = {
    ok: true,
    thread: input.thread,
    seq: body.seq,
  };
  assertNoSecrets(result);
  return toolTextResult(result);
}
