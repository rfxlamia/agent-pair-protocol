import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init as initPake } from "@agentpair/protocol";
import { createRelayApp } from "@agentpair/relay";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { HttpRelayClient } from "../relay/client.js";
import { createKeyStore } from "../store/keys.js";
import type { PendingQueue } from "../store/pending.js";
import { classifyApprovalOutcome } from "./approval-outcome.js";
import { readApprovalCode } from "./approval-test-helpers.js";
import { humanApproveInputSchema } from "./human-approve-schema.js";
import { handleHumanApprove } from "./human-approve.js";
import { createAgentContext, handlePairInit, handlePairJoin } from "./pair.js";
import { assertNoSecrets } from "./util.js";

const TEST_PORT = 13117;
const RELAY_URL = `http://127.0.0.1:${TEST_PORT}`;

type PendingQueueWithInit = PendingQueue & { init?: (secretKey: Uint8Array) => void };

function structured<T>(result: { structuredContent: T }): T {
  return result.structuredContent;
}

describe("approval-outcome classification (unit)", () => {
  it("classifies known terminal, transient, and no-consume statuses", () => {
    expect(classifyApprovalOutcome("pair_join", { status: "bonded" })).toBe("terminal");
    expect(classifyApprovalOutcome("pair_join", { status: "rolled_back" })).toBe("terminal");
    expect(classifyApprovalOutcome("pair_join", { status: "rejected" })).toBe("terminal");
    expect(classifyApprovalOutcome("pair_join", { status: "pake_failed" })).toBe("terminal");
    expect(classifyApprovalOutcome("pair_join", { error: "relay_unavailable" })).toBe("transient");
    expect(classifyApprovalOutcome("session_open", { error: "relay_unavailable" })).toBe(
      "transient",
    );
    expect(classifyApprovalOutcome("session_open", { error: "session_not_found" })).toBe(
      "terminal",
    );
    expect(classifyApprovalOutcome("budget_extend", { verified: true })).toBe(
      "unsupported_no_consume",
    );
  });
});

describe("human_approve approval_code gate", () => {
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
    await Promise.all(
      tempDirs.map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
      ),
    );
  });

  async function makeFileAgent(label: string) {
    const dataDir = await mkdtemp(join(tmpdir(), `agentpair-gate-${label}-`));
    tempDirs.push(dataDir);
    const ctx = createAgentContext({
      keyStore: createKeyStore({ keyPath: join(dataDir, "keys.json") }),
      relay: new HttpRelayClient(RELAY_URL),
      dataDir,
    });
    return { ctx, dataDir };
  }

  async function gatedRatifyPending(label: string) {
    const agent = await makeFileAgent(label);
    const keyPair = await agent.ctx.keyStore.loadOrCreate();
    (agent.ctx.pending as PendingQueueWithInit).init?.(keyPair.secretKey);
    const pending = agent.ctx.pending.addRatify({
      thread: "thread-1",
      peer: "ed25519:peer",
      artifactHash: "abc123",
    });
    const code = readApprovalCode(agent.dataDir, pending.id);
    return { ...agent, pending, code };
  }

  it("humanApproveInputSchema drops via_human and exposes approval_code", () => {
    const shape = humanApproveInputSchema.shape;
    expect(shape.via_human).toBeUndefined();
    expect(shape.approval_code).toBeDefined();
    if ("profiles" in shape) {
      expect(shape.profiles).toBeDefined();
    }
  });

  it("rejects with self_approval_forbidden when approval_code is missing", async () => {
    const bob = await gatedRatifyPending("missing-code");

    const result = structured(
      await handleHumanApprove(bob.ctx, { pending_id: bob.pending.id, decision: "approve" }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe("self_approval_forbidden");
    expect(bob.ctx.pending.get(bob.pending.id)).toBeDefined();
  });

  it("ignores a stray via_human=true and still requires approval_code", async () => {
    const bob = await gatedRatifyPending("stray-via-human");

    const result = structured(
      await handleHumanApprove(bob.ctx, {
        pending_id: bob.pending.id,
        decision: "approve",
        via_human: true,
      } as unknown as Parameters<typeof handleHumanApprove>[1]),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe("self_approval_forbidden");
  });

  it("requires approval_code even for reject", async () => {
    const bob = await gatedRatifyPending("reject-no-code");

    const result = structured(
      await handleHumanApprove(bob.ctx, {
        pending_id: bob.pending.id,
        decision: "reject:not-now",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe("self_approval_forbidden");
    expect(bob.ctx.pending.get(bob.pending.id)).toBeDefined();
  });

  it("valid code + reject:<reason> runs reject dispatch and consumes pending+file on terminal outcome", async () => {
    const bob = await gatedRatifyPending("reject-with-code");

    const result = structured(
      await handleHumanApprove(bob.ctx, {
        pending_id: bob.pending.id,
        decision: "reject:not-now",
        approval_code: bob.code,
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe("ratify_rejected");
    expect(bob.ctx.pending.get(bob.pending.id)).toBeUndefined();
    expect(() => readApprovalCode(bob.dataDir, bob.pending.id)).toThrow();
  });

  it("malformed codes never burn attempts; the 5th well-formed miss exhausts", async () => {
    const bob = await gatedRatifyPending("attempts");

    for (let i = 0; i < 10; i += 1) {
      const result = structured(
        await handleHumanApprove(bob.ctx, {
          pending_id: bob.pending.id,
          decision: "approve",
          approval_code: "abc12",
        }),
      );
      expect(result.ok).toBe(false);
      expect(result.error).toBe("invalid_approval_code");
      expect(result.malformed).toBe(true);
    }
    expect(
      (bob.ctx.pending.get(bob.pending.id) as { approvalAttempts?: number })?.approvalAttempts,
    ).toBe(0);

    const wrongCode = bob.code === "000001" ? "000002" : "000001";
    for (let i = 0; i < 4; i += 1) {
      const result = structured(
        await handleHumanApprove(bob.ctx, {
          pending_id: bob.pending.id,
          decision: "approve",
          approval_code: wrongCode,
        }),
      );
      expect(result.ok).toBe(false);
      expect(result.error).toBe("invalid_approval_code");
      expect(result.attempts_exhausted).toBeUndefined();
    }

    const fifthMiss = structured(
      await handleHumanApprove(bob.ctx, {
        pending_id: bob.pending.id,
        decision: "approve",
        approval_code: wrongCode,
      }),
    );
    expect(fifthMiss.ok).toBe(false);
    expect(fifthMiss.error).toBe("invalid_approval_code");
    expect(fifthMiss.attempts_exhausted).toBe(true);
    expect(bob.ctx.pending.get(bob.pending.id)).toBeUndefined();

    const sixthCall = structured(
      await handleHumanApprove(bob.ctx, {
        pending_id: bob.pending.id,
        decision: "approve",
        approval_code: bob.code,
      }),
    );
    expect(sixthCall.ok).toBe(false);
    expect(sixthCall.error).toBe("pending_not_found");
  });

  it("verifies a code submitted with leading/trailing whitespace after strip", async () => {
    const bob = await gatedRatifyPending("whitespace-code");

    const result = structured(
      await handleHumanApprove(bob.ctx, {
        pending_id: bob.pending.id,
        decision: "approve",
        approval_code: ` ${bob.code} `,
      }),
    );

    expect(result.error).not.toBe("invalid_approval_code");
    expect(result.error).not.toBe("self_approval_forbidden");
    expect(bob.ctx.pending.get(bob.pending.id)).toBeUndefined();
    expect(() => readApprovalCode(bob.dataDir, bob.pending.id)).toThrow();
  });

  it("expired session_open pending returns pending_not_found and leaves attempts untouched", async () => {
    const bob = await makeFileAgent("expired-session");
    const keyPair = await bob.ctx.keyStore.loadOrCreate();
    (bob.ctx.pending as PendingQueueWithInit).init?.(keyPair.secretKey);
    const pending = bob.ctx.pending.addSessionOpen({
      thread: "thread-expired",
      from: "ed25519:alice",
      goal: "g",
      acceptance: [],
      budget: { max_turns: 5, deadline: "2030-01-01T00:00:00.000Z" },
      mandate: { agent_may: [], human_required: [] },
      expiresAt: Date.now() - 1_000,
    });
    const code = readApprovalCode(bob.dataDir, pending.id);

    const result = structured(
      await handleHumanApprove(bob.ctx, {
        pending_id: pending.id,
        decision: "approve",
        approval_code: code,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe("pending_not_found");
    expect(bob.ctx.pending.get(pending.id)).toBeUndefined();
    expect(() => readApprovalCode(bob.dataDir, pending.id)).toThrow();
  });

  it("valid code with an unparseable decision does not consume the pending or burn attempts", async () => {
    const bob = await gatedRatifyPending("invalid-decision");

    const result = structured(
      await handleHumanApprove(bob.ctx, {
        pending_id: bob.pending.id,
        decision: "maybe-later",
        approval_code: bob.code,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid_decision");
    expect(
      (bob.ctx.pending.get(bob.pending.id) as { approvalAttempts?: number })?.approvalAttempts,
    ).toBe(0);
  });

  it("budget_extend verifies successfully but returns unsupported_pending_kind without consuming", async () => {
    const bob = await makeFileAgent("budget-extend");
    const keyPair = await bob.ctx.keyStore.loadOrCreate();
    (bob.ctx.pending as PendingQueueWithInit).init?.(keyPair.secretKey);
    const pending = bob.ctx.pending.addBudgetExtend({
      thread: "thread-budget",
      peer: "ed25519:alice",
    });
    const code = readApprovalCode(bob.dataDir, pending.id);

    const result = structured(
      await handleHumanApprove(bob.ctx, {
        pending_id: pending.id,
        decision: "approve",
        approval_code: code,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe("unsupported_pending_kind");
    expect(bob.ctx.pending.get(pending.id)).toBeDefined();
    expect(readApprovalCode(bob.dataDir, pending.id)).toBe(code);
  });

  it("keeps pending+code valid on a transient relay failure after verify (mocked network throw)", async () => {
    const alice = await makeFileAgent("alice-transient");
    const bob = await makeFileAgent("bob-transient");

    const initResult = structured(
      await handlePairInit(alice.ctx, {
        scope: ["session.negotiate"],
        mode: "ephemeral_until_session_closes",
      }),
    );
    if (!initResult.ok) throw new Error("pair init failed");
    const joinResult = structured(await handlePairJoin(bob.ctx, { code: initResult.code }));
    if (!joinResult.ok) throw new Error("pair join failed");

    const code = readApprovalCode(bob.dataDir, joinResult.pending_id);
    vi.spyOn(bob.ctx.relay, "putAllowlist").mockRejectedValue(new Error("ECONNREFUSED"));

    const result = structured(
      await handleHumanApprove(bob.ctx, {
        pending_id: joinResult.pending_id,
        decision: "approve",
        approval_code: code,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe("relay_unavailable");
    expect(bob.ctx.pending.get(joinResult.pending_id)).toBeDefined();
    expect(readApprovalCode(bob.dataDir, joinResult.pending_id)).toBe(code);
    expect(JSON.stringify(result)).toMatch(/retry.*same code/i);
  });

  it("terminal downstream failure after verify consumes pending+file (ratify against unknown session)", async () => {
    const bob = await gatedRatifyPending("terminal-fail");

    const result = structured(
      await handleHumanApprove(bob.ctx, {
        pending_id: bob.pending.id,
        decision: "approve",
        approval_code: bob.code,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).not.toBe("relay_unavailable");
    expect(bob.ctx.pending.get(bob.pending.id)).toBeUndefined();
    expect(() => readApprovalCode(bob.dataDir, bob.pending.id)).toThrow();
  });

  it("terminal rolled_back after verify consumes the pair_join pending+file (mocked allowlist push failure)", async () => {
    const alice = await makeFileAgent("alice-rollback");
    const bob = await makeFileAgent("bob-rollback");

    const initResult = structured(
      await handlePairInit(alice.ctx, {
        scope: ["session.negotiate"],
        mode: "ephemeral_until_session_closes",
      }),
    );
    if (!initResult.ok) throw new Error("pair init failed");
    const joinResult = structured(await handlePairJoin(bob.ctx, { code: initResult.code }));
    if (!joinResult.ok) throw new Error("pair join failed");

    const code = readApprovalCode(bob.dataDir, joinResult.pending_id);
    vi.spyOn(bob.ctx.relay, "putAllowlist").mockResolvedValue({ ok: false });

    const result = structured(
      await handleHumanApprove(bob.ctx, {
        pending_id: joinResult.pending_id,
        decision: "approve",
        approval_code: code,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe("rolled_back");
    expect(bob.ctx.pending.get(joinResult.pending_id)).toBeUndefined();
    expect(() => readApprovalCode(bob.dataDir, joinResult.pending_id)).toThrow();
  });

  it("exactly one of two concurrent valid approves consumes the pending", async () => {
    const bob = await gatedRatifyPending("concurrent");

    const [first, second] = await Promise.all([
      handleHumanApprove(bob.ctx, {
        pending_id: bob.pending.id,
        decision: "approve",
        approval_code: bob.code,
      }),
      handleHumanApprove(bob.ctx, {
        pending_id: bob.pending.id,
        decision: "approve",
        approval_code: bob.code,
      }),
    ]);

    const results = [structured(first), structured(second)];
    const pendingNotFound = results.filter((r) => !r.ok && r.error === "pending_not_found");
    const other = results.filter((r) => r.error !== "pending_not_found");
    expect(pendingNotFound).toHaveLength(1);
    expect(other).toHaveLength(1);
    expect(other[0].error).not.toBe("invalid_approval_code");
    expect(bob.ctx.pending.get(bob.pending.id)).toBeUndefined();
  });

  it("assertNoSecrets throws on a tool-shaped object leaking approvalCodeVerifier", () => {
    expect(() =>
      assertNoSecrets({ ok: true, pending_id: "p1", approvalCodeVerifier: "leak" }),
    ).toThrow();
  });
});
