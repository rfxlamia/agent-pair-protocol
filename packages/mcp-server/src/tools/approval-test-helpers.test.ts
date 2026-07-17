import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { approvalFilePath, formatApprovalFileBody } from "../store/approval-code.js";
import { readApprovalCode } from "./approval-test-helpers.js";

describe("readApprovalCode", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("reads a 6-digit code from an approval file", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "agentpair-read-code-"));
    tempDirs.push(dataDir);
    const pendingId = "pending-123";
    const approvalsDir = join(dataDir, "approvals");
    mkdirSync(approvalsDir, { recursive: true });
    writeFileSync(
      approvalFilePath(dataDir, pendingId),
      formatApprovalFileBody({
        code: "012345",
        kind: "ratify",
        peer: "ed25519:peer",
        thread: "thread-1",
        createdAt: Date.now(),
      }),
      "utf8",
    );

    expect(readApprovalCode(dataDir, pendingId)).toBe("012345");
  });

  it("throws when no approval code is present in the file", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "agentpair-read-code-missing-"));
    tempDirs.push(dataDir);
    const pendingId = "pending-missing";
    const approvalsDir = join(dataDir, "approvals");
    mkdirSync(approvalsDir, { recursive: true });
    writeFileSync(approvalFilePath(dataDir, pendingId), "no digits here", "utf8");

    expect(() => readApprovalCode(dataDir, pendingId)).toThrow(/no approval code found/);
  });
});
