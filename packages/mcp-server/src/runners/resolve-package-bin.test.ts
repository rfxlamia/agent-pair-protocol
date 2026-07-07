import { describe, expect, it } from "vitest";
import { resolvePackageBin } from "./resolve-package-bin.js";

describe("resolvePackageBin", () => {
  it("resolves @stoplight/spectral-cli bin via package.json", () => {
    const bin = resolvePackageBin("@stoplight/spectral-cli", "spectral");
    expect(bin).toMatch(/spectral-cli/);
    expect(bin).toMatch(/index\.js$/);
  });

  it("resolves quicktype bin via package.json", () => {
    const bin = resolvePackageBin("quicktype");
    expect(bin).toMatch(/quicktype/);
  });
});
