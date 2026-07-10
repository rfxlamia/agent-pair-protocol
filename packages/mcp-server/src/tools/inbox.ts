import {
  createOuterEnvelope,
  defaultEnvelopeTtl,
  isKnownEnvelopeType,
  isSessionDispatchType,
  parseEnvelopeBody,
  parseEnvelopePayload,
  publicKeyToAgentId,
  receiveEnvelope,
} from "@agentpair/protocol";
import { utf8ToBytes } from "@noble/ciphers/utils.js";
import type { AgentContext } from "./pair.js";
import { ensureAllowlistReady } from "./pair.js";
import {
  expirePendingSessions,
  peekSessionOpenStatus,
  processSessionInboxEnvelope,
  processThreadClose,
  resolveRatifyPendingId,
  resolveSessionOpenPendingId,
} from "./session.js";
import { detectClientThreadGaps, nextThreadSeq, recordSentSeq } from "./thread-seq.js";
import { assertNoSecrets, toolTextResult } from "./util.js";

const processedEnvelopeIds = new WeakMap<AgentContext, Set<string>>();

function formatPayloadForInbox(type: string, rawPayload: string): unknown {
  try {
    const parsed = JSON.parse(rawPayload);
    if (type === "core.msg" || type === "core.close" || type === "core.ack") {
      return parsed;
    }
  } catch {
    // fall through
  }
  return rawPayload;
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
  await expirePendingSessions(ctx);
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
  const rejected: Array<{ id?: string; error: string; cursor?: number }> = [];

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
      dispatch: async (type, plaintext) => {
        if (!isKnownEnvelopeType(type)) {
          return { ok: false as const, error: "unsupported_envelope_type" };
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(new TextDecoder().decode(plaintext));
        } catch {
          return { ok: false as const, error: "invalid_payload" };
        }
        return parseEnvelopePayload(type, parsed);
      },
    });

    if (!received.ok) {
      rejected.push({
        ...(received.body ? { id: received.body.id } : {}),
        error: received.error,
        cursor: rowid,
      });
      continue;
    }

    const { body, outer, plaintext } = received;
    // receiveEnvelope already committed seq; cursor advances at pull end, so this
    // envelope won't be redelivered (stale_seq would reject if it were). Session
    // side effects may still fail after commit — in-process `seen` dedupes by body.id.
    const payload = new TextDecoder().decode(plaintext);

    let pendingId: string | undefined;
    let sessionStatus: string | undefined;

    if (isSessionDispatchType(body.type) && !seen.has(body.id)) {
      const processed = await processSessionInboxEnvelope(ctx, {
        from: body.from,
        type: body.type,
        thread: body.thread,
        payload,
      });
      const effect = processed.structuredContent;
      if (effect.ok === true) {
        seen.add(body.id);
      }
      if (effect.ok === true && typeof effect.pending_id === "string") {
        pendingId = effect.pending_id;
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

    if (body.type === "core.close" && !ctx.closedThreads.isClosed(body.thread)) {
      let reason: string | undefined;
      try {
        const parsed = JSON.parse(payload) as { reason?: string };
        reason = parsed.reason;
      } catch {
        reason = undefined;
      }
      ctx.closedThreads.markClosed(body.thread, {
        closed_at: Math.floor(Date.now() / 1000),
        reason,
        by: body.from,
      });
      await ctx.closedThreads.flush();
      await processThreadClose(ctx, body.thread, reason);
    }

    envelopes.push({
      id: body.id,
      from: body.from,
      to: body.to,
      type: body.type,
      thread: body.thread,
      seq: body.seq,
      ttl: body.ttl,
      payload: formatPayloadForInbox(body.type, payload),
      sig: outer.sig,
      verified: true,
      ...(pendingId ? { pending_id: pendingId } : {}),
      ...(sessionStatus ? { session_status: sessionStatus } : {}),
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
    type: string;
    payload: string;
    thread?: string;
    seq?: number;
    ttl?: number;
  },
) {
  const keyPair = await ctx.keyStore.loadOrCreate();
  const senderId = publicKeyToAgentId(keyPair.publicKey);
  const allowed = ctx.allowlist.get(senderId);
  if (!allowed.includes(input.to)) {
    const result = { ok: false, error: "recipient_not_allowed" };
    assertNoSecrets(result);
    return toolTextResult(result);
  }

  const thread = input.thread ?? crypto.randomUUID();
  const seq = input.seq ?? nextThreadSeq(ctx, thread);
  const outer = createOuterEnvelope({
    sender: keyPair,
    recipientAgentId: input.to,
    type: input.type,
    thread,
    seq,
    ttl: defaultEnvelopeTtl(input.ttl),
    payload: utf8ToBytes(input.payload),
  });

  const body = parseEnvelopeBody(outer);

  await ctx.relay.sendEnvelope(input.to, outer);
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
