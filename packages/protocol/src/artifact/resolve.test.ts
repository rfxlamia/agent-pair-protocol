import { utf8ToBytes } from "@noble/ciphers/utils.js";
import { describe, expect, it, vi } from "vitest";
import { encodeBase64Url } from "../crypto/base64url.js";
import { MAX_SPILLOVER_PLAINTEXT_BYTES, encryptArtifact } from "./encrypt.js";
import { resolveSpillover } from "./resolve.js";

const artifactKey = new Uint8Array(32).fill(9);
const artifactKeyB64 = encodeBase64Url(artifactKey);

function spillRefBytes(overrides: Record<string, unknown> = {}): Uint8Array {
  const ref = {
    spill: 1,
    artifact_hash: "a".repeat(64),
    size: 5,
    content_type: "application/json",
    summary: "hello",
    artifact_key: artifactKeyB64,
    ...overrides,
  };
  return utf8ToBytes(JSON.stringify(ref));
}

describe("resolveSpillover", () => {
  it("returns original plaintext on happy path", async () => {
    const plaintext = utf8ToBytes('{"body":"spilled"}');
    const { blob, hash } = encryptArtifact(plaintext, artifactKey);
    const getArtifact = vi.fn().mockResolvedValue(blob);
    const result = await resolveSpillover(
      spillRefBytes({ artifact_hash: hash, size: plaintext.length }),
      { getArtifact },
    );
    expect(result).toEqual(plaintext);
    expect(getArtifact).toHaveBeenCalledWith(hash, plaintext.length);
  });

  it("passthrough: returns original bytes when spill key absent", async () => {
    const p = utf8ToBytes('{"body":"ok"}');
    const getArtifact = vi.fn();
    expect(await resolveSpillover(p, { getArtifact })).toEqual(p);
    expect(getArtifact).not.toHaveBeenCalled();
  });

  it("passthrough: returns original bytes for non-JSON plaintext", async () => {
    const p = new Uint8Array([0xff, 0x00, 1, 2, 3]);
    const getArtifact = vi.fn();
    expect(await resolveSpillover(p, { getArtifact })).toEqual(p);
    expect(getArtifact).not.toHaveBeenCalled();
  });

  it("returns artifact_decrypt_failed when fetched blob hash mismatches artifact_hash", async () => {
    const plaintext = utf8ToBytes("hello");
    const { blob } = encryptArtifact(plaintext, artifactKey);
    const getArtifact = vi.fn().mockResolvedValue(blob);
    const result = await resolveSpillover(
      spillRefBytes({
        artifact_hash: "b".repeat(64),
        size: plaintext.length,
      }),
      { getArtifact },
    );
    expect(result).toEqual({ error: "artifact_decrypt_failed" });
  });

  it("returns artifact_too_large before GET when size > cap", async () => {
    const getArtifact = vi.fn();
    const result = await resolveSpillover(
      spillRefBytes({ size: MAX_SPILLOVER_PLAINTEXT_BYTES + 1 }),
      { getArtifact },
    );
    expect(result).toEqual({ error: "artifact_too_large" });
    expect(getArtifact).not.toHaveBeenCalled();
  });

  it("returns invalid_payload when spill !== 1", async () => {
    const result = await resolveSpillover(spillRefBytes({ spill: 2 }), {
      getArtifact: vi.fn(),
    });
    expect(result).toEqual({ error: "invalid_payload" });
  });

  it("returns invalid_payload on strict schema failure", async () => {
    const bad = utf8ToBytes(JSON.stringify({ spill: 1, artifact_hash: "short", size: 0 }));
    const result = await resolveSpillover(bad, { getArtifact: vi.fn() });
    expect(result).toEqual({ error: "invalid_payload" });
  });

  it("returns artifact_not_found when getArtifact throws artifact_not_found", async () => {
    const getArtifact = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("artifact_not_found"), { code: "artifact_not_found" }),
      );
    const result = await resolveSpillover(spillRefBytes(), { getArtifact });
    expect(result).toEqual({ error: "artifact_not_found" });
  });

  it("returns artifact_fetch_failed when getArtifact throws artifact_fetch_failed", async () => {
    const getArtifact = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("artifact_fetch_failed"), { code: "artifact_fetch_failed" }),
      );
    const result = await resolveSpillover(spillRefBytes(), { getArtifact });
    expect(result).toEqual({ error: "artifact_fetch_failed" });
  });

  it("returns artifact_decrypt_failed when blob length !== size + 40", async () => {
    const plaintext = utf8ToBytes("hello");
    const { blob, hash } = encryptArtifact(plaintext, artifactKey);
    const getArtifact = vi.fn().mockResolvedValue(blob.subarray(0, blob.length - 1));
    const result = await resolveSpillover(
      spillRefBytes({ artifact_hash: hash, size: plaintext.length }),
      { getArtifact },
    );
    expect(result).toEqual({ error: "artifact_decrypt_failed" });
  });

  it("returns artifact_decrypt_failed when decrypt fails", async () => {
    const plaintext = utf8ToBytes("hello");
    const { blob, hash } = encryptArtifact(plaintext, artifactKey);
    const tampered = new Uint8Array(blob);
    tampered[tampered.length - 1] ^= 0xff;
    const getArtifact = vi.fn().mockResolvedValue(tampered);
    const result = await resolveSpillover(
      spillRefBytes({ artifact_hash: hash, size: plaintext.length }),
      { getArtifact },
    );
    expect(result).toEqual({ error: "artifact_decrypt_failed" });
  });
});
