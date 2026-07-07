import { serve } from "@hono/node-server";
import { createRelayApp } from "./server.js";

const PORT = Number(process.env.PORT ?? 3001);
const DB_PATH = process.env.AGENTPAIR_RELAY_DB ?? "/data/relay.db";

const { app } = createRelayApp({
  dbPath: DB_PATH,
  rateLimitWindowMs: 60_000,
  rateLimitMax: 120,
});

serve({ fetch: app.fetch, port: PORT, hostname: "0.0.0.0" }, () => {
  console.log(`agentpair relay listening on 0.0.0.0:${PORT}`);
});
