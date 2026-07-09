import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const _unused = 1;

describe("vitest smoke", () => {
  it("runs with node environment", () => {
    expect(typeof process.versions.node).toBe("string");
  });
});
