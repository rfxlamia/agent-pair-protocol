import type { KeyPair } from "../crypto/keys.js";
import type { Bond, LocalAllowlistStore, PairProposal } from "../pairing/flow.js";
import type { AcceptanceCriterion, SessionBudget, SessionMandate } from "./types.js";

export interface SessionOpenPendingInput {
  thread: string;
  from: string;
  goal: string;
  acceptance: AcceptanceCriterion[];
  budget: SessionBudget;
  mandate: SessionMandate;
  expiresAt: number;
}

export interface RatifyPendingInput {
  thread: string;
  peer: string;
  artifactHash: string;
  warnings?: string[];
}

export interface BudgetExtendPendingInput {
  thread: string;
  peer: string;
}

export interface SessionOpenPendingItem extends SessionOpenPendingInput {
  id: string;
  kind: "session_open";
  createdAt: number;
}

export interface RatifyPendingItem extends RatifyPendingInput {
  id: string;
  kind: "ratify";
  createdAt: number;
}

export interface BudgetExtendPendingItem extends BudgetExtendPendingInput {
  id: string;
  kind: "budget_extend";
  createdAt: number;
}

export interface PairJoinPendingItem {
  id: string;
  kind: "pair_join";
  code: string;
  proposal: PairProposal;
  createdAt: number;
}

export type SessionPendingItem =
  | SessionOpenPendingItem
  | RatifyPendingItem
  | BudgetExtendPendingItem
  | PairJoinPendingItem;

export interface SessionBondStore {
  find(agentId: string, peer: string): Bond | undefined;
  remove(agentId: string, peer: string): void;
}

export interface SessionPendingQueue {
  list(): SessionPendingItem[];
  get(id: string): SessionPendingItem | undefined;
  remove(id: string): void;
  addSessionOpen(input: SessionOpenPendingInput): SessionPendingItem;
  addRatify(input: RatifyPendingInput): SessionPendingItem;
  addBudgetExtend(input: BudgetExtendPendingInput): SessionPendingItem;
}

export interface SessionEnvelopeSender {
  send(input: {
    to: string;
    type: string;
    payload: string;
    thread: string;
    seq?: number;
  }): Promise<{ ok: boolean; error?: string }>;
}

export interface SessionStateMachineDeps {
  agentId: string;
  keyPair: KeyPair;
  pending: SessionPendingQueue;
  allowlist: LocalAllowlistStore;
  bonds: SessionBondStore;
  relay: SessionEnvelopeSender;
  now?: () => number;
}
