import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeBase64UrlStrict } from "../crypto/base64url.js";
import { type KeyPair, generateKeyPair, publicKeyToAgentId } from "../crypto/keys.js";
import type { Bond, LocalAllowlistStore } from "../pairing/flow.js";
import type {
  BudgetExtendPendingInput,
  RatifyPendingInput,
  SessionBondStore,
  SessionOpenPendingInput,
  SessionPendingItem,
  SessionPendingQueue,
} from "./deps.js";
import { type SessionStateMachine, createSessionStateMachine } from "./state-machine.js";
import { SESSION_OPEN_TTL_MS } from "./types.js";

function agentIdFromKeys(keys: KeyPair): string {
  return publicKeyToAgentId(keys.publicKey);
}

class MemoryAllowlistStore implements LocalAllowlistStore {
  private store = new Map<string, string[]>();

  get(agentId: string): string[] {
    return [...(this.store.get(agentId) ?? [])];
  }

  set(agentId: string, allowed: string[]): void {
    this.store.set(agentId, [...allowed]);
  }
}

class MockPendingQueue implements SessionPendingQueue {
  private items = new Map<string, SessionPendingItem>();

  list(): SessionPendingItem[] {
    return [...this.items.values()];
  }

  get(id: string): SessionPendingItem | undefined {
    return this.items.get(id);
  }

  remove(id: string): void {
    this.items.delete(id);
  }

  addSessionOpen(input: SessionOpenPendingInput): SessionPendingItem {
    const item: SessionPendingItem = {
      id: crypto.randomUUID(),
      kind: "session_open",
      createdAt: Date.now(),
      ...input,
    };
    this.items.set(item.id, item);
    return item;
  }

  addRatify(input: RatifyPendingInput): SessionPendingItem {
    const item: SessionPendingItem = {
      id: crypto.randomUUID(),
      kind: "ratify",
      createdAt: Date.now(),
      ...input,
    };
    this.items.set(item.id, item);
    return item;
  }

  addBudgetExtend(input: BudgetExtendPendingInput): SessionPendingItem {
    const item: SessionPendingItem = {
      id: crypto.randomUUID(),
      kind: "budget_extend",
      createdAt: Date.now(),
      ...input,
    };
    this.items.set(item.id, item);
    return item;
  }
}

class MockBondStore implements SessionBondStore {
  private store = new Map<string, Bond[]>();

  add(agentId: string, bond: Bond): void {
    const existing = this.get(agentId).filter((entry) => entry.peer !== bond.peer);
    this.store.set(agentId, [...existing, bond]);
  }

  private get(agentId: string): Bond[] {
    return [...(this.store.get(agentId) ?? [])];
  }

  find(agentId: string, peer: string): Bond | undefined {
    return this.get(agentId).find((entry) => entry.peer === peer);
  }

  remove(agentId: string, peer: string): void {
    const next = this.get(agentId).filter((entry) => entry.peer !== peer);
    this.store.set(agentId, next);
  }
}

describe("session state machine", () => {
  let aliceKeys: KeyPair;
  let bobKeys: KeyPair;
  let carolKeys: KeyPair;
  let aliceId: string;
  let bobId: string;
  let carolId: string;
  let aliceMachine: SessionStateMachine;
  let bobMachine: SessionStateMachine;
  let alicePending: MockPendingQueue;
  let bobPending: MockPendingQueue;
  let aliceAllowlist: MemoryAllowlistStore;
  let bobAllowlist: MemoryAllowlistStore;
  let aliceBonds: MockBondStore;
  let bobBonds: MockBondStore;

  function createLinkedMachines() {
    const peers = new Map<string, SessionStateMachine>();

    const deliver = async (
      fromId: string,
      input: { to: string; type: string; payload: string; thread: string },
    ) => {
      const peer = peers.get(input.to);
      if (!peer) {
        throw new Error(`unknown peer: ${input.to}`);
      }
      await peer.handleIncomingEnvelope({
        from: fromId,
        type: input.type,
        thread: input.thread,
        payload: input.payload,
      });
    };

    const alice = createSessionStateMachine({
      agentId: aliceId,
      keyPair: aliceKeys,
      pending: alicePending,
      allowlist: aliceAllowlist,
      bonds: aliceBonds,
      relay: {
        async send(input) {
          await deliver(aliceId, input);
          return { ok: true };
        },
      },
    });
    peers.set(aliceId, alice);
    const bob = createSessionStateMachine({
      agentId: bobId,
      keyPair: bobKeys,
      pending: bobPending,
      allowlist: bobAllowlist,
      bonds: bobBonds,
      relay: {
        async send(input) {
          await deliver(bobId, input);
          return { ok: true };
        },
      },
    });
    peers.set(bobId, bob);

    return { alice, bob };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    aliceKeys = generateKeyPair();
    bobKeys = generateKeyPair();
    carolKeys = generateKeyPair();
    aliceId = agentIdFromKeys(aliceKeys);
    bobId = agentIdFromKeys(bobKeys);
    carolId = agentIdFromKeys(carolKeys);
    alicePending = new MockPendingQueue();
    bobPending = new MockPendingQueue();
    aliceAllowlist = new MemoryAllowlistStore();
    bobAllowlist = new MemoryAllowlistStore();
    aliceBonds = new MockBondStore();
    bobBonds = new MockBondStore();

    aliceAllowlist.set(aliceId, [bobId]);
    bobAllowlist.set(bobId, [aliceId]);
    aliceBonds.add(aliceId, {
      peer: bobId,
      scope: ["session.negotiate"],
      mode: "ephemeral_until_session_closes",
    });
    bobBonds.add(bobId, {
      peer: aliceId,
      scope: ["session.negotiate"],
      mode: "ephemeral_until_session_closes",
    });

    const linked = createLinkedMachines();
    aliceMachine = linked.alice;
    bobMachine = linked.bob;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const openPayload = {
    goal: "Agree telemetry API contract v1",
    acceptance: [
      {
        id: "A1",
        test: "executable" as const,
        desc: "payload <= 4096 bytes",
        runner: "payload-size",
      },
    ],
    budget: { max_turns: 30 },
    mandate: {
      agent_may: ["propose", "counter", "accept_section", "challenge"],
      human_required: ["sign_final", "budget_extend", "constraint_change"],
    },
  };

  async function openAndApprove(): Promise<string> {
    const opened = await aliceMachine.handleOpen({
      to: bobId,
      ...openPayload,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      throw new Error("session open failed");
    }

    const bobPendingItems = bobPending.list().filter((item) => item.kind === "session_open");
    expect(bobPendingItems.length).toBe(1);
    const bobPendingItem = bobPendingItems[0];
    if (!bobPendingItem) {
      throw new Error("expected session_open pending item");
    }
    const pendingId = bobPendingItem.id;

    const approved = await bobMachine.handleApproveOpen({
      pending_id: pendingId,
      via_human: true,
    });
    expect(approved.ok).toBe(true);
    return opened.thread as string;
  }

  async function signFlowToSigned(thread: string, artifactHash: string): Promise<void> {
    await aliceMachine.handleMsg({ thread, type: "challenge", body: "{}" });
    await bobMachine.handleMsg({ thread, type: "challenge", body: "{}" });
    await aliceMachine.handleMsg({
      thread,
      type: "test_report",
      body: JSON.stringify({ artifact_hash: artifactHash, passed: true, runner: "payload-size" }),
    });
    await bobMachine.handleMsg({
      thread,
      type: "test_report",
      body: JSON.stringify({ artifact_hash: artifactHash, passed: true, runner: "payload-size" }),
    });
    await aliceMachine.handleSign({ thread, artifact_hash: artifactHash });
    await bobMachine.handleSign({ thread, artifact_hash: artifactHash });
    expect((await aliceMachine.handleStatus({ thread })).status).toBe("signed");
  }

  describe("handleThreadClose", () => {
    it("transitions live session to closed (§8.3 any → core.close → closed)", async () => {
      const thread = await openAndApprove();
      const result = await aliceMachine.handleThreadClose(thread, "user done");
      expect(result).toEqual({ ok: true, thread, status: "closed" });
      const status = await aliceMachine.handleStatus({ thread });
      expect(status.ok).toBe(true);
      if (!status.ok) return;
      expect(status.status).toBe("closed");
    });

    it("transitions signed session to closed", async () => {
      const thread = await openAndApprove();
      const artifactHash = "sha256:close-from-signed";
      await signFlowToSigned(thread, artifactHash);

      const result = await aliceMachine.handleThreadClose(thread, "abort ratify");
      expect(result.status).toBe("closed");
    });

    it("is no-op when no session exists", async () => {
      const thread = crypto.randomUUID();
      expect(await aliceMachine.handleThreadClose(thread)).toEqual({ ok: true, thread });
    });

    it("is idempotent when session already closed", async () => {
      const thread = await openAndApprove();
      await aliceMachine.handleThreadClose(thread, "first");
      const again = await aliceMachine.handleThreadClose(thread, "second");
      expect(again).toEqual({ ok: true, thread, status: "closed" });
      const status = await aliceMachine.handleStatus({ thread });
      expect(status.status).toBe("closed");
    });

    it("default close reason is thread_closed when reason omitted", async () => {
      const thread = await openAndApprove();
      await aliceMachine.handleThreadClose(thread);
      const status = await aliceMachine.handleStatus({ thread });
      expect(status.reject_reason).toBe("thread_closed");
    });

    it("removes session_open pending when closing a pending session", async () => {
      const opened = await aliceMachine.handleOpen({
        to: bobId,
        ...openPayload,
      });
      expect(opened.ok).toBe(true);
      if (!opened.ok) {
        return;
      }

      expect(bobPending.list().some((item) => item.kind === "session_open")).toBe(true);
      await bobMachine.handleThreadClose(opened.thread, "abort");
      expect(bobPending.list().some((item) => item.kind === "session_open")).toBe(false);
    });

    it("removes ratify pending when closing a signed session", async () => {
      const thread = await openAndApprove();
      const artifactHash = "sha256:close-clears-ratify";
      await signFlowToSigned(thread, artifactHash);
      expect(alicePending.list().some((item) => item.kind === "ratify")).toBe(true);

      await aliceMachine.handleThreadClose(thread, "abort ratify");
      expect(alicePending.list().some((item) => item.kind === "ratify")).toBe(false);
    });
  });

  it("handleIncomingEnvelope accepts nego.open", async () => {
    const thread = crypto.randomUUID();
    const result = await bobMachine.handleIncomingEnvelope({
      from: aliceId,
      type: "nego.open",
      thread,
      payload: JSON.stringify({ ...openPayload, expires_at: Date.now() + SESSION_OPEN_TTL_MS }),
    });
    expect(result.ok).toBe(true);
  });

  it("session_open queues pending and becomes live after human_approve", async () => {
    const opened = await aliceMachine.handleOpen({
      to: bobId,
      ...openPayload,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      return;
    }

    const aliceStatus = await aliceMachine.handleStatus({ thread: opened.thread });
    expect(aliceStatus.ok).toBe(true);
    if (!aliceStatus.ok) {
      return;
    }
    expect(aliceStatus.status).toBe("pending");

    const bobPendingItems = bobPending.list().filter((item) => item.kind === "session_open");
    expect(bobPendingItems).toHaveLength(1);
    const bobPendingItem = bobPendingItems[0];
    if (!bobPendingItem) {
      throw new Error("expected session_open pending item");
    }

    const approved = await bobMachine.handleApproveOpen({
      pending_id: bobPendingItem.id,
      via_human: true,
    });
    expect(approved.ok).toBe(true);

    const liveStatus = await aliceMachine.handleStatus({ thread: opened.thread });
    expect(liveStatus.ok).toBe(true);
    if (!liveStatus.ok) {
      return;
    }
    expect(liveStatus.status).toBe("live");
  });

  it("session_open rejected sends open_reject envelope and status open_rejected", async () => {
    const opened = await aliceMachine.handleOpen({
      to: bobId,
      ...openPayload,
    });
    if (!opened.ok) {
      throw new Error("open failed");
    }

    const bobOpenPending = bobPending.list().find((item) => item.kind === "session_open");
    if (!bobOpenPending) {
      throw new Error("expected session_open pending item");
    }
    const pendingId = bobOpenPending.id;
    const rejected = await bobMachine.handleRejectOpen({
      pending_id: pendingId,
      reason: "scope too broad",
      via_human: true,
    });
    expect(rejected.ok).toBe(true);

    const aliceStatus = await aliceMachine.handleStatus({ thread: opened.thread });
    expect(aliceStatus.ok).toBe(true);
    if (!aliceStatus.ok) {
      return;
    }
    expect(aliceStatus.status).toBe("open_rejected");
    expect(aliceStatus.reject_reason).toBe("scope too broad");
  });

  it("session_open expires after 1 hour", async () => {
    const opened = await aliceMachine.handleOpen({
      to: bobId,
      ...openPayload,
    });
    if (!opened.ok) {
      throw new Error("open failed");
    }

    vi.advanceTimersByTime(SESSION_OPEN_TTL_MS + 1);

    const expired = await bobMachine.handleExpirePendingOpens();
    expect(expired.ok).toBe(true);
    if (!expired.ok) {
      return;
    }
    expect(expired.expired).toContain(opened.thread);

    const aliceStatus = await aliceMachine.handleStatus({ thread: opened.thread });
    expect(aliceStatus.ok).toBe(true);
    if (!aliceStatus.ok) {
      return;
    }
    expect(aliceStatus.status).toBe("open_expired");
  });

  it("session_status reports open_expired when ensureRecipientOpenPending expires on read", async () => {
    const opened = await aliceMachine.handleOpen({
      to: bobId,
      ...openPayload,
    });
    if (!opened.ok) {
      throw new Error("open failed");
    }

    vi.advanceTimersByTime(SESSION_OPEN_TTL_MS + 1);

    const bobStatus = await bobMachine.handleStatus({ thread: opened.thread });
    expect(bobStatus.ok).toBe(true);
    if (!bobStatus.ok) {
      return;
    }
    expect(bobStatus.status).toBe("open_expired");
    expect(bobStatus.pending_id).toBeUndefined();
  });

  it("session.open redelivery does not reset a live recipient session", async () => {
    const thread = await openAndApprove();

    const bobBefore = await bobMachine.handleStatus({ thread });
    expect(bobBefore.ok).toBe(true);
    if (!bobBefore.ok) {
      return;
    }
    expect(bobBefore.status).toBe("live");

    const payloadObj = {
      goal: "Different goal should not apply",
      acceptance: openPayload.acceptance,
      budget: openPayload.budget,
      mandate: openPayload.mandate,
      from: aliceId,
      expires_at: Date.now() + SESSION_OPEN_TTL_MS,
    };
    const redelivered = await bobMachine.handleIncomingEnvelope({
      from: aliceId,
      type: "nego.open",
      thread,
      payload: JSON.stringify(payloadObj),
    });
    expect(redelivered.ok).toBe(true);
    if (!redelivered.ok) {
      return;
    }
    expect(redelivered.status).toBe("live");

    const bobAfter = await bobMachine.handleStatus({ thread });
    expect(bobAfter.ok).toBe(true);
    if (!bobAfter.ok) {
      return;
    }
    expect(bobAfter.status).toBe("live");
    expect(bobAfter.goal).toBe(bobBefore.goal);
  });

  it("session_msg supports propose/counter/accept negotiation", async () => {
    const thread = await openAndApprove();

    const propose = await bobMachine.handleMsg({
      thread,
      type: "propose",
      body: JSON.stringify({ diff: "timestamp: ISO-8601" }),
    });
    expect(propose.ok).toBe(true);

    const counter = await aliceMachine.handleMsg({
      thread,
      type: "counter",
      body: JSON.stringify({ diff: "timestamp: epoch uint32" }),
    });
    expect(counter.ok).toBe(true);

    const accept = await bobMachine.handleMsg({
      thread,
      type: "accept",
      body: JSON.stringify({ section_id: "timestamp" }),
    });
    expect(accept.ok).toBe(true);

    const status = await bobMachine.handleStatus({ thread });
    expect(status.ok).toBe(true);
    if (!status.ok) {
      return;
    }
    expect(status.locked_sections).toContain("timestamp");
  });

  it("session_sign is legal only when both test_reports pass", async () => {
    const thread = await openAndApprove();
    const artifactHash = "sha256:draft-hash-abc";

    const aliceFailBeforeChallenges = await aliceMachine.handleSign({
      thread,
      artifact_hash: artifactHash,
    });
    expect(aliceFailBeforeChallenges.ok).toBe(false);
    if (aliceFailBeforeChallenges.ok) {
      return;
    }
    expect(aliceFailBeforeChallenges.error).toBe("challenges_incomplete");

    await aliceMachine.handleMsg({
      thread,
      type: "challenge",
      body: JSON.stringify({ report: "adversarial pass" }),
    });
    await bobMachine.handleMsg({
      thread,
      type: "challenge",
      body: JSON.stringify({ report: "adversarial pass" }),
    });

    const aliceFail = await aliceMachine.handleSign({ thread, artifact_hash: artifactHash });
    expect(aliceFail.ok).toBe(false);
    if (aliceFail.ok) {
      return;
    }
    expect(aliceFail.error).toBe("tests_not_green");

    await aliceMachine.handleMsg({
      thread,
      type: "test_report",
      body: JSON.stringify({
        artifact_hash: artifactHash,
        passed: true,
        runner: "payload-size",
      }),
    });
    await bobMachine.handleMsg({
      thread,
      type: "test_report",
      body: JSON.stringify({
        artifact_hash: artifactHash,
        passed: false,
        runner: "payload-size",
      }),
    });

    const aliceStillIllegal = await aliceMachine.handleSign({
      thread,
      artifact_hash: artifactHash,
    });
    expect(aliceStillIllegal.ok).toBe(false);
    if (aliceStillIllegal.ok) {
      return;
    }
    expect(aliceStillIllegal.error).toBe("tests_not_green");

    await bobMachine.handleMsg({
      thread,
      type: "test_report",
      body: JSON.stringify({
        artifact_hash: artifactHash,
        passed: true,
        runner: "payload-size",
      }),
    });

    const aliceSign = await aliceMachine.handleSign({ thread, artifact_hash: artifactHash });
    expect(aliceSign.ok).toBe(true);

    const bobSign = await bobMachine.handleSign({ thread, artifact_hash: artifactHash });
    expect(bobSign.ok).toBe(true);

    const status = await aliceMachine.handleStatus({ thread });
    expect(status.ok).toBe(true);
    if (!status.ok) {
      return;
    }
    expect(status.status).toBe("signed");
  });

  it("ratification requires human_approve on both sides before co-sign", async () => {
    const thread = await openAndApprove();
    const artifactHash = "sha256:final-hash-xyz";

    await aliceMachine.handleMsg({
      thread,
      type: "challenge",
      body: JSON.stringify({ report: "pass" }),
    });
    await bobMachine.handleMsg({
      thread,
      type: "challenge",
      body: JSON.stringify({ report: "pass" }),
    });
    await aliceMachine.handleMsg({
      thread,
      type: "test_report",
      body: JSON.stringify({
        artifact_hash: artifactHash,
        passed: true,
        runner: "payload-size",
      }),
    });
    await bobMachine.handleMsg({
      thread,
      type: "test_report",
      body: JSON.stringify({
        artifact_hash: artifactHash,
        passed: true,
        runner: "payload-size",
      }),
    });
    await aliceMachine.handleSign({ thread, artifact_hash: artifactHash });
    await bobMachine.handleSign({ thread, artifact_hash: artifactHash });

    const aliceRatifyPending = alicePending.list().find((item) => item.kind === "ratify");
    const bobRatifyPending = bobPending.list().find((item) => item.kind === "ratify");
    if (!aliceRatifyPending || !bobRatifyPending) {
      throw new Error("expected ratify pending items");
    }

    const agentRatify = await aliceMachine.handleRatify({
      thread,
      artifact_hash: artifactHash,
      via_human: false,
    });
    expect(agentRatify.ok).toBe(false);
    if (agentRatify.ok) {
      return;
    }
    expect(agentRatify.error).toBe("human_required");

    const aliceApproved = await aliceMachine.handleRatify({
      pending_id: aliceRatifyPending.id,
      via_human: true,
    });
    expect(aliceApproved.ok).toBe(true);
    if (!aliceApproved.ok) {
      return;
    }
    expect(aliceApproved.status).toBe("awaiting_peer_ratify");
    expect(alicePending.list().filter((item) => item.kind === "ratify")).toHaveLength(0);

    const bobApproved = await bobMachine.handleRatify({
      pending_id: bobRatifyPending.id,
      via_human: true,
    });
    expect(bobApproved.ok).toBe(true);
    if (!bobApproved.ok) {
      return;
    }
    expect(bobApproved.status).toBe("closed");
    expect(bobApproved.co_signed_hash).toBe(artifactHash);
    expect(bobApproved.signatures).toBeDefined();
    if (!bobApproved.signatures) {
      return;
    }
    const bobSig = bobApproved.signatures[bobId];
    expect(bobSig).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(() => decodeBase64UrlStrict(bobSig)).not.toThrow();
    expect(bobPending.list().filter((item) => item.kind === "ratify")).toHaveLength(0);

    const aliceFinal = await aliceMachine.handleStatus({ thread });
    expect(aliceFinal.ok).toBe(true);
    if (!aliceFinal.ok) {
      return;
    }
    expect(aliceFinal.status).toBe("closed");
    expect(aliceFinal.co_signed_hash).toBe(artifactHash);
  });

  it("removes ratify pending when ratifying by thread without pending_id", async () => {
    const thread = await openAndApprove();
    const artifactHash = "sha256:thread-only-ratify";

    for (const machine of [aliceMachine, bobMachine]) {
      await machine.handleMsg({
        thread,
        type: "challenge",
        body: JSON.stringify({ report: "pass" }),
      });
      await machine.handleMsg({
        thread,
        type: "test_report",
        body: JSON.stringify({
          artifact_hash: artifactHash,
          passed: true,
          runner: "payload-size",
        }),
      });
    }
    await aliceMachine.handleSign({ thread, artifact_hash: artifactHash });
    await bobMachine.handleSign({ thread, artifact_hash: artifactHash });

    expect(alicePending.list().filter((item) => item.kind === "ratify")).toHaveLength(1);

    const approved = await aliceMachine.handleRatify({
      thread,
      artifact_hash: artifactHash,
      via_human: true,
    });
    expect(approved.ok).toBe(true);
    if (!approved.ok) {
      return;
    }
    expect(alicePending.list().filter((item) => item.kind === "ratify")).toHaveLength(0);
  });

  it("session_sign rejects when codegen-compile test_report is red", async () => {
    const thread = await openAndApprove();
    const artifactHash = "sha256:codegen-red-hash";

    await aliceMachine.handleMsg({
      thread,
      type: "challenge",
      body: JSON.stringify({ report: "pass" }),
    });
    await bobMachine.handleMsg({
      thread,
      type: "challenge",
      body: JSON.stringify({ report: "pass" }),
    });
    await aliceMachine.handleMsg({
      thread,
      type: "test_report",
      body: JSON.stringify({
        artifact_hash: artifactHash,
        passed: true,
        runner: "codegen-compile",
      }),
    });
    await bobMachine.handleMsg({
      thread,
      type: "test_report",
      body: JSON.stringify({
        artifact_hash: artifactHash,
        passed: false,
        runner: "codegen-compile",
        details: "xtensa-esp-elf-gcc syntax error",
      }),
    });

    const signAttempt = await aliceMachine.handleSign({ thread, artifact_hash: artifactHash });
    expect(signAttempt.ok).toBe(false);
    if (signAttempt.ok) {
      return;
    }
    expect(signAttempt.error).toBe("tests_not_green");
  });

  it("budget exhaustion escalates and blocks further propose", async () => {
    const opened = await aliceMachine.handleOpen({
      to: bobId,
      ...openPayload,
      budget: { max_turns: 2 },
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      return;
    }

    const bobPendingItems = bobPending.list().filter((item) => item.kind === "session_open");
    const bobPendingItem = bobPendingItems[0];
    if (!bobPendingItem) {
      throw new Error("expected session_open pending item");
    }
    await bobMachine.handleApproveOpen({
      pending_id: bobPendingItem.id,
      via_human: true,
    });

    const budgetThread = opened.thread as string;

    const first = await aliceMachine.handleMsg({
      thread: budgetThread,
      type: "propose",
      body: JSON.stringify({ diff: "section-a" }),
    });
    expect(first.ok).toBe(true);

    const second = await bobMachine.handleMsg({
      thread: budgetThread,
      type: "counter",
      body: JSON.stringify({ diff: "section-a-v2" }),
    });
    expect(second.ok).toBe(true);

    const exhausted = await aliceMachine.handleMsg({
      thread: budgetThread,
      type: "propose",
      body: JSON.stringify({ diff: "section-b" }),
    });
    expect(exhausted.ok).toBe(false);
    if (exhausted.ok) {
      return;
    }
    expect(exhausted.error).toBe("budget_exhausted");

    const budgetExtendPending = alicePending.list().find((item) => item.kind === "budget_extend");
    expect(budgetExtendPending).toBeDefined();
  });

  it("finalize removes ephemeral bond from allowlist", async () => {
    const thread = await openAndApprove();
    const artifactHash = "sha256:cleanup-hash";

    await aliceMachine.handleMsg({
      thread,
      type: "challenge",
      body: JSON.stringify({ report: "pass" }),
    });
    await bobMachine.handleMsg({
      thread,
      type: "challenge",
      body: JSON.stringify({ report: "pass" }),
    });
    await aliceMachine.handleMsg({
      thread,
      type: "test_report",
      body: JSON.stringify({
        artifact_hash: artifactHash,
        passed: true,
        runner: "payload-size",
      }),
    });
    await bobMachine.handleMsg({
      thread,
      type: "test_report",
      body: JSON.stringify({
        artifact_hash: artifactHash,
        passed: true,
        runner: "payload-size",
      }),
    });
    await aliceMachine.handleSign({ thread, artifact_hash: artifactHash });
    await bobMachine.handleSign({ thread, artifact_hash: artifactHash });

    const aliceRatifyPending = alicePending.list().find((item) => item.kind === "ratify");
    const bobRatifyPending = bobPending.list().find((item) => item.kind === "ratify");
    if (!aliceRatifyPending || !bobRatifyPending) {
      throw new Error("expected ratify pending items");
    }

    await aliceMachine.handleRatify({
      pending_id: aliceRatifyPending.id,
      via_human: true,
    });
    await bobMachine.handleRatify({
      pending_id: bobRatifyPending.id,
      via_human: true,
    });

    expect(aliceAllowlist.get(aliceId)).not.toContain(bobId);
    expect(bobAllowlist.get(bobId)).not.toContain(aliceId);
    expect(aliceBonds.find(aliceId, bobId)).toBeUndefined();
    expect(bobBonds.find(bobId, aliceId)).toBeUndefined();
  });

  async function openSignAndAliceRatify(): Promise<{ thread: string; artifactHash: string }> {
    const thread = await openAndApprove();
    const artifactHash = "sha256:non-participant-guard";

    for (const machine of [aliceMachine, bobMachine]) {
      await machine.handleMsg({
        thread,
        type: "challenge",
        body: JSON.stringify({ report: "pass" }),
      });
      await machine.handleMsg({
        thread,
        type: "test_report",
        body: JSON.stringify({
          artifact_hash: artifactHash,
          passed: true,
          runner: "payload-size",
        }),
      });
    }
    await aliceMachine.handleSign({ thread, artifact_hash: artifactHash });
    await bobMachine.handleSign({ thread, artifact_hash: artifactHash });

    const aliceRatifyPending = alicePending.list().find((item) => item.kind === "ratify");
    if (!aliceRatifyPending) {
      throw new Error("expected alice ratify pending item");
    }
    await aliceMachine.handleRatify({
      pending_id: aliceRatifyPending.id,
      via_human: true,
    });

    return { thread, artifactHash };
  }

  describe("non-participant envelope rejection", () => {
    it("rejects peer_ratified from a non-participant without closing the session", async () => {
      const { thread } = await openSignAndAliceRatify();

      const before = await aliceMachine.handleStatus({ thread });
      expect(before.ok).toBe(true);
      if (!before.ok) {
        return;
      }
      expect(before.status).toBe("signed");

      const rejected = await aliceMachine.handleIncomingEnvelope({
        from: carolId,
        type: "nego.ratified",
        thread,
        payload: "{}",
      });
      expect(rejected.ok).toBe(false);
      if (rejected.ok) {
        return;
      }
      expect(rejected.error).toBe("not_a_participant");

      const after = await aliceMachine.handleStatus({ thread });
      expect(after.ok).toBe(true);
      if (!after.ok) {
        return;
      }
      expect(after.status).toBe("signed");
    });

    it("rejects peer_signed from a non-participant without mutating signHashes", async () => {
      const thread = await openAndApprove();
      const artifactHash = "sha256:carol-signed-attack";

      const rejected = await aliceMachine.handleIncomingEnvelope({
        from: carolId,
        type: "nego.signed",
        thread,
        payload: JSON.stringify({ artifact_hash: artifactHash }),
      });
      expect(rejected.ok).toBe(false);
      if (rejected.ok) {
        return;
      }
      expect(rejected.error).toBe("not_a_participant");

      const status = await aliceMachine.handleStatus({ thread });
      expect(status.ok).toBe(true);
      if (!status.ok) {
        return;
      }
      expect(status.status).toBe("live");
      expect(status.artifact_hash).toBeUndefined();
    });

    it("rejects atest.challenge from a non-participant without filing challenges", async () => {
      const thread = await openAndApprove();

      const rejected = await aliceMachine.handleIncomingEnvelope({
        from: carolId,
        type: "atest.challenge",
        thread,
        payload: "{}",
      });
      expect(rejected.ok).toBe(false);
      if (rejected.ok) {
        return;
      }
      expect(rejected.error).toBe("not_a_participant");

      const status = await aliceMachine.handleStatus({ thread });
      expect(status.ok).toBe(true);
      if (!status.ok) {
        return;
      }
      expect(status.tests_legal).toBe(false);
    });

    it("rejects open_approved from a non-participant without going live", async () => {
      const opened = await aliceMachine.handleOpen({
        to: bobId,
        ...openPayload,
      });
      expect(opened.ok).toBe(true);
      if (!opened.ok) {
        return;
      }

      const rejected = await aliceMachine.handleIncomingEnvelope({
        from: carolId,
        type: "nego.open_approved",
        thread: opened.thread,
        payload: JSON.stringify({ thread: opened.thread }),
      });
      expect(rejected.ok).toBe(false);
      if (rejected.ok) {
        return;
      }
      expect(rejected.error).toBe("not_a_participant");

      const status = await aliceMachine.handleStatus({ thread: opened.thread });
      expect(status.ok).toBe(true);
      if (!status.ok) {
        return;
      }
      expect(status.status).toBe("pending");
    });

    it("rejects open_reject from a non-participant", async () => {
      const opened = await aliceMachine.handleOpen({
        to: bobId,
        ...openPayload,
      });
      expect(opened.ok).toBe(true);
      if (!opened.ok) {
        return;
      }

      const rejected = await aliceMachine.handleIncomingEnvelope({
        from: carolId,
        type: "nego.open_reject",
        thread: opened.thread,
        payload: JSON.stringify({ reason: "blocked by carol" }),
      });
      expect(rejected.ok).toBe(false);
      if (rejected.ok) {
        return;
      }
      expect(rejected.error).toBe("not_a_participant");

      const status = await aliceMachine.handleStatus({ thread: opened.thread });
      expect(status.ok).toBe(true);
      if (!status.ok) {
        return;
      }
      expect(status.status).toBe("pending");
    });

    it("rejects peer_turn from a non-participant without bumping turnCount", async () => {
      const thread = await openAndApprove();
      const before = await aliceMachine.handleStatus({ thread });
      expect(before.ok).toBe(true);
      if (!before.ok) {
        return;
      }
      const turnBefore = before.turn_count;

      const rejected = await aliceMachine.handleIncomingEnvelope({
        from: carolId,
        type: "nego.turn",
        thread,
        payload: JSON.stringify({
          turn_count: turnBefore + 10,
          msg_type: "propose",
          body: JSON.stringify({ diff: "injected" }),
        }),
      });
      expect(rejected.ok).toBe(false);
      if (rejected.ok) {
        return;
      }
      expect(rejected.error).toBe("not_a_participant");

      const after = await aliceMachine.handleStatus({ thread });
      expect(after.ok).toBe(true);
      if (!after.ok) {
        return;
      }
      expect(after.turn_count).toBe(turnBefore);
    });

    it("rejects malformed peer_test_report payloads", async () => {
      const thread = await openAndApprove();
      const artifactHash = "sha256:malformed-test-report";

      const rejected = await aliceMachine.handleIncomingEnvelope({
        from: bobId,
        type: "atest.report",
        thread,
        payload: JSON.stringify({
          artifact_hash: artifactHash,
          passed: "yes",
          runner: "payload-size",
        }),
      });
      expect(rejected.ok).toBe(false);
      if (rejected.ok) {
        return;
      }
      expect(rejected.error).toBe("invalid_payload");

      const status = await aliceMachine.handleStatus({ thread });
      expect(status.ok).toBe(true);
      if (!status.ok) {
        return;
      }
      expect(status.tests_legal).toBe(false);
    });

    it("accepts atest.challenge from a participant via handleIncomingEnvelope", async () => {
      const thread = await openAndApprove();

      const accepted = await aliceMachine.handleIncomingEnvelope({
        from: bobId,
        type: "atest.challenge",
        thread,
        payload: "{}",
      });
      expect(accepted).toEqual({ ok: true, thread, type: "challenge" });

      const status = await aliceMachine.handleStatus({ thread });
      expect(status.ok).toBe(true);
      if (!status.ok) {
        return;
      }
      expect(status.tests_legal).toBe(false);
    });

    it("rejects malformed atest.challenge payloads", async () => {
      const thread = await openAndApprove();

      const rejected = await aliceMachine.handleIncomingEnvelope({
        from: bobId,
        type: "atest.challenge",
        thread,
        payload: "[]",
      });
      expect(rejected.ok).toBe(false);
      if (rejected.ok) {
        return;
      }
      expect(rejected.error).toBe("invalid_payload");
    });

    it("rejects malformed peer_turn payloads", async () => {
      const thread = await openAndApprove();
      const before = await aliceMachine.handleStatus({ thread });
      expect(before.ok).toBe(true);
      if (!before.ok) {
        return;
      }
      const turnBefore = before.turn_count;

      const rejected = await aliceMachine.handleIncomingEnvelope({
        from: bobId,
        type: "nego.turn",
        thread,
        payload: JSON.stringify({
          turn_count: "abc",
          msg_type: "propose",
          body: JSON.stringify({ diff: "bad" }),
        }),
      });
      expect(rejected.ok).toBe(false);
      if (rejected.ok) {
        return;
      }
      expect(rejected.error).toBe("invalid_payload");

      const after = await aliceMachine.handleStatus({ thread });
      expect(after.ok).toBe(true);
      if (!after.ok) {
        return;
      }
      expect(after.turn_count).toBe(turnBefore);
    });

    it("rejects malformed session.open payloads missing required fields", async () => {
      const opened = await aliceMachine.handleOpen({
        to: bobId,
        ...openPayload,
      });
      expect(opened.ok).toBe(true);
      if (!opened.ok) {
        return;
      }

      const rejected = await bobMachine.handleIncomingEnvelope({
        from: aliceId,
        type: "nego.open",
        thread: opened.thread,
        payload: JSON.stringify({ goal: "only goal, no budget" }),
      });
      expect(rejected.ok).toBe(false);
      if (rejected.ok) {
        return;
      }
      expect(rejected.error).toBe("invalid_payload");
    });

    it("rejects non-object JSON envelope payloads", async () => {
      const thread = await openAndApprove();

      const rejected = await aliceMachine.handleIncomingEnvelope({
        from: bobId,
        type: "nego.turn",
        thread,
        payload: "null",
      });
      expect(rejected.ok).toBe(false);
      if (rejected.ok) {
        return;
      }
      expect(rejected.error).toBe("invalid_payload");
    });
  });

  describe("§10 invalid_payload collapse (M1.5)", () => {
    it("maps unknown handleMsg type to invalid_payload", async () => {
      const thread = await openAndApprove();

      const rejected = await aliceMachine.handleMsg({
        thread,
        type: "bogus",
        body: "{}",
      });
      expect(rejected.ok).toBe(false);
      if (rejected.ok) {
        return;
      }
      expect(rejected.error).toBe("invalid_payload");
    });

    it("maps invalid accept body to invalid_payload", async () => {
      const thread = await openAndApprove();

      const rejected = await aliceMachine.handleMsg({
        thread,
        type: "accept",
        body: JSON.stringify({ not_section_id: "A1" }),
      });
      expect(rejected.ok).toBe(false);
      if (rejected.ok) {
        return;
      }
      expect(rejected.error).toBe("invalid_payload");
    });

    it("maps handleRatify without thread or pending_id to invalid_payload", async () => {
      const rejected = await aliceMachine.handleRatify({ via_human: true });
      expect(rejected.ok).toBe(false);
      if (rejected.ok) {
        return;
      }
      expect(rejected.error).toBe("invalid_payload");
    });

    it("maps handleRatify with empty artifact_hash on signed session to invalid_payload", async () => {
      const thread = await openAndApprove();
      const artifactHash = "sha256:empty-hash-ratify";
      await signFlowToSigned(thread, artifactHash);

      const rejected = await aliceMachine.handleRatify({
        thread,
        artifact_hash: "",
        via_human: true,
      });
      expect(rejected.ok).toBe(false);
      if (rejected.ok) {
        return;
      }
      expect(rejected.error).toBe("invalid_payload");
    });
  });

  describe("wrong-role envelope rejection", () => {
    it("rejects open_approved from the initiator without going live", async () => {
      const opened = await aliceMachine.handleOpen({
        to: bobId,
        ...openPayload,
      });
      expect(opened.ok).toBe(true);
      if (!opened.ok) {
        return;
      }

      const rejected = await aliceMachine.handleIncomingEnvelope({
        from: aliceId,
        type: "nego.open_approved",
        thread: opened.thread,
        payload: JSON.stringify({ thread: opened.thread }),
      });
      expect(rejected.ok).toBe(false);
      if (rejected.ok) {
        return;
      }
      expect(rejected.error).toBe("wrong_role");

      const status = await aliceMachine.handleStatus({ thread: opened.thread });
      expect(status.ok).toBe(true);
      if (!status.ok) {
        return;
      }
      expect(status.status).toBe("pending");
    });

    it("rejects open_reject from the initiator on the recipient machine", async () => {
      const opened = await aliceMachine.handleOpen({
        to: bobId,
        ...openPayload,
      });
      expect(opened.ok).toBe(true);
      if (!opened.ok) {
        return;
      }

      const rejected = await bobMachine.handleIncomingEnvelope({
        from: aliceId,
        type: "nego.open_reject",
        thread: opened.thread,
        payload: JSON.stringify({ reason: "forced by initiator" }),
      });
      expect(rejected.ok).toBe(false);
      if (rejected.ok) {
        return;
      }
      expect(rejected.error).toBe("wrong_role");

      const status = await bobMachine.handleStatus({ thread: opened.thread });
      expect(status.ok).toBe(true);
      if (!status.ok) {
        return;
      }
      expect(status.status).toBe("pending");
    });

    it("rejects open_expired from the initiator on the recipient machine", async () => {
      const opened = await aliceMachine.handleOpen({
        to: bobId,
        ...openPayload,
      });
      expect(opened.ok).toBe(true);
      if (!opened.ok) {
        return;
      }

      const rejected = await bobMachine.handleIncomingEnvelope({
        from: aliceId,
        type: "nego.open_expired",
        thread: opened.thread,
        payload: JSON.stringify({ thread: opened.thread }),
      });
      expect(rejected.ok).toBe(false);
      if (rejected.ok) {
        return;
      }
      expect(rejected.error).toBe("wrong_role");

      const status = await bobMachine.handleStatus({ thread: opened.thread });
      expect(status.ok).toBe(true);
      if (!status.ok) {
        return;
      }
      expect(status.status).toBe("pending");
    });
  });

  describe("session.open initiator binding", () => {
    it("rejects session.open redelivery from a different initiator on pending session", async () => {
      const opened = await aliceMachine.handleOpen({
        to: bobId,
        ...openPayload,
      });
      expect(opened.ok).toBe(true);
      if (!opened.ok) {
        return;
      }

      const rejected = await bobMachine.handleIncomingEnvelope({
        from: carolId,
        type: "nego.open",
        thread: opened.thread,
        payload: JSON.stringify({
          goal: "hijacked goal",
          acceptance: openPayload.acceptance,
          budget: openPayload.budget,
          mandate: openPayload.mandate,
        }),
      });
      expect(rejected.ok).toBe(false);
      if (rejected.ok) {
        return;
      }
      expect(rejected.error).toBe("initiator_mismatch");

      const status = await bobMachine.handleStatus({ thread: opened.thread });
      expect(status.ok).toBe(true);
      if (!status.ok) {
        return;
      }
      expect(status.status).toBe("pending");
      expect(status.goal).toBe(openPayload.goal);
    });
  });
});
