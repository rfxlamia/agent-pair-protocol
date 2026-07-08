import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileSessionStore } from "./session-store.js";

/** Minimal on-disk sessions.json shape from agentpair 0.1.11 — no migration expected. */
const FIXTURE_0_1_11 = {
  v: 1,
  sessions: {
    "thread-legacy": {
      thread: "thread-legacy",
      initiator: "alice",
      recipient: "bob",
      role: "initiator",
      status: "live",
      goal: "backward compat",
      acceptance: [{ id: "ac-1", test: "judgment", desc: "works" }],
      budget: { max_turns: 10, deadline: "2026-12-31T00:00:00.000Z" },
      mandate: { agent_may: ["read"], human_required: ["approve"], escalate_on: ["error"] },
      createdAt: 1_700_000_000_000,
      expiresAt: 1_700_003_600_000,
      turnCount: 2,
      peerMessages: [],
      lockedSections: [],
      testReports: {},
      challenges: {},
      signHashes: {},
      ratifyApproved: {},
    },
  },
};

describe("createFileSessionStore", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function tempDataDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "agentpair-session-store-"));
    tempDirs.push(dir);
    return dir;
  }

  it("loads 0.1.11 sessions.json fixture without migration", async () => {
    const dataDir = await tempDataDir();
    await writeFile(join(dataDir, "sessions.json"), JSON.stringify(FIXTURE_0_1_11), "utf8");

    const store = createFileSessionStore({ dataDir });
    const session = store.get("thread-legacy");

    expect(session).toBeDefined();
    expect(session?.thread).toBe("thread-legacy");
    expect(session?.initiator).toBe("alice");
    expect(session?.recipient).toBe("bob");
    expect(session?.role).toBe("initiator");
    expect(session?.status).toBe("live");
    expect(session?.goal).toBe("backward compat");
    expect(session?.acceptance).toEqual([{ id: "ac-1", test: "judgment", desc: "works" }]);
    expect(session?.budget).toEqual({ max_turns: 10, deadline: "2026-12-31T00:00:00.000Z" });
    expect(session?.mandate).toEqual({
      agent_may: ["read"],
      human_required: ["approve"],
      escalate_on: ["error"],
    });
    expect(session?.turnCount).toBe(2);
  });
});
