import { agentIdToPublicKey, sign, verify } from "@agentpair/protocol";
import { utf8ToBytes } from "@noble/ciphers/utils.js";
import { Hono } from "hono";
import type { RelayDatabase } from "../db/index.js";

export interface AllowlistBody {
  agent_id: string;
  allowed: string[];
  sig: string;
}

function canonicalAllowlistBytes(agentId: string, allowed: string[]): Uint8Array {
  const ordered = { agent_id: agentId, allowed: [...allowed].sort() };
  return utf8ToBytes(JSON.stringify(ordered));
}

function verifyAllowlistSignature(body: AllowlistBody): boolean {
  try {
    const publicKey = agentIdToPublicKey(body.agent_id);
    const signature = Buffer.from(body.sig, "base64url");
    return verify(signature, canonicalAllowlistBytes(body.agent_id, body.allowed), publicKey);
  } catch {
    return false;
  }
}

export function isSenderAllowed(
  db: RelayDatabase,
  recipientAgentId: string,
  senderAgentId: string,
): boolean {
  const row = db
    .prepare("SELECT allowed_json FROM allowlists WHERE agent_id = ?")
    .get(recipientAgentId) as { allowed_json: string } | undefined;

  if (!row) {
    return false;
  }

  const allowed = JSON.parse(row.allowed_json) as string[];
  return allowed.includes(senderAgentId);
}

export function createAllowlistRoutes(db: RelayDatabase) {
  const routes = new Hono();

  routes.put("/allowlist/:agentId", async (c) => {
    const agentId = c.req.param("agentId");
    let body: AllowlistBody;

    try {
      body = (await c.req.json()) as AllowlistBody;
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }

    if (body.agent_id !== agentId) {
      return c.json({ error: "agent_id_mismatch" }, 400);
    }

    if (!Array.isArray(body.allowed) || typeof body.sig !== "string") {
      return c.json({ error: "invalid_allowlist" }, 400);
    }

    if (!verifyAllowlistSignature(body)) {
      return c.json({ error: "invalid_signature" }, 403);
    }

    const now = Date.now();
    db.prepare(
      `INSERT INTO allowlists (agent_id, allowed_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET allowed_json = excluded.allowed_json, updated_at = excluded.updated_at`,
    ).run(agentId, JSON.stringify(body.allowed), now);

    return c.body(null, 204);
  });

  return routes;
}

export function signChallenge(nonce: string, secretKey: Uint8Array): string {
  const signature = sign(utf8ToBytes(nonce), secretKey);
  return Buffer.from(signature).toString("base64url");
}
