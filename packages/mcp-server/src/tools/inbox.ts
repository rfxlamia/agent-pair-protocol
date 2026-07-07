import {
  createEnvelope,
  publicKeyToAgentId,
  verifyEnvelope,
} from "@agentpair/protocol";
import { utf8ToBytes } from "@noble/ciphers/utils.js";
import type { AgentContext } from "./pair.js";
import { assertNoSecrets, toolTextResult } from "./util.js";

export async function handleInbox(ctx: AgentContext, input: { since?: number }) {
  const keyPair = await ctx.keyStore.loadOrCreate();
  const since = input.since ?? 0;
  const pull = await ctx.relay.pullInbox(keyPair, since);

  if (!pull.ok) {
    const result = { ok: false, ...pull };
    assertNoSecrets(result);
    return toolTextResult(result);
  }

  const envelopes = pull.envelopes.map((envelope) => ({
    id: envelope.id,
    from: envelope.from,
    to: envelope.to,
    type: envelope.type,
    thread: envelope.thread,
    seq: envelope.seq,
    ttl: envelope.ttl,
    payload: envelope.payload,
    sig: envelope.sig,
    verified: verifyEnvelope(envelope),
  }));

  const result = { ok: true, since, envelopes };
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

  const envelope = createEnvelope({
    sender: keyPair,
    recipientAgentId: input.to,
    type: input.type,
    thread: input.thread ?? crypto.randomUUID(),
    seq: input.seq ?? 1,
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
