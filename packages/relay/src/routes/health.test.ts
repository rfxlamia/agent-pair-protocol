import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRelayApp } from "../server.js";

describe("relay /health conformance claim", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns required conformance claim fields", async () => {
    const { app } = createRelayApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.spec_version).toBe("1.0-draft");
    expect(body.relay_conformance).toBe("agentpair-relay/1");
  });

  it("includes optional artifact quota and retention from env when set", async () => {
    vi.stubEnv("AGENTPAIR_ARTIFACT_QUOTA_BYTES", "52428800");
    vi.stubEnv("AGENTPAIR_ARTIFACT_RETENTION_MS", "2592000000");

    const { app } = createRelayApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.artifact_quota_bytes).toBe(52428800);
    expect(body.artifact_retention_ms).toBe(2592000000);
  });

  it("omits optional fields when env vars are unset", async () => {
    const { app } = createRelayApp();
    const res = await app.request("/health");
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).not.toHaveProperty("artifact_quota_bytes");
    expect(body).not.toHaveProperty("artifact_retention_ms");
  });
});
