import { encodeAllowlistPush, generateKeyPair, publicKeyToAgentId } from "@agentpair/protocol";
import type { Probe } from "../types.js";

export const allowlistBlobProbe: Probe = {
  id: "allowlist-blob",
  tier: "fast",
  async run(baseUrl) {
    const owner = generateKeyPair();
    const peer = generateKeyPair();
    const ownerId = publicKeyToAgentId(owner.publicKey);
    const peerId = publicKeyToAgentId(peer.publicKey);

    const body = encodeAllowlistPush(ownerId, [peerId], owner.secretKey);
    const res = await fetch(`${baseUrl}/allowlist/${ownerId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status !== 204) {
      throw new Error(`expected 204, got ${res.status}`);
    }
  },
};
