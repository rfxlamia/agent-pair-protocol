import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeBase64UrlStrict } from "../crypto/base64url.js";
import { type KeyPair, generateKeyPair, publicKeyToAgentId } from "../crypto/keys.js";
import type { Bond, LocalAllowlistStore } from "../pairing/flow.js";
import { REFERENCE_PROFILES } from "../profile/reference.js";
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

  type RelayCapture = { type: string; to: string; thread: string; payload: string };

  function createLinkedMachines(capture?: {
    aliceSends?: RelayCapture[];
    bobSends?: RelayCapture[];
  }) {
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
          capture?.aliceSends?.push({
            type: input.type,
            to: input.to,
            thread: input.thread,
            payload: input.payload,
          });
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
          capture?.bobSends?.push({
            type: input.type,
            to: input.to,
            thread: input.thread,
            payload: input.payload,
          });
          await deliver(bobId, input);
          return { ok: true };
        },
      },
    });
    peers.set(bobId, bob);
    const carol = createSessionStateMachine({
      agentId: carolId,
      keyPair: carolKeys,
      pending: new MockPendingQueue(),
      allowlist: new MemoryAllowlistStore(),
      bonds: new MockBondStore(),
      relay: {
        async send(input) {
          await deliver(carolId, input);
          return { ok: true };
        },
      },
    });
    peers.set(carolId, carol);

    return { alice, bob, carol };
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

  const FUTURE_DEADLINE = new Date(Date.now() + 86_400_000).toISOString();
  const PAST_DEADLINE = new Date(Date.now() - 60_000).toISOString();

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
    budget: { max_turns: 30, deadline: FUTURE_DEADLINE },
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

  const NEGO_ONLY = [...REFERENCE_PROFILES];
  const ATEST_CAPABLE = [...REFERENCE_PROFILES, "atest/1"];

  function wireBondProfiles(
    profiles: string[],
    capture?: Parameters<typeof createLinkedMachines>[0],
  ) {
    aliceBonds.add(aliceId, {
      peer: bobId,
      scope: ["session.negotiate"],
      mode: "ephemeral_until_session_closes",
      profiles,
    });
    bobBonds.add(bobId, {
      peer: aliceId,
      scope: ["session.negotiate"],
      mode: "ephemeral_until_session_closes",
      profiles,
    });
    const linked = createLinkedMachines(capture);
    aliceMachine = linked.alice;
    bobMachine = linked.bob;
  }

  function wireNegoOnlyBonds(capture?: Parameters<typeof createLinkedMachines>[0]) {
    wireBondProfiles(NEGO_ONLY, capture);
  }

  function wireAtestCapableBonds(capture?: Parameters<typeof createLinkedMachines>[0]) {
    wireBondProfiles(ATEST_CAPABLE, capture);
  }

  function ensureAtestCapableBonds(): void {
    for (const [agentId, peerId, bonds] of [
      [aliceId, bobId, aliceBonds],
      [bobId, aliceId, bobBonds],
    ] as const) {
      const bond = bonds.find(agentId, peerId);
      if (bond) {
        bonds.add(agentId, { ...bond, profiles: [...ATEST_CAPABLE] });
      }
    }
  }

  async function signFlowToSigned(thread: string, artifactHash: string): Promise<void> {
    ensureAtestCapableBonds();
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

  describe("handleBondRevoke", () => {
    beforeEach(() => {
      aliceBonds.add(aliceId, {
        peer: bobId,
        scope: ["session.negotiate"],
        mode: "bonded_contact",
      });
      bobBonds.add(bobId, {
        peer: aliceId,
        scope: ["session.negotiate"],
        mode: "bonded_contact",
      });
    });

    it("closes pending session with bond_revoked", async () => {
      const opened = await aliceMachine.handleOpen({ to: bobId, ...openPayload });
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;

      aliceMachine.handleBondRevoke(bobId);

      const status = await aliceMachine.handleStatus({ thread: opened.thread });
      expect(status.ok).toBe(true);
      if (!status.ok) return;
      expect(status.status).toBe("closed");
      expect(status.reject_reason).toBe("bond_revoked");
    });

    it("closes live session with bond_revoked", async () => {
      const thread = await openAndApprove();

      aliceMachine.handleBondRevoke(bobId);

      const status = await aliceMachine.handleStatus({ thread });
      expect(status.ok).toBe(true);
      if (!status.ok) return;
      expect(status.status).toBe("closed");
      expect(status.reject_reason).toBe("bond_revoked");
    });

    it("closes signed session retaining signHashes and artifactHash", async () => {
      const thread = await openAndApprove();
      const artifactHash = "sha256:bond-revoke-signed-retain";
      await signFlowToSigned(thread, artifactHash);
      const before = aliceMachine.store.get(thread);
      expect(before).toBeDefined();
      if (!before) return;

      aliceMachine.handleBondRevoke(bobId);

      const after = aliceMachine.store.get(thread);
      expect(after).toBeDefined();
      if (!after) return;
      expect(after.status).toBe("closed");
      expect(after.rejectReason).toBe("bond_revoked");
      expect(after.signHashes).toEqual(before.signHashes);
      expect(after.artifactHash).toBe(before.artifactHash);
      expect(after.peerMessages).toEqual(before.peerMessages);
      expect(after.testReports).toEqual(before.testReports);
      expect(after.challenges).toEqual(before.challenges);
      expect(after.ratifyApproved).toEqual(before.ratifyApproved);
    });

    it("leaves terminal sessions unchanged", async () => {
      const finalizedThread = await openAndApprove();
      const finalizedHash = "sha256:terminal-finalized";
      await signFlowToSigned(finalizedThread, finalizedHash);
      const aliceRatify = alicePending.list().find((item) => item.kind === "ratify");
      const bobRatify = bobPending.list().find((item) => item.kind === "ratify");
      if (!aliceRatify || !bobRatify) throw new Error("expected ratify pending");
      await aliceMachine.handleRatify({ pending_id: aliceRatify.id, via_human: true });
      await bobMachine.handleRatify({ pending_id: bobRatify.id, via_human: true });
      const finalizedBefore = aliceMachine.store.get(finalizedThread);
      expect(finalizedBefore?.coSignedHash).toBeDefined();

      const rejectedOpen = await aliceMachine.handleOpen({ to: bobId, ...openPayload });
      expect(rejectedOpen.ok).toBe(true);
      if (!rejectedOpen.ok) return;
      const bobRejectPending = bobPending
        .list()
        .find((item) => item.kind === "session_open" && item.thread === rejectedOpen.thread);
      if (!bobRejectPending) throw new Error("expected session_open pending");
      await bobMachine.handleRejectOpen({
        pending_id: bobRejectPending.id,
        reason: "scope",
        via_human: true,
      });
      const rejectedBefore = aliceMachine.store.get(rejectedOpen.thread);

      const expiredOpen = await aliceMachine.handleOpen({ to: bobId, ...openPayload });
      expect(expiredOpen.ok).toBe(true);
      if (!expiredOpen.ok) return;
      vi.advanceTimersByTime(SESSION_OPEN_TTL_MS + 1);
      await bobMachine.handleExpireSessions();
      const expiredBefore = aliceMachine.store.get(expiredOpen.thread);

      aliceMachine.handleBondRevoke(bobId);

      expect(aliceMachine.store.get(finalizedThread)).toEqual(finalizedBefore);
      expect(aliceMachine.store.get(rejectedOpen.thread)).toEqual(rejectedBefore);
      expect(aliceMachine.store.get(expiredOpen.thread)).toEqual(expiredBefore);
    });

    it("closes only sessions for the revoked peer", async () => {
      aliceAllowlist.set(aliceId, [bobId, carolId]);
      aliceBonds.add(aliceId, {
        peer: carolId,
        scope: ["session.negotiate"],
        mode: "ephemeral_until_session_closes",
      });

      const bobThreads = [await openAndApprove(), await openAndApprove(), await openAndApprove()];
      const carolOpen = await aliceMachine.handleOpen({ to: carolId, ...openPayload });
      expect(carolOpen.ok).toBe(true);
      if (!carolOpen.ok) return;

      aliceMachine.handleBondRevoke(bobId);

      for (const thread of bobThreads) {
        const status = await aliceMachine.handleStatus({ thread });
        expect(status.status).toBe("closed");
        expect(status.reject_reason).toBe("bond_revoked");
      }
      const carolStatus = await aliceMachine.handleStatus({ thread: carolOpen.thread });
      expect(carolStatus.status).toBe("pending");
    });

    it("removes session_open pending when revoking on recipient pending session", async () => {
      const thread = crypto.randomUUID();
      const inbound = await aliceMachine.handleIncomingEnvelope({
        from: bobId,
        type: "nego.open",
        thread,
        payload: JSON.stringify({
          ...openPayload,
          from: bobId,
        }),
      });
      expect(inbound.ok).toBe(true);
      const sessionOpenPending = alicePending.list().find((item) => item.kind === "session_open");
      expect(sessionOpenPending).toBeDefined();
      if (!sessionOpenPending) return;

      aliceMachine.handleBondRevoke(bobId);

      expect(alicePending.get(sessionOpenPending.id)).toBeUndefined();
      const status = await aliceMachine.handleStatus({ thread });
      expect(status.status).toBe("closed");
      expect(status.reject_reason).toBe("bond_revoked");
    });

    it("sweeps budget_extend pending on live session revoke", async () => {
      const thread = await openAndApprove();
      const budgetPending = alicePending.addBudgetExtend({ thread, peer: bobId });

      aliceMachine.handleBondRevoke(bobId);

      expect(alicePending.get(budgetPending.id)).toBeUndefined();
      const status = await aliceMachine.handleStatus({ thread });
      expect(status.status).toBe("closed");
      expect(status.reject_reason).toBe("bond_revoked");
    });

    it("sweeps orphan ratify pending on normal-closed session", async () => {
      const thread = await openAndApprove();
      const artifactHash = "sha256:orphan-ratify-sweep";
      await signFlowToSigned(thread, artifactHash);
      await aliceMachine.handleThreadClose(thread);
      const orphanRatify = alicePending.addRatify({ thread, peer: bobId, artifactHash });
      expect(alicePending.get(orphanRatify.id)).toBeDefined();

      aliceMachine.handleBondRevoke(bobId);

      expect(alicePending.get(orphanRatify.id)).toBeUndefined();
      aliceBonds.remove(aliceId, bobId);
      const status = await aliceMachine.handleStatus({ thread });
      expect(status.pending_id).toBeUndefined();
      expect(status.status).toBe("closed");
      expect(status.reject_reason).toBe("thread_closed");
    });
  });

  describe("ensureRatifyPending bond revoke guards", () => {
    it("does not re-queue ratify after bond_revoked close via session_status", async () => {
      const thread = await openAndApprove();
      const artifactHash = "sha256:ratify-guard-bond-revoked";
      await signFlowToSigned(thread, artifactHash);
      expect(alicePending.list().some((item) => item.kind === "ratify")).toBe(true);

      aliceMachine.handleBondRevoke(bobId);
      for (const item of alicePending
        .list()
        .filter((pending) => pending.kind === "ratify" && pending.thread === thread)) {
        alicePending.remove(item.id);
      }

      const status = await aliceMachine.handleStatus({ thread });
      expect(status.ok).toBe(true);
      if (!status.ok) return;
      expect(status.status).toBe("closed");
      expect(status.reject_reason).toBe("bond_revoked");
      expect(status.pending_id).toBeUndefined();
      expect(
        alicePending.list().some((item) => item.kind === "ratify" && item.thread === thread),
      ).toBe(false);
    });

    it("does not re-queue ratify when bond absent on normal-closed session", async () => {
      const thread = await openAndApprove();
      const artifactHash = "sha256:ratify-guard-no-bond";
      await signFlowToSigned(thread, artifactHash);
      await aliceMachine.handleThreadClose(thread, "done");
      aliceBonds.remove(aliceId, bobId);

      const status = await aliceMachine.handleStatus({ thread });
      expect(status.ok).toBe(true);
      if (!status.ok) return;
      expect(status.pending_id).toBeUndefined();
      expect(
        alicePending.list().some((item) => item.kind === "ratify" && item.thread === thread),
      ).toBe(false);
    });

    it("re-queues ratify on thread_closed after revoke and re-bond", async () => {
      const thread = await openAndApprove();
      const artifactHash = "sha256:ratify-guard-revoke-rebond-normal";
      await signFlowToSigned(thread, artifactHash);
      await aliceMachine.handleThreadClose(thread);

      aliceMachine.handleBondRevoke(bobId);
      aliceBonds.remove(aliceId, bobId);

      let status = await aliceMachine.handleStatus({ thread });
      expect(status.ok).toBe(true);
      if (!status.ok) return;
      expect(status.reject_reason).toBe("thread_closed");
      expect(status.pending_id).toBeUndefined();

      aliceBonds.add(aliceId, {
        peer: bobId,
        scope: ["session.negotiate"],
        mode: "ephemeral_until_session_closes",
      });
      status = await aliceMachine.handleStatus({ thread });
      expect(status.pending_id).toBeTypeOf("string");
    });

    it("re-queues ratify on normal-closed after re-bond but never on bond_revoked", async () => {
      const normalThread = await openAndApprove();
      const artifactHash = "sha256:ratify-guard-rebond";
      await signFlowToSigned(normalThread, artifactHash);
      await aliceMachine.handleThreadClose(normalThread, "done");
      aliceBonds.remove(aliceId, bobId);

      let status = await aliceMachine.handleStatus({ thread: normalThread });
      expect(status.pending_id).toBeUndefined();

      aliceBonds.add(aliceId, {
        peer: bobId,
        scope: ["session.negotiate"],
        mode: "ephemeral_until_session_closes",
      });
      status = await aliceMachine.handleStatus({ thread: normalThread });
      expect(status.pending_id).toBeTypeOf("string");

      const revokedThread = await openAndApprove();
      await signFlowToSigned(revokedThread, artifactHash);
      aliceMachine.handleBondRevoke(bobId);
      aliceBonds.add(aliceId, {
        peer: bobId,
        scope: ["session.negotiate"],
        mode: "ephemeral_until_session_closes",
      });

      status = await aliceMachine.handleStatus({ thread: revokedThread });
      expect(status.reject_reason).toBe("bond_revoked");
      expect(status.pending_id).toBeUndefined();
      expect(
        alicePending.list().some((item) => item.kind === "ratify" && item.thread === revokedThread),
      ).toBe(false);
    });
  });

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
      payload: JSON.stringify(openPayload),
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

    const expired = await bobMachine.handleExpireSessions();
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

  it("ratification requires human_approve on both sides before co-sign", async () => {
    wireAtestCapableBonds();
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

  it("session_sign rejects when payload-size test_report is red", async () => {
    wireAtestCapableBonds();
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
      budget: { max_turns: 2, deadline: FUTURE_DEADLINE },
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
    wireAtestCapableBonds();
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
      expect(status.tests_legal).toBe(true);
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
      expect(status.tests_legal).toBe(true);
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
      expect(status.tests_legal).toBe(true);
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

  describe("terminal wire precision guard", () => {
    async function finalizeToClosed(): Promise<string> {
      const thread = await openAndApprove();
      const artifactHash = "sha256:terminal-guard-finalized";
      await signFlowToSigned(thread, artifactHash);
      const aliceRatify = alicePending.list().find((item) => item.kind === "ratify");
      const bobRatify = bobPending.list().find((item) => item.kind === "ratify");
      if (!aliceRatify || !bobRatify) throw new Error("expected ratify pending");
      await aliceMachine.handleRatify({ pending_id: aliceRatify.id, via_human: true });
      await bobMachine.handleRatify({ pending_id: bobRatify.id, via_human: true });
      return thread;
    }

    async function rejectOpen(): Promise<string> {
      const opened = await aliceMachine.handleOpen({ to: bobId, ...openPayload });
      expect(opened.ok).toBe(true);
      if (!opened.ok) throw new Error("open failed");
      const bobRejectPending = bobPending
        .list()
        .find((item) => item.kind === "session_open" && item.thread === opened.thread);
      if (!bobRejectPending) throw new Error("expected session_open pending");
      await bobMachine.handleRejectOpen({
        pending_id: bobRejectPending.id,
        reason: "scope",
        via_human: true,
      });
      return opened.thread;
    }

    async function expireOpen(): Promise<string> {
      const opened = await aliceMachine.handleOpen({ to: bobId, ...openPayload });
      expect(opened.ok).toBe(true);
      if (!opened.ok) throw new Error("open failed");
      vi.advanceTimersByTime(SESSION_OPEN_TTL_MS + 1);
      await bobMachine.handleExpireSessions();
      return opened.thread;
    }

    async function bondRevokeClosed(): Promise<string> {
      const thread = await openAndApprove();
      aliceMachine.handleBondRevoke(bobId);
      return thread;
    }

    async function threadCloseClosed(): Promise<string> {
      const thread = await openAndApprove();
      await aliceMachine.handleThreadClose(thread);
      return thread;
    }

    const illegalMutationCases = [
      {
        type: "nego.open_approved",
        from: (thread: string) => bobId,
        payload: (thread: string) => JSON.stringify({ thread }),
      },
      {
        type: "nego.turn",
        from: () => bobId,
        payload: () =>
          JSON.stringify({
            turn_count: 1,
            msg_type: "propose",
            body: JSON.stringify({ diff: "late" }),
          }),
      },
      {
        type: "nego.signed",
        from: () => bobId,
        payload: () => JSON.stringify({ artifact_hash: "sha256:late-sign" }),
      },
      {
        type: "atest.challenge",
        from: () => bobId,
        payload: () => "{}",
      },
      {
        type: "atest.report",
        from: () => bobId,
        payload: () =>
          JSON.stringify({
            artifact_hash: "sha256:late-report",
            passed: true,
            runner: "payload-size",
          }),
      },
    ] as const;

    const terminalFactories = [
      { label: "closed (finalized)", factory: finalizeToClosed },
      { label: "open_rejected", factory: rejectOpen },
      { label: "open_expired", factory: expireOpen },
    ] as const;

    for (const terminal of terminalFactories) {
      for (const mutation of illegalMutationCases) {
        it(`rejects ${mutation.type} on ${terminal.label} with thread_closed`, async () => {
          const thread = await terminal.factory();
          const before = aliceMachine.store.get(thread);
          expect(before).toBeDefined();
          if (!before) return;

          const result = await aliceMachine.handleIncomingEnvelope({
            from: mutation.from(thread),
            type: mutation.type,
            thread,
            payload: mutation.payload(thread),
          });
          expect(result).toEqual({ ok: false, error: "thread_closed" });
          expect(aliceMachine.store.get(thread)).toEqual(before);
        });
      }
    }

    for (const mutation of illegalMutationCases) {
      it(`rejects ${mutation.type} on closed (bond_revoked) with thread_closed`, async () => {
        const thread = await bondRevokeClosed();
        const before = aliceMachine.store.get(thread);
        expect(before).toBeDefined();
        if (!before) return;

        const result = await aliceMachine.handleIncomingEnvelope({
          from: mutation.from(thread),
          type: mutation.type,
          thread,
          payload: mutation.payload(thread),
        });
        expect(result).toEqual({ ok: false, error: "thread_closed" });
        expect(aliceMachine.store.get(thread)).toEqual(before);
      });

      it(`rejects ${mutation.type} on closed (thread_closed) with thread_closed`, async () => {
        const thread = await threadCloseClosed();
        const before = aliceMachine.store.get(thread);
        expect(before).toBeDefined();
        if (!before) return;

        const result = await aliceMachine.handleIncomingEnvelope({
          from: mutation.from(thread),
          type: mutation.type,
          thread,
          payload: mutation.payload(thread),
        });
        expect(result).toEqual({ ok: false, error: "thread_closed" });
        expect(aliceMachine.store.get(thread)).toEqual(before);
      });
    }

    it("rejects open_reject on closed (finalized) with thread_closed", async () => {
      const thread = await finalizeToClosed();
      const before = aliceMachine.store.get(thread);
      expect(before).toBeDefined();
      if (!before) return;

      const result = await aliceMachine.handleIncomingEnvelope({
        from: bobId,
        type: "nego.open_reject",
        thread,
        payload: JSON.stringify({ reason: "late reject" }),
      });
      expect(result).toEqual({ ok: false, error: "thread_closed" });
      expect(aliceMachine.store.get(thread)).toEqual(before);
    });

    it("rejects open_reject on closed (bond_revoked) with thread_closed", async () => {
      const thread = await bondRevokeClosed();
      const before = aliceMachine.store.get(thread);
      expect(before).toBeDefined();
      if (!before) return;

      const result = await aliceMachine.handleIncomingEnvelope({
        from: bobId,
        type: "nego.open_reject",
        thread,
        payload: JSON.stringify({ reason: "late reject" }),
      });
      expect(result).toEqual({ ok: false, error: "thread_closed" });
      expect(aliceMachine.store.get(thread)).toEqual(before);
    });

    it("rejects open_expired on closed (finalized) with thread_closed", async () => {
      const thread = await finalizeToClosed();
      const before = aliceMachine.store.get(thread);
      expect(before).toBeDefined();
      if (!before) return;

      const result = await aliceMachine.handleIncomingEnvelope({
        from: bobId,
        type: "nego.open_expired",
        thread,
        payload: JSON.stringify({ thread }),
      });
      expect(result).toEqual({ ok: false, error: "thread_closed" });
      expect(aliceMachine.store.get(thread)).toEqual(before);
    });

    it("rejects open_expired on closed (bond_revoked) with thread_closed", async () => {
      const thread = await bondRevokeClosed();
      const before = aliceMachine.store.get(thread);
      expect(before).toBeDefined();
      if (!before) return;

      const result = await aliceMachine.handleIncomingEnvelope({
        from: bobId,
        type: "nego.open_expired",
        thread,
        payload: JSON.stringify({ thread }),
      });
      expect(result).toEqual({ ok: false, error: "thread_closed" });
      expect(aliceMachine.store.get(thread)).toEqual(before);
    });

    it("accepts ratified redelivery on finalized closed without mutation", async () => {
      const thread = await finalizeToClosed();
      const before = aliceMachine.store.get(thread);
      expect(before?.coSignedHash).toBeDefined();
      if (!before) return;

      const result = await aliceMachine.handleIncomingEnvelope({
        from: bobId,
        type: "nego.ratified",
        thread,
        payload: JSON.stringify({ artifact_hash: before.coSignedHash }),
      });
      expect(result).toEqual({ ok: true, thread, status: "closed" });
      expect(aliceMachine.store.get(thread)).toEqual(before);
    });

    it("accepts open_reject redelivery on open_rejected without mutation", async () => {
      const thread = await rejectOpen();
      const before = aliceMachine.store.get(thread);
      expect(before?.status).toBe("open_rejected");
      if (!before) return;

      const result = await aliceMachine.handleIncomingEnvelope({
        from: bobId,
        type: "nego.open_reject",
        thread,
        payload: JSON.stringify({ reason: "scope" }),
      });
      expect(result).toEqual({ ok: true, thread, status: "open_rejected" });
      expect(aliceMachine.store.get(thread)).toEqual(before);
    });

    it("accepts open_expired redelivery on open_expired without mutation", async () => {
      const thread = await expireOpen();
      const before = aliceMachine.store.get(thread);
      expect(before?.status).toBe("open_expired");
      if (!before) return;

      const result = await aliceMachine.handleIncomingEnvelope({
        from: bobId,
        type: "nego.open_expired",
        thread,
        payload: JSON.stringify({ thread }),
      });
      expect(result).toEqual({ ok: true, thread, status: "open_expired" });
      expect(aliceMachine.store.get(thread)).toEqual(before);
    });

    it("nego.open redelivery on closed returns ok without mutation", async () => {
      const thread = await finalizeToClosed();
      const before = aliceMachine.store.get(thread);
      expect(before).toBeDefined();
      if (!before) return;

      const result = await aliceMachine.handleIncomingEnvelope({
        from: aliceId,
        type: "nego.open",
        thread,
        payload: JSON.stringify({
          ...openPayload,
          from: aliceId,
        }),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.status).toBe("closed");
      expect(aliceMachine.store.get(thread)).toEqual(before);
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

  describe("deadline expiry (M2.4)", () => {
    function sessionOpenPendingId(): string {
      const pending = bobPending.list().find((i) => i.kind === "session_open");
      if (!pending) {
        throw new Error("expected session_open pending item");
      }
      return pending.id;
    }

    function requireSession(thread: string) {
      const session = aliceMachine.store.get(thread);
      if (!session) {
        throw new Error(`expected session ${thread}`);
      }
      return session;
    }

    it("handleOpen rejects past deadline before creating session or sending", async () => {
      const aliceSends: RelayCapture[] = [];
      const { alice } = createLinkedMachines({ aliceSends });
      aliceMachine = alice;
      const beforeCount = aliceMachine.store.list().length;
      const result = await aliceMachine.handleOpen({
        to: bobId,
        ...openPayload,
        budget: { max_turns: 30, deadline: PAST_DEADLINE },
      });
      expect(result).toEqual({ ok: false, error: "invalid_payload" });
      expect(aliceMachine.store.list().length).toBe(beforeCount);
      expect(aliceSends).toHaveLength(0);
    });

    it("handleOpen accepts deadline equal to now (strict > guard)", async () => {
      vi.setSystemTime(new Date("2030-06-01T12:00:00.000Z"));
      const deadline = "2030-06-01T12:00:00.000Z";
      const result = await aliceMachine.handleOpen({
        to: bobId,
        ...openPayload,
        budget: { max_turns: 30, deadline },
      });
      expect(result.ok).toBe(true);
    });

    it("handleOpen wire payload has budget.deadline and no expires_at", async () => {
      const aliceSends: RelayCapture[] = [];
      const { alice, bob } = createLinkedMachines({ aliceSends });
      aliceMachine = alice;
      bobMachine = bob;
      const opened = await aliceMachine.handleOpen({ to: bobId, ...openPayload });
      expect(opened.ok).toBe(true);
      const openSend = aliceSends.find((s) => s.type === "nego.open");
      if (!openSend) {
        throw new Error("expected nego.open send");
      }
      const body = JSON.parse(openSend.payload) as Record<string, unknown>;
      expect((body.budget as { deadline?: string }).deadline).toBeDefined();
      expect(body).not.toHaveProperty("expires_at");
    });

    it("recipient session expiresAt equals createdAt + SESSION_OPEN_TTL_MS", async () => {
      vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
      const thread = crypto.randomUUID();
      await bobMachine.handleIncomingOpen({
        thread,
        from: aliceId,
        goal: openPayload.goal,
        acceptance: openPayload.acceptance,
        budget: openPayload.budget,
        mandate: openPayload.mandate,
      });
      const session = bobMachine.store.get(thread);
      expect(session?.expiresAt).toBe(Date.now() + SESSION_OPEN_TTL_MS);
    });

    it("handleIncomingOpen with past deadline → open_expired, no pending, courtesy sent", async () => {
      const bobSends: RelayCapture[] = [];
      const { bob } = createLinkedMachines({ bobSends });
      const thread = crypto.randomUUID();
      const result = await bob.handleIncomingOpen({
        thread,
        from: aliceId,
        goal: openPayload.goal,
        acceptance: openPayload.acceptance,
        budget: { max_turns: 30, deadline: PAST_DEADLINE },
        mandate: openPayload.mandate,
      });
      expect(result).toMatchObject({ ok: true, status: "open_expired" });
      expect(bob.store.get(thread)?.status).toBe("open_expired");
      expect(bobPending.list().filter((i) => i.kind === "session_open")).toHaveLength(0);
      expect(bobSends.some((s) => s.type === "nego.open_expired")).toBe(true);
      expect(bobSends[0]).toMatchObject({ type: "nego.open_expired", to: aliceId, thread });
    });

    it("redelivered nego.open on open_expired is no-op", async () => {
      const bobSends: RelayCapture[] = [];
      const { bob } = createLinkedMachines({ bobSends });
      const thread = crypto.randomUUID();
      const input = {
        thread,
        from: aliceId,
        goal: openPayload.goal,
        acceptance: openPayload.acceptance,
        budget: { max_turns: 30, deadline: PAST_DEADLINE },
        mandate: openPayload.mandate,
      };
      await bob.handleIncomingOpen(input);
      const sendCountAfterFirst = bobSends.length;
      const beforePending = bobPending.list().length;
      const second = await bob.handleIncomingOpen(input);
      expect(second).toMatchObject({ ok: true, status: "open_expired" });
      expect(bobPending.list().length).toBe(beforePending);
      expect(bobSends.length).toBe(sendCountAfterFirst);
    });

    it("now equal to deadline is not expired for effectiveOpenExpiry check", async () => {
      vi.setSystemTime(new Date("2030-06-01T12:00:00.000Z"));
      const deadline = "2030-06-01T12:00:00.000Z";
      const opened = await aliceMachine.handleOpen({
        to: bobId,
        ...openPayload,
        budget: { max_turns: 30, deadline },
      });
      if (!opened.ok) throw new Error("open failed");
      const approve = await bobMachine.handleApproveOpen({
        pending_id: sessionOpenPendingId(),
        via_human: true,
      });
      expect(approve.ok).toBe(true);
    });

    it("approve after effectiveOpenExpiry → session_open_expired + open_expired", async () => {
      const shortDeadline = new Date(Date.now() + 30 * 60_000).toISOString();
      const opened = await aliceMachine.handleOpen({
        to: bobId,
        ...openPayload,
        budget: { max_turns: 30, deadline: shortDeadline },
      });
      if (!opened.ok) throw new Error("open failed");
      const pendingId = sessionOpenPendingId();
      vi.advanceTimersByTime(31 * 60_000);
      const result = await bobMachine.handleApproveOpen({ pending_id: pendingId, via_human: true });
      expect(result).toEqual({ ok: false, error: "session_open_expired" });
      expect(bobMachine.store.get(opened.thread)?.status).toBe("open_expired");
    });

    it("reject after effectiveOpenExpiry → session_open_expired, no nego.open_reject", async () => {
      const bobSends: RelayCapture[] = [];
      const { alice, bob } = createLinkedMachines({ bobSends });
      aliceMachine = alice;
      bobMachine = bob;
      const shortDeadline = new Date(Date.now() + 30 * 60_000).toISOString();
      await aliceMachine.handleOpen({
        to: bobId,
        ...openPayload,
        budget: { max_turns: 30, deadline: shortDeadline },
      });
      const pendingId = sessionOpenPendingId();
      vi.advanceTimersByTime(31 * 60_000);
      const result = await bobMachine.handleRejectOpen({
        pending_id: pendingId,
        reason: "no",
        via_human: true,
      });
      expect(result).toEqual({ ok: false, error: "session_open_expired" });
      expect(bobSends.some((s) => s.type === "nego.open_reject")).toBe(false);
    });

    it("handleExpireSessions closes live session with deadline_expired", async () => {
      const thread = await openAndApprove();
      const session = requireSession(thread);
      const nearDeadline = new Date(Date.now() + 60_000).toISOString();
      aliceMachine.store.upsert({
        ...session,
        budget: { ...session.budget, deadline: nearDeadline },
      });
      vi.advanceTimersByTime(120_000);
      await aliceMachine.handleExpireSessions();
      expect(aliceMachine.store.get(thread)?.status).toBe("closed");
      expect(aliceMachine.store.get(thread)?.rejectReason).toBe("deadline_expired");
    });

    it("handleMsg on expired live → session_not_live + budget_extend GC", async () => {
      const opened = await aliceMachine.handleOpen({
        to: bobId,
        ...openPayload,
        budget: { max_turns: 1, deadline: FUTURE_DEADLINE },
      });
      if (!opened.ok) throw new Error("open failed");
      await bobMachine.handleApproveOpen({ pending_id: sessionOpenPendingId(), via_human: true });
      const thread = opened.thread;
      const okTurn = await aliceMachine.handleMsg({
        thread,
        type: "propose",
        body: JSON.stringify({ section_id: "s0" }),
      });
      expect(okTurn.ok).toBe(true);
      const exhausted = await aliceMachine.handleMsg({
        thread,
        type: "propose",
        body: JSON.stringify({ section_id: "s1" }),
      });
      expect(exhausted).toEqual({ ok: false, error: "budget_exhausted" });
      expect(
        alicePending.list().some((p) => p.kind === "budget_extend" && p.thread === thread),
      ).toBe(true);
      const session = requireSession(thread);
      const nearDeadline = new Date(Date.now() + 60_000).toISOString();
      aliceMachine.store.upsert({
        ...session,
        budget: { ...session.budget, deadline: nearDeadline },
      });
      vi.advanceTimersByTime(120_000);
      const result = await aliceMachine.handleMsg({ thread, type: "propose", body: "{}" });
      expect(result).toEqual({ ok: false, error: "session_not_live" });
      expect(
        alicePending.list().some((p) => p.kind === "budget_extend" && p.thread === thread),
      ).toBe(false);
    });

    it("handleSign on expired live → session_not_live after auto-close", async () => {
      const thread = await openAndApprove();
      const session = requireSession(thread);
      const nearDeadline = new Date(Date.now() + 60_000).toISOString();
      aliceMachine.store.upsert({
        ...session,
        budget: { ...session.budget, deadline: nearDeadline },
      });
      vi.advanceTimersByTime(120_000);
      const result = await aliceMachine.handleSign({ thread, artifact_hash: "sha256:abc" });
      expect(result).toEqual({ ok: false, error: "session_not_live" });
      expect(aliceMachine.store.get(thread)?.rejectReason).toBe("deadline_expired");
    });

    it("handleIncomingEnvelope nego.turn on expired live → thread_closed", async () => {
      const thread = await openAndApprove();
      const session = requireSession(thread);
      const nearDeadline = new Date(Date.now() + 60_000).toISOString();
      const bobSession = bobMachine.store.get(thread);
      if (!bobSession) {
        throw new Error(`expected bob session ${thread}`);
      }
      bobMachine.store.upsert({
        ...bobSession,
        budget: { ...session.budget, deadline: nearDeadline },
      });
      vi.advanceTimersByTime(120_000);
      const result = await bobMachine.handleIncomingEnvelope({
        from: aliceId,
        type: "nego.turn",
        thread,
        payload: JSON.stringify({ turn_count: 1, msg_type: "propose", body: "{}" }),
      });
      expect(result).toEqual({ ok: false, error: "thread_closed" });
    });

    it("handleStatus on expired live → closed + deadline_expired", async () => {
      const thread = await openAndApprove();
      const session = requireSession(thread);
      const nearDeadline = new Date(Date.now() + 60_000).toISOString();
      aliceMachine.store.upsert({
        ...session,
        budget: { ...session.budget, deadline: nearDeadline },
      });
      vi.advanceTimersByTime(120_000);
      const result = await aliceMachine.handleStatus({ thread });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.status).toBe("closed");
        expect(result.reject_reason).toBe("deadline_expired");
      }
    });

    it("signed past deadline survives sweep", async () => {
      const thread = await openAndApprove();
      await signFlowToSigned(thread, "sha256:deadline-survive-test");
      const session = requireSession(thread);
      const pastDeadline = new Date(Date.now() - 60_000).toISOString();
      aliceMachine.store.upsert({
        ...session,
        budget: { ...session.budget, deadline: pastDeadline },
      });
      await aliceMachine.handleExpireSessions();
      expect(aliceMachine.store.get(thread)?.status).toBe("signed");
      expect(alicePending.list().some((p) => p.kind === "ratify" && p.thread === thread)).toBe(
        true,
      );
    });

    it("core.close after deadline_expired is no-op on rejectReason", async () => {
      const thread = await openAndApprove();
      const session = requireSession(thread);
      const nearDeadline = new Date(Date.now() + 60_000).toISOString();
      aliceMachine.store.upsert({
        ...session,
        budget: { ...session.budget, deadline: nearDeadline },
      });
      vi.advanceTimersByTime(120_000);
      await aliceMachine.handleStatus({ thread });
      const close = await aliceMachine.handleThreadClose(thread, "user_abort");
      expect(close.status).toBe("closed");
      expect(aliceMachine.store.get(thread)?.rejectReason).toBe("deadline_expired");
    });

    it("initiator pending expire sends no envelope", async () => {
      const aliceSends: RelayCapture[] = [];
      const { alice, bob } = createLinkedMachines({ aliceSends });
      aliceMachine = alice;
      bobMachine = bob;
      const shortDeadline = new Date(Date.now() + 30 * 60_000).toISOString();
      await aliceMachine.handleOpen({
        to: bobId,
        ...openPayload,
        budget: { max_turns: 30, deadline: shortDeadline },
      });
      aliceSends.length = 0;
      vi.advanceTimersByTime(31 * 60_000);
      await aliceMachine.handleExpireSessions();
      expect(aliceSends).toHaveLength(0);
      expect(aliceMachine.store.list()[0]?.status).toBe("open_expired");
    });

    it("ensureRecipientOpenPending re-queues gate when pending dropped but session valid", async () => {
      const opened = await aliceMachine.handleOpen({ to: bobId, ...openPayload });
      if (!opened.ok) throw new Error("open failed");
      const pendingBefore = bobPending.list().filter((i) => i.kind === "session_open");
      expect(pendingBefore).toHaveLength(1);
      const dropped = pendingBefore[0];
      if (!dropped) {
        throw new Error("expected session_open pending item");
      }
      bobPending.remove(dropped.id);
      const status = await bobMachine.handleStatus({ thread: opened.thread });
      expect(status.ok).toBe(true);
      if (status.ok) {
        expect(status.pending_id).toBeDefined();
        expect(status.pending_kind).toBe("session_open");
      }
    });

    it("exports handleExpireSessions", () => {
      expect(typeof aliceMachine.handleExpireSessions).toBe("function");
      expect(
        (aliceMachine as { handleExpirePendingOpens?: unknown }).handleExpirePendingOpens,
      ).toBeUndefined();
    });
  });

  describe("N6 wire-derived turn count (M2.5)", () => {
    function requireN6Session(thread: string) {
      const session = aliceMachine.store.get(thread);
      if (!session) {
        throw new Error(`expected session ${thread}`);
      }
      return session;
    }

    function peerTurnEnvelope(turnCount?: number): string {
      const payload: Record<string, unknown> = {
        msg_type: "propose",
        body: JSON.stringify({ diff: "peer" }),
      };
      if (turnCount !== undefined) {
        payload.turn_count = turnCount;
      }
      return JSON.stringify(payload);
    }

    async function liveSessionAtTurnCountTwo(): Promise<string> {
      const thread = await openAndApprove();
      const session = requireN6Session(thread);
      aliceMachine.store.upsert({ ...session, turnCount: 2 });
      return thread;
    }

    it("rejects nego.turn in pending with session_not_live and no side effects", async () => {
      const opened = await aliceMachine.handleOpen({ to: bobId, ...openPayload });
      expect(opened.ok).toBe(true);
      if (!opened.ok) {
        throw new Error("open failed");
      }
      const thread = opened.thread;
      const before = requireN6Session(thread);
      expect(before.status).toBe("pending");

      const result = await aliceMachine.handleIncomingEnvelope({
        from: bobId,
        type: "nego.turn",
        thread,
        payload: peerTurnEnvelope(1),
      });
      expect(result).toEqual({ ok: false, error: "session_not_live" });

      const after = requireN6Session(thread);
      expect(after.turnCount).toBe(before.turnCount);
      expect(after.peerMessages).toEqual(before.peerMessages);
      expect(after.status).toBe("pending");
    });

    it("rejects nego.turn in signed with session_not_live and no increment", async () => {
      const thread = await openAndApprove();
      await signFlowToSigned(thread, "sha256:n6-signed-guard");
      const before = requireN6Session(thread);
      expect(before.status).toBe("signed");

      const result = await aliceMachine.handleIncomingEnvelope({
        from: bobId,
        type: "nego.turn",
        thread,
        payload: peerTurnEnvelope(1),
      });
      expect(result).toEqual({ ok: false, error: "session_not_live" });
      expect(requireN6Session(thread).turnCount).toBe(before.turnCount);
    });

    it("rejects nego.turn in terminal status with thread_closed", async () => {
      const thread = await openAndApprove();
      await aliceMachine.handleThreadClose(thread);

      const result = await aliceMachine.handleIncomingEnvelope({
        from: bobId,
        type: "nego.turn",
        thread,
        payload: peerTurnEnvelope(1),
      });
      expect(result).toEqual({ ok: false, error: "thread_closed" });
    });

    it.each([
      { label: "inflated peer counter", turn_count: 999 },
      { label: "zero peer counter", turn_count: 0 },
      { label: "negative peer counter", turn_count: -5 },
      { label: "absent peer counter", turn_count: undefined },
    ])(
      "increments wire-derived count ignoring peer turn_count ($label)",
      async ({ turn_count }) => {
        const thread = await liveSessionAtTurnCountTwo();

        const accepted = await aliceMachine.handleIncomingEnvelope({
          from: bobId,
          type: "nego.turn",
          thread,
          payload: peerTurnEnvelope(turn_count),
        });
        expect(accepted).toEqual({ ok: true, thread, type: "turn" });

        const after = await aliceMachine.handleStatus({ thread });
        expect(after.ok).toBe(true);
        if (!after.ok) {
          return;
        }
        expect(after.turn_count).toBe(3);
      },
    );

    describe("receive-side budget enforcement (R3)", () => {
      async function openLiveWithMaxTurns(maxTurns: number): Promise<string> {
        const opened = await aliceMachine.handleOpen({
          to: bobId,
          ...openPayload,
          budget: { max_turns: maxTurns, deadline: FUTURE_DEADLINE },
        });
        expect(opened.ok).toBe(true);
        if (!opened.ok) {
          throw new Error("open failed");
        }
        const bobPendingItems = bobPending.list().filter((item) => item.kind === "session_open");
        const bobPendingItem = bobPendingItems[0];
        if (!bobPendingItem) {
          throw new Error("expected session_open pending");
        }
        await bobMachine.handleApproveOpen({
          pending_id: bobPendingItem.id,
          via_human: true,
        });
        return opened.thread;
      }

      async function exhaustTurnBudgetViaMsgs(thread: string, maxTurns: number): Promise<void> {
        for (let i = 0; i < maxTurns; i++) {
          const machine = i % 2 === 0 ? aliceMachine : bobMachine;
          const type = i % 2 === 0 ? "propose" : "counter";
          const result = await machine.handleMsg({
            thread,
            type,
            body: JSON.stringify({ diff: `turn-${i}` }),
          });
          expect(result.ok).toBe(true);
        }
      }

      function budgetExtendCount(thread: string): number {
        return alicePending
          .list()
          .filter((item) => item.kind === "budget_extend" && item.thread === thread).length;
      }

      it("rejects over-budget nego.turn with budget_exhausted and registers one budget_extend", async () => {
        const maxTurns = 3;
        const thread = await openLiveWithMaxTurns(maxTurns);
        await exhaustTurnBudgetViaMsgs(thread, maxTurns);

        const before = requireN6Session(thread);
        expect(before.turnCount).toBe(maxTurns);

        const result = await aliceMachine.handleIncomingEnvelope({
          from: bobId,
          type: "nego.turn",
          thread,
          payload: peerTurnEnvelope(),
        });
        expect(result).toEqual({ ok: false, error: "budget_exhausted" });

        const after = requireN6Session(thread);
        expect(after.turnCount).toBe(maxTurns);
        expect(after.peerMessages).toEqual(before.peerMessages);
        expect(budgetExtendCount(thread)).toBe(1);
      });

      it("repeated over-budget nego.turn does not duplicate budget_extend pending", async () => {
        const maxTurns = 3;
        const thread = await openLiveWithMaxTurns(maxTurns);
        await exhaustTurnBudgetViaMsgs(thread, maxTurns);

        const first = await aliceMachine.handleIncomingEnvelope({
          from: bobId,
          type: "nego.turn",
          thread,
          payload: peerTurnEnvelope(),
        });
        expect(first).toEqual({ ok: false, error: "budget_exhausted" });
        expect(budgetExtendCount(thread)).toBe(1);

        const second = await aliceMachine.handleIncomingEnvelope({
          from: bobId,
          type: "nego.turn",
          thread,
          payload: peerTurnEnvelope(999),
        });
        expect(second).toEqual({ ok: false, error: "budget_exhausted" });
        expect(budgetExtendCount(thread)).toBe(1);
      });

      it("send-path then receive-path over-budget shares one budget_extend pending", async () => {
        const maxTurns = 3;
        const thread = await openLiveWithMaxTurns(maxTurns);
        await exhaustTurnBudgetViaMsgs(thread, maxTurns);

        const sendExhausted = await aliceMachine.handleMsg({
          thread,
          type: "propose",
          body: JSON.stringify({ diff: "over-send" }),
        });
        expect(sendExhausted).toEqual({ ok: false, error: "budget_exhausted" });
        expect(budgetExtendCount(thread)).toBe(1);

        const receiveExhausted = await aliceMachine.handleIncomingEnvelope({
          from: bobId,
          type: "nego.turn",
          thread,
          payload: peerTurnEnvelope(),
        });
        expect(receiveExhausted).toEqual({ ok: false, error: "budget_exhausted" });
        expect(budgetExtendCount(thread)).toBe(1);
      });

      it("receive-path then send-path over-budget shares one budget_extend pending", async () => {
        const maxTurns = 3;
        const thread = await openLiveWithMaxTurns(maxTurns);
        await exhaustTurnBudgetViaMsgs(thread, maxTurns);

        const receiveExhausted = await aliceMachine.handleIncomingEnvelope({
          from: bobId,
          type: "nego.turn",
          thread,
          payload: peerTurnEnvelope(),
        });
        expect(receiveExhausted).toEqual({ ok: false, error: "budget_exhausted" });
        expect(budgetExtendCount(thread)).toBe(1);

        const sendExhausted = await aliceMachine.handleMsg({
          thread,
          type: "propose",
          body: JSON.stringify({ diff: "over-send" }),
        });
        expect(sendExhausted).toEqual({ ok: false, error: "budget_exhausted" });
        expect(budgetExtendCount(thread)).toBe(1);
      });
    });
  });

  describe("M3.1 atest profile extraction", () => {
    const judgmentOpenPayload = {
      goal: "Human-reviewed contract",
      acceptance: [{ id: "J1", test: "judgment" as const, desc: "human review" }],
      budget: { max_turns: 30, deadline: FUTURE_DEADLINE },
      mandate: openPayload.mandate,
    };

    const dualRunnerOpenPayload = {
      goal: "Dual-runner executable gate",
      acceptance: [
        { id: "A1", test: "executable" as const, desc: "size", runner: "payload-size" },
        { id: "A2", test: "executable" as const, desc: "lint", runner: "spectral" },
      ],
      budget: { max_turns: 30, deadline: FUTURE_DEADLINE },
      mandate: openPayload.mandate,
    };

    async function openWithPayload(payload: typeof openPayload): Promise<string> {
      const opened = await aliceMachine.handleOpen({ to: bobId, ...payload });
      expect(opened.ok).toBe(true);
      if (!opened.ok) {
        throw new Error("session open failed");
      }
      const bobPendingItems = bobPending.list().filter((item) => item.kind === "session_open");
      expect(bobPendingItems.length).toBe(1);
      const pending = bobPendingItems[0];
      if (!pending) {
        throw new Error("expected session_open pending item");
      }
      const approved = await bobMachine.handleApproveOpen({
        pending_id: pending.id,
        via_human: true,
      });
      expect(approved.ok).toBe(true);
      return opened.thread as string;
    }

    function reportBody(hash: string, runner: string, passed = true): string {
      return JSON.stringify({ artifact_hash: hash, passed, runner });
    }

    beforeEach(() => {
      wireNegoOnlyBonds();
    });

    it("nego-only bond signs without atest ceremony", async () => {
      const thread = await openAndApprove();
      const hash = "sha256:m31-nego-only";
      const aliceSign = await aliceMachine.handleSign({ thread, artifact_hash: hash });
      expect(aliceSign.ok).toBe(true);
      const bobSign = await bobMachine.handleSign({ thread, artifact_hash: hash });
      expect(bobSign.ok).toBe(true);
      const status = await aliceMachine.handleStatus({ thread });
      expect(status.ok).toBe(true);
      if (!status.ok) {
        return;
      }
      expect(status.status).toBe("signed");
    });

    it("nego-only bond has tests_legal true on live session", async () => {
      const thread = await openAndApprove();
      const status = await aliceMachine.handleStatus({ thread });
      expect(status.ok).toBe(true);
      if (!status.ok) {
        return;
      }
      expect(status.tests_legal).toBe(true);
    });

    it("judgment-only session with atest/1 signs without ceremony", async () => {
      wireAtestCapableBonds();
      const thread = await openWithPayload(judgmentOpenPayload);
      const hash = "sha256:m31-judgment-only";
      expect((await aliceMachine.handleSign({ thread, artifact_hash: hash })).ok).toBe(true);
      expect((await bobMachine.handleSign({ thread, artifact_hash: hash })).ok).toBe(true);
      const status = await aliceMachine.handleStatus({ thread });
      expect(status.ok).toBe(true);
      if (!status.ok) {
        return;
      }
      expect(status.status).toBe("signed");
      expect(status.tests_legal).toBe(true);
    });

    it("executable + atest/1 returns challenges_incomplete then tests_not_green", async () => {
      wireAtestCapableBonds();
      const thread = await openAndApprove();
      const hash = "sha256:m31-exec-gate-order";

      const beforeChallenges = await aliceMachine.handleSign({ thread, artifact_hash: hash });
      expect(beforeChallenges.ok).toBe(false);
      if (beforeChallenges.ok) {
        return;
      }
      expect(beforeChallenges.error).toBe("challenges_incomplete");

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

      const beforeReports = await aliceMachine.handleSign({ thread, artifact_hash: hash });
      expect(beforeReports.ok).toBe(false);
      if (beforeReports.ok) {
        return;
      }
      expect(beforeReports.error).toBe("tests_not_green");
    });

    it("executable + atest/1 full ceremony succeeds when all runners green both sides", async () => {
      wireAtestCapableBonds();
      const thread = await openAndApprove();
      const hash = "sha256:m31-full-ceremony";

      await aliceMachine.handleMsg({ thread, type: "challenge", body: "{}" });
      await bobMachine.handleMsg({ thread, type: "challenge", body: "{}" });
      await aliceMachine.handleMsg({
        thread,
        type: "test_report",
        body: reportBody(hash, "payload-size"),
      });
      await bobMachine.handleMsg({
        thread,
        type: "test_report",
        body: reportBody(hash, "payload-size"),
      });

      expect((await aliceMachine.handleSign({ thread, artifact_hash: hash })).ok).toBe(true);
      expect((await bobMachine.handleSign({ thread, artifact_hash: hash })).ok).toBe(true);
      const status = await aliceMachine.handleStatus({ thread });
      expect(status.ok).toBe(true);
      if (!status.ok) {
        return;
      }
      expect(status.status).toBe("signed");
    });

    it("two runners with partial reports blocks sign with tests_not_green", async () => {
      wireAtestCapableBonds();
      const thread = await openWithPayload(dualRunnerOpenPayload);
      const hash = "sha256:m31-dual-partial";

      await aliceMachine.handleMsg({ thread, type: "challenge", body: "{}" });
      await bobMachine.handleMsg({ thread, type: "challenge", body: "{}" });
      await aliceMachine.handleMsg({
        thread,
        type: "test_report",
        body: reportBody(hash, "payload-size"),
      });
      await bobMachine.handleMsg({
        thread,
        type: "test_report",
        body: reportBody(hash, "payload-size"),
      });

      const blocked = await aliceMachine.handleSign({ thread, artifact_hash: hash });
      expect(blocked.ok).toBe(false);
      if (blocked.ok) {
        return;
      }
      expect(blocked.error).toBe("tests_not_green");
    });

    it("second report for a different runner does not overwrite the first", async () => {
      wireAtestCapableBonds();
      const thread = await openWithPayload(dualRunnerOpenPayload);
      const hash = "sha256:m31-no-overwrite";

      await aliceMachine.handleMsg({ thread, type: "challenge", body: "{}" });
      await bobMachine.handleMsg({ thread, type: "challenge", body: "{}" });

      await aliceMachine.handleMsg({
        thread,
        type: "test_report",
        body: reportBody(hash, "payload-size"),
      });
      await bobMachine.handleMsg({
        thread,
        type: "test_report",
        body: reportBody(hash, "payload-size"),
      });
      await aliceMachine.handleMsg({
        thread,
        type: "test_report",
        body: reportBody(hash, "spectral"),
      });

      const stillBlocked = await aliceMachine.handleSign({ thread, artifact_hash: hash });
      expect(stillBlocked.ok).toBe(false);
      if (stillBlocked.ok) {
        return;
      }
      expect(stillBlocked.error).toBe("tests_not_green");

      await bobMachine.handleMsg({
        thread,
        type: "test_report",
        body: reportBody(hash, "spectral"),
      });
      expect((await aliceMachine.handleSign({ thread, artifact_hash: hash })).ok).toBe(true);
      expect((await bobMachine.handleSign({ thread, artifact_hash: hash })).ok).toBe(true);
    });

    it("judgment + atest/1 records inbound atest.challenge but sign gate stays inert", async () => {
      wireAtestCapableBonds();
      const thread = await openWithPayload(judgmentOpenPayload);

      const inbound = await bobMachine.handleIncomingEnvelope({
        from: aliceId,
        type: "atest.challenge",
        thread,
        payload: "{}",
      });
      expect(inbound.ok).toBe(true);

      const stored = bobMachine.store.get(thread);
      expect(stored).toBeDefined();
      expect(stored?.challenges.initiator).toBe(true);

      const liveStatus = await bobMachine.handleStatus({ thread });
      expect(liveStatus.ok).toBe(true);
      if (!liveStatus.ok) {
        return;
      }
      expect(liveStatus.tests_legal).toBe(true);

      const hash = "sha256:m31-judgment-challenge";
      expect((await aliceMachine.handleSign({ thread, artifact_hash: hash })).ok).toBe(true);
      expect((await bobMachine.handleSign({ thread, artifact_hash: hash })).ok).toBe(true);
    });
  });
});
