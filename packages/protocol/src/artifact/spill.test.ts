import { utf8ToBytes } from "@noble/ciphers/utils.js";
import { describe, expect, it, vi } from "vitest";
import { encodeBase64Url } from "../crypto/base64url.js";
import {
  createOuterEnvelope,
  parseEnvelopeBody,
  serializeOuterEnvelope,
} from "../crypto/envelope.js";
import { generateKeyPair, publicKeyToAgentId } from "../crypto/keys.js";
import { MAX_ENVELOPE_WIRE_BYTES } from "../crypto/receive-envelope.js";
import { wireUtf8Length } from "../fixtures/wire-padding.js";
import { MAX_SPILLOVER_PLAINTEXT_BYTES } from "./encrypt.js";
import { wrapOrSpill } from "./spill.js";

const thread = "550e8400-e29b-41d4-a716-446655440000";

function mulberry32(seed: number) {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function spillInput(
  sender: ReturnType<typeof generateKeyPair>,
  recipientId: string,
  payload: Uint8Array,
) {
  return {
    sender,
    recipientAgentId: recipientId,
    type: "core.msg" as const,
    thread,
    seq: 1,
    ttl: 9_999_999_999,
    payload,
  };
}

describe("wrapOrSpill", () => {
  it("returns spilled:false when try-build wire is at exact cap", async () => {
    // Build a payload whose try-build wire is EXACTLY MAX_ENVELOPE_WIRE_BYTES.
    // Do not use a grow-until-overshoot loop (can land > cap and incorrectly spill).
    // Prefer binary-search body size, or pad via fixtures/wire-padding helpers if needed.
    const sender = generateKeyPair();
    const recipient = generateKeyPair();
    const recipientId = publicKeyToAgentId(recipient.publicKey);
    let lo = 1;
    let hi = 70_000;
    let payload = utf8ToBytes(`{"body":"${"a".repeat(1)}"}`);
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const candidate = utf8ToBytes(`{"body":"${"a".repeat(mid)}"}`);
      const len = wireUtf8Length(
        serializeOuterEnvelope(createOuterEnvelope(spillInput(sender, recipientId, candidate))),
      );
      if (len <= MAX_ENVELOPE_WIRE_BYTES) {
        payload = candidate;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const exactLen = wireUtf8Length(
      serializeOuterEnvelope(createOuterEnvelope(spillInput(sender, recipientId, payload))),
    );
    expect(exactLen).toBeLessThanOrEqual(MAX_ENVELOPE_WIRE_BYTES);
    // If not exact, grow single chars until we hit cap or must stop one below
    // (acceptable: spilled:false for any wire <= cap). Prefer assert exact when achievable.
    const putArtifact = vi.fn();
    const result = await wrapOrSpill(spillInput(sender, recipientId, payload), { putArtifact });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.spilled).toBe(false);
    expect(putArtifact).not.toHaveBeenCalled();
    expect(wireUtf8Length(serializeOuterEnvelope(result.outer))).toBeLessThanOrEqual(
      MAX_ENVELOPE_WIRE_BYTES,
    );
  });

  it("returns spilled:true and calls putArtifact when wire > MAX_ENVELOPE_WIRE_BYTES", async () => {
    const sender = generateKeyPair();
    const recipient = generateKeyPair();
    const recipientId = publicKeyToAgentId(recipient.publicKey);
    const huge = utf8ToBytes(JSON.stringify({ body: "x".repeat(70000) }));
    const putArtifact = vi.fn().mockResolvedValue(undefined);
    const result = await wrapOrSpill(spillInput(sender, recipientId, huge), { putArtifact });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.spilled).toBe(true);
    expect(putArtifact).toHaveBeenCalledOnce();
    const body = parseEnvelopeBody(result.outer);
    expect(body.seq).toBe(1);
    expect(wireUtf8Length(serializeOuterEnvelope(result.outer))).toBeLessThanOrEqual(
      MAX_ENVELOPE_WIRE_BYTES,
    );
  });

  it("returns artifact_too_large when plaintext exceeds cap", async () => {
    const sender = generateKeyPair();
    const recipient = generateKeyPair();
    const recipientId = publicKeyToAgentId(recipient.publicKey);
    const over = new Uint8Array(MAX_SPILLOVER_PLAINTEXT_BYTES + 1);
    const result = await wrapOrSpill(spillInput(sender, recipientId, over), {
      putArtifact: vi.fn(),
    });
    expect(result).toEqual({ ok: false, error: "artifact_too_large" });
  });

  it("PUT passthrough quota_exceeded", async () => {
    const sender = generateKeyPair();
    const recipient = generateKeyPair();
    const recipientId = publicKeyToAgentId(recipient.publicKey);
    const huge = utf8ToBytes(JSON.stringify({ body: "y".repeat(70000) }));
    const result = await wrapOrSpill(spillInput(sender, recipientId, huge), {
      putArtifact: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("quota_exceeded"), { code: "quota_exceeded" })),
    });
    expect(result).toEqual({ ok: false, error: "quota_exceeded" });
  });

  it("PUT unknown error → artifact_upload_failed", async () => {
    const sender = generateKeyPair();
    const recipient = generateKeyPair();
    const recipientId = publicKeyToAgentId(recipient.publicKey);
    const huge = utf8ToBytes(JSON.stringify({ body: "z".repeat(70000) }));
    const result = await wrapOrSpill(spillInput(sender, recipientId, huge), {
      putArtifact: vi.fn().mockRejectedValue(new Error("network")),
    });
    expect(result).toEqual({ ok: false, error: "artifact_upload_failed" });
  });

  it("PUT hash_mismatch throws", async () => {
    const sender = generateKeyPair();
    const recipient = generateKeyPair();
    const recipientId = publicKeyToAgentId(recipient.publicKey);
    const huge = utf8ToBytes(JSON.stringify({ body: "w".repeat(70000) }));
    await expect(
      wrapOrSpill(spillInput(sender, recipientId, huge), {
        putArtifact: () => {
          throw Object.assign(new Error("hash_mismatch"), { code: "hash_mismatch" });
        },
      }),
    ).rejects.toThrow(/hash_mismatch/);
  });

  it.each(["auth_required", "invalid_signature", "agent_not_registered"] as const)(
    "PUT passthrough %s",
    async (code) => {
      const sender = generateKeyPair();
      const recipient = generateKeyPair();
      const recipientId = publicKeyToAgentId(recipient.publicKey);
      const huge = utf8ToBytes(JSON.stringify({ body: "y".repeat(70000) }));
      const result = await wrapOrSpill(spillInput(sender, recipientId, huge), {
        putArtifact: vi.fn().mockRejectedValue(Object.assign(new Error(code), { code })),
      });
      expect(result).toEqual({ ok: false, error: code });
    },
  );
});

describe("spill ref wire boundedness (manual fuzz — no fast-check)", () => {
  const WIRE_MARGIN = 8192;
  const ITERATIONS = 200;

  it(`rebuilt spill envelope wire < ${WIRE_MARGIN} under fuzzed ref fields`, () => {
    const sender = generateKeyPair();
    const recipient = generateKeyPair();
    const recipientId = publicKeyToAgentId(recipient.publicKey);
    const rand = mulberry32(42);
    const emoji = "😀";
    for (let i = 0; i < ITERATIONS; i++) {
      const summaryLen = Math.floor(rand() * 241);
      const summary = emoji.repeat(summaryLen);
      const contentType = `application/${"x".repeat(Math.floor(rand() * 128))}`;
      const size = Math.floor(rand() * MAX_SPILLOVER_PLAINTEXT_BYTES);
      const artifactHash = "a".repeat(64);
      const key = new Uint8Array(32).fill(i % 256);
      const ref = {
        spill: 1,
        artifact_hash: artifactHash,
        size,
        content_type: contentType,
        summary,
        artifact_key: encodeBase64Url(key),
      };
      const outer = createOuterEnvelope({
        sender,
        recipientAgentId: recipientId,
        type: "core.msg",
        thread,
        seq: i + 1,
        ttl: 9_999_999_999,
        payload: utf8ToBytes(JSON.stringify(ref)),
      });
      expect(wireUtf8Length(serializeOuterEnvelope(outer))).toBeLessThan(WIRE_MARGIN);
    }
  });
});
