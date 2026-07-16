import { generateKeyPair, publicKeyToAgentId } from "@agentpair/protocol";
import { postEnvelope } from "../helpers/post-envelope.js";
import type { Probe } from "../types.js";

export const defaultDenyProbe: Probe = {
  id: "default-deny",
  tier: "fast",
  async run(baseUrl) {
    const recipient = generateKeyPair();
    const sender = generateKeyPair();
    const recipientId = publicKeyToAgentId(recipient.publicKey);

    const res = await postEnvelope(baseUrl, recipientId, sender, 1);
    if (res.status !== 403) {
      throw new Error(`expected 403 recipient_not_allowed, got ${res.status}`);
    }
    const body = (await res.json()) as { error: string };
    if (body.error !== "recipient_not_allowed") {
      throw new Error(`expected recipient_not_allowed, got ${body.error}`);
    }
  },
};
