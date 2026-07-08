import type { Bond } from "@agentpair/protocol";
import type { SessionRecord, SessionStatus } from "../session/state-machine.js";

const BOND_MODES = new Set(["ephemeral_until_session_closes", "bonded_contact"]);
const SESSION_STATUSES = new Set<SessionStatus>([
  "pending",
  "live",
  "open_rejected",
  "open_expired",
  "signed",
  "closed",
]);
const PENDING_KINDS = new Set(["pair_join", "session_open", "ratify", "budget_extend"]);

export function isBond(value: unknown): value is Bond {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const bond = value as Bond;
  return (
    typeof bond.peer === "string" &&
    Array.isArray(bond.scope) &&
    bond.scope.every((entry) => typeof entry === "string") &&
    BOND_MODES.has(bond.mode)
  );
}

export function parseBondAgents(agents: unknown): Record<string, Bond[]> | undefined {
  if (typeof agents !== "object" || agents === null) {
    return undefined;
  }
  const parsed: Record<string, Bond[]> = {};
  for (const [agentId, bonds] of Object.entries(agents)) {
    if (!Array.isArray(bonds) || !bonds.every(isBond)) {
      return undefined;
    }
    parsed[agentId] = bonds;
  }
  return parsed;
}

export function isSessionRecord(value: unknown): value is SessionRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const session = value as SessionRecord;
  return (
    typeof session.thread === "string" &&
    typeof session.initiator === "string" &&
    typeof session.recipient === "string" &&
    (session.role === "initiator" || session.role === "recipient") &&
    SESSION_STATUSES.has(session.status) &&
    typeof session.goal === "string" &&
    Array.isArray(session.acceptance) &&
    typeof session.budget === "object" &&
    session.budget !== null &&
    typeof session.budget.max_turns === "number" &&
    typeof session.mandate === "object" &&
    session.mandate !== null &&
    Array.isArray(session.mandate.agent_may) &&
    Array.isArray(session.mandate.human_required) &&
    typeof session.createdAt === "number" &&
    typeof session.expiresAt === "number" &&
    typeof session.turnCount === "number" &&
    Array.isArray(session.peerMessages) &&
    Array.isArray(session.lockedSections) &&
    typeof session.testReports === "object" &&
    session.testReports !== null &&
    typeof session.challenges === "object" &&
    session.challenges !== null &&
    typeof session.signHashes === "object" &&
    session.signHashes !== null &&
    typeof session.ratifyApproved === "object" &&
    session.ratifyApproved !== null
  );
}

export function parseSessionRecords(sessions: unknown): Record<string, SessionRecord> | undefined {
  if (typeof sessions !== "object" || sessions === null) {
    return undefined;
  }
  const parsed: Record<string, SessionRecord> = {};
  for (const [thread, record] of Object.entries(sessions)) {
    if (!isSessionRecord(record)) {
      console.error(`[agentpair] dropping invalid session entry ${thread}`);
      continue;
    }
    parsed[thread] = record;
  }
  return parsed;
}

export function isPendingItemRecord(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || typeof item.createdAt !== "number") {
    return false;
  }
  if (!PENDING_KINDS.has(item.kind as string)) {
    return false;
  }
  switch (item.kind) {
    case "pair_join": {
      const proposal = item.proposal;
      return (
        typeof item.code === "string" &&
        typeof proposal === "object" &&
        proposal !== null &&
        Array.isArray((proposal as { scope?: unknown }).scope) &&
        BOND_MODES.has((proposal as { mode?: string }).mode as Bond["mode"]) &&
        typeof (proposal as { initiatorAgentId?: unknown }).initiatorAgentId === "string"
      );
    }
    case "session_open":
      return (
        typeof item.thread === "string" &&
        typeof item.from === "string" &&
        typeof item.goal === "string" &&
        Array.isArray(item.acceptance) &&
        typeof item.budget === "object" &&
        item.budget !== null &&
        typeof item.mandate === "object" &&
        item.mandate !== null &&
        typeof item.expiresAt === "number"
      );
    case "ratify":
      return (
        typeof item.thread === "string" &&
        typeof item.peer === "string" &&
        typeof item.artifactHash === "string"
      );
    case "budget_extend":
      return typeof item.thread === "string" && typeof item.peer === "string";
    default:
      return false;
  }
}

export function parsePendingItemRecords(
  items: unknown,
): Record<string, Record<string, unknown>> | undefined {
  if (typeof items !== "object" || items === null) {
    return undefined;
  }
  const parsed: Record<string, Record<string, unknown>> = {};
  for (const [id, item] of Object.entries(items)) {
    if (!isPendingItemRecord(item)) {
      return undefined;
    }
    parsed[id] = item;
  }
  return parsed;
}
