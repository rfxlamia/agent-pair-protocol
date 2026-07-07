import { describe, expect, it } from "vitest";
import { generateKeyPair } from "./keys.js";
import { decryptPayload, encryptPayload } from "./encrypt.js";
import { randomNonce } from "./envelope.js";
import { utf8ToBytes } from "@noble/ciphers/utils.js";

const XCHACHA_NONCE_LENGTH = 24;

describe("encrypt", () => {
  it("rejects payloads shorter than nonce plus Poly1305 tag", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const short = Buffer.alloc(XCHACHA_NONCE_LENGTH + 15).toString("base64url");

    expect(() =>
      decryptPayload(short, bob.secretKey, alice.publicKey),
    ).toThrow(/too short/i);
  });

  it("defaults randomNonce to XChaCha20 nonce length (24 bytes)", () => {
    expect(randomNonce().length).toBe(XCHACHA_NONCE_LENGTH);
  });

  it("round-trips when randomNonce supplies the correct length", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const plaintext = utf8ToBytes("nonce-length-check");

    const encrypted = encryptPayload(
      plaintext,
      alice.secretKey,
      bob.publicKey,
    );
    const decrypted = decryptPayload(
      encrypted,
      bob.secretKey,
      alice.publicKey,
    );
    expect(decrypted).toEqual(plaintext);
  });
});
