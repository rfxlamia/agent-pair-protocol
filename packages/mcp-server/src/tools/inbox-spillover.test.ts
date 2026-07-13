import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REFERENCE_PROFILES, hasSpillMarker } from "@agentpair/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type DualRelayEnv,
  createDualAgent,
  runPairingFlow,
  startDualRelay,
} from "../e2e/dual-server.js";
import type { HttpRelayClient } from "../relay/client.js";
import { MemoryAllowlistStore } from "../store/allowlist.js";
import { MemoryBondStore } from "../store/bonds.js";
import { MemoryInboxCursorStore } from "../store/inbox-cursor.js";
import { createKeyStore } from "../store/keys.js";
import { createPendingQueue } from "../store/pending.js";
import { handleClose, handleInbox, handleSend } from "./inbox.js";
import { createAgentContext } from "./pair.js";
import { handleSessionStatus } from "./session.js";

function structured<T>(result: { structuredContent: T }): T {
  return result.structuredContent;
}

function largeText(chars = 70_000): string {
  return "x".repeat(chars);
}

async function pairOnRelay(env: DualRelayEnv, label: string) {
  const alice = await createDualAgent(env, `${label}-alice`);
  const bob = await createDualAgent(env, `${label}-bob`);
  await runPairingFlow(alice, bob);
  return { alice, bob };
}

async function makeStubBondedPair() {
  const [aliceDir, bobDir] = await Promise.all([
    mkdtemp(join(tmpdir(), "agentpair-spill-alice-")),
    mkdtemp(join(tmpdir(), "agentpair-spill-bob-")),
  ]);
  const allowlistAlice = new MemoryAllowlistStore();
  const allowlistBob = new MemoryAllowlistStore();
  const bondsAlice = new MemoryBondStore();
  const bondsBob = new MemoryBondStore();
  const relay = {
    sendEnvelope: vi.fn(async () => undefined),
    pullInbox: vi.fn(),
    putArtifact: vi.fn(async () => undefined),
    getArtifact: vi.fn(),
  };

  const aliceCtx = createAgentContext({
    keyStore: createKeyStore({ keyPath: join(aliceDir, "keys.json") }),
    relay: relay as unknown as HttpRelayClient,
    allowlist: allowlistAlice,
    bonds: bondsAlice,
    pending: createPendingQueue(),
    inboxCursor: new MemoryInboxCursorStore(),
  });
  const bobCtx = createAgentContext({
    keyStore: createKeyStore({ keyPath: join(bobDir, "keys.json") }),
    relay: relay as unknown as HttpRelayClient,
    allowlist: allowlistBob,
    bonds: bondsBob,
    pending: createPendingQueue(),
    inboxCursor: new MemoryInboxCursorStore(),
  });

  const aliceKeys = await aliceCtx.keyStore.loadOrCreate();
  const bobKeys = await bobCtx.keyStore.loadOrCreate();
  const { publicKeyToAgentId } = await import("@agentpair/protocol");
  const aliceId = publicKeyToAgentId(aliceKeys.publicKey);
  const bobId = publicKeyToAgentId(bobKeys.publicKey);

  allowlistAlice.set(aliceId, [bobId]);
  allowlistBob.set(bobId, [aliceId]);
  bondsAlice.add(aliceId, {
    peer: bobId,
    scope: ["msg"],
    mode: "bonded_contact",
    profiles: [...REFERENCE_PROFILES],
  });
  bondsBob.add(bobId, {
    peer: aliceId,
    scope: ["msg"],
    mode: "bonded_contact",
    profiles: [...REFERENCE_PROFILES],
  });

  await aliceCtx.envelopeSeq.init(aliceId);
  await bobCtx.envelopeSeq.init(bobId);

  return { aliceCtx, bobCtx, aliceId, bobId, relay, aliceDir, bobDir };
}

describe("inbox spillover", () => {
  let env: DualRelayEnv;

  beforeAll(async () => {
    env = await startDualRelay(13223);
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it("handleSend large body spills and receiver gets original body", async () => {
    const { alice, bob } = await pairOnRelay(env, "spill-send");
    const originalBody = largeText();
    const thread = crypto.randomUUID();

    const sent = structured(
      await handleSend(alice.ctx, { to: bob.agentId, body: originalBody, thread }),
    );
    expect(sent.ok).toBe(true);

    const inbox = structured(await handleInbox(bob.ctx, {}));
    expect(inbox.ok).toBe(true);
    if (!inbox.ok) {
      return;
    }
    expect(inbox.envelopes).toHaveLength(1);
    const msg = inbox.envelopes[0];
    expect(msg?.type).toBe("core.msg");
    expect(msg?.payload).toEqual({ body: originalBody });
    expect(hasSpillMarker(msg?.payload)).toBe(false);
  });

  it("handleClose large reason spills", async () => {
    const { alice, bob } = await pairOnRelay(env, "spill-close");
    const thread = crypto.randomUUID();
    const reason = largeText();

    const closed = structured(await handleClose(alice.ctx, { thread, to: bob.agentId, reason }));
    expect(closed.ok).toBe(true);

    const inbox = structured(await handleInbox(bob.ctx, {}));
    expect(inbox.ok).toBe(true);
    if (!inbox.ok) {
      return;
    }
    const closeEnv = inbox.envelopes.find((e) => e.type === "core.close");
    expect(closeEnv?.payload).toEqual({ reason });
    expect(hasSpillMarker(closeEnv?.payload)).toBe(false);
  });

  it("artifact_fetch_failed → rejected retryable:true + cursor", async () => {
    const { alice, bob } = await pairOnRelay(env, "fetch-fail");
    const thread = crypto.randomUUID();
    const sent = structured(
      await handleSend(alice.ctx, {
        to: bob.agentId,
        body: largeText(),
        thread,
      }),
    );
    expect(sent.ok).toBe(true);

    const fetchError = Object.assign(new Error("artifact_fetch_failed"), {
      code: "artifact_fetch_failed",
    });
    const getArtifactSpy = vi.spyOn(bob.ctx.relay, "getArtifact").mockRejectedValueOnce(fetchError);

    const inbox = structured(await handleInbox(bob.ctx, {}));
    getArtifactSpy.mockRestore();

    expect(inbox.ok).toBe(true);
    if (!inbox.ok) {
      return;
    }
    expect(inbox.envelopes).toHaveLength(0);
    expect(inbox.rejected).toEqual([
      expect.objectContaining({
        error: "artifact_fetch_failed",
        retryable: true,
        cursor: expect.any(Number),
      }),
    ]);
    expect(inbox.rejected?.some((r) => r.error === "relay_unavailable")).toBe(false);
  });

  it("artifact_not_found → terminal, not retryable", async () => {
    const { alice, bob } = await pairOnRelay(env, "not-found");
    const thread = crypto.randomUUID();
    const sent = structured(
      await handleSend(alice.ctx, {
        to: bob.agentId,
        body: largeText(),
        thread,
      }),
    );
    expect(sent.ok).toBe(true);

    const notFound = Object.assign(new Error("artifact_not_found"), {
      code: "artifact_not_found",
    });
    const getArtifactSpy = vi.spyOn(bob.ctx.relay, "getArtifact").mockRejectedValue(notFound);

    const inbox = structured(await handleInbox(bob.ctx, {}));
    getArtifactSpy.mockRestore();

    expect(inbox.ok).toBe(true);
    if (!inbox.ok) {
      return;
    }
    expect(inbox.envelopes).toHaveLength(0);
    expect(inbox.rejected).toEqual([
      expect.objectContaining({
        error: "artifact_not_found",
        cursor: expect.any(Number),
      }),
    ]);
    expect(inbox.rejected?.[0]?.retryable).toBeUndefined();
  });

  it("send POST failure → relay_unavailable (not in rejected)", async () => {
    const { aliceCtx, bobCtx, bobId, relay, aliceDir, bobDir } = await makeStubBondedPair();
    try {
      relay.pullInbox.mockResolvedValue({ ok: true, wires: [], rowids: [], cursor: 0 });
      relay.sendEnvelope.mockRejectedValueOnce(new Error("network down"));

      const result = structured(await handleSend(aliceCtx, { to: bobId, body: "small message" }));
      expect(result).toEqual({ ok: false, error: "relay_unavailable" });

      const inbox = structured(await handleInbox(bobCtx, {}));
      expect(inbox.ok).toBe(true);
      if (!inbox.ok) {
        return;
      }
      expect(inbox.rejected ?? []).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ error: "relay_unavailable" })]),
      );
    } finally {
      await Promise.all([
        rm(aliceDir, { recursive: true, force: true }),
        rm(bobDir, { recursive: true, force: true }),
      ]);
    }
  });

  it("send retry after relay_unavailable: same-hash PUT is no-op", async () => {
    const { alice, bob } = await pairOnRelay(env, "send-retry");
    const thread = crypto.randomUUID();
    const body = largeText();

    const sendSpy = vi
      .spyOn(alice.ctx.relay, "sendEnvelope")
      .mockRejectedValueOnce(new Error("relay down"));

    const first = structured(await handleSend(alice.ctx, { to: bob.agentId, body, thread }));
    expect(first).toEqual({ ok: false, error: "relay_unavailable" });

    sendSpy.mockRestore();

    const second = structured(await handleSend(alice.ctx, { to: bob.agentId, body, thread }));
    expect(second.ok).toBe(true);

    const inbox = structured(await handleInbox(bob.ctx, {}));
    expect(inbox.ok).toBe(true);
    if (!inbox.ok) {
      return;
    }
    expect(inbox.envelopes).toHaveLength(1);
    expect(inbox.envelopes[0]?.payload).toEqual({ body });
  });

  it("re-pull since=cursor-1 retries transient artifact_fetch_failed", async () => {
    const { alice, bob } = await pairOnRelay(env, "repull-retry");
    const thread = crypto.randomUUID();
    const originalBody = largeText();

    const sent = structured(
      await handleSend(alice.ctx, {
        to: bob.agentId,
        body: originalBody,
        thread,
      }),
    );
    expect(sent.ok).toBe(true);

    const fetchError = Object.assign(new Error("artifact_fetch_failed"), {
      code: "artifact_fetch_failed",
    });
    const getArtifactSpy = vi.spyOn(bob.ctx.relay, "getArtifact").mockRejectedValueOnce(fetchError);

    const first = structured(await handleInbox(bob.ctx, {}));
    getArtifactSpy.mockRestore();

    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(first.rejected).toEqual([
      expect.objectContaining({ error: "artifact_fetch_failed", retryable: true }),
    ]);
    const failedCursor = first.rejected?.[0]?.cursor;
    expect(failedCursor).toBeTypeOf("number");
    if (typeof failedCursor !== "number") {
      return;
    }

    const second = structured(await handleInbox(bob.ctx, { since: failedCursor - 1 }));
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    expect(second.envelopes).toHaveLength(1);
    expect(second.envelopes[0]?.payload).toEqual({ body: originalBody });
    expect(second.rejected ?? []).toHaveLength(0);
  });

  it("handleSend success shape still includes id, thread, seq", async () => {
    const { alice, bob } = await pairOnRelay(env, "send-shape");
    const thread = crypto.randomUUID();

    const sent = structured(
      await handleSend(alice.ctx, {
        to: bob.agentId,
        body: largeText(),
        thread,
      }),
    );
    expect(sent.ok).toBe(true);
    if (!sent.ok) {
      return;
    }
    expect(sent.id).toBeTypeOf("string");
    expect(sent.thread).toBe(thread);
    expect(sent.seq).toBe(1);
    expect(Object.keys(sent).sort()).toEqual(["id", "ok", "seq", "thread"]);
  });

  it("handleClose still markClosed + processThreadClose after successful spill send", async () => {
    const { alice, bob } = await pairOnRelay(env, "close-sidefx");
    const thread = crypto.randomUUID();

    alice.ctx.sessionStore.upsert({
      thread,
      initiator: alice.agentId,
      recipient: bob.agentId,
      role: "initiator",
      status: "live",
      goal: "spill close probe",
      acceptance: [{ id: "a1", test: "judgment", desc: "d" }],
      budget: { max_turns: 5 },
      mandate: { agent_may: ["propose"], human_required: ["sign_final"] },
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
      turnCount: 0,
      peerMessages: [],
      lockedSections: [],
      testReports: {},
      challenges: {},
      signHashes: {},
      ratifyApproved: {},
    });

    const closed = structured(
      await handleClose(alice.ctx, {
        thread,
        to: bob.agentId,
        reason: largeText(),
      }),
    );
    expect(closed.ok).toBe(true);

    expect(alice.ctx.closedThreads.isClosed(thread)).toBe(true);
    const aliceStatus = structured(await handleSessionStatus(alice.ctx, { thread }));
    expect(aliceStatus.status).toBe("closed");

    const bobInbox = structured(await handleInbox(bob.ctx, {}));
    expect(bobInbox.ok).toBe(true);
    if (!bobInbox.ok) {
      return;
    }
    expect(bobInbox.envelopes.some((e) => e.type === "core.close")).toBe(true);
  });
});
