import { describe, expect, it } from "vitest";
import type { Bond } from "../pairing/flow.js";
import type {
  SessionBondStore,
  SessionOpenPendingInput,
  SessionPendingQueue,
  SessionStateMachineDeps,
} from "./deps.js";

describe("SessionStateMachineDeps structural typing", () => {
  it("accepts inline minimal mocks without adapter", () => {
    const MockBondStore: SessionBondStore = {
      find(_agentId, _peer): Bond | undefined {
        return {
          peer: "peer-id",
          scope: ["session.negotiate"],
          mode: "bonded_contact",
        };
      },
      remove() {},
    };

    const MockPendingQueue: SessionPendingQueue = {
      list() {
        return [];
      },
      get() {
        return undefined;
      },
      remove() {},
      addSessionOpen(input: SessionOpenPendingInput) {
        return {
          id: "pending-1",
          kind: "session_open" as const,
          createdAt: Date.now(),
          ...input,
        };
      },
      addRatify(input) {
        return {
          id: "pending-2",
          kind: "ratify" as const,
          createdAt: Date.now(),
          ...input,
        };
      },
      addBudgetExtend(input) {
        return {
          id: "pending-3",
          kind: "budget_extend" as const,
          createdAt: Date.now(),
          ...input,
        };
      },
    };

    const deps: SessionStateMachineDeps = {
      agentId: "agent-1",
      keyPair: {} as SessionStateMachineDeps["keyPair"],
      pending: MockPendingQueue,
      allowlist: { get: () => [], set: () => {} },
      bonds: MockBondStore,
      relay: { send: async () => ({ ok: true }) },
    };

    expect(deps.bonds.find("agent-1", "peer-id")).toEqual({
      peer: "peer-id",
      scope: ["session.negotiate"],
      mode: "bonded_contact",
    });

    const pending = deps.pending.addSessionOpen({
      thread: "thread-1",
      from: "initiator",
      goal: "test goal",
      acceptance: [],
      budget: { max_turns: 10, deadline: "2030-01-01T00:00:00.000Z" },
      mandate: { agent_may: [], human_required: [] },
      expiresAt: Date.now() + 3_600_000,
    });
    expect(pending.kind).toBe("session_open");
  });
});
