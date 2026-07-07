import { ed25519 } from "@noble/curves/ed25519.js";

const AGENT_ID_PREFIX = "ed25519:";

export interface KeyPair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

export function generateKeyPair(): KeyPair {
  return ed25519.keygen();
}

export function publicKeyToAgentId(publicKey: Uint8Array): string {
  return `${AGENT_ID_PREFIX}${Buffer.from(publicKey).toString("base64url")}`;
}

export function agentIdToPublicKey(agentId: string): Uint8Array {
  if (!agentId.startsWith(AGENT_ID_PREFIX)) {
    throw new Error(`Invalid agent id prefix: ${agentId}`);
  }
  return new Uint8Array(
    Buffer.from(agentId.slice(AGENT_ID_PREFIX.length), "base64url"),
  );
}

export function getPublicKey(secretKey: Uint8Array): Uint8Array {
  return ed25519.getPublicKey(secretKey);
}
