import type { BondMode, PairProposal } from "@agentpair/protocol";

export type PendingKind = "pair_join";

export interface PairJoinPending {
  id: string;
  kind: "pair_join";
  code: string;
  proposal: PairProposal;
  createdAt: number;
}

export type PendingItem = PairJoinPending;

export interface PendingQueue {
  add(item: Omit<PairJoinPending, "id" | "createdAt" | "kind">): PairJoinPending;
  get(id: string): PendingItem | undefined;
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
    get(id) {
      return items.get(id);
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
