import { utf8ToBytes } from "@noble/ciphers/utils.js";
import { describe, expect, it } from "vitest";
import { decryptPayload, encryptPayload } from "../crypto/encrypt.js";
import { generateKeyPair } from "../crypto/keys.js";
import { FIXTURE_NONCE_LENGTH, encryptPayloadWithFixedNonce } from "./crypto-fixtures.js";

describe("crypto-fixtures (golden-vector helpers)", () => {
  it("is deterministic when fixedNonce is provided", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const plaintext = utf8ToBytes("deterministic");
    const nonce = new Uint8Array(FIXTURE_NONCE_LENGTH).fill(0x42);

    const a = encryptPayloadWithFixedNonce(plaintext, alice.secretKey, bob.publicKey, nonce);
    const b = encryptPayloadWithFixedNonce(plaintext, alice.secretKey, bob.publicKey, nonce);

    expect(a).toBe(b);
    expect(decryptPayload(a, bob.secretKey, alice.publicKey)).toEqual(plaintext);
  });

  it("rejects fixed nonces that are not 24 bytes", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    expect(() =>
      encryptPayloadWithFixedNonce(
        utf8ToBytes("x"),
        alice.secretKey,
        bob.publicKey,
        new Uint8Array(8),
      ),
    ).toThrow(/24 bytes/);
  });
});

describe("encrypt", () => {
  it("uses a fresh random nonce on each call", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const plaintext = utf8ToBytes("nonce-uniqueness");

    const first = encryptPayload(plaintext, alice.secretKey, bob.publicKey);
    const second = encryptPayload(plaintext, alice.secretKey, bob.publicKey);

    expect(first).not.toBe(second);
  });
});
