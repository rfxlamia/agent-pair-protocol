import {
  type EnvelopeBody,
  type OuterEnvelope,
  agentIdToPublicKey,
  createOuterEnvelope,
  decryptEnvelopePayload,
  deserializeOuterEnvelope,
  parseEnvelopeBody,
  publicKeyToAgentId,
  verifyOuterEnvelope,
} from "@agentpair/protocol";
import { utf8ToBytes } from "@noble/ciphers/utils.js";
import type { AgentContext } from "./pair.js";
import { ensureAllowlistReady } from "./pair.js";
import {
  expirePendingSessions,
  peekSessionOpenStatus,
  processSessionInboxEnvelope,
  resolveRatifyPendingId,
  resolveSessionOpenPendingId,
} from "./session.js";
import {
  detectClientThreadGaps,
  nextThreadSeq,
  recordPeerSeq,
  recordSentSeq,
} from "./thread-seq.js";
import { assertNoSecrets, toolTextResult } from "./util.js";

const processedEnvelopeIds = new WeakMap<AgentContext, Set<string>>();

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

function filterBondedEnvelopes(
  envelopes: OuterEnvelope[],
  allowedPeers: string[],
  includeHistory: boolean,
): { envelopes: OuterEnvelope[]; filteredCount: number } {
  if (includeHistory) {
    return { envelopes, filteredCount: 0 };
  }
  const allowed = new Set(allowedPeers);
  const filtered = envelopes.filter((envelope) => allowed.has(envelope.from));
  return {
    envelopes: filtered,
    filteredCount: envelopes.length - filtered.length,
  };
}

function parseOuterEnvelope(raw: OuterEnvelope | string): OuterEnvelope {
  if (typeof raw === "string") {
    return deserializeOuterEnvelope(raw);
  }
  return raw;
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

  const pull = await ctx.relay.pullInbox(keyPair, sinceUsed, {
    bonded_only: !includeHistory,
    senders: !includeHistory && bondedPeers.length > 0 ? bondedPeers : undefined,
  });

  if (!pull.ok) {
    assertNoSecrets(pull);
    return toolTextResult(pull);
  }

  const { envelopes: envelopesToProcess, filteredCount } = filterBondedEnvelopes(
    pull.envelopes,
    bondedPeers,
    includeHistory,
  );

  const seen = processedEnvelopeIds.get(ctx) ?? new Set<string>();
  processedEnvelopeIds.set(ctx, seen);

  const envelopes = [];
  let skippedUnsupported = 0;
  for (const raw of envelopesToProcess) {
    let outer: OuterEnvelope;
    let body: EnvelopeBody;
    try {
      outer = parseOuterEnvelope(raw);
      body = parseEnvelopeBody(outer);
    } catch {
      skippedUnsupported += 1;
      continue;
    }

    recordPeerSeq(ctx, body.thread, body.seq);

    const senderPublicKey = agentIdToPublicKey(body.from);
    const verified = verifyOuterEnvelope(outer, senderPublicKey);

    let payload = body.payload;
    let pendingId: string | undefined;
    let sessionStatus: string | undefined;
    if (verified) {
      try {
        const plaintext = decryptEnvelopePayload(body, keyPair, senderPublicKey);
        payload = new TextDecoder().decode(plaintext);

        if (body.type.startsWith("session.") && !seen.has(body.id)) {
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

        if (body.type === "session.open" && !pendingId) {
          pendingId = await resolveSessionOpenPendingId(ctx, body.thread);
        }

        if (body.type === "session.peer_signed" && !pendingId) {
          pendingId = await resolveRatifyPendingId(ctx, body.thread);
        }

        if (body.type === "session.open") {
          sessionStatus = peekSessionOpenStatus(ctx, body.thread);
        }
      } catch {
        // Keep wire ciphertext if decryption fails.
      }
    }

    envelopes.push({
      id: body.id,
      from: body.from,
      to: body.to,
      type: body.type,
      thread: body.thread,
      seq: body.seq,
      ttl: body.ttl,
      payload,
      sig: outer.sig,
      verified,
      ...(pendingId ? { pending_id: pendingId } : {}),
      ...(sessionStatus ? { session_status: sessionStatus } : {}),
    });
  }

  const gapWarnings = detectClientThreadGaps(ctx);
  const cursor = pull.cursor ?? sinceUsed;
  ctx.inboxCursor.set(cursor);
  await ctx.inboxCursor.flush();
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
    ...(bondsEmpty ? { bonds_empty: true } : {}),
    ...(cursorReset ? { cursor_reset: true } : {}),
    ...(gapWarnings.length > 0 ? { gap_warnings: gapWarnings } : {}),
    ...(pull.relay_gaps && pull.relay_gaps.length > 0 ? { relay_gaps: pull.relay_gaps } : {}),
    ...(skippedUnsupported > 0 ? { skipped_unsupported: skippedUnsupported } : {}),
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
    ttl: input.ttl ?? 3600,
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
