import { bytesToUtf8, utf8ToBytes } from "@noble/ciphers/utils.js";
import { describe, expect, it } from "vitest";
import { decodeBase64UrlStrict, encodeBase64Url } from "./crypto/base64url.js";
import {
  createOuterEnvelope,
  decryptEnvelopePayload,
  deserializeOuterEnvelope,
  parseEnvelopeBody,
  serializeOuterEnvelope,
  verifyOuterEnvelope,
} from "./crypto/envelope.js";
import { generateKeyPair, publicKeyToAgentId } from "./crypto/keys.js";

describe("outer envelope v1 sign-the-blob", () => {
  const thread = "550e8400-e29b-41d4-a716-446655440000";

  it("createOuterEnvelope → verifyOuterEnvelope true over exact blob bytes", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const bobId = publicKeyToAgentId(bob.publicKey);

    const outer = createOuterEnvelope({
      sender: alice,
      recipientAgentId: bobId,
      type: "chat.message",
      thread,
      seq: 1,
      ttl: 86400,
      payload: utf8ToBytes('{"hello":"world"}'),
    });

    expect(verifyOuterEnvelope(outer, alice.publicKey)).toBe(true);

    const body = parseEnvelopeBody(outer);
    expect(body.v).toBe(1);
    expect(body.from).toBe(publicKeyToAgentId(alice.publicKey));
    expect(body.to).toBe(bobId);
    expect(body.type).toBe("chat.message");
    expect(body.thread).toBe(thread);
    expect(body.seq).toBe(1);
    expect(body.ttl).toBe(86400);
    expect(typeof body.id).toBe("string");
    expect(typeof body.payload).toBe("string");

    const decrypted = decryptEnvelopePayload(body, bob, alice.publicKey);
    expect(bytesToUtf8(decrypted)).toBe('{"hello":"world"}');
  });

  it("fixes body JSON key order at create time: v, id, from, to, type, thread, seq, ttl, payload", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const bobId = publicKeyToAgentId(bob.publicKey);

    const outer = createOuterEnvelope({
      sender: alice,
      recipientAgentId: bobId,
      type: "chat.message",
      thread,
      seq: 2,
      ttl: 3600,
      payload: utf8ToBytes("key-order"),
    });

    const body = parseEnvelopeBody(outer);
    const bodyJson = new TextDecoder().decode(decodeBase64UrlStrict(outer.blob));
    expect(bodyJson).toBe(
      JSON.stringify({
        v: 1,
        id: body.id,
        from: body.from,
        to: body.to,
        type: body.type,
        thread: body.thread,
        seq: body.seq,
        ttl: body.ttl,
        payload: body.payload,
      }),
    );
  });

  it("rejects tampered blob byte with unchanged sig", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();

    const outer = createOuterEnvelope({
      sender: alice,
      recipientAgentId: publicKeyToAgentId(bob.publicKey),
      type: "chat.message",
      thread,
      seq: 3,
      ttl: 3600,
      payload: utf8ToBytes("tamper blob"),
    });

    const blobBytes = decodeBase64UrlStrict(outer.blob);
    blobBytes[10] ^= 0xff;
    const tampered = { ...outer, blob: encodeBase64Url(blobBytes) };

    expect(verifyOuterEnvelope(tampered, alice.publicKey)).toBe(false);
  });

  it("rejects tampered signature", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();

    const outer = createOuterEnvelope({
      sender: alice,
      recipientAgentId: publicKeyToAgentId(bob.publicKey),
      type: "chat.message",
      thread,
      seq: 4,
      ttl: 3600,
      payload: utf8ToBytes("tamper sig"),
    });

    const tampered = { ...outer, sig: `${outer.sig.slice(0, -2)}XX` };
    expect(verifyOuterEnvelope(tampered, alice.publicKey)).toBe(false);
  });

  it("round-trips serializeOuterEnvelope / deserializeOuterEnvelope", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();

    const outer = createOuterEnvelope({
      sender: alice,
      recipientAgentId: publicKeyToAgentId(bob.publicKey),
      type: "chat.message",
      thread,
      seq: 5,
      ttl: 3600,
      payload: utf8ToBytes("round-trip"),
    });

    const wire = serializeOuterEnvelope(outer);
    const parsed = JSON.parse(wire) as Record<string, unknown>;
    expect(parsed.v).toBe(1);
    expect(parsed.blob).toBe(outer.blob);
    expect(parsed.sig).toBe(outer.sig);
    expect(parsed).not.toHaveProperty("id");
    expect(parsed).not.toHaveProperty("payload");

    const roundTripped = deserializeOuterEnvelope(wire);
    expect(roundTripped).toEqual(outer);
    expect(verifyOuterEnvelope(roundTripped, alice.publicKey)).toBe(true);
  });

  it("deserializeOuterEnvelope rejects v0 flat JSON (no v/blob)", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const flat = JSON.stringify({
      id: crypto.randomUUID(),
      from: publicKeyToAgentId(alice.publicKey),
      to: publicKeyToAgentId(bob.publicKey),
      type: "chat.message",
      thread,
      seq: 1,
      ttl: 3600,
      payload: "ciphertext",
      sig: "d".repeat(86),
    });

    expect(() => deserializeOuterEnvelope(flat)).toThrow();
  });
});
