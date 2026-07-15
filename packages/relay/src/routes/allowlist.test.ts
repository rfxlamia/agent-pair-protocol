import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeBase64UrlStrict,
  encodeAllowlistPush,
  generateKeyPair,
  publicKeyToAgentId,
} from "@agentpair/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createRelayApp } from "../server.js";
import { isSenderAllowed, signChallenge } from "./allowlist.js";

/** Legacy pre-cutover wire — must be rejected after T2. */
function legacyAllowlistBody(
  owner: ReturnType<typeof generateKeyPair>,
  allowed: string[],
): { agent_id: string; allowed: string[]; sig: string } {
  const agentId = publicKeyToAgentId(owner.publicKey);
  const ordered = { agent_id: agentId, allowed: [...allowed].sort() };
  return {
    agent_id: agentId,
    allowed,
    sig: signChallenge(JSON.stringify(ordered), owner.secretKey),
  };
}

describe("allowlist relay routes — sign-the-blob cutover", () => {
  const owner = generateKeyPair();
  const peer = generateKeyPair();
  const stranger = generateKeyPair();
  const ownerId = publicKeyToAgentId(owner.publicKey);
  const peerId = publicKeyToAgentId(peer.publicKey);
  const strangerId = publicKeyToAgentId(stranger.publicKey);
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("accepts valid sign-the-blob push and persists allowlist", async () => {
    const { app, db } = createRelayApp();
    const body = encodeAllowlistPush(ownerId, [peerId], owner.secretKey);

    const res = await app.request(`/allowlist/${ownerId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(204);
    expect(isSenderAllowed(db, ownerId, peerId)).toBe(true);
    expect(isSenderAllowed(db, ownerId, strangerId)).toBe(false);
  });

  it("accepts unsorted allowed array inside signed blob", async () => {
    const { app, db } = createRelayApp();
    const body = encodeAllowlistPush(ownerId, [strangerId, peerId], owner.secretKey);

    const res = await app.request(`/allowlist/${ownerId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(204);
    expect(isSenderAllowed(db, ownerId, peerId)).toBe(true);
    expect(isSenderAllowed(db, ownerId, strangerId)).toBe(true);
  });

  it("rejects legacy JSON allowlist body with invalid_allowlist", async () => {
    const { app } = createRelayApp();
    const legacy = legacyAllowlistBody(owner, [peerId]);

    const res = await app.request(`/allowlist/${ownerId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(legacy),
    });
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe("invalid_allowlist");
  });

  it("rejects tampered blob bytes with invalid_signature", async () => {
    const { app } = createRelayApp();
    const body = encodeAllowlistPush(ownerId, [peerId], owner.secretKey);
    const blobBytes = decodeBase64UrlStrict(body.blob);
    blobBytes[0] ^= 0xff;
    const tampered = { ...body, blob: Buffer.from(blobBytes).toString("base64url") };

    const res = await app.request(`/allowlist/${ownerId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tampered),
    });
    expect(res.status).toBe(403);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe("invalid_signature");
  });

  it("truncates allowlists on first open after cutover (shared file DB — not two :memory: apps)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentpair-allowlist-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "relay.sqlite");

    const seed = createRelayApp({ dbPath });
    seed.db
      .prepare("INSERT INTO allowlists (agent_id, allowed_json, updated_at) VALUES (?, ?, ?)")
      .run(ownerId, JSON.stringify([peerId]), Date.now());
    try {
      seed.db.prepare("DELETE FROM relay_meta WHERE key = 'allowlist_wire_version'").run();
    } catch {
      // table may not exist until T2 implements it
    }
    seed.db.close();

    const reopened = createRelayApp({ dbPath });
    expect(isSenderAllowed(reopened.db, ownerId, peerId)).toBe(false);

    const body = encodeAllowlistPush(ownerId, [peerId], owner.secretKey);
    const res = await reopened.app.request(`/allowlist/${ownerId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(204);
    expect(isSenderAllowed(reopened.db, ownerId, peerId)).toBe(true);
    reopened.db.close();

    const third = createRelayApp({ dbPath });
    expect(isSenderAllowed(third.db, ownerId, peerId)).toBe(true);
    third.db.close();
  });

  it("rejects allowlist signed by a different keypair", async () => {
    const { app } = createRelayApp();
    const body = encodeAllowlistPush(ownerId, [peerId], owner.secretKey);
    const forged = encodeAllowlistPush(strangerId, [peerId], stranger.secretKey);
    body.sig = forged.sig;

    const res = await app.request(`/allowlist/${ownerId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(403);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe("invalid_signature");
  });

  it("rejects malformed JSON", async () => {
    const { app } = createRelayApp();
    const res = await app.request(`/allowlist/${ownerId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    });
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe("invalid_json");
  });

  it("rejects agent_id mismatch after signature verifies", async () => {
    // Blob agent_id is ownerId but signed with peer key; path is peerId → verify ok, schema mismatch.
    const { app } = createRelayApp();
    const body = encodeAllowlistPush(ownerId, [peerId], peer.secretKey);

    const res = await app.request(`/allowlist/${peerId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe("agent_id_mismatch");
  });

  it("rejects null JSON body with invalid_allowlist (not 500)", async () => {
    const { app } = createRelayApp();
    const res = await app.request(`/allowlist/${ownerId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "null",
    });
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe("invalid_allowlist");
  });

  it("rejects invalid allowlist shape", async () => {
    const { app } = createRelayApp();
    const res = await app.request(`/allowlist/${ownerId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blob: "not-valid", sig: "also-not" }),
    });
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe("invalid_allowlist");
  });

  it("rejects allowlist sig with padding (YQ== loose-valid)", async () => {
    const { app } = createRelayApp();
    const body = encodeAllowlistPush(ownerId, [peerId], owner.secretKey);
    body.sig = "YQ==";

    const res = await app.request(`/allowlist/${ownerId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(403);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe("invalid_signature");
  });

  it("rejects allowlist sig with non-canonical encoding (_8 loose-valid)", async () => {
    const { app } = createRelayApp();
    const body = encodeAllowlistPush(ownerId, [peerId], owner.secretKey);
    body.sig = "_8";

    const res = await app.request(`/allowlist/${ownerId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(403);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe("invalid_signature");
  });

  it("rejects allowlist sig with padded canonical encoding (loose-valid)", async () => {
    const { app } = createRelayApp();
    const body = encodeAllowlistPush(ownerId, [peerId], owner.secretKey);
    body.sig = `${body.sig}==`;

    const res = await app.request(`/allowlist/${ownerId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(403);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe("invalid_signature");
  });
});
