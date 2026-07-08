import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type RelayDatabase, createDatabase } from "./db/index.js";
import { createRateLimiter } from "./middleware/rate-limit.js";
import { createAllowlistRoutes } from "./routes/allowlist.js";
import { createArtifactRoutes } from "./routes/artifact.js";
import { createCardRoutes } from "./routes/card.js";
import { healthRoutes } from "./routes/health.js";
import { createInboxRoutes } from "./routes/inbox.js";
import { createPairRoutes } from "./routes/pair.js";

export interface RelayConfig {
  dbPath?: string;
  maxBodyBytes?: number;
  rateLimitWindowMs?: number;
  rateLimitMax?: number;
}

export interface RelayApp {
  app: Hono;
  db: RelayDatabase;
}

export function createRelayApp(config: RelayConfig = {}): RelayApp {
  const db = createDatabase(config.dbPath ?? ":memory:");
  const app = new Hono();

  const maxBodyBytes = config.maxBodyBytes ?? 1024 * 1024;
  app.use(
    "*",
    bodyLimit({
      maxSize: maxBodyBytes,
      onError: (c) => c.json({ error: "payload_too_large" }, 413),
    }),
  );

  const rateLimit = createRateLimiter({
    windowMs: config.rateLimitWindowMs ?? 60_000,
    maxRequests: config.rateLimitMax ?? 60,
  });

  app.route("/", healthRoutes);
  app.route("/", createCardRoutes(db));
  app.route("/", createAllowlistRoutes(db));
  app.route("/", createPairRoutes(db, rateLimit));
  app.route("/", createInboxRoutes(db, rateLimit));
  app.route("/", createArtifactRoutes(db, rateLimit));

  return { app, db };
}

export function createRelayServer(config: RelayConfig = {}) {
  return createRelayApp(config);
}
