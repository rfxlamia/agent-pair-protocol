import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes, utf8ToBytes } from "@noble/ciphers/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";

const NONCE_LENGTH = 24;

export const MAX_SPILLOVER_PLAINTEXT_BYTES = 10 * 1024 * 1024;
export const ARTIFACT_AAD = "agentpair-artifact-v1";

const aadBytes = utf8ToBytes(ARTIFACT_AAD);

export function hashArtifactBlob(blob: Uint8Array): string {
  return Buffer.from(sha256(blob)).toString("hex");
}

export function encryptArtifact(
  plaintext: Uint8Array,
  key: Uint8Array,
  options?: { nonce?: Uint8Array },
): { blob: Uint8Array; hash: string } {
  const nonce = options?.nonce ?? randomBytes(NONCE_LENGTH);
  if (nonce.length !== NONCE_LENGTH) {
    throw new Error(`Artifact nonce must be ${NONCE_LENGTH} bytes`);
  }
  const cipher = xchacha20poly1305(key, nonce, aadBytes);
  const ciphertext = cipher.encrypt(plaintext);
  const blob = new Uint8Array(nonce.length + ciphertext.length);
  blob.set(nonce, 0);
  blob.set(ciphertext, nonce.length);
  return { blob, hash: hashArtifactBlob(blob) };
}

export function decryptArtifact(blob: Uint8Array, key: Uint8Array): Uint8Array {
  if (blob.length < NONCE_LENGTH + 16) {
    throw new Error("Artifact blob is too short");
  }
  const nonce = blob.subarray(0, NONCE_LENGTH);
  const ciphertext = blob.subarray(NONCE_LENGTH);
  const cipher = xchacha20poly1305(key, nonce, aadBytes);
  return cipher.decrypt(ciphertext);
}
