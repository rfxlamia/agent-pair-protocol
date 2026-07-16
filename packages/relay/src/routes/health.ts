import { Hono } from "hono";

export const healthRoutes = new Hono();

function buildHealthClaim(): Record<string, unknown> {
  const claim: Record<string, unknown> = {
    status: "ok",
    spec_version: "1.0-draft",
    relay_conformance: "agentpair-relay/1",
  };

  const quotaRaw = process.env.AGENTPAIR_ARTIFACT_QUOTA_BYTES;
  if (quotaRaw) {
    const parsed = Number(quotaRaw);
    if (Number.isFinite(parsed)) {
      claim.artifact_quota_bytes = parsed;
    }
  }

  const retentionRaw = process.env.AGENTPAIR_ARTIFACT_RETENTION_MS;
  if (retentionRaw) {
    const parsed = Number(retentionRaw);
    if (Number.isFinite(parsed)) {
      claim.artifact_retention_ms = parsed;
    }
  }

  return claim;
}

healthRoutes.get("/health", (c) => {
  return c.json(buildHealthClaim());
});
