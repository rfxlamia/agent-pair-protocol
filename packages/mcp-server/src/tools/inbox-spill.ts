import {
  type KeyPair,
  type OuterEnvelope,
  publicKeyToAgentId,
  wrapOrSpill,
} from "@agentpair/protocol";
import type { AgentContext } from "./pair.js";

export type SpillSendInput = {
  sender: KeyPair;
  to: string;
  type: string;
  thread: string;
  seq: number;
  ttl: number;
  payload: Uint8Array;
};

export async function sendEnvelopeWithSpill(
  ctx: AgentContext,
  input: SpillSendInput,
): Promise<{ ok: true; outer: OuterEnvelope } | { ok: false; error: string }> {
  const agentId = publicKeyToAgentId(input.sender.publicKey);
  const spillResult = await wrapOrSpill(
    {
      sender: input.sender,
      recipientAgentId: input.to,
      type: input.type,
      thread: input.thread,
      seq: input.seq,
      ttl: input.ttl,
      payload: input.payload,
    },
    {
      putArtifact: (blob, hash) =>
        ctx.relay.putArtifact(hash, blob, agentId, input.sender.secretKey),
    },
  );
  if (!spillResult.ok) {
    return { ok: false, error: spillResult.error };
  }
  try {
    await ctx.relay.sendEnvelope(input.to, spillResult.outer);
  } catch {
    return { ok: false, error: "relay_unavailable" };
  }
  return { ok: true, outer: spillResult.outer };
}
