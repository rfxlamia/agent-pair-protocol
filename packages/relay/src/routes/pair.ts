import { Hono } from "hono";
import type { RelayDatabase } from "../db/index.js";
import { createRateLimiter } from "../middleware/rate-limit.js";

const PAIR_TTL_MS = 5 * 60 * 1000;

export function createPairRoutes(
  db: RelayDatabase,
  rateLimit: ReturnType<typeof createRateLimiter>,
) {
  const routes = new Hono();

  routes.post("/pair/:sessionId", rateLimit, async (c) => {
    const sessionId = c.req.param("sessionId");
    const messageJson = await c.req.text();
    const now = Date.now();
    const expiresAt = now + PAIR_TTL_MS;

    db.prepare(
      `INSERT INTO pair_sessions (session_id, message_json, created_at, expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         message_json = excluded.message_json,
         expires_at = excluded.expires_at`,
    ).run(sessionId, messageJson, now, expiresAt);

    return c.body(null, 204);
  });

  routes.get("/pair/:sessionId", (c) => {
    const sessionId = c.req.param("sessionId");
    const row = db
      .prepare(
        "SELECT message_json, expires_at FROM pair_sessions WHERE session_id = ?",
      )
      .get(sessionId) as
      | { message_json: string; expires_at: number }
      | undefined;

    if (!row) {
      return c.json({ error: "session_not_found" }, 404);
    }

    if (row.expires_at < Date.now()) {
      db.prepare("DELETE FROM pair_sessions WHERE session_id = ?").run(
        sessionId,
      );
      return c.json({ error: "session_expired" }, 410);
    }

    return c.body(row.message_json, 200, {
      "Content-Type": "application/json",
    });
  });

  return routes;
}
