// packages/mcp-server/src/tools/inbox-wait.test.ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DualRelayEnv,
  createDualAgent,
  runPairingFlow,
  startDualRelay,
} from "../e2e/dual-server.js";
import { HttpRelayClient } from "../relay/client.js";
import { MemoryAllowlistStore } from "../store/allowlist.js";
import { createKeyStore } from "../store/keys.js";
import {
  DEFAULT_WAIT_TIMEOUT_MS,
  MAX_WAIT_TIMEOUT_MS,
  type WaitDeps,
  handleInboxWait,
  hasDeliverableMail,
} from "./inbox-wait.js";
import * as inbox from "./inbox.js";
import type { AgentContext } from "./pair.js";
import { createAgentContext } from "./pair.js";
import { handleSessionOpen } from "./session.js";
import { toolTextResult } from "./util.js";

function structured<T>(result: { structuredContent: T }): T {
  return result.structuredContent;
}

const TEST_DEADLINE = "2030-06-01T12:00:00.000Z";

function emptyInboxOk(overrides: Record<string, unknown> = {}) {
  return toolTextResult({
    ok: true,
    since: 0,
    since_used: 0,
    cursor: 0,
    new_count: 0,
    filtered_count: 0,
    bonded_peers: [],
    envelopes: [],
    ...overrides,
  });
}

function inboxError(error: string, extras: Record<string, unknown> = {}) {
  return toolTextResult({ ok: false, error, ...extras });
}

async function makeStubCtx(): Promise<AgentContext> {
  const dir = await mkdtemp(join(tmpdir(), "agentpair-inbox-wait-unit-"));
  return createAgentContext({
    keyStore: createKeyStore({ keyPath: join(dir, "keys.json") }),
    relay: new HttpRelayClient("http://127.0.0.1:9"),
    allowlist: new MemoryAllowlistStore(),
    dataDir: dir,
  });
}

/** Deterministic clock: sleep resolves immediately and advances nowMs. No vi.useFakeTimers. */
function makeTimerDeps(startMs = 0): WaitDeps & { sleeps: number[] } {
  let nowMs = startMs;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => nowMs,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      nowMs += ms;
      await Promise.resolve();
    },
  };
}

describe("hasDeliverableMail", () => {
  it("returns true when envelopes or rejected are non-empty", () => {
    expect(hasDeliverableMail(structured(emptyInboxOk()))).toBe(false);
    expect(
      hasDeliverableMail(structured(emptyInboxOk({ envelopes: [{ id: "e1", type: "core.msg" }] }))),
    ).toBe(true);
    expect(hasDeliverableMail(structured(emptyInboxOk({ rejected: [{ error: "bad_sig" }] })))).toBe(
      true,
    );
  });
});

describe("inbox-wait unit", () => {
  let handleInboxSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Injectable WaitDeps only — do NOT call vi.useFakeTimers (conflicts with mkdtemp; redundant with deps).
    handleInboxSpy = vi.spyOn(inbox, "handleInbox");
  });

  afterEach(() => {
    handleInboxSpy.mockRestore();
  });

  it("returns immediately when mail is pre-queued", async () => {
    const ctx = await makeStubCtx();
    handleInboxSpy.mockResolvedValue(
      emptyInboxOk({
        new_count: 1,
        envelopes: [{ id: "e1", type: "core.msg", from: "peer", payload: {} }],
      }),
    );

    const deps = makeTimerDeps();
    const result = structured(await handleInboxWait(ctx, {}, deps));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.timed_out).toBe(false);
    expect(result.waited_ms).toBeLessThanOrEqual(50);
    expect(handleInboxSpy).toHaveBeenCalledTimes(1);
    expect(deps.sleeps).toHaveLength(0);
  });

  it("times out after default 30s with healthy empty inbox", async () => {
    const ctx = await makeStubCtx();
    handleInboxSpy.mockImplementation(async () => emptyInboxOk());

    const deps = makeTimerDeps();
    const result = structured(await handleInboxWait(ctx, {}, deps));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.timed_out).toBe(true);
    expect(result.new_count).toBe(0);
    expect(result.waited_ms).toBeGreaterThanOrEqual(DEFAULT_WAIT_TIMEOUT_MS - 500);
    expect(result.waited_ms).toBeLessThanOrEqual(DEFAULT_WAIT_TIMEOUT_MS + 500);
    expect(handleInboxSpy.mock.calls.length).toBeGreaterThan(1);
  });

  it("clamps timeout_ms 120000 to MAX_WAIT_TIMEOUT_MS (55s)", async () => {
    const ctx = await makeStubCtx();
    handleInboxSpy.mockImplementation(async () => emptyInboxOk());

    const deps = makeTimerDeps();
    const result = structured(await handleInboxWait(ctx, { timeout_ms: 120_000 }, deps));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.timed_out).toBe(true);
    expect(result.waited_ms).toBeLessThanOrEqual(MAX_WAIT_TIMEOUT_MS + 500);
  });

  it("retries transient inbox_pull_failed_429 then succeeds", async () => {
    const ctx = await makeStubCtx();
    handleInboxSpy
      .mockResolvedValueOnce(inboxError("inbox_pull_failed_429", { retry_after_ms: 2000 }))
      .mockResolvedValueOnce(
        emptyInboxOk({
          envelopes: [{ id: "e1", type: "core.msg" }],
          new_count: 1,
        }),
      );

    const deps = makeTimerDeps();
    const result = structured(await handleInboxWait(ctx, { timeout_ms: 10_000 }, deps));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.timed_out).toBe(false);
    expect(result.envelopes).toHaveLength(1);
    expect(handleInboxSpy).toHaveBeenCalledTimes(2);
    expect(deps.sleeps.some((ms) => ms >= 2000)).toBe(true);
  });

  it("retries relay_unavailable then succeeds", async () => {
    const ctx = await makeStubCtx();
    handleInboxSpy
      .mockResolvedValueOnce(inboxError("relay_unavailable"))
      .mockResolvedValueOnce(emptyInboxOk({ envelopes: [{ id: "e1", type: "core.msg" }] }));

    const deps = makeTimerDeps();
    const result = structured(await handleInboxWait(ctx, { timeout_ms: 10_000 }, deps));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.timed_out).toBe(false);
    expect(handleInboxSpy).toHaveBeenCalledTimes(2);
  });

  it("retries inbox_pull_failed_502 (any 5xx) until success", async () => {
    const ctx = await makeStubCtx();
    handleInboxSpy
      .mockResolvedValueOnce(inboxError("inbox_pull_failed_502"))
      .mockResolvedValueOnce(inboxError("inbox_pull_failed_500"))
      .mockResolvedValueOnce(emptyInboxOk({ envelopes: [{ id: "e1", type: "core.msg" }] }));

    const deps = makeTimerDeps();
    const result = structured(await handleInboxWait(ctx, { timeout_ms: 15_000 }, deps));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.timed_out).toBe(false);
    expect(handleInboxSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("treats handleInbox throw as transient network blip then succeeds", async () => {
    const ctx = await makeStubCtx();
    handleInboxSpy
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(emptyInboxOk({ envelopes: [{ id: "e1", type: "core.msg" }] }));

    const deps = makeTimerDeps();
    const result = structured(await handleInboxWait(ctx, { timeout_ms: 10_000 }, deps));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.timed_out).toBe(false);
    expect(handleInboxSpy).toHaveBeenCalledTimes(2);
  });

  it("ends wait on rejected-only pull (no envelopes)", async () => {
    const ctx = await makeStubCtx();
    handleInboxSpy.mockResolvedValue(
      emptyInboxOk({ rejected: [{ id: "bad", error: "invalid_signature", cursor: 1 }] }),
    );

    const result = structured(await handleInboxWait(ctx, {}, makeTimerDeps()));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.timed_out).toBe(false);
    expect(result.rejected).toHaveLength(1);
  });

  it("returns sick timeout when every pull fails transiently", async () => {
    const ctx = await makeStubCtx();
    handleInboxSpy.mockImplementation(async () => inboxError("relay_unavailable"));

    const deps = makeTimerDeps();
    const result = structured(await handleInboxWait(ctx, { timeout_ms: 5000 }, deps));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("relay_unavailable");
    expect(result.waited_ms).toBeGreaterThan(0);
    expect("timed_out" in result).toBe(false);
  });

  it("fail-fast on non-transient unexpected_challenge_status", async () => {
    const ctx = await makeStubCtx();
    handleInboxSpy.mockResolvedValue(inboxError("unexpected_challenge_status"));

    const deps = makeTimerDeps();
    const result = structured(await handleInboxWait(ctx, { timeout_ms: 30_000 }, deps));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("unexpected_challenge_status");
    expect(result.waited_ms).toBeGreaterThanOrEqual(0);
    expect(handleInboxSpy).toHaveBeenCalledTimes(1);
    expect(deps.sleeps).toHaveLength(0);
  });

  it("continues waiting when only filtered_count > 0", async () => {
    const ctx = await makeStubCtx();
    handleInboxSpy.mockResolvedValueOnce(emptyInboxOk({ filtered_count: 2 })).mockResolvedValueOnce(
      emptyInboxOk({
        envelopes: [{ id: "e1", type: "core.msg" }],
        new_count: 1,
      }),
    );

    const deps = makeTimerDeps();
    const result = structured(await handleInboxWait(ctx, { timeout_ms: 10_000 }, deps));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.timed_out).toBe(false);
    expect(handleInboxSpy).toHaveBeenCalledTimes(2);
  });

  it("continues waiting on metadata-only relay_gaps", async () => {
    const ctx = await makeStubCtx();
    handleInboxSpy
      .mockResolvedValueOnce(
        emptyInboxOk({
          relay_gaps: [{ thread: "t1", last_good_seq: 1, expected_seq: 2 }],
        }),
      )
      .mockResolvedValueOnce(emptyInboxOk({ envelopes: [{ id: "e1", type: "core.msg" }] }));

    const deps = makeTimerDeps();
    const result = structured(await handleInboxWait(ctx, { timeout_ms: 10_000 }, deps));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.timed_out).toBe(false);
    expect(handleInboxSpy).toHaveBeenCalledTimes(2);
  });

  it("passes since only on the first handleInbox call", async () => {
    const ctx = await makeStubCtx();
    handleInboxSpy.mockImplementation(async () => emptyInboxOk({ cursor: 42 }));

    const deps = makeTimerDeps();
    await handleInboxWait(ctx, { since: 7, timeout_ms: 5000 }, deps);

    expect(handleInboxSpy.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ since: 7 }));
    for (const call of handleInboxSpy.mock.calls.slice(1)) {
      expect(call[1]?.since).toBeUndefined();
    }
  });

  it("adds only timed_out and waited_ms beyond inbox success keys", async () => {
    const ctx = await makeStubCtx();
    const base = {
      ok: true as const,
      since: 0,
      since_used: 0,
      cursor: 5,
      new_count: 1,
      filtered_count: 0,
      bonded_peers: ["peer"],
      envelopes: [{ id: "e1", type: "core.msg" }],
    };
    handleInboxSpy.mockResolvedValue(toolTextResult(base));

    const result = structured(await handleInboxWait(ctx, {}, makeTimerDeps()));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result).sort()).toEqual(
      [...Object.keys({ ...base, timed_out: false, waited_ms: 0 })].sort(),
    );
    expect(result.timed_out).toBe(false);
    expect(typeof result.waited_ms).toBe("number");
  });
});

describe("inbox-wait integration", () => {
  let env: DualRelayEnv;

  beforeAll(async () => {
    // Port 13340 — avoid collision with spillover-roundtrip (13224) and other dual-server tests
    env = await startDualRelay(13340);
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it("returns pending_id when nego.open arrives during wait", async () => {
    const alice = await createDualAgent(env, "wait-alice");
    const bob = await createDualAgent(env, "wait-bob");
    await runPairingFlow(alice, bob);

    const waitPromise = handleInboxWait(bob.ctx, { timeout_ms: 15_000 });

    await handleSessionOpen(alice.ctx, {
      to: bob.agentId,
      goal: "Inbox wait human gate probe",
      acceptance: [{ id: "A1", test: "executable", desc: "probe", runner: "payload-size" }],
      budget: { max_turns: 10, deadline: TEST_DEADLINE },
      mandate: { agent_may: ["propose"], human_required: ["sign_final"] },
    });

    const result = structured(await waitPromise);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.timed_out).toBe(false);
    expect(result.envelopes.some((e) => e.type === "nego.open")).toBe(true);
    const negoOpen = result.envelopes.find((e) => e.type === "nego.open");
    expect(negoOpen?.pending_id).toBeTypeOf("string");
  }, 20000);
});
