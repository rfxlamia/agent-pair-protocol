import { createHash } from "node:crypto";
import { encodeAllowlistPush, generateKeyPair, publicKeyToAgentId } from "@agentpair/protocol";
import { signChallenge } from "../helpers/sign-challenge.js";
import type { Probe } from "../types.js";

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export const artifact10mbProbe: Probe = {
  id: "artifact-10mb",
  tier: "large",
  async run(baseUrl) {
    const owner = generateKeyPair();
    const ownerId = publicKeyToAgentId(owner.publicKey);
    const body = encodeAllowlistPush(ownerId, [], owner.secretKey);

    const allowRes = await fetch(`${baseUrl}/allowlist/${ownerId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (allowRes.status !== 204) {
      throw new Error(`agent registration failed: ${allowRes.status}`);
    }

    const blob = new Uint8Array(10 * 1024 * 1024);
    blob.fill(0xab);
    const hash = sha256Hex(blob);
    const sig = signChallenge(hash, owner.secretKey);

    const res = await fetch(`${baseUrl}/artifact/${hash}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "x-agent-id": ownerId,
        "x-artifact-sig": sig,
      },
      body: blob,
    });
    if (res.status !== 204) {
      throw new Error(`10 MiB artifact PUT failed: ${res.status}`);
    }
  },
};
