// Full file: packages/protocol/src/session/turn-count.property.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const ITERATIONS = 300;
const FUZZ_SEED = 42;
// Hardcoded far-future deadline (unit tests use dynamic FUTURE_DEADLINE) — fine with vi.useFakeTimers().
const FUTURE_DEADLINE = "2099-12-31T23:59:59.000Z";

type TamperMode = "huge" | "zero" | "negative" | "absent";
type MsgType = "propose" | "counter" | "accept";

function mulberry32(seed: number) {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tamperTurnCount(payload: string, mode: TamperMode): string {
  const obj = JSON.parse(payload) as { turn_count?: number };
  if (mode === "huge") obj.turn_count = 999_999_999;
  else if (mode === "zero") obj.turn_count = 0;
  else if (mode === "negative") obj.turn_count = -42;
  else obj.turn_count = undefined;
  return JSON.stringify(obj);
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
    const item = { id: crypto.randomUUID(), kind: "session_open" as const, createdAt: 0, ...input };
    this.items.set(item.id, item);
    return item;
  }
  addRatify(input: RatifyPendingInput): SessionPendingItem {
    const item = { id: crypto.randomUUID(), kind: "ratify" as const, createdAt: 0, ...input };
    this.items.set(item.id, item);
    return item;
  }
  addBudgetExtend(input: BudgetExtendPendingInput): SessionPendingItem {
    const item = {
      id: crypto.randomUUID(),
      kind: "budget_extend" as const,
      createdAt: 0,
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
    this.store.set(
      agentId,
      this.get(agentId).filter((entry) => entry.peer !== peer),
    );
  }
}

describe("N6 turn count convergence property", () => {
  let aliceKeys: KeyPair;
  let bobKeys: KeyPair;
  let aliceId: string;
  let bobId: string;

  beforeEach(() => {
    vi.useFakeTimers();
    aliceKeys = generateKeyPair();
    bobKeys = generateKeyPair();
    aliceId = publicKeyToAgentId(aliceKeys.publicKey);
    bobId = publicKeyToAgentId(bobKeys.publicKey);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function wirePairing(
    aliceAllowlist: MemoryAllowlistStore,
    bobAllowlist: MemoryAllowlistStore,
    aliceBonds: MockBondStore,
    bobBonds: MockBondStore,
  ): void {
    aliceAllowlist.set(aliceId, [bobId]);
    bobAllowlist.set(bobId, [aliceId]);
    const bond = {
      scope: ["session.negotiate"] as const,
      mode: "ephemeral_until_session_closes" as const,
    };
    aliceBonds.add(aliceId, { peer: bobId, ...bond });
    bobBonds.add(bobId, { peer: aliceId, ...bond });
  }

  function createLinkedMachines(
    alicePending: MockPendingQueue,
    bobPending: MockPendingQueue,
    aliceAllowlist: MemoryAllowlistStore,
    bobAllowlist: MemoryAllowlistStore,
    aliceBonds: MockBondStore,
    bobBonds: MockBondStore,
    hooks: { pickTamperMode: () => TamperMode; onTurnDelivered: () => void },
  ): { alice: SessionStateMachine; bob: SessionStateMachine } {
    const peers = new Map<string, SessionStateMachine>();

    const deliver = async (
      fromId: string,
      input: { to: string; type: string; payload: string; thread: string },
    ) => {
      let payload = input.payload;
      if (input.type === "nego.turn") {
        const preTamper = JSON.parse(payload) as { turn_count?: number };
        const sender = peers.get(fromId);
        const senderTurn = sender?.store.get(input.thread)?.turnCount;
        expect(preTamper.turn_count).toBe(senderTurn);
        payload = tamperTurnCount(payload, hooks.pickTamperMode());
        hooks.onTurnDelivered();
      }
      const peer = peers.get(input.to);
      if (!peer) throw new Error(`unknown peer: ${input.to}`);
      await peer.handleIncomingEnvelope({ from: fromId, ...input, payload });
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

  async function openAndApprove(
    alice: SessionStateMachine,
    bob: SessionStateMachine,
    bobPending: MockPendingQueue,
    maxTurns: number,
  ): Promise<string> {
    const opened = await alice.handleOpen({
      to: bobId,
      goal: "N6 property fuzz",
      acceptance: [{ id: "A1", test: "executable", desc: "probe", runner: "vitest" }],
      budget: { max_turns: maxTurns, deadline: FUTURE_DEADLINE },
      mandate: {
        agent_may: ["propose", "counter", "accept_section", "challenge"],
        human_required: ["sign_final", "budget_extend", "constraint_change"],
      },
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("session open failed");

    const pending = bobPending.list().find((item) => item.kind === "session_open");
    if (!pending) throw new Error("expected session_open pending item");
    const approved = await bob.handleApproveOpen({ pending_id: pending.id, via_human: true });
    expect(approved.ok).toBe(true);
    return opened.thread;
  }

  function pickMsgType(rand: () => number): MsgType {
    const roll = rand();
    if (roll < 1 / 3) return "propose";
    if (roll < 2 / 3) return "counter";
    return "accept";
  }

  function makeBody(type: MsgType, rand: () => number, iter: number, turnIdx: number): string {
    const salt = `${iter}-${turnIdx}-${Math.floor(rand() * 10_000)}`;
    return type === "accept"
      ? JSON.stringify({ section_id: `sec-${salt}` })
      : JSON.stringify({ diff: `fuzz-${salt}` });
  }

  // [no-tdd — property-test task; mutation check step 3 is red-phase equivalent]
  it("keeps alice and bob turn counts equal to delivered wire turns under tampered payloads", async () => {
    const rand = mulberry32(FUZZ_SEED);
    const tamperModes: TamperMode[] = ["huge", "zero", "negative", "absent"];

    for (let iter = 0; iter < ITERATIONS; iter++) {
      const alicePending = new MockPendingQueue();
      const bobPending = new MockPendingQueue();
      const aliceAllowlist = new MemoryAllowlistStore();
      const bobAllowlist = new MemoryAllowlistStore();
      const aliceBonds = new MockBondStore();
      const bobBonds = new MockBondStore();
      wirePairing(aliceAllowlist, bobAllowlist, aliceBonds, bobBonds);

      let deliveredTurnCount = 0;
      const linked = createLinkedMachines(
        alicePending,
        bobPending,
        aliceAllowlist,
        bobAllowlist,
        aliceBonds,
        bobBonds,
        {
          pickTamperMode: () => {
            const idx = Math.floor(rand() * tamperModes.length);
            return tamperModes[idx] ?? "absent";
          },
          onTurnDelivered: () => {
            deliveredTurnCount++;
          },
        },
      );

      const maxTurns = 1 + Math.floor(rand() * 10);
      const thread = await openAndApprove(linked.alice, linked.bob, bobPending, maxTurns);

      const assertConvergence = () => {
        expect(linked.alice.store.get(thread)?.turnCount).toBe(deliveredTurnCount);
        expect(linked.bob.store.get(thread)?.turnCount).toBe(deliveredTurnCount);
      };

      while ((linked.alice.store.get(thread)?.turnCount ?? 0) < maxTurns) {
        const turnCount = linked.alice.store.get(thread)?.turnCount ?? 0;
        const host = turnCount % 2 === 0 ? linked.alice : linked.bob;
        const msgType = pickMsgType(rand);
        const result = await host.handleMsg({
          thread,
          type: msgType,
          body: makeBody(msgType, rand, iter, turnCount),
        });
        expect(result.ok).toBe(true);
        assertConvergence();
      }

      expect(deliveredTurnCount).toBe(maxTurns);
      const exhaustedHost = maxTurns % 2 === 0 ? linked.alice : linked.bob;
      const receiver = maxTurns % 2 === 0 ? linked.bob : linked.alice;
      const peerId = maxTurns % 2 === 0 ? aliceId : bobId;

      expect(
        await exhaustedHost.handleMsg({
          thread,
          type: "propose",
          body: JSON.stringify({ diff: `exhaust-send-${iter}` }),
        }),
      ).toEqual({ ok: false, error: "budget_exhausted" });

      expect(
        await receiver.handleIncomingEnvelope({
          from: peerId,
          type: "nego.turn",
          thread,
          payload: JSON.stringify({
            turn_count: 999_999,
            msg_type: "propose",
            body: JSON.stringify({ diff: `exhaust-recv-${iter}` }),
          }),
        }),
      ).toEqual({ ok: false, error: "budget_exhausted" });

      expect(linked.alice.store.get(thread)?.turnCount).toBe(maxTurns);
      expect(linked.bob.store.get(thread)?.turnCount).toBe(maxTurns);
    }
  });

  it("does not increment turn count when atest.challenge is received (R4)", async () => {
    const alicePending = new MockPendingQueue();
    const bobPending = new MockPendingQueue();
    const aliceAllowlist = new MemoryAllowlistStore();
    const bobAllowlist = new MemoryAllowlistStore();
    const aliceBonds = new MockBondStore();
    const bobBonds = new MockBondStore();
    wirePairing(aliceAllowlist, bobAllowlist, aliceBonds, bobBonds);

    const linked = createLinkedMachines(
      alicePending,
      bobPending,
      aliceAllowlist,
      bobAllowlist,
      aliceBonds,
      bobBonds,
      { pickTamperMode: () => "absent", onTurnDelivered: () => {} },
    );

    const thread = await openAndApprove(linked.alice, linked.bob, bobPending, 10);
    await linked.alice.handleMsg({
      thread,
      type: "propose",
      body: JSON.stringify({ diff: "r4-a" }),
    });
    await linked.bob.handleMsg({
      thread,
      type: "counter",
      body: JSON.stringify({ diff: "r4-b" }),
    });
    expect(linked.alice.store.get(thread)?.turnCount).toBe(2);
    expect(linked.bob.store.get(thread)?.turnCount).toBe(2);

    expect(
      await linked.alice.handleIncomingEnvelope({
        from: bobId,
        type: "atest.challenge",
        thread,
        payload: "{}",
      }),
    ).toEqual({ ok: true, thread, type: "challenge" });
    expect(linked.alice.store.get(thread)?.turnCount).toBe(2);
    expect(linked.bob.store.get(thread)?.turnCount).toBe(2);
  });
});
