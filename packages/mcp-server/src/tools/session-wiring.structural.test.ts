import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const srcRoot = join(import.meta.dirname, "..");

describe("session wiring (structural)", () => {
  it("session_open schema requires deadline", () => {
    const indexSrc = readFileSync(join(srcRoot, "index.ts"), "utf8");
    expect(indexSrc).toMatch(/deadline:\s*z\.string\(\)\.datetime\(\)/);
  });

  it("expireSessions rename applied at call sites", () => {
    const sessionSrc = readFileSync(join(srcRoot, "tools/session.ts"), "utf8");
    const inboxSrc = readFileSync(join(srcRoot, "tools/inbox.ts"), "utf8");
    expect(sessionSrc).toContain("expireSessions");
    expect(sessionSrc).not.toContain("expirePendingSessions");
    expect(sessionSrc).toContain("handleExpireSessions");
    expect(sessionSrc).not.toContain("handleExpirePendingOpens");
    expect(inboxSrc).toContain("expireSessions");
    expect(inboxSrc).not.toContain("expirePendingSessions");
  });

  it("dual-server SESSION_OPEN_PAYLOAD includes deadline", () => {
    const dualSrc = readFileSync(join(srcRoot, "e2e/dual-server.ts"), "utf8");
    expect(dualSrc).toMatch(/deadline:/);
    expect(dualSrc).not.toMatch(/expires_at/);
  });
});
