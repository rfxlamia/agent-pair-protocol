import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRecord } from "@agentpair/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createFileSessionStore } from "./session-store.js";

describe("session testReports migration on load", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function tempDataDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "agentpair-session-migrate-"));
    tempDirs.push(dir);
    return dir;
  }

  const baseSession = (thread: string): SessionRecord => ({
    thread,
    initiator: "ed25519:alice",
    recipient: "ed25519:bob",
    role: "initiator",
    status: "live",
    goal: "migration probe",
    acceptance: [{ id: "A1", test: "executable", desc: "size", runner: "payload-size" }],
    budget: { max_turns: 30, deadline: new Date(Date.now() + 86_400_000).toISOString() },
    mandate: { agent_may: ["propose"], human_required: ["sign_final"] },
    createdAt: Date.now(),
    expiresAt: Date.now() + 86_400_000,
    turnCount: 0,
    peerMessages: [],
    lockedSections: [],
    challenges: { initiator: true, recipient: true },
    signHashes: {},
    ratifyApproved: {},
    testReports: {},
  });

  it("normalizes legacy per-hash testReports to per-runner nested shape", async () => {
    const dataDir = await tempDataDir();
    const thread = "thread-legacy-nested";
    const hash = "sha256:legacy-hash";
    const legacyReports = {
      [hash]: {
        initiator: {
          artifact_hash: hash,
          passed: true,
          runner: "payload-size",
        },
        recipient: {
          artifact_hash: hash,
          passed: true,
          runner: "payload-size",
        },
      },
    };

    await writeFile(
      join(dataDir, "sessions.json"),
      JSON.stringify({
        v: 1,
        sessions: {
          [thread]: { ...baseSession(thread), testReports: legacyReports },
        },
      }),
      "utf8",
    );

    const store = createFileSessionStore({ dataDir });
    const session = store.get(thread);
    expect(session).toBeDefined();
    if (!session) {
      return;
    }
    expect(session.testReports[hash]).toBeDefined();
    expect(session.testReports[hash]?.["payload-size"]?.initiator?.runner).toBe("payload-size");
    expect(session.testReports[hash]?.["payload-size"]?.recipient?.passed).toBe(true);

    await store.flush();
    const raw = JSON.parse(await readFile(join(dataDir, "sessions.json"), "utf8")) as {
      sessions: Record<string, SessionRecord>;
    };
    expect(raw.sessions[thread]?.testReports[hash]?.["payload-size"]).toBeDefined();
  });

  it("uses DEFAULT_RUNNER_BUCKET when legacy report omits runner field", async () => {
    const dataDir = await tempDataDir();
    const thread = "thread-legacy-default-runner";
    const hash = "sha256:legacy-no-runner";
    const legacyReports = {
      [hash]: {
        initiator: {
          artifact_hash: hash,
          passed: false,
        },
      },
    };

    await writeFile(
      join(dataDir, "sessions.json"),
      JSON.stringify({
        v: 1,
        sessions: {
          [thread]: { ...baseSession(thread), testReports: legacyReports },
        },
      }),
      "utf8",
    );

    const store = createFileSessionStore({ dataDir });
    const session = store.get(thread);
    expect(session).toBeDefined();
    if (!session) {
      return;
    }
    const runners = Object.keys(session.testReports[hash] ?? {});
    expect(runners).toContain("default");
    expect(session.testReports[hash]?.default?.initiator?.passed).toBe(false);
    await store.flush();
  });

  it("preserves already-migrated nested per-runner shape", async () => {
    const dataDir = await tempDataDir();
    const thread = "thread-already-migrated";
    const hash = "sha256:modern-hash";
    const nestedReports = {
      [hash]: {
        "payload-size": {
          initiator: { artifact_hash: hash, passed: true, runner: "payload-size" },
          recipient: { artifact_hash: hash, passed: true, runner: "payload-size" },
        },
        spectral: {
          initiator: { artifact_hash: hash, passed: true, runner: "spectral" },
        },
      },
    };

    await writeFile(
      join(dataDir, "sessions.json"),
      JSON.stringify({
        v: 1,
        sessions: {
          [thread]: { ...baseSession(thread), testReports: nestedReports },
        },
      }),
      "utf8",
    );

    const store = createFileSessionStore({ dataDir });
    const session = store.get(thread);
    expect(session).toBeDefined();
    if (!session) {
      return;
    }
    expect(session.testReports[hash]?.["payload-size"]?.recipient?.passed).toBe(true);
    expect(session.testReports[hash]?.spectral?.initiator?.runner).toBe("spectral");
    await store.flush();
  });

  it("rejects sessions.json with malformed nested testReports", async () => {
    const dataDir = await tempDataDir();
    const thread = "thread-malformed";
    await writeFile(
      join(dataDir, "sessions.json"),
      JSON.stringify({
        v: 1,
        sessions: {
          [thread]: {
            ...baseSession(thread),
            testReports: { "sha256:bad": { "not-a-runner": "garbage" } },
          },
        },
      }),
      "utf8",
    );

    const store = createFileSessionStore({ dataDir });
    expect(store.get(thread)).toBeUndefined();
    expect(store.list()).toHaveLength(0);
  });
});
