import {
  agentIdToPublicKey,
  decodeAllowlistBlob,
  decodeBase64UrlStrict,
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

  const allowed = JSON.parse(row.allowed_json) as string[];
  return allowed.includes(senderAgentId);
}

export function createAllowlistRoutes(db: RelayDatabase) {
  const routes = new Hono();

  routes.put("/allowlist/:agentId", async (c) => {
    const agentId = c.req.param("agentId");
    let raw: Record<string, unknown>;

    try {
      raw = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }

    if (isLegacyAllowlistBody(raw) || !isSignTheBlobBody(raw)) {
      return c.json({ error: "invalid_allowlist" }, 400);
    }

    const push = raw as unknown as AllowlistPushBody;

    let blobBytes: Uint8Array;
    try {
      blobBytes = decodeBase64UrlStrict(push.blob);
    } catch {
      return c.json({ error: "invalid_allowlist" }, 400);
    }

    try {
      const preview = JSON.parse(Buffer.from(blobBytes).toString("utf8")) as {
        agent_id?: string;
      };
      if (typeof preview.agent_id === "string" && preview.agent_id !== agentId) {
        return c.json({ error: "agent_id_mismatch" }, 400);
      }
    } catch {
      // Unparseable blob — signature verification below returns invalid_signature.
    }

    let publicKey: Uint8Array;
    try {
      publicKey = agentIdToPublicKey(agentId);
    } catch {
      return c.json({ error: "invalid_allowlist" }, 400);
    }

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
