import { randomBytes } from "node:crypto";
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
    const secretKey = randomBytes(32);
    const first = createFilePendingQueue({ dataDir, secretKey });
    const item = first.addRatify({
      thread: "thread-1",
      peer: "bob",
      artifactHash: "abc123",
    });
    await first.flush();

    const second = createFilePendingQueue({ dataDir, secretKey });
    expect(second.get(item.id)?.kind).toBe("ratify");
    expect(
      (second.get(item.id) as { approvalCodeVerifier?: string })?.approvalCodeVerifier,
    ).toBeTruthy();
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
      approvalCodeVerifier: "ZmFrZQ",
      approvalAttempts: 0,
    };
    expect(isPendingItemRecord(item)).toBe(true);
  });

  it("drops ratify pending missing approvalCodeVerifier/approvalAttempts", () => {
    const item = {
      id: "p1",
      kind: "ratify" as const,
      createdAt: 1,
      thread: "t1",
      peer: "ed25519:bob",
      artifactHash: "abc",
    };
    expect(isPendingItemRecord(item)).toBe(false);
  });

  it("accepts ratify pending with approvalCodeVerifier/approvalAttempts", () => {
    const item = {
      id: "p1",
      kind: "ratify" as const,
      createdAt: 1,
      thread: "t1",
      peer: "ed25519:bob",
      artifactHash: "abc",
      approvalCodeVerifier: "ZmFrZQ",
      approvalAttempts: 0,
    };
    expect(isPendingItemRecord(item)).toBe(true);
  });
});

describe("N4 session extension fields", () => {
  const baseSession = {
    thread: "t1",
    initiator: "ed25519:a",
    recipient: "ed25519:b",
    role: "recipient" as const,
    status: "live" as const,
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

  it("accepts legacy session without extension fields", () => {
    expect(isSessionRecord(baseSession)).toBe(true);
  });

  it("accepts session with extension and extensionDecided", () => {
    const record = {
      ...baseSession,
      extension: {
        proposal_id: "550e8400-e29b-41d4-a716-446655440000",
        new_max_turns: 30,
        proposed_by: "initiator" as const,
        status: "awaiting_peer" as const,
        envelope_bytes: "SGVsbG8",
      },
      extensionDecided: [
        { proposal_id: "6ba7b810-9dad-11d1-80b4-00c04fd430c8", decision: "rejected" as const },
      ],
    };
    expect(isSessionRecord(record)).toBe(true);
  });

  it("rejects extension with invalid envelope_bytes", () => {
    const record = {
      ...baseSession,
      extension: {
        proposal_id: "550e8400-e29b-41d4-a716-446655440000",
        new_max_turns: 30,
        proposed_by: "initiator" as const,
        status: "emitting" as const,
        envelope_bytes: "not-valid-base64url!!",
      },
    };
    expect(isSessionRecord(record)).toBe(false);
  });

  it("rejects extensionDecided nested under extension", () => {
    const record = {
      ...baseSession,
      extension: {
        proposal_id: "550e8400-e29b-41d4-a716-446655440000",
        new_max_turns: 30,
        proposed_by: "initiator" as const,
        status: "awaiting_peer" as const,
        extensionDecided: [],
      },
    };
    expect(isSessionRecord(record)).toBe(false);
  });
});

describe("N4 budget_extend pending fields", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function tempDataDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "agentpair-budget-extend-"));
    tempDirs.push(dir);
    return dir;
  }

  it("accepts budget_extend pending with new_max_turns and proposal_id", () => {
    const item = {
      id: "p1",
      kind: "budget_extend" as const,
      createdAt: 1,
      thread: "t1",
      peer: "ed25519:bob",
      new_max_turns: 30,
      proposal_id: "550e8400-e29b-41d4-a716-446655440000",
      approvalCodeVerifier: "ZmFrZQ",
      approvalAttempts: 0,
    };
    expect(isPendingItemRecord(item)).toBe(true);
  });

  it("addBudgetExtend round-trips optional fields through restart", async () => {
    const dataDir = await tempDataDir();
    const secretKey = randomBytes(32);
    const first = createFilePendingQueue({ dataDir, secretKey });
    const item = first.addBudgetExtend({
      thread: "thread-1",
      peer: "ed25519:bob",
      new_max_turns: 30,
      proposal_id: "550e8400-e29b-41d4-a716-446655440000",
    });
    await first.flush();

    const second = createFilePendingQueue({ dataDir, secretKey });
    const reloaded = second.get(item.id) as {
      new_max_turns?: number;
      proposal_id?: string;
    };
    expect(reloaded?.new_max_turns).toBe(30);
    expect(reloaded?.proposal_id).toBe("550e8400-e29b-41d4-a716-446655440000");
  });
});
