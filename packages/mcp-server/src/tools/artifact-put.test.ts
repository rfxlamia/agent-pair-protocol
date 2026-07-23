import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashArtifactBlob } from "@agentpair/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKeyStore } from "../store/keys.js";
import { handleArtifactPut } from "./artifact-put.js";
import { createAgentContext } from "./pair.js";

function structured<T>(result: { structuredContent: T }): T {
  return result.structuredContent;
}

describe("artifact_put", () => {
  const tempDirs: string[] = [];
  const putArtifact = vi.fn(async () => undefined);

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    putArtifact.mockClear();
  });

  async function makeCtx() {
    const dir = await mkdtemp(join(tmpdir(), "agentpair-artifact-put-"));
    tempDirs.push(dir);
    return createAgentContext({
      keyStore: createKeyStore({ keyPath: join(dir, "keys.json") }),
      relay: { putArtifact } as never,
    });
  }

  it("rejects empty content with invalid_payload", async () => {
    const ctx = await makeCtx();
    const result = structured(await handleArtifactPut(ctx, { content: "" }));
    expect(result).toEqual({ ok: false, error: "invalid_payload" });
    expect(putArtifact).not.toHaveBeenCalled();
  });

  it("rejects oversized content with artifact_too_large", async () => {
    const ctx = await makeCtx();
    const content = "x".repeat(10 * 1024 * 1024 + 1);
    const result = structured(await handleArtifactPut(ctx, { content }));
    expect(result).toEqual({ ok: false, error: "artifact_too_large" });
    expect(putArtifact).not.toHaveBeenCalled();
  });

  it("uploads UTF-8 bytes and returns hashArtifactBlob hex", async () => {
    const ctx = await makeCtx();
    const content = JSON.stringify({ type: "object", title: "café" });
    const blob = new TextEncoder().encode(content);
    const expectedHash = hashArtifactBlob(blob);

    const result = structured(await handleArtifactPut(ctx, { content }));

    expect(result).toEqual({ ok: true, artifact_hash: expectedHash, size: blob.byteLength });
    expect(putArtifact).toHaveBeenCalledTimes(1);
    const [hash, uploaded, agentId, secretKey] = putArtifact.mock.calls[0] as [
      string,
      Uint8Array,
      string,
      Uint8Array,
    ];
    expect(hash).toBe(expectedHash);
    expect(Buffer.from(uploaded)).toEqual(Buffer.from(blob));
    expect(agentId).toMatch(/^ed25519:/);
    expect(secretKey).toBeInstanceOf(Uint8Array);
  });

  it("passthrough relay quota_exceeded", async () => {
    putArtifact.mockRejectedValueOnce(
      Object.assign(new Error("quota"), { code: "quota_exceeded" }),
    );
    const ctx = await makeCtx();
    const result = structured(await handleArtifactPut(ctx, { content: "{}" }));
    expect(result).toEqual({ ok: false, error: "quota_exceeded" });
  });

  it("maps unknown relay failures to artifact_upload_failed", async () => {
    putArtifact.mockRejectedValueOnce(new Error("network"));
    const ctx = await makeCtx();
    const result = structured(await handleArtifactPut(ctx, { content: "{}" }));
    expect(result).toEqual({ ok: false, error: "artifact_upload_failed" });
  });
});
