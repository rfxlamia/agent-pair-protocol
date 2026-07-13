import { describe, expect, it } from "vitest";
import { intersectProfiles } from "./intersect.js";

describe("intersectProfiles", () => {
  it("returns sorted lex deduped intersection", () => {
    expect(intersectProfiles(["nego/1", "core/1"], ["core/1"])).toEqual(["core/1"]);
  });
  it("returns empty for disjoint lists", () => {
    expect(intersectProfiles(["core/1"], ["nego/1"])).toEqual([]);
  });
});
