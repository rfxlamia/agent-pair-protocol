import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { RelayDatabase } from "../db/index.js";
import type { createRateLimiter } from "../middleware/rate-limit.js";

export function createArtifactRoutes(
  db: RelayDatabase,
  rateLimit: ReturnType<typeof createRateLimiter>,
) {
  const routes = new Hono();

  routes.put("/artifact/:hash", rateLimit, async (c) => {
    const hash = c.req.param("hash");
    const blob = await c.req.arrayBuffer();
    const computed = createHash("sha256").update(Buffer.from(blob)).digest("hex");

    if (computed !== hash) {
      return c.json({ error: "hash_mismatch" }, 400);
    }

    const now = Date.now();
    db.prepare(
      `INSERT INTO artifacts (hash, blob, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(hash) DO NOTHING`,
    ).run(hash, Buffer.from(blob), now);

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

    return c.body(row.blob, 200, {
      "Content-Type": "application/octet-stream",
    });
  });

  return routes;
}
