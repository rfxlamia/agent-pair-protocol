import { generateKeyPair, publicKeyToAgentId } from "@agentpair/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpRelayClient } from "./client.js";
import * as preflight from "./preflight.js";

const BASE_URL = "http://relay-guards.test";

describe("HttpRelayClient ensurePreflight guards", () => {
  const keyPair = generateKeyPair();
  const agentId = publicKeyToAgentId(keyPair.publicKey);
  let ensureSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    ensureSpy = vi.spyOn(preflight, "ensurePreflight").mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    ensureSpy.mockRestore();
  });

  it.each([
    ["putAllowlist", (c: HttpRelayClient) => c.putAllowlist(agentId, [], keyPair.secretKey)],
    ["sendEnvelope", (c: HttpRelayClient) => c.sendEnvelope(agentId, {} as never)],
    ["pullInbox", (c: HttpRelayClient) => c.pullInbox(keyPair)],
    ["postPakeMessage", (c: HttpRelayClient) => c.postPakeMessage("sess", "{}")],
    ["pollPakeMessage", (c: HttpRelayClient) => c.pollPakeMessage("sess")],
    [
      "putArtifact",
      (c: HttpRelayClient) => c.putArtifact("h", new Uint8Array([1]), agentId, keyPair.secretKey),
    ],
    ["getArtifact", (c: HttpRelayClient) => c.getArtifact("h", 1)],
    ["purgeInboxDyad", (c: HttpRelayClient) => c.purgeInboxDyad("peer", keyPair)],
  ] as const)("calls ensurePreflight before %s", async (_name, invoke) => {
    const client = new HttpRelayClient(BASE_URL);
    await invoke(client).catch(() => undefined); // wire body may be invalid; guard must still run first
    expect(ensureSpy).toHaveBeenCalledWith(BASE_URL);
    expect(ensureSpy.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(fetch).mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });
});
