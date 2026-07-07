import {
  agentIdToPublicKey,
  createEnvelope,
  decryptEnvelopePayload,
  publicKeyToAgentId,
  verifyEnvelope,
} from "@agentpair/protocol";
import { utf8ToBytes } from "@noble/ciphers/utils.js";
import type { AgentContext } from "./pair.js";
import { expirePendingSessions, processSessionInboxEnvelope } from "./session.js";
import { assertNoSecrets, toolTextResult } from "./util.js";

const processedEnvelopeIds = new WeakMap<AgentContext, Set<string>>();
const threadSeqCounters = new WeakMap<AgentContext, Map<string, number>>();

function nextSeq(ctx: AgentContext, thread: string): number {
  const counters = threadSeqCounters.get(ctx) ?? new Map<string, number>();
  threadSeqCounters.set(ctx, counters);
  const next = (counters.get(thread) ?? 0) + 1;
  counters.set(thread, next);
  return next;
}

export async function handleInbox(ctx: AgentContext, input: { since?: number }) {
  await expirePendingSessions(ctx);

  const keyPair = await ctx.keyStore.loadOrCreate();
  const since = input.since ?? 0;
  const pull = await ctx.relay.pullInbox(keyPair, since);

  if (!pull.ok) {
    const result = { ok: false, ...pull };
    assertNoSecrets(result);
    return toolTextResult(result);
  }

  const seen = processedEnvelopeIds.get(ctx) ?? new Set<string>();
  processedEnvelopeIds.set(ctx, seen);

  const envelopes = [];
  for (const envelope of pull.envelopes) {
    const senderPublicKey = agentIdToPublicKey(envelope.from);
    const verified = verifyEnvelope(envelope, senderPublicKey);

    if (verified && envelope.type.startsWith("session.") && !seen.has(envelope.id)) {
      seen.add(envelope.id);
      const plaintext = decryptEnvelopePayload(envelope, keyPair, senderPublicKey);
      const payload = new TextDecoder().decode(plaintext);
      await processSessionInboxEnvelope(ctx, {
        from: envelope.from,
        type: envelope.type,
        thread: envelope.thread,
        payload,
      });
    }

    envelopes.push({
      id: envelope.id,
      from: envelope.from,
      to: envelope.to,
      type: envelope.type,
      thread: envelope.thread,
      seq: envelope.seq,
      ttl: envelope.ttl,
      payload: envelope.payload,
      sig: envelope.sig,
      verified,
    });
  }

  const result = {
    ok: true,
    since,
    cursor: pull.cursor ?? since,
    envelopes,
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
    seq: input.seq ?? nextSeq(ctx, thread),
    ttl: input.ttl ?? 3600,
    payload: utf8ToBytes(input.payload),
  });

  await ctx.relay.sendEnvelope(input.to, envelope);

  const result = {
    ok: true,
    id: envelope.id,
    thread: envelope.thread,
    seq: envelope.seq,
  };
  assertNoSecrets(result);
  return toolTextResult(result);
}
