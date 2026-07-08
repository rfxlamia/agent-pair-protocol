import { bytesToUtf8, utf8ToBytes } from "@noble/ciphers/utils.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import {
  createEnvelope,
  decryptEnvelopePayload,
  serializeEnvelope,
  verifyEnvelope,
} from "./crypto/envelope.js";
import { generateKeyPair, publicKeyToAgentId } from "./crypto/keys.js";

describe("envelope", () => {
  it("round-trips encrypt, sign, verify, and decrypt", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();

    const plaintext = utf8ToBytes('{"hello":"world"}');
    const envelope = createEnvelope({
      sender: alice,
      recipientAgentId: publicKeyToAgentId(bob.publicKey),
      type: "chat.message",
      thread: "550e8400-e29b-41d4-a716-446655440000",
      seq: 1,
      ttl: 86400,
      payload: plaintext,
    });

    expect(verifyEnvelope(envelope, alice.publicKey)).toBe(true);

    const decrypted = decryptEnvelopePayload(envelope, bob, alice.publicKey);
    expect(bytesToUtf8(decrypted)).toBe('{"hello":"world"}');
  });

  it("rejects a tampered signature", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();

    const envelope = createEnvelope({
      sender: alice,
      recipientAgentId: publicKeyToAgentId(bob.publicKey),
      type: "chat.message",
      thread: "550e8400-e29b-41d4-a716-446655440001",
      seq: 2,
      ttl: 86400,
      payload: utf8ToBytes("tamper me"),
    });

    const tampered = { ...envelope, sig: `${envelope.sig.slice(0, -2)}XX` };
    expect(verifyEnvelope(tampered, alice.publicKey)).toBe(false);
  });

  it("does not expose raw private keys in serialized envelope", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();

    const envelope = createEnvelope({
      sender: alice,
      recipientAgentId: publicKeyToAgentId(bob.publicKey),
      type: "session.msg",
      thread: "550e8400-e29b-41d4-a716-446655440002",
      seq: 3,
      ttl: 3600,
      payload: utf8ToBytes("secret payload"),
    });

    const serialized = serializeEnvelope(envelope);
    const secretHex = bytesToHex(alice.secretKey);
    expect(serialized).not.toContain(secretHex);
    expect(serialized).not.toContain(Buffer.from(alice.secretKey).toString("base64"));
    expect(serialized).not.toContain(Buffer.from(alice.secretKey).toString("base64url"));
  });
});
