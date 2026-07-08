import { describe, expect, it } from "vitest";
import { resolvePackageBin } from "./resolve-package-bin.js";
import { runSpectral } from "./spectral.js";

const spectralBin = resolvePackageBin("@stoplight/spectral-cli", "spectral");

const validOpenApi = {
  openapi: "3.0.3",
  info: { title: "Test API", version: "1.0.0" },
  paths: {
    "/health": {
      get: {
        responses: {
          "200": {
            description: "ok",
          },
        },
      },
    },
  },
} as const;

describe("spectral runner", () => {
  it("passes a minimal valid OpenAPI document", async () => {
    const result = await runSpectral(validOpenApi, { spectralBin });
    expect(result.ok).toBe(true);
  });

  it("fails when required OpenAPI fields are missing", async () => {
    const result = await runSpectral({ openapi: "3.0.3" } as { openapi: string }, { spectralBin });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/spectral lint failed/i);
  });

  it("uses the package-local spectral binary by default", async () => {
    const result = await runSpectral(validOpenApi);
    expect(result.ok).toBe(true);
  });
});
