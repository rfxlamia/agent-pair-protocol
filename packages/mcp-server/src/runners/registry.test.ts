import { describe, expect, it } from "vitest";
import { lookupRunner, runRegisteredRunner } from "./registry.js";

describe("runner registry", () => {
  it("registers payload-size runner", () => {
    expect(lookupRunner("payload-size")).toBeDefined();
    expect(typeof lookupRunner("payload-size")).toBe("function");
  });

  it("rejects injection attempt with exact-match only — no shell execution", async () => {
    const malicious = "spectral; rm -rf /";
    expect(lookupRunner(malicious)).toBeUndefined();
    const result = await runRegisteredRunner(malicious, { schema: { type: "object" } });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not registered|unknown runner|no match/i);
  });

  it("returns local error when spectral runner unavailable", async () => {
    const result = await runRegisteredRunner("spectral", {
      schema: { type: "object" },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("runs payload-size when json-schema-faker is available", async () => {
    const result = await runRegisteredRunner("payload-size", {
      schema: { type: "object", properties: { id: { type: "string" } } },
      maxBytes: 4096,
    });
    if (result.ok) {
      expect(result.details).toBeDefined();
    } else {
      expect(result.error).toMatch(/unavailable|json-schema-faker/i);
    }
  });
});
