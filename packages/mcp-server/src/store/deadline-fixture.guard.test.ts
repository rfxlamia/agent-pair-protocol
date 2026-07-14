import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const PKG_ROOT = join(import.meta.dirname, "../..");
const SRC_ROOT = join(PKG_ROOT, "src");

const EXCLUDED = new Set([
  "store/persistence.test.ts",
  "tools/session-wiring.structural.test.ts",
  "store/deadline-fixture.guard.test.ts",
]);

function listGuardedTestFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!name.endsWith(".test.ts")) continue;
      const rel = relative(SRC_ROOT, full).replaceAll("\\", "/");
      if (EXCLUDED.has(rel)) continue;
      if (rel.endsWith("deadline-fixture.guard.test.ts")) continue;
      out.push(rel);
    }
  };
  walk(SRC_ROOT);
  return out;
}

describe("mcp-server deadline fixture guard", () => {
  it("every inline budget block in guarded test files includes deadline", () => {
    const files = listGuardedTestFiles();
    expect(files.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const rel of files) {
      const content = readFileSync(join(SRC_ROOT, rel), "utf8");
      // Single-line regex only — multi-line `budget: { ... }` blocks are not scanned.
      for (const match of content.matchAll(/budget:\s*\{[^}]*\}/g)) {
        if (!match[0].includes("deadline")) {
          violations.push(`${rel}: ${match[0]}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("guarded test files do not reference expires_at", () => {
    const files = listGuardedTestFiles();
    const violations: string[] = [];
    for (const rel of files) {
      const content = readFileSync(join(SRC_ROOT, rel), "utf8");
      if (content.includes("expires_at")) {
        violations.push(rel);
      }
    }
    expect(violations).toEqual([]);
  });
});
