import { createHash } from "node:crypto";
import { encodeAllowlistPush, generateKeyPair, publicKeyToAgentId } from "@agentpair/protocol";
import { signChallenge } from "../helpers/sign-challenge.js";
import type { Probe } from "../types.js";

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export const hashVerifyProbe: Probe = {
  id: "hash-verify",
  tier: "fast",
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

    const blob = new TextEncoder().encode("hash-verify-payload");
    const wrongHash = "0".repeat(64);
    const sig = signChallenge(wrongHash, owner.secretKey);

    const res = await fetch(`${baseUrl}/artifact/${wrongHash}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "x-agent-id": ownerId,
        "x-artifact-sig": sig,
      },
      body: blob,
    });
    if (res.status !== 400) {
      throw new Error(`expected 400 hash_mismatch, got ${res.status}`);
    }
    const err = (await res.json()) as { error: string };
    if (err.error !== "hash_mismatch") {
      throw new Error(`expected hash_mismatch, got ${err.error}`);
    }

    const correctHash = sha256Hex(blob);
    if (correctHash === wrongHash) {
      throw new Error("test setup error: hashes collided");
    }
  },
};
