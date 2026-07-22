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

export function agentIdFromKeys(keys: KeyPair): string {
  return publicKeyToAgentId(keys.publicKey);
}

export class MemoryAllowlistStore implements LocalAllowlistStore {
  private store = new Map<string, string[]>();

  get(agentId: string): string[] {
    return [...(this.store.get(agentId) ?? [])];
  }

  set(agentId: string, allowed: string[]): void {
    this.store.set(agentId, [...allowed]);
  }
}

export class MockPendingQueue implements SessionPendingQueue {
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

export class MockBondStore implements SessionBondStore {
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

export type RelayCapture = { type: string; to: string; thread: string; payload: string };

export type RelaySendInput = {
  to: string;
  type: string;
  payload: string;
  thread: string;
  seq?: number;
};

export type LinkedMachinesOptions = {
  capture?: {
    aliceSends?: RelayCapture[];
    bobSends?: RelayCapture[];
  };
  pauseDelivery?: boolean;
  injectSendFailure?: (input: {
    agentId: string;
    to: string;
    type: string;
    thread: string;
    payload: string;
  }) => boolean;
};

export type SessionTestFixtures = {
  aliceKeys: KeyPair;
  bobKeys: KeyPair;
  carolKeys: KeyPair;
  aliceId: string;
  bobId: string;
  carolId: string;
  alicePending: MockPendingQueue;
  bobPending: MockPendingQueue;
  aliceAllowlist: MemoryAllowlistStore;
  bobAllowlist: MemoryAllowlistStore;
  aliceBonds: MockBondStore;
  bobBonds: MockBondStore;
};

export function createSessionTestFixtures(): SessionTestFixtures {
  const aliceKeys = generateKeyPair();
  const bobKeys = generateKeyPair();
  const carolKeys = generateKeyPair();
  const aliceId = agentIdFromKeys(aliceKeys);
  const bobId = agentIdFromKeys(bobKeys);
  const carolId = agentIdFromKeys(carolKeys);
  const alicePending = new MockPendingQueue();
  const bobPending = new MockPendingQueue();
  const aliceAllowlist = new MemoryAllowlistStore();
  const bobAllowlist = new MemoryAllowlistStore();
  const aliceBonds = new MockBondStore();
  const bobBonds = new MockBondStore();

  aliceAllowlist.set(aliceId, [bobId]);
  bobAllowlist.set(bobId, [aliceId]);
  aliceBonds.add(aliceId, {
    peer: bobId,
    scope: ["session.negotiate"],
    mode: "ephemeral_until_session_closes",
    profiles: [...REFERENCE_PROFILES],
  });
  bobBonds.add(bobId, {
    peer: aliceId,
    scope: ["session.negotiate"],
    mode: "ephemeral_until_session_closes",
    profiles: [...REFERENCE_PROFILES],
  });

  return {
    aliceKeys,
    bobKeys,
    carolKeys,
    aliceId,
    bobId,
    carolId,
    alicePending,
    bobPending,
    aliceAllowlist,
    bobAllowlist,
    aliceBonds,
    bobBonds,
  };
}

export type LinkedMachines = {
  alice: SessionStateMachine;
  bob: SessionStateMachine;
  carol: SessionStateMachine;
  flush: () => Promise<void>;
  setPauseDelivery: (paused: boolean) => void;
};

export function createLinkedMachines(
  fixtures: SessionTestFixtures,
  options?: LinkedMachinesOptions,
): LinkedMachines {
  const peers = new Map<string, SessionStateMachine>();
  const deliveryQueue: Array<{ fromId: string; input: RelaySendInput }> = [];
  let paused = options?.pauseDelivery ?? false;

  const deliver = async (fromId: string, input: RelaySendInput) => {
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

  const relayFor = (agentId: string, capture?: RelayCapture[]) => ({
    async send(input: RelaySendInput) {
      if (
        options?.injectSendFailure?.({
          agentId,
          to: input.to,
          type: input.type,
          thread: input.thread,
          payload: input.payload,
        })
      ) {
        return { ok: false as const, error: "relay_unavailable" };
      }
      capture?.push({
        type: input.type,
        to: input.to,
        thread: input.thread,
        payload: input.payload,
      });
      if (paused) {
        deliveryQueue.push({ fromId: agentId, input });
        return { ok: true as const };
      }
      await deliver(agentId, input);
      return { ok: true as const };
    },
  });

  const alice = createSessionStateMachine({
    agentId: fixtures.aliceId,
    keyPair: fixtures.aliceKeys,
    pending: fixtures.alicePending,
    allowlist: fixtures.aliceAllowlist,
    bonds: fixtures.aliceBonds,
    relay: relayFor(fixtures.aliceId, options?.capture?.aliceSends),
  });
  peers.set(fixtures.aliceId, alice);

  const bob = createSessionStateMachine({
    agentId: fixtures.bobId,
    keyPair: fixtures.bobKeys,
    pending: fixtures.bobPending,
    allowlist: fixtures.bobAllowlist,
    bonds: fixtures.bobBonds,
    relay: relayFor(fixtures.bobId, options?.capture?.bobSends),
  });
  peers.set(fixtures.bobId, bob);

  const carol = createSessionStateMachine({
    agentId: fixtures.carolId,
    keyPair: fixtures.carolKeys,
    pending: new MockPendingQueue(),
    allowlist: new MemoryAllowlistStore(),
    bonds: new MockBondStore(),
    relay: {
      async send(input) {
        await deliver(fixtures.carolId, input);
        return { ok: true as const };
      },
    },
  });
  peers.set(fixtures.carolId, carol);

  return {
    alice,
    bob,
    carol,
    async flush() {
      while (deliveryQueue.length > 0) {
        const next = deliveryQueue.shift();
        if (!next) {
          break;
        }
        await deliver(next.fromId, next.input);
      }
    },
    setPauseDelivery(next: boolean) {
      paused = next;
    },
  };
}

export const FUTURE_DEADLINE = new Date(Date.now() + 86_400_000).toISOString();
export const PAST_DEADLINE = new Date(Date.now() - 60_000).toISOString();
export { SESSION_OPEN_TTL_MS };
export const NEGO_ONLY = [...REFERENCE_PROFILES];
export const ATEST_CAPABLE = [...REFERENCE_PROFILES, "atest/1"];

export const defaultOpenPayload = {
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

export async function openLiveWithMaxTurns(
  aliceMachine: SessionStateMachine,
  bobMachine: SessionStateMachine,
  bobPending: MockPendingQueue,
  bobId: string,
  maxTurns: number,
  openPayload = defaultOpenPayload,
): Promise<string> {
  const opened = await aliceMachine.handleOpen({
    to: bobId,
    ...openPayload,
    budget: { max_turns: maxTurns, deadline: FUTURE_DEADLINE },
  });
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
  return opened.thread as string;
}

export async function openAndApprove(
  aliceMachine: SessionStateMachine,
  bobMachine: SessionStateMachine,
  bobPending: MockPendingQueue,
  bobId: string,
  openPayload = defaultOpenPayload,
): Promise<string> {
  const opened = await aliceMachine.handleOpen({
    to: bobId,
    ...openPayload,
  });
  if (!opened.ok) {
    throw new Error("session open failed");
  }

  const bobPendingItems = bobPending.list().filter((item) => item.kind === "session_open");
  if (bobPendingItems.length !== 1) {
    throw new Error("expected one session_open pending item");
  }
  const bobPendingItem = bobPendingItems[0];
  if (!bobPendingItem) {
    throw new Error("expected session_open pending item");
  }

  const approved = await bobMachine.handleApproveOpen({
    pending_id: bobPendingItem.id,
    via_human: true,
  });
  if (!approved.ok) {
    throw new Error("approve open failed");
  }
  return opened.thread as string;
}
