import { createHash } from "node:crypto";
import { agentIdToPublicKey, decodeBase64UrlStrict, verify } from "@agentpair/protocol";
import { utf8ToBytes } from "@noble/ciphers/utils.js";
import { Hono } from "hono";
import type { RelayDatabase } from "../db/index.js";
import type { createRateLimiter } from "../middleware/rate-limit.js";

const GC_INTERVAL_MS = 60_000;
const DEFAULT_QUOTA_BYTES = 50 * 1024 * 1024;
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function artifactAuthMode(): "off" | "required" {
  const mode = process.env.AGENTPAIR_ARTIFACT_AUTH ?? "required";
  return mode === "off" ? "off" : "required";
}

function artifactQuotaBytes(): number {
  const raw = process.env.AGENTPAIR_ARTIFACT_QUOTA_BYTES;
  if (!raw) {
    return DEFAULT_QUOTA_BYTES;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_QUOTA_BYTES;
}

function artifactRetentionMs(): number {
  const raw = process.env.AGENTPAIR_ARTIFACT_RETENTION_MS;
  if (!raw) {
    return DEFAULT_RETENTION_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_MS;
}

function ensureArtifactSchema(db: RelayDatabase): void {
  const columns = db.prepare("PRAGMA table_info(artifacts)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "owner_agent_id")) {
    db.exec("ALTER TABLE artifacts ADD COLUMN owner_agent_id TEXT");
  }
}

function isAgentRegistered(db: RelayDatabase, agentId: string): boolean {
  const allowlist = db.prepare("SELECT 1 AS ok FROM allowlists WHERE agent_id = ?").get(agentId) as
    | { ok: number }
    | undefined;
  if (allowlist) {
    return true;
  }
  const card = db.prepare("SELECT 1 AS ok FROM cards WHERE agent_id = ?").get(agentId) as
    | { ok: number }
    | undefined;
  return Boolean(card);
}

function verifyArtifactSignature(agentId: string, hash: string, sig: string): boolean {
  try {
    const publicKey = agentIdToPublicKey(agentId);
    const signature = decodeBase64UrlStrict(sig);
    return verify(signature, utf8ToBytes(hash), publicKey);
  } catch {
    return false;
  }
}

function maybeGarbageCollectArtifacts(db: RelayDatabase, state: { lastGcAt: number }): void {
  const now = Date.now();
  if (now - state.lastGcAt < GC_INTERVAL_MS) {
    return;
  }
  state.lastGcAt = now;
  const cutoff = now - artifactRetentionMs();
  db.prepare("DELETE FROM artifacts WHERE created_at < ?").run(cutoff);
}

function agentArtifactBytes(db: RelayDatabase, agentId: string): number {
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(length(blob)), 0) AS total FROM artifacts WHERE owner_agent_id = ?",
    )
    .get(agentId) as { total: number };
  return row.total;
}

function artifactExists(db: RelayDatabase, hash: string): boolean {
  const row = db.prepare("SELECT 1 AS ok FROM artifacts WHERE hash = ?").get(hash) as
    | { ok: number }
    | undefined;
  return Boolean(row);
}

export function createArtifactRoutes(
  db: RelayDatabase,
  rateLimit: ReturnType<typeof createRateLimiter>,
) {
  ensureArtifactSchema(db);
  const gcState = { lastGcAt: 0 };
  const routes = new Hono();

  routes.put("/artifact/:hash", rateLimit, async (c) => {
    const hash = c.req.param("hash");
    maybeGarbageCollectArtifacts(db, gcState);

    const authMode = artifactAuthMode();
    let ownerAgentId: string | null = null;

    if (authMode === "required") {
      const agentId = c.req.header("x-agent-id");
      const sig = c.req.header("x-artifact-sig");
      if (!agentId || !sig) {
        return c.json({ error: "auth_required" }, 401);
      }
      if (!isAgentRegistered(db, agentId)) {
        return c.json({ error: "agent_not_registered" }, 403);
      }
      if (!verifyArtifactSignature(agentId, hash, sig)) {
        return c.json({ error: "invalid_signature" }, 403);
      }
      ownerAgentId = agentId;
    }

    const blob = await c.req.arrayBuffer();
    const computed = createHash("sha256").update(Buffer.from(blob)).digest("hex");
    if (computed !== hash) {
      return c.json({ error: "hash_mismatch" }, 400);
    }

    if (authMode === "required" && ownerAgentId) {
      if (!artifactExists(db, hash)) {
        const used = agentArtifactBytes(db, ownerAgentId);
        if (used + blob.byteLength > artifactQuotaBytes()) {
          return c.json({ error: "quota_exceeded" }, 413);
        }
      }
    }

    const now = Date.now();
    db.prepare(
      `INSERT INTO artifacts (hash, blob, created_at, owner_agent_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(hash) DO NOTHING`,
    ).run(hash, Buffer.from(blob), now, ownerAgentId);

    return c.body(null, 204);
  });

  routes.get("/artifact/:hash", (c) => {
    const hash = c.req.param("hash");
    const row = db.prepare("SELECT blob FROM artifacts WHERE hash = ?").get(hash) as
      | { blob: Buffer }
      | undefined;

    if (!row) {
      return c.json({ error: "artifact_not_found" }, 404);
    }

    return c.body(new Uint8Array(row.blob), 200, {
      "Content-Type": "application/octet-stream",
    });
  });

  return routes;
}
