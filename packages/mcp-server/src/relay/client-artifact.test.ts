import {
  MAX_SPILLOVER_PLAINTEXT_BYTES,
  generateKeyPair,
  publicKeyToAgentId,
  sign,
} from "@agentpair/protocol";
import { utf8ToBytes } from "@noble/ciphers/utils.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpRelayClient } from "./client.js";

const BASE_URL = "http://relay.test";

function signArtifactHash(hash: string, secretKey: Uint8Array): string {
  const signature = sign(utf8ToBytes(hash), secretKey);
  return Buffer.from(signature).toString("base64url");
}

describe("HttpRelayClient artifact", () => {
  const keyPair = generateKeyPair();
  const agentId = publicKeyToAgentId(keyPair.publicKey);
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("putArtifact sends PUT with x-agent-id and x-artifact-sig", async () => {
    const hash = "abc123deadbeef";
    const blob = new Uint8Array([1, 2, 3]);
    const expectedSig = signArtifactHash(hash, keyPair.secretKey);
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    globalThis.fetch = async (input, init) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedInit = init;
      return new Response(null, { status: 204 });
    };

    const client = new HttpRelayClient(BASE_URL);
    await client.putArtifact(hash, blob, agentId, keyPair.secretKey);

    expect(capturedUrl).toBe(`${BASE_URL}/artifact/${hash}`);
    expect(capturedInit?.method).toBe("PUT");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["x-agent-id"]).toBe(agentId);
    expect(headers["x-artifact-sig"]).toBe(expectedSig);
    expect(headers["Content-Type"]).toBe("application/octet-stream");
  });

  it("putArtifact passthrough quota_exceeded", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "quota_exceeded" }), { status: 413 });

    const client = new HttpRelayClient(BASE_URL);
    await expect(
      client.putArtifact("hash", new Uint8Array([1]), agentId, keyPair.secretKey),
    ).rejects.toMatchObject({ message: "quota_exceeded", code: "quota_exceeded" });
  });

  it("putArtifact hash_mismatch throws", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "hash_mismatch" }), { status: 400 });

    const client = new HttpRelayClient(BASE_URL);
    await expect(
      client.putArtifact("hash", new Uint8Array([1]), agentId, keyPair.secretKey),
    ).rejects.toThrow("hash_mismatch");

    try {
      await client.putArtifact("hash", new Uint8Array([1]), agentId, keyPair.secretKey);
      expect.fail("expected hash_mismatch throw");
    } catch (error) {
      expect((error as Error & { code?: string }).code).toBeUndefined();
    }
  });

  it("getArtifact artifact_not_found on 404", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "artifact_not_found" }), { status: 404 });

    const client = new HttpRelayClient(BASE_URL);
    await expect(client.getArtifact("missing", 100)).rejects.toMatchObject({
      message: "artifact_not_found",
      code: "artifact_not_found",
    });
  });

  it("getArtifact artifact_fetch_failed on 503", async () => {
    globalThis.fetch = async () => new Response(null, { status: 503 });

    const client = new HttpRelayClient(BASE_URL);
    await expect(client.getArtifact("hash", 100)).rejects.toMatchObject({
      message: "artifact_fetch_failed",
      code: "artifact_fetch_failed",
    });
  });

  it("getArtifact artifact_decrypt_failed when body exceeds read limit", async () => {
    const size = 100;
    const readLimit = Math.min(size + 40, MAX_SPILLOVER_PLAINTEXT_BYTES + 40);
    const oversized = new Uint8Array(readLimit + 1).fill(0xff);

    globalThis.fetch = async () => new Response(oversized, { status: 200 });

    const client = new HttpRelayClient(BASE_URL);
    await expect(client.getArtifact("hash", size)).rejects.toMatchObject({
      message: "artifact_decrypt_failed",
      code: "artifact_decrypt_failed",
    });
  });

  it.each(["auth_required", "invalid_signature", "agent_not_registered"] as const)(
    "putArtifact passthrough %s",
    async (errorCode) => {
      const status = errorCode === "auth_required" ? 401 : 403;
      globalThis.fetch = async () => new Response(JSON.stringify({ error: errorCode }), { status });

      const client = new HttpRelayClient(BASE_URL);
      await expect(
        client.putArtifact("hash", new Uint8Array([1]), agentId, keyPair.secretKey),
      ).rejects.toMatchObject({ message: errorCode, code: errorCode });
    },
  );

  it("putArtifact unknown body maps to artifact_upload_failed", async () => {
    globalThis.fetch = async () => new Response("not json", { status: 400 });

    const client = new HttpRelayClient(BASE_URL);
    await expect(
      client.putArtifact("hash", new Uint8Array([1]), agentId, keyPair.secretKey),
    ).rejects.toMatchObject({
      message: "artifact_upload_failed",
      code: "artifact_upload_failed",
    });
  });
});
