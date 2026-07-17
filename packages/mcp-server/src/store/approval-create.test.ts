import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init as initPake } from "@agentpair/protocol";
import { createRelayApp } from "@agentpair/relay";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { HttpRelayClient } from "../relay/client.js";
import { handleInbox } from "../tools/inbox.js";
import {
  createAgentContext,
  executePairJoinApproval,
  handlePairInit,
  handlePairInitComplete,
  handlePairJoin,
} from "../tools/pair.js";
import { handleSessionOpen, handleSessionStatus } from "../tools/session.js";
import { flushAgentContext } from "./flush-context.js";
import { createKeyStore } from "./keys.js";
import type { PendingQueue } from "./pending.js";

const TEST_PORT = 13116;
const RELAY_URL = `http://127.0.0.1:${TEST_PORT}`;

type PendingQueueWithInit = PendingQueue & { init?: (secretKey: Uint8Array) => void };

const SESSION_OPEN_INPUT = {
  acceptance: [{ id: "A1", test: "executable" as const, desc: "probe", runner: "payload-size" }],
  budget: { max_turns: 10, deadline: "2030-06-01T12:00:00.000Z" },
  mandate: { agent_may: ["propose"], human_required: ["sign_final"] },
};

function structured<T>(result: { structuredContent: T }): T {
  return result.structuredContent;
}

describe("approval-create — gated create-path + approval_path surfacing", () => {
  let server: ServerType;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    await initPake();
    const { app } = createRelayApp({ rateLimitWindowMs: 60_000, rateLimitMax: 200 });
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: TEST_PORT }, resolve);
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function makeFileAgent(label: string) {
    const dataDir = await mkdtemp(join(tmpdir(), `agentpair-create-${label}-`));
    tempDirs.push(dataDir);
    const ctx = createAgentContext({
      keyStore: createKeyStore({ keyPath: join(dataDir, "keys.json") }),
      relay: new HttpRelayClient(RELAY_URL),
      dataDir,
    });
    return { ctx, dataDir };
  }

  it("pair_join queues a gated pending with approval_path and no plaintext code/verifier", async () => {
    const alice = await makeFileAgent("alice-pj");
    const bob = await makeFileAgent("bob-pj");

    const initResult = structured(
      await handlePairInit(alice.ctx, {
        scope: ["session.negotiate"],
        mode: "ephemeral_until_session_closes",
      }),
    );
    expect(initResult.ok).toBe(true);
    if (!initResult.ok) return;

    const joinResult = structured(await handlePairJoin(bob.ctx, { code: initResult.code }));
    expect(joinResult.ok).toBe(true);
    if (!joinResult.ok) return;

    expect(typeof joinResult.approval_path).toBe("string");
    expect(joinResult.approval_path).toContain(joinResult.pending_id);

    const fileStat = await stat(joinResult.approval_path as string);
    expect(fileStat.mode & 0o777).toBe(0o600);

    const raw = JSON.stringify(joinResult);
    expect(raw).not.toMatch(/approvalCodeVerifier/i);
    expect(raw).not.toMatch(/\b\d{6}\b/);
  });

  it("session_open pending surfaced via inbox/status includes approval_path", async () => {
    const alice = await makeFileAgent("alice-so");
    const bob = await makeFileAgent("bob-so");

    const initResult = structured(
      await handlePairInit(alice.ctx, {
        scope: ["session.negotiate"],
        mode: "bonded_contact",
      }),
    );
    if (!initResult.ok) throw new Error("pair init failed");
    const joinResult = structured(await handlePairJoin(bob.ctx, { code: initResult.code }));
    if (!joinResult.ok) throw new Error("pair join failed");

    const completeInitPromise = handlePairInitComplete(alice.ctx, { code: initResult.code });
    const bond = await executePairJoinApproval(bob.ctx, {
      code: initResult.code,
      decision: { approve: true },
    });
    if (bond.status !== "bonded") {
      throw new Error(`bond failed: ${JSON.stringify(bond)}`);
    }
    bob.ctx.pending.remove(joinResult.pending_id);
    const bobKeysForBond = await bob.ctx.keyStore.loadOrCreate();
    const { publicKeyToAgentId: toId } = await import("@agentpair/protocol");
    bob.ctx.bonds.add(toId(bobKeysForBond.publicKey), bond.bond);
    const initComplete = await completeInitPromise;
    if (initComplete.status !== "bonded") {
      throw new Error(`initiator complete failed: ${JSON.stringify(initComplete)}`);
    }

    const bobKeys = await bob.ctx.keyStore.loadOrCreate();
    const { publicKeyToAgentId } = await import("@agentpair/protocol");
    const bobId = publicKeyToAgentId(bobKeys.publicKey);

    const opened = structured(
      await handleSessionOpen(alice.ctx, {
        to: bobId,
        goal: "approval path surfaced",
        ...SESSION_OPEN_INPUT,
      }),
    );
    if (!opened.ok) throw new Error(`session_open failed: ${JSON.stringify(opened)}`);

    const bobInbox = structured(await handleInbox(bob.ctx, { since: 0 }));
    expect(bobInbox.ok).toBe(true);

    const bobPending = bob.ctx.pending.list().find((item) => item.kind === "session_open");
    expect(bobPending).toBeDefined();
    if (!bobPending) return;

    const bobStatus = structured(await handleSessionStatus(bob.ctx, { thread: opened.thread }));
    expect(bobStatus.pending_id).toBe(bobPending.id);
    expect(typeof bobStatus.approval_path).toBe("string");
    expect(bobStatus.approval_path).toContain(bobPending.id);
    expect(JSON.stringify(bobStatus)).not.toMatch(/approvalCodeVerifier/i);
    expect(JSON.stringify(bobStatus)).not.toMatch(/\b\d{6}\b/);
  });

  it("budget_extend pending gets a verifier + approval file and survives an AgentContext restart", async () => {
    const bob = await makeFileAgent("bob-budget");
    const keyPair = await bob.ctx.keyStore.loadOrCreate();
    (bob.ctx.pending as PendingQueueWithInit).init?.(keyPair.secretKey);

    const item = bob.ctx.pending.addBudgetExtend({ thread: "t1", peer: "ed25519:alice" });
    expect(typeof (item as { approvalCodeVerifier?: string }).approvalCodeVerifier).toBe("string");

    const filePath = join(bob.dataDir, "approvals", item.id);
    const fileStat = await stat(filePath);
    expect(fileStat.mode & 0o777).toBe(0o600);

    await flushAgentContext(bob.ctx);

    const restarted = createAgentContext({
      keyStore: createKeyStore({ keyPath: join(bob.dataDir, "keys.json") }),
      relay: new HttpRelayClient(RELAY_URL),
      dataDir: bob.dataDir,
    });
    expect(restarted.pending.get(item.id)?.kind).toBe("budget_extend");
  });

  it("ratify create-path writes approval file + verifier (fourth kind)", async () => {
    const bob = await makeFileAgent("bob-ratify");
    const keyPair = await bob.ctx.keyStore.loadOrCreate();
    (bob.ctx.pending as PendingQueueWithInit).init?.(keyPair.secretKey);

    const item = bob.ctx.pending.addRatify({
      thread: "thread-ratify",
      peer: "ed25519:alice",
      artifactHash: "deadbeef",
    });
    expect(typeof (item as { approvalCodeVerifier?: string }).approvalCodeVerifier).toBe("string");
    expect((item as { approvalAttempts?: number }).approvalAttempts).toBe(0);

    const filePath = join(bob.dataDir, "approvals", item.id);
    const fileStat = await stat(filePath);
    expect(fileStat.mode & 0o777).toBe(0o600);
  });

  it("returns approval_channel_unavailable and stores no pending when the approval file write fails", async () => {
    const alice = await makeFileAgent("alice-fail");
    const bob = await makeFileAgent("bob-fail");
    await writeFile(join(bob.dataDir, "approvals"), "blocked", "utf8");

    const initResult = structured(
      await handlePairInit(alice.ctx, {
        scope: ["session.negotiate"],
        mode: "ephemeral_until_session_closes",
      }),
    );
    if (!initResult.ok) throw new Error("pair init failed");

    const joinResult = structured(await handlePairJoin(bob.ctx, { code: initResult.code }));
    expect(joinResult.ok).toBe(false);
    expect(joinResult.error).toBe("approval_channel_unavailable");
    expect(bob.ctx.pending.list()).toHaveLength(0);
  });

  it("prints the approval code to stderr once, best-effort (does not fail create if stderr throws)", async () => {
    const alice = await makeFileAgent("alice-stderr");
    const bob = await makeFileAgent("bob-stderr");
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("stderr unavailable");
    });

    const initResult = structured(
      await handlePairInit(alice.ctx, {
        scope: ["session.negotiate"],
        mode: "ephemeral_until_session_closes",
      }),
    );
    if (!initResult.ok) throw new Error("pair init failed");

    const joinResult = structured(await handlePairJoin(bob.ctx, { code: initResult.code }));
    expect(joinResult.ok).toBe(true);

    const codeLines = stderrSpy.mock.calls.filter((call) => /\b\d{6}\b/.test(call.join(" ")));
    expect(codeLines.length).toBeGreaterThanOrEqual(1);

    stderrSpy.mockRestore();
  });

  it("maps gated add* write failure on session_open create to structured approval_channel_unavailable", async () => {
    const alice = await makeFileAgent("alice-so-fail");
    const bob = await makeFileAgent("bob-so-fail");
    const initResult = structured(
      await handlePairInit(alice.ctx, {
        scope: ["session.negotiate"],
        mode: "bonded_contact",
      }),
    );
    if (!initResult.ok) throw new Error("pair init failed");
    const joinResult = structured(await handlePairJoin(bob.ctx, { code: initResult.code }));
    if (!joinResult.ok) throw new Error("pair join failed");
    const completeInitPromise = handlePairInitComplete(alice.ctx, { code: initResult.code });
    const bond = await executePairJoinApproval(bob.ctx, {
      code: initResult.code,
      decision: { approve: true },
    });
    if (bond.status !== "bonded") throw new Error(`bond failed: ${JSON.stringify(bond)}`);
    bob.ctx.pending.remove(joinResult.pending_id);
    const bobKeysForBond = await bob.ctx.keyStore.loadOrCreate();
    const { publicKeyToAgentId: toId } = await import("@agentpair/protocol");
    bob.ctx.bonds.add(toId(bobKeysForBond.publicKey), bond.bond);
    const initComplete = await completeInitPromise;
    if (initComplete.status !== "bonded") {
      throw new Error(`initiator complete failed: ${JSON.stringify(initComplete)}`);
    }

    await rm(join(bob.dataDir, "approvals"), { recursive: true, force: true });
    await writeFile(join(bob.dataDir, "approvals"), "blocked", "utf8");
    const bobKeys = await bob.ctx.keyStore.loadOrCreate();
    const { publicKeyToAgentId } = await import("@agentpair/protocol");
    const bobId = publicKeyToAgentId(bobKeys.publicKey);

    const opened = structured(
      await handleSessionOpen(alice.ctx, {
        to: bobId,
        goal: "channel fail on bob create",
        ...SESSION_OPEN_INPUT,
      }),
    );
    if (!opened.ok) throw new Error(`session_open failed: ${JSON.stringify(opened)}`);

    const bobInbox = structured(await handleInbox(bob.ctx, { since: 0 }));
    expect(bob.ctx.pending.list().filter((p) => p.kind === "session_open")).toHaveLength(0);
    const raw = JSON.stringify(bobInbox);
    expect(raw).toMatch(/approval_channel_unavailable/);
  });
});
