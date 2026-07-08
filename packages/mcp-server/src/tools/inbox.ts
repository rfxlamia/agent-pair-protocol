import {
  agentIdToPublicKey,
  createEnvelope,
  decryptEnvelopePayload,
  publicKeyToAgentId,
  verifyEnvelope,
} from "@agentpair/protocol";
import type { Envelope } from "@agentpair/protocol";
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
  const bonds = ctx.bonds.get(agentId);
  if (bonds.length > 0) {
    return { peers: bonds.map((bond) => bond.peer), bondsEmpty: false };
  }
  return { peers: ctx.allowlist.get(agentId), bondsEmpty: true };
}

function filterBondedEnvelopes(
  envelopes: Envelope[],
  allowedPeers: string[],
  includeHistory: boolean,
): { envelopes: Envelope[]; filteredCount: number } {
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

  const pull = await ctx.relay.pullInbox(keyPair, sinceUsed);

  if (!pull.ok) {
    assertNoSecrets(pull);
    return toolTextResult(pull);
  }

  const { peers: bondedPeers, bondsEmpty } = resolveAllowedPeers(ctx, agentId);
  const { envelopes: envelopesToProcess, filteredCount } = filterBondedEnvelopes(
    pull.envelopes,
    bondedPeers,
    includeHistory,
  );

  const seen = processedEnvelopeIds.get(ctx) ?? new Set<string>();
  processedEnvelopeIds.set(ctx, seen);

  const envelopes = [];
  for (const envelope of envelopesToProcess) {
    recordPeerSeq(ctx, envelope.thread, envelope.seq);

    const senderPublicKey = agentIdToPublicKey(envelope.from);
    const verified = verifyEnvelope(envelope, senderPublicKey);

    let payload = envelope.payload;
    let pendingId: string | undefined;
    let sessionStatus: string | undefined;
    if (verified) {
      try {
        const plaintext = decryptEnvelopePayload(envelope, keyPair, senderPublicKey);
        payload = new TextDecoder().decode(plaintext);

        if (envelope.type.startsWith("session.") && !seen.has(envelope.id)) {
          const processed = await processSessionInboxEnvelope(ctx, {
            from: envelope.from,
            type: envelope.type,
            thread: envelope.thread,
            payload,
          });
          const effect = processed.structuredContent;
          if (effect.ok === true) {
            seen.add(envelope.id);
          }
          if (effect.ok === true && typeof effect.pending_id === "string") {
            pendingId = effect.pending_id;
          }
        }

        if (envelope.type === "session.open" && !pendingId) {
          pendingId = await resolveSessionOpenPendingId(ctx, envelope.thread);
        }

        if (envelope.type === "session.peer_signed" && !pendingId) {
          pendingId = await resolveRatifyPendingId(ctx, envelope.thread);
        }

        if (envelope.type === "session.open") {
          sessionStatus = peekSessionOpenStatus(ctx, envelope.thread);
        }
      } catch {
        // Keep wire ciphertext if decryption fails.
      }
    }

    envelopes.push({
      id: envelope.id,
      from: envelope.from,
      to: envelope.to,
      type: envelope.type,
      thread: envelope.thread,
      seq: envelope.seq,
      ttl: envelope.ttl,
      payload,
      sig: envelope.sig,
      verified,
      ...(pendingId ? { pending_id: pendingId } : {}),
      ...(sessionStatus ? { session_status: sessionStatus } : {}),
    });
  }

  const gapWarnings = detectClientThreadGaps(ctx);
  const cursor = pull.cursor ?? sinceUsed;
  ctx.inboxCursor.set(cursor);

  const result = {
    ok: true,
    since: sinceUsed,
    since_used: sinceUsed,
    cursor,
    new_count: envelopes.length,
    filtered_count: filteredCount,
    bonded_peers: bondedPeers,
    envelopes,
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
  const envelope = createEnvelope({
    sender: keyPair,
    recipientAgentId: input.to,
    type: input.type,
    thread,
    seq: input.seq ?? nextThreadSeq(ctx, thread),
    ttl: input.ttl ?? 3600,
    payload: utf8ToBytes(input.payload),
  });

  await ctx.relay.sendEnvelope(input.to, envelope);
  recordSentSeq(ctx, thread, envelope.seq);

  const result = {
    ok: true,
    id: envelope.id,
    thread: envelope.thread,
    seq: envelope.seq,
  };
  assertNoSecrets(result);
  return toolTextResult(result);
}
