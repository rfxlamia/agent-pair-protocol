import { utf8ToBytes } from "@noble/ciphers/utils.js";
import { describe, expect, it } from "vitest";
import { encodeBase64Url } from "./base64url.js";
import { decryptPayload, encryptPayload } from "./encrypt.js";
import { randomNonce } from "./envelope.js";
import { generateKeyPair } from "./keys.js";

const XCHACHA_NONCE_LENGTH = 24;

describe("encrypt", () => {
  it("rejects payloads shorter than nonce plus Poly1305 tag", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const short = encodeBase64Url(Buffer.alloc(XCHACHA_NONCE_LENGTH + 15));

    expect(() => decryptPayload(short, bob.secretKey, alice.publicKey)).toThrow(/too short/i);
  });

  it("defaults randomNonce to XChaCha20 nonce length (24 bytes)", () => {
    expect(randomNonce().length).toBe(XCHACHA_NONCE_LENGTH);
  });

  it("round-trips when randomNonce supplies the correct length", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const plaintext = utf8ToBytes("nonce-length-check");

    const encrypted = encryptPayload(plaintext, alice.secretKey, bob.publicKey);
    const decrypted = decryptPayload(encrypted, bob.secretKey, alice.publicKey);
    expect(decrypted).toEqual(plaintext);
  });

  it("is deterministic when testOnlyNonce is provided", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const plaintext = utf8ToBytes("deterministic");
    const nonce = new Uint8Array(24).fill(0x42);

    const a = encryptPayload(plaintext, alice.secretKey, bob.publicKey, nonce);
    const b = encryptPayload(plaintext, alice.secretKey, bob.publicKey, nonce);

    expect(a).toBe(b);
    expect(decryptPayload(a, bob.secretKey, alice.publicKey)).toEqual(plaintext);
  });

  it("uses a fresh random nonce on each call when testOnlyNonce is omitted", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const plaintext = utf8ToBytes("nonce-uniqueness");

    const first = encryptPayload(plaintext, alice.secretKey, bob.publicKey);
    const second = encryptPayload(plaintext, alice.secretKey, bob.publicKey);

    expect(first).not.toBe(second);
  });
});
