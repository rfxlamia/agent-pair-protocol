import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runSpectral } from "./spectral.js";

const spectralBin = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../node_modules/.bin/spectral",
);

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
    const result = await runSpectral(
      { openapi: "3.0.3" } as { openapi: string },
      { spectralBin },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/spectral lint failed/i);
  });
});
