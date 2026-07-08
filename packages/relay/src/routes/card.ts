import { Hono } from "hono";
import type { RelayDatabase } from "../db/index.js";

export function createCardRoutes(db: RelayDatabase) {
  const routes = new Hono();

  routes.get("/card/:agentId", (c) => {
    const agentId = c.req.param("agentId");
    const row = db.prepare("SELECT card_json FROM cards WHERE agent_id = ?").get(agentId) as
      | { card_json: string }
      | undefined;

    if (!row) {
      return c.json({ error: "card_not_found" }, 404);
    }

    return c.body(row.card_json, 200, { "Content-Type": "application/json" });
  });

  routes.put("/card/:agentId", async (c) => {
    const agentId = c.req.param("agentId");
    const cardJson = await c.req.text();
    const now = Date.now();

    db.prepare(
      `INSERT INTO cards (agent_id, card_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET card_json = excluded.card_json, updated_at = excluded.updated_at`,
    ).run(agentId, cardJson, now);

    return c.body(null, 204);
  });

  return routes;
}
