import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/ciphers/utils.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { decodeBase64UrlStrict, encodeBase64Url } from "./base64url.js";

const NONCE_LENGTH = 24;
const HKDF_INFO = new TextEncoder().encode("agentpair-envelope-v1");

function deriveEncryptionKey(
  senderSecretKey: Uint8Array,
  recipientPublicKey: Uint8Array,
): Uint8Array {
  const senderX25519Secret = ed25519.utils.toMontgomerySecret(senderSecretKey);
  const recipientX25519Public = ed25519.utils.toMontgomery(recipientPublicKey);
  const sharedSecret = x25519.getSharedSecret(senderX25519Secret, recipientX25519Public);
  return hkdf(sha256, sharedSecret, undefined, HKDF_INFO, 32);
}

export function encryptPayload(
  plaintext: Uint8Array,
  senderSecretKey: Uint8Array,
  recipientPublicKey: Uint8Array,
): string {
  const key = deriveEncryptionKey(senderSecretKey, recipientPublicKey);
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = xchacha20poly1305(key, nonce);
  const ciphertext = cipher.encrypt(plaintext);
  const payload = new Uint8Array(nonce.length + ciphertext.length);
  payload.set(nonce, 0);
  payload.set(ciphertext, nonce.length);
  return encodeBase64Url(payload);
}

export function decryptPayload(
  encryptedPayload: string,
  recipientSecretKey: Uint8Array,
  senderPublicKey: Uint8Array,
): Uint8Array {
  const payload = decodeBase64UrlStrict(encryptedPayload);
  if (payload.length < NONCE_LENGTH + 16) {
    throw new Error("Encrypted payload is too short");
  }

  const nonce = payload.subarray(0, NONCE_LENGTH);
  const ciphertext = payload.subarray(NONCE_LENGTH);
  const recipientX25519Secret = ed25519.utils.toMontgomerySecret(recipientSecretKey);
  const senderX25519Public = ed25519.utils.toMontgomery(senderPublicKey);
  const sharedSecret = x25519.getSharedSecret(recipientX25519Secret, senderX25519Public);
  const key = hkdf(sha256, sharedSecret, undefined, HKDF_INFO, 32);
  const cipher = xchacha20poly1305(key, nonce);
  return cipher.decrypt(ciphertext);
}
