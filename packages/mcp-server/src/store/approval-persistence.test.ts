import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { approvalFilePath } from "./approval-code.js";
import { createFilePendingQueue, createPendingQueue } from "./pending.js";

describe("approval-persistence", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function tempDataDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "agentpair-approval-persist-"));
    tempDirs.push(dir);
    return dir;
  }

  it("drops a legacy pending item missing approval fields, keeps the new-shape item", async () => {
    const dataDir = await tempDataDir();
    await writeFile(
      join(dataDir, "pending.json"),
      JSON.stringify({
        v: 1,
        items: {
          "legacy-1": {
            id: "legacy-1",
            kind: "ratify",
            createdAt: 1,
            thread: "t1",
            peer: "ed25519:bob",
            artifactHash: "abc",
          },
          "new-1": {
            id: "new-1",
            kind: "ratify",
            createdAt: 2,
            thread: "t2",
            peer: "ed25519:bob",
            artifactHash: "def",
            approvalCodeVerifier: "ZmFrZS12ZXJpZmllcg",
            approvalAttempts: 0,
          },
        },
      }),
      "utf8",
    );
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const queue = createFilePendingQueue({ dataDir });

    expect(queue.get("new-1")?.kind).toBe("ratify");
    expect(queue.get("legacy-1")).toBeUndefined();
    expect(stderrSpy.mock.calls.some((call) => call.join(" ").includes("legacy-1"))).toBe(true);

    stderrSpy.mockRestore();
  });

  it("sweeps orphan approval files that have no matching pending on load", async () => {
    const dataDir = await tempDataDir();
    await mkdir(join(dataDir, "approvals"), { recursive: true });
    await writeFile(join(dataDir, "approvals", "ghost-id"), "orphaned approval file", "utf8");

    createFilePendingQueue({ dataDir });

    await expect(stat(join(dataDir, "approvals", "ghost-id"))).rejects.toThrow();
  });

  it("does not commit a pending when the approval file write fails (fail-closed)", async () => {
    const dataDir = await tempDataDir();
    await writeFile(join(dataDir, "approvals"), "blocked", "utf8");
    const secretKey = randomBytes(32);

    const queue = createFilePendingQueue({ dataDir, secretKey });

    expect(() =>
      queue.addRatify({ thread: "t1", peer: "ed25519:bob", artifactHash: "abc" }),
    ).toThrow();
    expect(queue.list()).toHaveLength(0);
  });

  it("persists approvalCodeVerifier + writes approval file for budget_extend and survives restart", async () => {
    const dataDir = await tempDataDir();
    const secretKey = randomBytes(32);
    const first = createFilePendingQueue({ dataDir, secretKey });

    const item = first.addBudgetExtend({ thread: "t1", peer: "ed25519:bob" });
    await first.flush();

    expect(typeof (item as { approvalCodeVerifier?: string }).approvalCodeVerifier).toBe("string");
    expect((item as { approvalAttempts?: number }).approvalAttempts).toBe(0);
    await expect(stat(approvalFilePath(dataDir, item.id))).resolves.toBeDefined();

    const second = createFilePendingQueue({ dataDir, secretKey });
    const reloaded = second.get(item.id);
    expect(reloaded?.kind).toBe("budget_extend");
    expect((reloaded as { approvalCodeVerifier?: string })?.approvalCodeVerifier).toBe(
      (item as { approvalCodeVerifier?: string }).approvalCodeVerifier,
    );
  });

  it("approvalAttempts survive a simulated restart", async () => {
    const dataDir = await tempDataDir();
    const secretKey = randomBytes(32);
    const first = createFilePendingQueue({ dataDir, secretKey });

    const item = first.addRatify({ thread: "t1", peer: "ed25519:bob", artifactHash: "abc" });
    first.setApprovalAttempts(item.id, 2);
    await first.flush();

    const second = createFilePendingQueue({ dataDir, secretKey });
    expect((second.get(item.id) as { approvalAttempts?: number })?.approvalAttempts).toBe(2);
  });

  it("memory queue with secretKey commits verifier without writing an approval file", async () => {
    const secretKey = randomBytes(32);
    const queue = createPendingQueue({ secretKey });
    const item = queue.addRatify({ thread: "t1", peer: "ed25519:bob", artifactHash: "abc" });
    expect(typeof (item as { approvalCodeVerifier?: string }).approvalCodeVerifier).toBe("string");
    expect((item as { approvalAttempts?: number }).approvalAttempts).toBe(0);
  });

  it("add* fails closed when no secretKey is bound", () => {
    const queue = createPendingQueue();
    expect(() =>
      queue.addRatify({ thread: "t1", peer: "ed25519:bob", artifactHash: "abc" }),
    ).toThrow();
  });

  it("remove best-effort deletes the approval file when dataDir is bound", async () => {
    const dataDir = await tempDataDir();
    const secretKey = randomBytes(32);
    const queue = createFilePendingQueue({ dataDir, secretKey });
    const item = queue.addRatify({ thread: "t1", peer: "ed25519:bob", artifactHash: "abc" });
    await expect(stat(approvalFilePath(dataDir, item.id))).resolves.toBeDefined();

    queue.remove(item.id);

    expect(queue.get(item.id)).toBeUndefined();
    await expect(stat(approvalFilePath(dataDir, item.id))).rejects.toThrow();
    expect(() => queue.remove("already-gone")).not.toThrow();
    await queue.flush();
  });
});
