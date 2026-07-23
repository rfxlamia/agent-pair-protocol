import { Hono } from "hono";
import { type RelayDatabase, createDatabase } from "./db/index.js";
import { createRateLimitConsumer, createRateLimiter } from "./middleware/rate-limit.js";
import { createAllowlistRoutes } from "./routes/allowlist.js";
import { createArtifactRoutes } from "./routes/artifact.js";
import { healthRoutes } from "./routes/health.js";
import { createInboxRoutes } from "./routes/inbox.js";
import { createPairRoutes } from "./routes/pair.js";

export interface RelayConfig {
  dbPath?: string;
  rateLimitWindowMs?: number;
  rateLimitMax?: number;
  trustProxy?: boolean;
}

export interface RelayApp {
  app: Hono;
  db: RelayDatabase;
}

export function createRelayApp(config: RelayConfig = {}): RelayApp {
  const db = createDatabase(config.dbPath ?? ":memory:");
  const app = new Hono();

  const rateLimitOptions = {
    windowMs: config.rateLimitWindowMs ?? 60_000,
    maxRequests: config.rateLimitMax ?? 60,
    trustProxy: config.trustProxy ?? false,
  };
  const rateLimit = createRateLimiter(rateLimitOptions);
  const challengeIssueRateLimit = createRateLimitConsumer(rateLimitOptions);

  app.route("/", healthRoutes);
  app.route("/", createAllowlistRoutes(db));
  app.route("/", createPairRoutes(db, rateLimit));
  app.route("/", createInboxRoutes(db, rateLimit, challengeIssueRateLimit));
  app.route("/", createArtifactRoutes(db, rateLimit));

  return { app, db };
}

export function createRelayServer(config: RelayConfig = {}) {
  return createRelayApp(config);
}
