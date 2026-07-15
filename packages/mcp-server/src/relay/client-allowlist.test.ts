import {
  decodeAllowlistBlob,
  encodeAllowlistPush,
  generateKeyPair,
  publicKeyToAgentId,
  verifyAllowlistPush,
} from "@agentpair/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpRelayClient } from "./client.js";

const BASE_URL = "http://relay.test";

describe("HttpRelayClient putAllowlist", () => {
  const keyPair = generateKeyPair();
  const peer = generateKeyPair();
  const agentId = publicKeyToAgentId(keyPair.publicKey);
  const peerId = publicKeyToAgentId(peer.publicKey);
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("putAllowlist sends sign-the-blob {blob, sig} body", async () => {
    const allowed = [peerId];
    const expected = encodeAllowlistPush(agentId, allowed, keyPair.secretKey);
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    globalThis.fetch = async (input, init) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedInit = init;
      return new Response(null, { status: 204 });
    };

    const client = new HttpRelayClient(BASE_URL);
    const result = await client.putAllowlist(agentId, allowed, keyPair.secretKey);

    expect(result).toEqual({ ok: true });
    expect(capturedUrl).toBe(`${BASE_URL}/allowlist/${encodeURIComponent(agentId)}`);
    expect(capturedInit?.method).toBe("PUT");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(capturedInit?.body as string) as { blob: string; sig: string };
    expect(body).toEqual(expected);
    expect(body).not.toHaveProperty("agent_id");
    expect(body).not.toHaveProperty("allowed");
    expect(verifyAllowlistPush(body, keyPair.publicKey)).toBe(true);

    const decoded = decodeAllowlistBlob(body);
    expect(decoded.agent_id).toBe(agentId);
    expect(decoded.allowed).toEqual(allowed);
  });

  it("putAllowlist returns ok: false on non-204", async () => {
    globalThis.fetch = async () => new Response(null, { status: 403 });

    const client = new HttpRelayClient(BASE_URL);
    const result = await client.putAllowlist(agentId, [peerId], keyPair.secretKey);
    expect(result).toEqual({ ok: false });
  });
});
