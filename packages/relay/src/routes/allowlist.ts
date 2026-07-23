import {
  agentIdToPublicKey,
  decodeAllowlistBlob,
  sign,
  validateAllowlistSchema,
  verifyAllowlistPush,
} from "@agentpair/protocol";
import { utf8ToBytes } from "@noble/ciphers/utils.js";
import { Hono } from "hono";
import type { RelayDatabase } from "../db/index.js";

export interface AllowlistPushBody {
  blob: string;
  sig: string;
}

function isLegacyAllowlistBody(body: Record<string, unknown>): boolean {
  return "agent_id" in body || "allowed" in body;
}

function isSignTheBlobBody(body: Record<string, unknown>): boolean {
  return typeof body.blob === "string" && typeof body.sig === "string";
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

  let allowed: unknown;
  try {
    allowed = JSON.parse(row.allowed_json);
  } catch {
    return false;
  }

  if (!Array.isArray(allowed)) {
    return false;
  }

  return allowed.includes(senderAgentId);
}

export function createAllowlistRoutes(db: RelayDatabase) {
  const routes = new Hono();

  routes.put("/allowlist/:agentId", async (c) => {
    const agentId = c.req.param("agentId");
    let raw: unknown;

    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }

    // null / primitives: fail closed (avoid TypeError from `in` on non-object).
    // Arrays are already invalid shape; guard keeps object-boundary consistent.
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return c.json({ error: "invalid_allowlist" }, 400);
    }

    const body = raw as Record<string, unknown>;
    if (isLegacyAllowlistBody(body) || !isSignTheBlobBody(body)) {
      return c.json({ error: "invalid_allowlist" }, 400);
    }

    const push = body as unknown as AllowlistPushBody;

    let publicKey: Uint8Array;
    try {
      publicKey = agentIdToPublicKey(agentId);
    } catch {
      return c.json({ error: "invalid_allowlist" }, 400);
    }

    // Verify signature first; agent_id_mismatch comes from schema after verify.
    if (!verifyAllowlistPush(push, publicKey)) {
      return c.json({ error: "invalid_signature" }, 403);
    }

    let decoded: ReturnType<typeof decodeAllowlistBlob>;
    try {
      decoded = decodeAllowlistBlob(push);
    } catch {
      return c.json({ error: "invalid_allowlist" }, 400);
    }

    const schema = validateAllowlistSchema(decoded, agentId);
    if (!schema.ok) {
      if (schema.error === "agent_id_mismatch") {
        return c.json({ error: "agent_id_mismatch" }, 400);
      }
      return c.json({ error: "invalid_allowlist" }, 400);
    }

    const now = Date.now();
    db.prepare(
      `INSERT INTO allowlists (agent_id, allowed_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET allowed_json = excluded.allowed_json, updated_at = excluded.updated_at`,
    ).run(agentId, JSON.stringify(decoded.allowed), now);

    return c.body(null, 204);
  });

  return routes;
}

export function signChallenge(nonce: string, secretKey: Uint8Array): string {
  const signature = sign(utf8ToBytes(nonce), secretKey);
  return Buffer.from(signature).toString("base64url");
}
