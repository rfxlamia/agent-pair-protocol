import type { BondMode, PairProposal } from "@agentpair/protocol";

export type PendingKind = "pair_join" | "session_open" | "ratify" | "budget_extend";

export interface PairJoinPending {
  id: string;
  kind: "pair_join";
  code: string;
  proposal: PairProposal;
  createdAt: number;
}

export interface SessionOpenPending {
  id: string;
  kind: "session_open";
  thread: string;
  from: string;
  goal: string;
  acceptance: AcceptanceCriterion[];
  budget: SessionBudget;
  mandate: SessionMandate;
  createdAt: number;
  expiresAt: number;
}

export interface RatifyPending {
  id: string;
  kind: "ratify";
  thread: string;
  peer: string;
  artifactHash: string;
  createdAt: number;
}

export interface BudgetExtendPending {
  id: string;
  kind: "budget_extend";
  thread: string;
  peer: string;
  createdAt: number;
}

export type PendingItem =
  | PairJoinPending
  | SessionOpenPending
  | RatifyPending
  | BudgetExtendPending;

export interface AcceptanceCriterion {
  id: string;
  test: "executable" | "judgment";
  desc: string;
  runner?: string;
}

export interface SessionBudget {
  max_turns: number;
  deadline?: string;
}

export interface SessionMandate {
  agent_may: string[];
  human_required: string[];
  escalate_on?: string[];
}

export interface PendingQueue {
  add(item: Omit<PairJoinPending, "id" | "createdAt" | "kind">): PairJoinPending;
  addSessionOpen(
    item: Omit<SessionOpenPending, "id" | "createdAt" | "kind">,
  ): SessionOpenPending;
  addRatify(
    item: Omit<RatifyPending, "id" | "createdAt" | "kind">,
  ): RatifyPending;
  addBudgetExtend(
    item: Omit<BudgetExtendPending, "id" | "createdAt" | "kind">,
  ): BudgetExtendPending;
  get(id: string): PendingItem | undefined;
  list(): PendingItem[];
  remove(id: string): void;
}

export function createPendingQueue(): PendingQueue {
  const items = new Map<string, PendingItem>();

  return {
    add(input) {
      const item: PairJoinPending = {
        id: crypto.randomUUID(),
        kind: "pair_join",
        createdAt: Date.now(),
        code: input.code,
        proposal: input.proposal,
      };
      items.set(item.id, item);
      return item;
    },
    addSessionOpen(input) {
      const item: SessionOpenPending = {
        id: crypto.randomUUID(),
        kind: "session_open",
        createdAt: Date.now(),
        thread: input.thread,
        from: input.from,
        goal: input.goal,
        acceptance: input.acceptance,
        budget: input.budget,
        mandate: input.mandate,
        expiresAt: input.expiresAt,
      };
      items.set(item.id, item);
      return item;
    },
    addRatify(input) {
      const item: RatifyPending = {
        id: crypto.randomUUID(),
        kind: "ratify",
        createdAt: Date.now(),
        thread: input.thread,
        peer: input.peer,
        artifactHash: input.artifactHash,
      };
      items.set(item.id, item);
      return item;
    },
    addBudgetExtend(input) {
      const item: BudgetExtendPending = {
        id: crypto.randomUUID(),
        kind: "budget_extend",
        createdAt: Date.now(),
        thread: input.thread,
        peer: input.peer,
      };
      items.set(item.id, item);
      return item;
    },
    get(id) {
      return items.get(id);
    },
    list() {
      return [...items.values()];
    },
    remove(id) {
      items.delete(id);
    },
  };
}

export type HumanDecision =
  | { approve: true }
  | { reject: string };

export function parseHumanDecision(
  decision: string,
): HumanDecision | { error: string } {
  if (decision === "approve") {
    return { approve: true };
  }
  if (decision.startsWith("reject:")) {
    return { reject: decision.slice("reject:".length) };
  }
  return { error: "invalid_decision" };
}
