import type {
  AcceptanceCriterion,
  PairProposal,
  SessionBudget,
  SessionMandate,
} from "@agentpair/protocol";
import { parsePendingItemRecords } from "./persistence-validate.js";
import { createJsonPersistentStore, resolveDataDir, storePath } from "./persistent-store.js";

interface PendingFile {
  v: 1;
  items: Record<string, PendingItem>;
}

const EMPTY_PENDING_FILE: PendingFile = { v: 1, items: {} };

function validatePendingFile(parsed: unknown): PendingFile | undefined {
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const items = parsePendingItemRecords((parsed as PendingFile).items);
  if (!items) {
    return undefined;
  }
  return { v: 1, items: items as unknown as Record<string, PendingItem> };
}

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

export interface PendingQueue {
  add(item: Omit<PairJoinPending, "id" | "createdAt" | "kind">): PairJoinPending;
  addSessionOpen(item: Omit<SessionOpenPending, "id" | "createdAt" | "kind">): SessionOpenPending;
  addRatify(item: Omit<RatifyPending, "id" | "createdAt" | "kind">): RatifyPending;
  addBudgetExtend(
    item: Omit<BudgetExtendPending, "id" | "createdAt" | "kind">,
  ): BudgetExtendPending;
  get(id: string): PendingItem | undefined;
  list(): PendingItem[];
  remove(id: string): void;
}

export function createPendingQueue(): PendingQueue {
  const items = new Map<string, PendingItem>();

  return buildPendingQueue(items);
}

export function resolvePendingPath(dataDir?: string): string {
  return storePath(resolveDataDir(dataDir), "pending.json");
}

export function createFilePendingQueue(
  options: { filePath?: string; dataDir?: string } = {},
): PendingQueue & {
  flush(): Promise<void>;
} {
  const filePath = options.filePath ?? resolvePendingPath(options.dataDir);
  const backing = createJsonPersistentStore({
    filePath,
    defaultData: structuredClone(EMPTY_PENDING_FILE),
    validate: validatePendingFile,
  });

  const items = new Map<string, PendingItem>();
  for (const [id, item] of Object.entries(backing.read().items)) {
    items.set(id, item);
  }

  const queue = buildPendingQueue(
    items,
    (item) => {
      backing.mutate((data) => {
        data.items[item.id] = item;
      });
    },
    (id) => {
      backing.mutate((data) => {
        delete data.items[id];
      });
    },
  );

  return {
    ...queue,
    flush: () => backing.flush(),
  };
}

function buildPendingQueue(
  items: Map<string, PendingItem>,
  onAdd?: (item: PendingItem) => void,
  onRemove?: (id: string) => void,
): PendingQueue {
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
      onAdd?.(item);
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
      onAdd?.(item);
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
      onAdd?.(item);
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
      onAdd?.(item);
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
      onRemove?.(id);
    },
  };
}

export type HumanDecision = { approve: true } | { reject: string };

export function parseHumanDecision(decision: string): HumanDecision | { error: string } {
  if (decision === "approve") {
    return { approve: true };
  }
  if (decision.startsWith("reject:")) {
    return { reject: decision.slice("reject:".length) };
  }
  return { error: "invalid_decision" };
}
