import { describe, expect, it } from "vitest";
import { decodeBase64UrlStrict } from "../crypto/base64url.js";
import { generateKeyPair, publicKeyToAgentId } from "../crypto/keys.js";
import { verify } from "../crypto/sign.js";
import {
  decodeAllowlistBlob,
  encodeAllowlistPush,
  sortAllowed,
  verifyAllowlistPush,
} from "./encode.js";
import { ALLOWLIST_MAX_ALLOWED, validateAllowlistSchema } from "./schema.js";

describe("allowlist sign-the-blob encode", () => {
  const owner = generateKeyPair();
  const peer = generateKeyPair();
  const ownerId = publicKeyToAgentId(owner.publicKey);
  const peerId = publicKeyToAgentId(peer.publicKey);

  it("encodeAllowlistPush produces {blob, sig} that verifies with verifyAllowlistPush", () => {
    const push = encodeAllowlistPush(ownerId, [peerId], owner.secretKey);

    expect(push).toEqual(
      expect.objectContaining({
        blob: expect.any(String),
        sig: expect.any(String),
      }),
    );
    expect(verifyAllowlistPush(push, owner.publicKey)).toBe(true);

    const decoded = decodeAllowlistBlob(push);
    expect(decoded.agent_id).toBe(ownerId);
    expect(decoded.allowed).toEqual([peerId]);
  });

  it("accepts unsorted allowed array in schema validation", () => {
    const push = encodeAllowlistPush(ownerId, [peerId], owner.secretKey);
    const decoded = decodeAllowlistBlob(push);
    decoded.allowed = [peerId, ownerId]; // host order preserved, not sorted

    expect(validateAllowlistSchema(decoded, ownerId)).toEqual({ ok: true });
  });

  it("rejects agent_id mismatch between blob and path", () => {
    const push = encodeAllowlistPush(ownerId, [peerId], owner.secretKey);
    const decoded = decodeAllowlistBlob(push);

    expect(validateAllowlistSchema(decoded, peerId)).toEqual({
      ok: false,
      error: "agent_id_mismatch",
    });
  });

  it("rejects duplicate entries in allowed", () => {
    expect(
      validateAllowlistSchema({ agent_id: ownerId, allowed: [peerId, peerId] }, ownerId),
    ).toEqual({ ok: false, error: "duplicate_allowed" });
  });

  it("rejects invalid agent_id strings in allowed", () => {
    expect(
      validateAllowlistSchema({ agent_id: ownerId, allowed: ["not-a-valid-agent-id"] }, ownerId),
    ).toEqual({ ok: false, error: "invalid_agent_id" });
  });

  it("rejects allowed count over cap", () => {
    const tooMany = Array.from({ length: ALLOWLIST_MAX_ALLOWED + 1 }, (_, i) =>
      publicKeyToAgentId(generateKeyPair().publicKey),
    );
    expect(validateAllowlistSchema({ agent_id: ownerId, allowed: tooMany }, ownerId)).toEqual({
      ok: false,
      error: "allowlist_too_large",
    });
  });

  it("rejects tampered blob bytes (sig no longer matches blob)", () => {
    const push = encodeAllowlistPush(ownerId, [peerId], owner.secretKey);
    const blobBytes = decodeBase64UrlStrict(push.blob);
    blobBytes[0] ^= 0xff;
    const tampered = { ...push, blob: Buffer.from(blobBytes).toString("base64url") };

    expect(verifyAllowlistPush(tampered, owner.publicKey)).toBe(false);
    const sigBytes = decodeBase64UrlStrict(tampered.sig);
    expect(verify(sigBytes, blobBytes, owner.publicKey)).toBe(false);
  });

  it("exports ALLOWLIST_MAX_ALLOWED = 1024", () => {
    expect(ALLOWLIST_MAX_ALLOWED).toBe(1024);
  });

  it("sortAllowed is stable and does not mutate input (host SHOULD sort)", () => {
    const input = [peerId, ownerId];
    const sorted = sortAllowed(input);
    expect(sorted).toEqual([...input].sort());
    expect(input).toEqual([peerId, ownerId]);
  });
});
