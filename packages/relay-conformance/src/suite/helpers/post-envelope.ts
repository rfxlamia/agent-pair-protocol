import { type KeyPair, createOuterEnvelope, serializeOuterEnvelope } from "@agentpair/protocol";
import { utf8ToBytes } from "@noble/ciphers/utils.js";
import { futureTtl } from "./future-ttl.js";

export async function postEnvelope(
  baseUrl: string,
  recipientId: string,
  sender: KeyPair,
  seq: number,
  overrides?: { ttl?: number; id?: string; thread?: string },
): Promise<Response> {
  const envelope = createOuterEnvelope({
    sender,
    recipientAgentId: recipientId,
    type: "core.msg",
    thread: overrides?.thread ?? "550e8400-e29b-41d4-a716-446655440000",
    seq,
    ttl: overrides?.ttl ?? futureTtl(),
    payload: utf8ToBytes(`message-${seq}`),
    id: overrides?.id ?? crypto.randomUUID(),
  });

  return fetch(`${baseUrl}/inbox/${recipientId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: serializeOuterEnvelope(envelope),
  });
}
