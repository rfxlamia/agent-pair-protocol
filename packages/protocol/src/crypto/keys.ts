import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeBase64UrlStrict, encodeBase64Url } from "./base64url.js";

const AGENT_ID_PREFIX = "ed25519:";
const ED25519_PUBLIC_KEY_LENGTH = 32;

export interface KeyPair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

export function generateKeyPair(): KeyPair {
  return ed25519.keygen();
}

export function publicKeyToAgentId(publicKey: Uint8Array): string {
  return `${AGENT_ID_PREFIX}${encodeBase64Url(publicKey)}`;
}

export function agentIdToPublicKey(agentId: string): Uint8Array {
  if (!agentId.startsWith(AGENT_ID_PREFIX)) {
    throw new Error(`Invalid agent id prefix: ${agentId}`);
  }
  const bytes = decodeBase64UrlStrict(agentId.slice(AGENT_ID_PREFIX.length));
  if (bytes.length !== ED25519_PUBLIC_KEY_LENGTH) {
    throw new Error("Invalid Ed25519 public key length");
  }
  return bytes;
}

export function getPublicKey(secretKey: Uint8Array): Uint8Array {
  return ed25519.getPublicKey(secretKey);
}
