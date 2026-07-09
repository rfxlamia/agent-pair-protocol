import { describe, expect, it } from "vitest";

describe("vitest smoke", () => {
  it("runs with node environment", () => {
    expect(typeof process.versions.node).toBe("string");
  });
});
