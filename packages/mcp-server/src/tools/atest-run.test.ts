import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REFERENCE_PROFILES,
  createSessionStore,
  generateKeyPair,
  publicKeyToAgentId,
} from "@agentpair/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryAllowlistStore } from "../store/allowlist.js";
import { MemoryBondStore } from "../store/bonds.js";
import { createKeyStore } from "../store/keys.js";
import { createPendingQueue } from "../store/pending.js";
import { handleAtestRun } from "./atest-run.js";
import { createAgentContext } from "./pair.js";

function structured<T>(result: { structuredContent: T }): T {
  return result.structuredContent;
}

const TEST_DEADLINE = "2030-06-01T12:00:00.000Z";
// Minimal JSON Schema artifact body for payload-size runner
const SCHEMA_BYTES = new TextEncoder().encode(
  JSON.stringify({ type: "object", properties: { id: { type: "string" } } }),
);

describe("atest_run", () => {
  const tempDirs: string[] = [];
  // Match HttpRelayClient shapes used by session wiring: sendEnvelope + getArtifact(hash, size) → Uint8Array
  const sendEnvelope = vi.fn(async () => undefined);
  const getArtifact = vi.fn(async (_hash: string, _size: number) => SCHEMA_BYTES);

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    sendEnvelope.mockClear();
    getArtifact.mockClear();
  });

  async function makeCtx(profiles: string[]) {
    const dir = await mkdtemp(join(tmpdir(), "agentpair-atest-run-"));
    tempDirs.push(dir);
    const bonds = new MemoryBondStore();
    const allowlist = new MemoryAllowlistStore();
    const sessionStore = createSessionStore();
    const ctx = createAgentContext({
      keyStore: createKeyStore({ keyPath: join(dir, "keys.json") }),
      relay: {
        sendEnvelope,
        pullInbox: vi.fn(),
        putArtifact: vi.fn(async () => undefined),
        getArtifact,
      } as never,
      bonds,
      allowlist,
      pending: createPendingQueue(),
      sessionStore,
    });
    const keys = await ctx.keyStore.loadOrCreate();
    const agentId = publicKeyToAgentId(keys.publicKey);
    const peer = publicKeyToAgentId(generateKeyPair().publicKey);
    allowlist.set(agentId, [peer]);
    bonds.add(agentId, {
      peer,
      scope: ["session.negotiate"],
      mode: "bonded_contact",
      profiles,
    });
    return { ctx, agentId, peer, sessionStore };
  }

  function seedLiveSession(
    sessionStore: ReturnType<typeof createSessionStore>,
    thread: string,
    initiator: string,
    recipient: string,
    acceptance: Array<{
      id: string;
      test: "executable" | "judgment";
      desc: string;
      runner?: string;
    }>,
  ) {
    sessionStore.upsert({
      thread,
      initiator,
      recipient,
      role: "initiator",
      status: "live",
      goal: "atest_run probe",
      acceptance,
      budget: { max_turns: 10, deadline: TEST_DEADLINE },
      mandate: { agent_may: ["propose"], human_required: ["sign_final"] },
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
      turnCount: 0,
      peerMessages: [],
      lockedSections: [],
      testReports: {},
      challenges: { initiator: true, recipient: true },
      signHashes: {},
      ratifyApproved: {},
    });
  }

  it("returns profile_not_supported on nego-only bond with zero side effects", async () => {
    const thread = crypto.randomUUID();
    const hash = "sha256:atest-run-nego";
    const { ctx, agentId, peer, sessionStore } = await makeCtx([...REFERENCE_PROFILES]);
    seedLiveSession(sessionStore, thread, agentId, peer, [
      { id: "A1", test: "executable", desc: "size", runner: "payload-size" },
    ]);
    const before = sessionStore.get(thread);
    expect(before).toBeDefined();

    const result = structured(
      await handleAtestRun(ctx, {
        thread,
        criterion_id: "A1",
        artifact_hash: hash,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toBe("profile_not_supported");
    expect(sendEnvelope).not.toHaveBeenCalled();
    expect(getArtifact).not.toHaveBeenCalled();

    const after = sessionStore.get(thread);
    expect(after?.testReports).toEqual(before?.testReports);
  });

  it("runs registry and emits atest.report on atest/1 bond with executable criterion", async () => {
    const thread = crypto.randomUUID();
    const hash = "sha256:atest-run-ok";
    const profiles = [...REFERENCE_PROFILES, "atest/1"];
    const { ctx, agentId, peer, sessionStore } = await makeCtx(profiles);
    seedLiveSession(sessionStore, thread, agentId, peer, [
      { id: "A1", test: "executable", desc: "size", runner: "payload-size" },
    ]);

    const result = structured(
      await handleAtestRun(ctx, {
        thread,
        criterion_id: "A1",
        artifact_hash: hash,
      }),
    );

    if (result.ok) {
      expect(result.runner).toBe("payload-size");
      expect(result.passed).toBeDefined();
      expect(getArtifact).toHaveBeenCalled();
      expect(sendEnvelope).toHaveBeenCalled();
      // Report stored on session store (not handleSessionStatus.test_reports)
      const stored = sessionStore.get(thread);
      expect(stored?.testReports[hash]?.["payload-size"]?.initiator).toBeDefined();
    } else {
      // Graceful if json-schema-faker missing in env
      expect(result.error).toMatch(/unavailable|json-schema-faker/i);
      expect(sendEnvelope).not.toHaveBeenCalled();
    }
  });

  it("returns local error for judgment-only criterion_id", async () => {
    const thread = crypto.randomUUID();
    const hash = "sha256:atest-run-judgment";
    const profiles = [...REFERENCE_PROFILES, "atest/1"];
    const { ctx, agentId, peer, sessionStore } = await makeCtx(profiles);
    seedLiveSession(sessionStore, thread, agentId, peer, [
      { id: "J1", test: "judgment", desc: "human review" },
    ]);

    const result = structured(
      await handleAtestRun(ctx, {
        thread,
        criterion_id: "J1",
        artifact_hash: hash,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toMatch(/judgment|not executable|criterion/i);
    expect(sendEnvelope).not.toHaveBeenCalled();
  });

  it("returns local error for unregistered runner without shell execution", async () => {
    const thread = crypto.randomUUID();
    const hash = "sha256:atest-run-inject";
    const profiles = [...REFERENCE_PROFILES, "atest/1"];
    const { ctx, agentId, peer, sessionStore } = await makeCtx(profiles);
    seedLiveSession(sessionStore, thread, agentId, peer, [
      { id: "A1", test: "executable", desc: "evil", runner: "spectral; rm -rf /" },
    ]);

    const result = structured(
      await handleAtestRun(ctx, {
        thread,
        criterion_id: "A1",
        artifact_hash: hash,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toMatch(/not registered|unknown runner|no match/i);
    expect(sendEnvelope).not.toHaveBeenCalled();
    expect(getArtifact).not.toHaveBeenCalled();
  });
});
