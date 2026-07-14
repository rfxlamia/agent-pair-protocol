import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bond } from "@agentpair/protocol";
import { REFERENCE_PROFILES } from "@agentpair/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createFileAllowlistStore } from "./allowlist.js";
import { FileBondStore } from "./bonds.js";
import { createFilePendingQueue } from "./pending.js";
import { isPendingItemRecord, isSessionRecord } from "./persistence-validate.js";
import { createFileSessionStore } from "./session-store.js";

const SAMPLE_BOND: Bond = {
  peer: "peer-agent-1",
  mode: "bonded_contact",
  scope: ["inbox"],
  establishedAt: 1_700_000_000_000,
};

describe("file-backed stores restart simulation", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function tempDataDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "agentpair-restart-"));
    tempDirs.push(dir);
    return dir;
  }

  it("bond survives restart", async () => {
    const dataDir = await tempDataDir();
    const first = new FileBondStore({ dataDir });
    first.add("alice", SAMPLE_BOND);
    await first.flush();

    const second = new FileBondStore({ dataDir });
    expect(second.find("alice", "peer-agent-1")).toEqual({
      ...SAMPLE_BOND,
      profiles: [...REFERENCE_PROFILES],
    });
    await second.flush();
  });

  it("pending ratify survives restart", async () => {
    const dataDir = await tempDataDir();
    const first = createFilePendingQueue({ dataDir });
    const item = first.addRatify({
      thread: "thread-1",
      peer: "bob",
      artifactHash: "abc123",
    });
    await first.flush();

    const second = createFilePendingQueue({ dataDir });
    expect(second.get(item.id)?.kind).toBe("ratify");
  });

  it("session survives restart", async () => {
    const dataDir = await tempDataDir();
    const first = createFileSessionStore({ dataDir });
    first.upsert({
      thread: "thread-1",
      initiator: "alice",
      recipient: "bob",
      role: "initiator",
      status: "live",
      goal: "test",
      acceptance: [],
      budget: { max_turns: 5, deadline: "2030-01-01T00:00:00.000Z" },
      mandate: { agent_may: [], human_required: [] },
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      turnCount: 0,
      peerMessages: [],
      lockedSections: [],
      testReports: {},
      challenges: {},
      signHashes: {},
      ratifyApproved: {},
    });
    await first.flush();

    const second = createFileSessionStore({ dataDir });
    expect(second.get("thread-1")?.status).toBe("live");
  });

  it("bond store returns empty for invalid on-disk shape without throwing", async () => {
    const dataDir = await tempDataDir();
    await writeFile(join(dataDir, "bonds.json"), JSON.stringify({ v: 1 }), "utf8");

    const store = new FileBondStore({ dataDir });
    expect(store.get("alice")).toEqual([]);
  });

  it("bond store rejects agents with non-array bond lists", async () => {
    const dataDir = await tempDataDir();
    await writeFile(
      join(dataDir, "bonds.json"),
      JSON.stringify({ v: 1, agents: { alice: "not-an-array" } }),
      "utf8",
    );

    const store = new FileBondStore({ dataDir });
    expect(store.get("alice")).toEqual([]);
  });

  it("session store drops invalid session entries on load", async () => {
    const dataDir = await tempDataDir();
    await writeFile(
      join(dataDir, "sessions.json"),
      JSON.stringify({
        v: 1,
        sessions: {
          good: {
            thread: "good",
            initiator: "alice",
            recipient: "bob",
            role: "initiator",
            status: "live",
            goal: "test",
            acceptance: [],
            budget: { max_turns: 1, deadline: "2030-01-01T00:00:00.000Z" },
            mandate: { agent_may: [], human_required: [] },
            createdAt: 1,
            expiresAt: 2,
            turnCount: 0,
            peerMessages: [],
            lockedSections: [],
            testReports: {},
            challenges: {},
            signHashes: {},
            ratifyApproved: {},
          },
          bad: { thread: "bad" },
        },
      }),
      "utf8",
    );

    const store = createFileSessionStore({ dataDir });
    expect(store.get("good")?.status).toBe("live");
    expect(store.get("bad")).toBeUndefined();
  });

  it("allowlist store returns empty for invalid on-disk shape without throwing", async () => {
    const dataDir = await tempDataDir();
    await writeFile(join(dataDir, "allowlist.json"), JSON.stringify({}), "utf8");

    const store = createFileAllowlistStore({ dataDir, agentId: "alice" });
    expect(store.get("alice")).toEqual([]);
  });

  it("createAgentContext without dataDir writes no runtime store files", async () => {
    const dataDir = await tempDataDir();
    const { createAgentContext } = await import("../tools/pair.js");
    const { MemoryAllowlistStore } = await import("./allowlist.js");
    const { MemoryBondStore } = await import("./bonds.js");
    const { createPendingQueue } = await import("./pending.js");
    const { createSessionStore } = await import("@agentpair/protocol");
    const { HttpRelayClient } = await import("../relay/client.js");
    const { createKeyStore } = await import("./keys.js");

    createAgentContext({
      keyStore: createKeyStore({ keyPath: join(dataDir, "keys.json") }),
      relay: new HttpRelayClient("http://127.0.0.1:9"),
      allowlist: new MemoryAllowlistStore(),
      bonds: new MemoryBondStore(),
      pending: createPendingQueue(),
      sessionStore: createSessionStore(),
    });

    await createKeyStore({ keyPath: join(dataDir, "keys.json") }).loadOrCreate();

    const files = await readdir(dataDir);
    expect(files).toContain("keys.json");
    expect(files).not.toContain("bonds.json");
    expect(files).not.toContain("pending.json");
    expect(files).not.toContain("sessions.json");
    expect(files).not.toContain("allowlist.json");
  });
});

describe("deadline presence guards", () => {
  it("drops session record missing budget.deadline", () => {
    const record = {
      thread: "t1",
      initiator: "ed25519:a",
      recipient: "ed25519:b",
      role: "recipient" as const,
      status: "pending" as const,
      goal: "g",
      acceptance: [],
      budget: { max_turns: 10 },
      mandate: { agent_may: [], human_required: [] },
      createdAt: 1,
      expiresAt: 2,
      turnCount: 0,
      peerMessages: [],
      lockedSections: [],
      testReports: {},
      challenges: {},
      signHashes: {},
      ratifyApproved: {},
    };
    expect(isSessionRecord(record)).toBe(false);
  });

  it("accepts session record with budget.deadline", () => {
    const record = {
      thread: "t1",
      initiator: "ed25519:a",
      recipient: "ed25519:b",
      role: "recipient" as const,
      status: "pending" as const,
      goal: "g",
      acceptance: [],
      budget: { max_turns: 10, deadline: "2030-01-01T00:00:00.000Z" },
      mandate: { agent_may: [], human_required: [] },
      createdAt: 1,
      expiresAt: 2,
      turnCount: 0,
      peerMessages: [],
      lockedSections: [],
      testReports: {},
      challenges: {},
      signHashes: {},
      ratifyApproved: {},
    };
    expect(isSessionRecord(record)).toBe(true);
  });

  it("drops session_open pending missing budget.deadline", () => {
    const item = {
      id: "p1",
      kind: "session_open" as const,
      createdAt: 1,
      thread: "t1",
      from: "ed25519:a",
      goal: "g",
      acceptance: [],
      budget: { max_turns: 5 },
      mandate: { agent_may: [], human_required: [] },
      expiresAt: 2,
    };
    expect(isPendingItemRecord(item)).toBe(false);
  });

  it("accepts session_open pending with budget.deadline", () => {
    const item = {
      id: "p1",
      kind: "session_open" as const,
      createdAt: 1,
      thread: "t1",
      from: "ed25519:a",
      goal: "g",
      acceptance: [],
      budget: { max_turns: 5, deadline: "2030-01-01T00:00:00.000Z" },
      mandate: { agent_may: [], human_required: [] },
      expiresAt: 2,
    };
    expect(isPendingItemRecord(item)).toBe(true);
  });
});
