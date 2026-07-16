import {
  createOuterEnvelope,
  encodeAllowlistPush,
  generateKeyPair,
  publicKeyToAgentId,
  serializeOuterEnvelope,
} from "@agentpair/protocol";
import { utf8ToBytes } from "@noble/ciphers/utils.js";
import { futureTtl } from "../helpers/future-ttl.js";
import type { Probe } from "../types.js";

export const inboxIdempotencyProbe: Probe = {
  id: "inbox-idempotency",
  tier: "fast",
  async run(baseUrl) {
    const recipient = generateKeyPair();
    const sender = generateKeyPair();
    const recipientId = publicKeyToAgentId(recipient.publicKey);
    const senderId = publicKeyToAgentId(sender.publicKey);
    const thread = "bb0e8400-e29b-41d4-a716-446655440099";

    const allowlist = encodeAllowlistPush(recipientId, [senderId], recipient.secretKey);
    const allowRes = await fetch(`${baseUrl}/allowlist/${recipientId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(allowlist),
    });
    if (allowRes.status !== 204) {
      throw new Error(`allowlist setup failed: ${allowRes.status}`);
    }

    const envelope = createOuterEnvelope({
      sender,
      recipientAgentId: recipientId,
      type: "core.msg",
      thread,
      seq: 1,
      ttl: futureTtl(),
      payload: utf8ToBytes("dup"),
      id: crypto.randomUUID(),
    });
    const wire = serializeOuterEnvelope(envelope);

    const first = await fetch(`${baseUrl}/inbox/${recipientId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: wire,
    });
    if (first.status !== 204) {
      throw new Error(`first POST failed: ${first.status}`);
    }

    const second = await fetch(`${baseUrl}/inbox/${recipientId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: wire,
    });
    if (second.status !== 204) {
      throw new Error(`byte-identical retry expected 204, got ${second.status}`);
    }
  },
};
