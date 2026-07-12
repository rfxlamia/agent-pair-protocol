/**
 * Golden-vector encryption helpers — not exported from `@agentpair/protocol`.
 * Uses a fixed nonce so committed fixture JSON is reproducible; production code
 * must call `encryptPayload` / `createOuterEnvelope` without a fixed nonce (§3).
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { utf8ToBytes } from "@noble/ciphers/utils.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { encodeBase64Url } from "../crypto/base64url.js";
import {
  type CreateOuterEnvelopeInput,
  type OuterEnvelope,
  serializeBodyBytes,
} from "../crypto/envelope.js";
import { agentIdToPublicKey, publicKeyToAgentId } from "../crypto/keys.js";
import { sign } from "../crypto/sign.js";

export const FIXTURE_NONCE_LENGTH = 24;
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

export function encryptPayloadWithFixedNonce(
  plaintext: Uint8Array,
  senderSecretKey: Uint8Array,
  recipientPublicKey: Uint8Array,
  fixedNonce: Uint8Array,
): string {
  if (fixedNonce.length !== FIXTURE_NONCE_LENGTH) {
    throw new Error(`fixedNonce must be ${FIXTURE_NONCE_LENGTH} bytes`);
  }
  const key = deriveEncryptionKey(senderSecretKey, recipientPublicKey);
  const cipher = xchacha20poly1305(key, fixedNonce);
  const ciphertext = cipher.encrypt(plaintext);
  const payload = new Uint8Array(fixedNonce.length + ciphertext.length);
  payload.set(fixedNonce, 0);
  payload.set(ciphertext, fixedNonce.length);
  return encodeBase64Url(payload);
}

export type CreateOuterEnvelopeFixtureInput = CreateOuterEnvelopeInput & {
  fixedNonce: Uint8Array;
};

export function createOuterEnvelopeWithFixedNonce(
  input: CreateOuterEnvelopeFixtureInput,
): OuterEnvelope {
  const recipientPublicKey = agentIdToPublicKey(input.recipientAgentId);
  const encryptedPayload = encryptPayloadWithFixedNonce(
    input.payload,
    input.sender.secretKey,
    recipientPublicKey,
    input.fixedNonce,
  );

  const from = publicKeyToAgentId(input.sender.publicKey);
  const body = {
    v: 1 as const,
    id: input.id ?? crypto.randomUUID(),
    from,
    to: input.recipientAgentId,
    type: input.type,
    thread: input.thread,
    seq: input.seq,
    ttl: input.ttl,
    payload: encryptedPayload,
  };

  const bodyBytes = serializeBodyBytes(body);
  const signature = sign(bodyBytes, input.sender.secretKey);

  return {
    v: 1,
    from,
    to: input.recipientAgentId,
    blob: encodeBase64Url(bodyBytes),
    sig: encodeBase64Url(signature),
  };
}

export function utf8FixtureBytes(text: string): Uint8Array {
  return utf8ToBytes(text);
}
