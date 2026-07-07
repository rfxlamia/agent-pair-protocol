import {
  agentIdToPublicKey,
  createEnvelope,
  decryptEnvelopePayload,
  publicKeyToAgentId,
  verifyEnvelope,
} from "@agentpair/protocol";
import { utf8ToBytes } from "@noble/ciphers/utils.js";
import type { AgentContext } from "./pair.js";
import { expirePendingSessions, peekSessionOpenStatus, processSessionInboxEnvelope, resolveSessionOpenPendingId } from "./session.js";
import {
  detectClientThreadGaps,
  nextThreadSeq,
  recordPeerSeq,
  recordSentSeq,
} from "./thread-seq.js";
import { assertNoSecrets, toolTextResult } from "./util.js";

const processedEnvelopeIds = new WeakMap<AgentContext, Set<string>>();

export async function handleInbox(ctx: AgentContext, input: { since?: number }) {
  await expirePendingSessions(ctx);

  const keyPair = await ctx.keyStore.loadOrCreate();
  const since = input.since ?? 0;
  const pull = await ctx.relay.pullInbox(keyPair, since);

  if (!pull.ok) {
    assertNoSecrets(pull);
    return toolTextResult(pull);
  }

  const seen = processedEnvelopeIds.get(ctx) ?? new Set<string>();
  processedEnvelopeIds.set(ctx, seen);

  const envelopes = [];
  for (const envelope of pull.envelopes) {
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
          seen.add(envelope.id);
          const processed = await processSessionInboxEnvelope(ctx, {
            from: envelope.from,
            type: envelope.type,
            thread: envelope.thread,
            payload,
          });
          const effect = processed.structuredContent;
          if (
            effect.ok === true &&
            typeof effect.pending_id === "string"
          ) {
            pendingId = effect.pending_id;
          }
        }

        if (envelope.type === "session.open" && !pendingId) {
          pendingId = await resolveSessionOpenPendingId(ctx, envelope.thread);
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
  const result = {
    ok: true,
    since,
    cursor: pull.cursor ?? since,
    envelopes,
    ...(gapWarnings.length > 0 ? { gap_warnings: gapWarnings } : {}),
    ...(pull.relay_gaps && pull.relay_gaps.length > 0
      ? { relay_gaps: pull.relay_gaps }
      : {}),
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
