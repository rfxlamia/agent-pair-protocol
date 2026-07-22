import { readdirSync } from "node:fs";
import { join } from "node:path";
import type {
  AcceptanceCriterion,
  PairProposal,
  SessionBudget,
  SessionMandate,
} from "@agentpair/protocol";
import {
  deleteApprovalFileSync,
  deriveApprovalMacKey,
  generateApprovalCode,
  hmacApprovalCode,
  writeApprovalFileSync,
} from "./approval-code.js";
import { parsePendingItemRecords } from "./persistence-validate.js";
import { createJsonPersistentStore, resolveDataDir, storePath } from "./persistent-store.js";

interface PendingFile {
  v: 1;
  items: Record<string, PendingItem>;
}

const EMPTY_PENDING_FILE: PendingFile = { v: 1, items: {} };

export type ApprovalChannelErrorCode =
  | "approval_channel_unavailable"
  | "approval_secret_key_unbound";

export class ApprovalChannelError extends Error {
  readonly code: ApprovalChannelErrorCode;

  constructor(code: ApprovalChannelErrorCode, message: string) {
    super(message);
    this.name = "ApprovalChannelError";
    this.code = code;
  }
}

interface ApprovalFields {
  approvalCodeVerifier: string;
  approvalAttempts: number;
}

interface PendingQueueContext {
  secretKey?: Uint8Array;
  dataDir?: string;
}

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
  approvalCodeVerifier: string;
  approvalAttempts: number;
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
  approvalCodeVerifier: string;
  approvalAttempts: number;
}

export interface RatifyPending {
  id: string;
  kind: "ratify";
  thread: string;
  peer: string;
  artifactHash: string;
  warnings?: string[];
  createdAt: number;
  approvalCodeVerifier: string;
  approvalAttempts: number;
}

export interface BudgetExtendPending {
  id: string;
  kind: "budget_extend";
  thread: string;
  peer: string;
  new_max_turns?: number;
  proposal_id?: string;
  proposed_by?: "initiator" | "recipient";
  createdAt: number;
  approvalCodeVerifier: string;
  approvalAttempts: number;
}

export type PendingItem =
  | PairJoinPending
  | SessionOpenPending
  | RatifyPending
  | BudgetExtendPending;

export interface PendingQueue {
  init(secretKey: Uint8Array): void;
  setApprovalAttempts(id: string, attempts: number): void;
  add(
    item: Omit<PairJoinPending, "id" | "createdAt" | "kind" | keyof ApprovalFields>,
  ): PairJoinPending;
  addSessionOpen(
    item: Omit<SessionOpenPending, "id" | "createdAt" | "kind" | keyof ApprovalFields>,
  ): SessionOpenPending;
  addRatify(
    item: Omit<RatifyPending, "id" | "createdAt" | "kind" | keyof ApprovalFields>,
  ): RatifyPending;
  addBudgetExtend(
    item: Omit<BudgetExtendPending, "id" | "createdAt" | "kind" | keyof ApprovalFields>,
  ): BudgetExtendPending;
  get(id: string): PendingItem | undefined;
  list(): PendingItem[];
  remove(id: string): void;
  /** Oldest queued pair_join pending for code, if any (still in the Map). */
  findActivePairJoinByCode(code: string): PairJoinPending | undefined;
}

function requireSecretKey(context: PendingQueueContext): Uint8Array {
  if (!context.secretKey) {
    throw new ApprovalChannelError(
      "approval_secret_key_unbound",
      "Pending queue secret key is not bound",
    );
  }
  return context.secretKey;
}

function createApprovalFields(secretKey: Uint8Array): ApprovalFields & { code: string } {
  const code = generateApprovalCode();
  const macKey = deriveApprovalMacKey(secretKey);
  const approvalCodeVerifier = hmacApprovalCode(macKey, code).toString("base64url");
  return { code, approvalCodeVerifier, approvalAttempts: 0 };
}

function logApprovalCodeBestEffort(pendingId: string, code: string): void {
  try {
    console.error(`[agentpair] approval code for pending ${pendingId}: ${code}`);
  } catch {
    // best-effort stderr; must not fail create
  }
}

function writeApprovalFileOrThrow(
  dataDir: string,
  pendingId: string,
  input: { code: string; kind: string; peer?: string; thread?: string; createdAt: number },
): void {
  try {
    writeApprovalFileSync({
      dataDir,
      pendingId,
      code: input.code,
      kind: input.kind,
      peer: input.peer,
      thread: input.thread,
      createdAt: input.createdAt,
    });
    logApprovalCodeBestEffort(pendingId, input.code);
  } catch {
    throw new ApprovalChannelError("approval_channel_unavailable", "Failed to write approval file");
  }
}

function sweepOrphanApprovalFilesSync(dataDir: string, pendingIds: Set<string>): void {
  const approvalsDir = join(dataDir, "approvals");
  let entries: string[];
  try {
    entries = readdirSync(approvalsDir);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT" || err.code === "ENOTDIR") {
      return;
    }
    throw error;
  }
  for (const name of entries) {
    if (!pendingIds.has(name)) {
      try {
        deleteApprovalFileSync(dataDir, name);
      } catch {
        // best-effort orphan cleanup
      }
    }
  }
}

export function createPendingQueue(options: { secretKey?: Uint8Array } = {}): PendingQueue {
  const items = new Map<string, PendingItem>();
  const context: PendingQueueContext = { secretKey: options.secretKey };

  return buildPendingQueue(items, context);
}

export function resolvePendingPath(dataDir?: string): string {
  return storePath(resolveDataDir(dataDir), "pending.json");
}

export function createFilePendingQueue(
  options: { filePath?: string; dataDir?: string; secretKey?: Uint8Array } = {},
): PendingQueue & {
  flush(): Promise<void>;
} {
  const dataDir = options.dataDir;
  const filePath = options.filePath ?? resolvePendingPath(dataDir);
  const backing = createJsonPersistentStore({
    filePath,
    defaultData: structuredClone(EMPTY_PENDING_FILE),
    validate: validatePendingFile,
  });

  const items = new Map<string, PendingItem>();
  for (const [id, item] of Object.entries(backing.read().items)) {
    items.set(id, item);
  }

  if (dataDir) {
    sweepOrphanApprovalFilesSync(dataDir, new Set(items.keys()));
  }

  const context: PendingQueueContext = { secretKey: options.secretKey, dataDir };

  const queue = buildPendingQueue(
    items,
    context,
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
  context: PendingQueueContext,
  onAdd?: (item: PendingItem) => void,
  onRemove?: (id: string) => void,
): PendingQueue {
  const commitItem = <T extends PendingItem>(
    build: (id: string, createdAt: number, approval: ApprovalFields) => T,
    fileMeta: { kind: string; peer?: string; thread?: string },
  ): T => {
    const secretKey = requireSecretKey(context);
    const id = crypto.randomUUID();
    const createdAt = Date.now();
    const approval = createApprovalFields(secretKey);

    if (context.dataDir) {
      writeApprovalFileOrThrow(context.dataDir, id, {
        code: approval.code,
        kind: fileMeta.kind,
        peer: fileMeta.peer,
        thread: fileMeta.thread,
        createdAt,
      });
    }

    const item = build(id, createdAt, approval);
    items.set(item.id, item);
    onAdd?.(item);
    return item;
  };

  return {
    init(secretKey: Uint8Array) {
      context.secretKey = secretKey;
    },
    /**
     * Store-layer mutator for approval attempt counts (tests and T4 gate).
     * Not a model-facing API.
     */
    setApprovalAttempts(id: string, attempts: number) {
      const item = items.get(id);
      if (!item) {
        return;
      }
      const updated = { ...item, approvalAttempts: attempts };
      items.set(id, updated);
      onAdd?.(updated);
    },
    add(input) {
      return commitItem(
        (id, createdAt, approval) => ({
          id,
          kind: "pair_join",
          createdAt,
          code: input.code,
          proposal: input.proposal,
          approvalCodeVerifier: approval.approvalCodeVerifier,
          approvalAttempts: approval.approvalAttempts,
        }),
        { kind: "pair_join", peer: input.proposal.initiatorAgentId },
      );
    },
    addSessionOpen(input) {
      return commitItem(
        (id, createdAt, approval) => ({
          id,
          kind: "session_open",
          createdAt,
          thread: input.thread,
          from: input.from,
          goal: input.goal,
          acceptance: input.acceptance,
          budget: input.budget,
          mandate: input.mandate,
          expiresAt: input.expiresAt,
          approvalCodeVerifier: approval.approvalCodeVerifier,
          approvalAttempts: approval.approvalAttempts,
        }),
        { kind: "session_open", thread: input.thread, peer: input.from },
      );
    },
    addRatify(input) {
      return commitItem(
        (id, createdAt, approval) => ({
          id,
          kind: "ratify",
          createdAt,
          thread: input.thread,
          peer: input.peer,
          artifactHash: input.artifactHash,
          ...(input.warnings ? { warnings: input.warnings } : {}),
          approvalCodeVerifier: approval.approvalCodeVerifier,
          approvalAttempts: approval.approvalAttempts,
        }),
        { kind: "ratify", thread: input.thread, peer: input.peer },
      );
    },
    addBudgetExtend(input) {
      return commitItem(
        (id, createdAt, approval) => ({
          id,
          kind: "budget_extend",
          createdAt,
          thread: input.thread,
          peer: input.peer,
          ...(input.new_max_turns !== undefined ? { new_max_turns: input.new_max_turns } : {}),
          ...(input.proposal_id !== undefined ? { proposal_id: input.proposal_id } : {}),
          ...(input.proposed_by !== undefined ? { proposed_by: input.proposed_by } : {}),
          approvalCodeVerifier: approval.approvalCodeVerifier,
          approvalAttempts: approval.approvalAttempts,
        }),
        { kind: "budget_extend", thread: input.thread, peer: input.peer },
      );
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
      if (context.dataDir) {
        try {
          deleteApprovalFileSync(context.dataDir, id);
        } catch {
          // best-effort approval file cleanup
        }
      }
    },
    findActivePairJoinByCode(code) {
      let oldest: PairJoinPending | undefined;
      for (const item of items.values()) {
        if (item.kind !== "pair_join" || item.code !== code) {
          continue;
        }
        if (!oldest || item.createdAt < oldest.createdAt) {
          oldest = item;
        }
      }
      return oldest;
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
