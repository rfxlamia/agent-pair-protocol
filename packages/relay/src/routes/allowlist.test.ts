import { generateKeyPair, publicKeyToAgentId } from "@agentpair/protocol";
import { describe, expect, it } from "vitest";
import { createRelayApp } from "../server.js";
import { type AllowlistBody, isSenderAllowed, signChallenge } from "./allowlist.js";

function signedAllowlist(
  owner: ReturnType<typeof generateKeyPair>,
  allowed: string[],
): AllowlistBody {
  const agentId = publicKeyToAgentId(owner.publicKey);
  const ordered = { agent_id: agentId, allowed: [...allowed].sort() };
  const sig = signChallenge(JSON.stringify(ordered), owner.secretKey);
  return { agent_id: agentId, allowed, sig };
}

describe("allowlist relay routes", () => {
  const owner = generateKeyPair();
  const peer = generateKeyPair();
  const stranger = generateKeyPair();
  const ownerId = publicKeyToAgentId(owner.publicKey);
  const peerId = publicKeyToAgentId(peer.publicKey);
  const strangerId = publicKeyToAgentId(stranger.publicKey);

  it("accepts a valid signature and persists the allowlist", async () => {
    const { app, db } = createRelayApp();
    const body = signedAllowlist(owner, [peerId]);

    const res = await app.request(`/allowlist/${ownerId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(204);

    expect(isSenderAllowed(db, ownerId, peerId)).toBe(true);
    expect(isSenderAllowed(db, ownerId, strangerId)).toBe(false);
  });

  it("rejects allowlist signed by a different keypair", async () => {
    const { app } = createRelayApp();
    const body = signedAllowlist(owner, [peerId]);
    const forged = signedAllowlist(stranger, [peerId]);
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

  it("rejects agent_id mismatch between body and URL", async () => {
    const { app } = createRelayApp();
    const body = signedAllowlist(owner, [peerId]);

    const res = await app.request(`/allowlist/${peerId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe("agent_id_mismatch");
  });

  it("rejects invalid allowlist shape", async () => {
    const { app } = createRelayApp();
    const body = signedAllowlist(owner, [peerId]);
    const invalid = { ...body, allowed: "not-an-array" as unknown as string[] };

    const res = await app.request(`/allowlist/${ownerId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(invalid),
    });
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe("invalid_allowlist");
  });

  it("sorts allowed entries canonically before verifying signatures", async () => {
    const { app, db } = createRelayApp();
    const body = signedAllowlist(owner, [strangerId, peerId]);

    const res = await app.request(`/allowlist/${ownerId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(204);
    expect(isSenderAllowed(db, ownerId, peerId)).toBe(true);
    expect(isSenderAllowed(db, ownerId, strangerId)).toBe(true);
  });

  it("rejects allowlist sig with padding (YQ== loose-valid)", async () => {
    const { app } = createRelayApp();
    const body = signedAllowlist(owner, [peerId]);
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
    const body = signedAllowlist(owner, [peerId]);
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
    const body = signedAllowlist(owner, [peerId]);
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
