import { describe, expect, it } from "vitest";
import { REFERENCE_PROFILES } from "./reference.js";
import { parseProfilesWire } from "./wire-schema.js";

describe("parseProfilesWire", () => {
  it("accepts valid reference profiles", () => {
    expect(parseProfilesWire([...REFERENCE_PROFILES])).toEqual({
      ok: true,
      profiles: ["core/1", "nego/1"],
    });
  });
  it("rejects duplicates", () => {
    expect(parseProfilesWire(["core/1", "core/1"]).ok).toBe(false);
  });
  it("rejects missing/invalid grammar and oversize id", () => {
    expect(parseProfilesWire(undefined).ok).toBe(false);
    expect(parseProfilesWire(["Core/1"]).ok).toBe(false);
    expect(parseProfilesWire(["core/1", `${"x".repeat(65)}/1`]).ok).toBe(false);
  });
  it("rejects more than 32 profiles", () => {
    const tooMany = Array.from({ length: 33 }, (_, i) => `p${i}/1`);
    expect(parseProfilesWire(tooMany).ok).toBe(false);
  });
});
