import { createHash } from "node:crypto";
import { encodeAllowlistPush, generateKeyPair, publicKeyToAgentId } from "@agentpair/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRelayApp } from "../server.js";
import { signChallenge } from "./allowlist.js";

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function signedAllowlist(owner: ReturnType<typeof generateKeyPair>, allowed: string[] = []) {
  const agentId = publicKeyToAgentId(owner.publicKey);
  return encodeAllowlistPush(agentId, allowed, owner.secretKey);
}

function artifactAuthHeaders(
  owner: ReturnType<typeof generateKeyPair>,
  hash: string,
): Record<string, string> {
  const agentId = publicKeyToAgentId(owner.publicKey);
  return {
    "x-agent-id": agentId,
    "x-artifact-sig": signChallenge(hash, owner.secretKey),
  };
}

async function registerAgent(
  app: ReturnType<typeof createRelayApp>["app"],
  owner: ReturnType<typeof generateKeyPair>,
): Promise<string> {
  const agentId = publicKeyToAgentId(owner.publicKey);
  const body = signedAllowlist(owner);
  const res = await app.request(`/allowlist/${agentId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(204);
  return agentId;
}

async function putArtifact(
  app: ReturnType<typeof createRelayApp>["app"],
  owner: ReturnType<typeof generateKeyPair>,
  blob: Uint8Array,
  headers: Record<string, string> = {},
) {
  const hash = sha256Hex(blob);
  const res = await app.request(`/artifact/${hash}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/octet-stream",
      ...artifactAuthHeaders(owner, hash),
      ...headers,
    },
    body: blob,
  });
  return { res, hash };
}

describe("artifact relay routes", () => {
  const owner = generateKeyPair();
  const stranger = generateKeyPair();

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("stores an authenticated artifact and returns it on GET", async () => {
    const { app } = createRelayApp();
    await registerAgent(app, owner);
    const blob = utf8Blob("artifact-payload-v1");

    const { res, hash } = await putArtifact(app, owner, blob);
    expect(res.status).toBe(204);

    const getRes = await app.request(`/artifact/${hash}`);
    expect(getRes.status).toBe(200);
    expect(new Uint8Array(await getRes.arrayBuffer())).toEqual(blob);
  });

  it("rejects anonymous PUT when auth is required", async () => {
    const { app } = createRelayApp();
    const blob = utf8Blob("anonymous");
    const hash = sha256Hex(blob);

    const res = await app.request(`/artifact/${hash}`, {
      method: "PUT",
      body: blob,
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("auth_required");

    const getRes = await app.request(`/artifact/${hash}`);
    expect(getRes.status).toBe(404);
  });

  it("rejects forged signatures", async () => {
    const { app } = createRelayApp();
    await registerAgent(app, owner);
    const blob = utf8Blob("forged");
    const hash = sha256Hex(blob);
    const forgedSig = signChallenge(hash, stranger.secretKey);

    const res = await app.request(`/artifact/${hash}`, {
      method: "PUT",
      headers: {
        "x-agent-id": publicKeyToAgentId(owner.publicKey),
        "x-artifact-sig": forgedSig,
      },
      body: blob,
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_signature");
  });

  it("rejects uploads from unregistered agents", async () => {
    const { app } = createRelayApp();
    const blob = utf8Blob("unregistered");
    const hash = sha256Hex(blob);

    const res = await app.request(`/artifact/${hash}`, {
      method: "PUT",
      headers: artifactAuthHeaders(stranger, hash),
      body: blob,
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("agent_not_registered");
  });

  it("returns hash_mismatch before auth side effects", async () => {
    const { app } = createRelayApp();
    await registerAgent(app, owner);
    const blob = utf8Blob("mismatch");
    const wrongHash = "0".repeat(64);

    const res = await app.request(`/artifact/${wrongHash}`, {
      method: "PUT",
      headers: artifactAuthHeaders(owner, wrongHash),
      body: blob,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("hash_mismatch");
  });

  it("enforces per-agent quota and frees space after retention GC", async () => {
    vi.stubEnv("AGENTPAIR_ARTIFACT_QUOTA_BYTES", "1000");
    vi.stubEnv("AGENTPAIR_ARTIFACT_RETENTION_MS", String(24 * 60 * 60 * 1000));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const { app } = createRelayApp();
    await registerAgent(app, owner);

    const first = await putArtifact(app, owner, utf8Blob("x".repeat(800)));
    expect(first.res.status).toBe(204);

    const overQuota = await putArtifact(app, owner, utf8Blob("y".repeat(300)));
    expect(overQuota.res.status).toBe(413);
    const quotaBody = (await overQuota.res.json()) as { error: string };
    expect(quotaBody.error).toBe("quota_exceeded");

    vi.setSystemTime(new Date("2026-02-01T00:00:00.000Z"));

    const afterGc = await putArtifact(app, owner, utf8Blob("z".repeat(300)));
    expect(afterGc.res.status).toBe(204);

    const oldGet = await app.request(`/artifact/${first.hash}`);
    expect(oldGet.status).toBe(404);
  });

  it("does not double-count quota for idempotent re-PUT of the same hash", async () => {
    vi.stubEnv("AGENTPAIR_ARTIFACT_QUOTA_BYTES", "1000");

    const { app } = createRelayApp();
    await registerAgent(app, owner);
    const blob = utf8Blob("x".repeat(900));

    const first = await putArtifact(app, owner, blob);
    expect(first.res.status).toBe(204);

    const second = await putArtifact(app, owner, blob);
    expect(second.res.status).toBe(204);
    expect(second.hash).toBe(first.hash);
  });

  it("allows anonymous uploads when auth is off", async () => {
    vi.stubEnv("AGENTPAIR_ARTIFACT_AUTH", "off");

    const { app } = createRelayApp();
    const blob = utf8Blob("legacy-client");
    const hash = sha256Hex(blob);

    const res = await app.request(`/artifact/${hash}`, {
      method: "PUT",
      body: blob,
    });
    expect(res.status).toBe(204);

    const getRes = await app.request(`/artifact/${hash}`);
    expect(getRes.status).toBe(200);
    expect(new Uint8Array(await getRes.arrayBuffer())).toEqual(blob);
  });

  it("rejects artifact sig with padding (YQ== loose-valid)", async () => {
    const { app } = createRelayApp();
    await registerAgent(app, owner);
    const blob = utf8Blob("padded-sig");
    const hash = sha256Hex(blob);

    const res = await app.request(`/artifact/${hash}`, {
      method: "PUT",
      headers: {
        "x-agent-id": publicKeyToAgentId(owner.publicKey),
        "x-artifact-sig": "YQ==",
      },
      body: blob,
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_signature");
  });

  it("rejects artifact sig with non-canonical encoding (_8 loose-valid)", async () => {
    const { app } = createRelayApp();
    await registerAgent(app, owner);
    const blob = utf8Blob("non-canonical-sig");
    const hash = sha256Hex(blob);

    const res = await app.request(`/artifact/${hash}`, {
      method: "PUT",
      headers: {
        "x-agent-id": publicKeyToAgentId(owner.publicKey),
        "x-artifact-sig": "_8",
      },
      body: blob,
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_signature");
  });

  it("accepts exactly 10 MiB artifact PUT with auth", async () => {
    const { app } = createRelayApp();
    await registerAgent(app, owner);
    const blob = new Uint8Array(10 * 1024 * 1024);
    blob.fill(0xab);

    const { res } = await putArtifact(app, owner, blob);
    expect(res.status).toBe(204);
  });

  it("rejects artifact sig with padded canonical encoding (loose-valid)", async () => {
    const { app } = createRelayApp();
    await registerAgent(app, owner);
    const blob = utf8Blob("padded-canonical-sig");
    const hash = sha256Hex(blob);
    const canonical = signChallenge(hash, owner.secretKey);

    const res = await app.request(`/artifact/${hash}`, {
      method: "PUT",
      headers: {
        "x-agent-id": publicKeyToAgentId(owner.publicKey),
        "x-artifact-sig": `${canonical}==`,
      },
      body: blob,
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_signature");
  });
});

function utf8Blob(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("card cut + allowlist-only registration", () => {
  const owner = generateKeyPair();
  const ownerId = publicKeyToAgentId(owner.publicKey);

  it("returns 404 for GET /card/{agent_id}", async () => {
    const { app } = createRelayApp();
    const res = await app.request(`/card/${ownerId}`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for PUT /card/{agent_id}", async () => {
    const { app } = createRelayApp();
    const res = await app.request(`/card/${ownerId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: ownerId, name: "card-only" }),
    });
    expect(res.status).toBe(404);
  });

  it("registers agent via signed allowlist push with allowed: []", async () => {
    const { app } = createRelayApp();
    const body = encodeAllowlistPush(ownerId, [], owner.secretKey);

    const allowlistRes = await app.request(`/allowlist/${ownerId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(allowlistRes.status).toBe(204);

    const blob = utf8Blob("allowlist-registered");
    const hash = sha256Hex(blob);
    const artifactRes = await app.request(`/artifact/${hash}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        ...artifactAuthHeaders(owner, hash),
      },
      body: blob,
    });
    expect(artifactRes.status).toBe(204);
  });

  it("returns 403 agent_not_registered when no allowlist row exists", async () => {
    const { app } = createRelayApp();
    const blob = utf8Blob("unregistered");
    const hash = sha256Hex(blob);

    const res = await app.request(`/artifact/${hash}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        ...artifactAuthHeaders(owner, hash),
      },
      body: blob,
    });
    expect(res.status).toBe(403);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe("agent_not_registered");
  });

  it("rejects re-PUT of existing hash without valid auth (not 204 idempotent success)", async () => {
    const { app } = createRelayApp();
    const body = encodeAllowlistPush(ownerId, [], owner.secretKey);
    await app.request(`/allowlist/${ownerId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const blob = utf8Blob("already-stored");
    const hash = sha256Hex(blob);
    const first = await app.request(`/artifact/${hash}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        ...artifactAuthHeaders(owner, hash),
      },
      body: blob,
    });
    expect(first.status).toBe(204);

    const replay = await app.request(`/artifact/${hash}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: blob,
    });
    expect(replay.status).toBe(401);
    const payload = (await replay.json()) as { error: string };
    expect(payload.error).toBe("auth_required");
  });
});
