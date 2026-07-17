import type { PendingKind } from "../store/pending.js";

export type ApprovalOutcomeClass = "terminal" | "transient" | "unsupported_no_consume";

type DispatchResult = {
  ok?: boolean;
  status?: string;
  error?: string;
  verified?: boolean;
};

const PAIR_JOIN_TERMINAL_STATUSES = new Set([
  "bonded",
  "rejected",
  "rolled_back",
  "pake_failed",
  "not_found",
]);

const SESSION_TERMINAL_ERRORS = new Set([
  "session_not_found",
  "session_open_expired",
  "pending_not_found",
  "challenges_incomplete",
]);

export function classifyApprovalOutcome(
  kind: PendingKind,
  result: DispatchResult,
): ApprovalOutcomeClass {
  if (kind === "budget_extend") {
    return "unsupported_no_consume";
  }

  if (result.error === "relay_unavailable") {
    return "transient";
  }

  if (kind === "pair_join") {
    if (result.status && PAIR_JOIN_TERMINAL_STATUSES.has(result.status)) {
      return "terminal";
    }
    if (result.error === "pair_not_found" || result.error === "pair_session_lost") {
      return "terminal";
    }
    return "terminal";
  }

  if (kind === "session_open" || kind === "ratify") {
    if (result.ok === true) {
      return "terminal";
    }
    if (result.error && SESSION_TERMINAL_ERRORS.has(result.error)) {
      return "terminal";
    }
    return "terminal";
  }

  return "terminal";
}
