import {
  type Bond,
  type SessionRecord,
  type SessionStatus,
  decodeBase64UrlStrict,
  isValidProfilesArray,
  isValidTestReports,
} from "@agentpair/protocol";

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
const EXTENSION_STATUSES = new Set([
  "emitting",
  "awaiting_peer",
  "approved_emitting",
  "rejected_emitting",
]);

function isValidBase64UrlString(value: string): boolean {
  try {
    decodeBase64UrlStrict(value);
    return true;
  } catch {
    return false;
  }
}

function isSessionExtension(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const ext = value as Record<string, unknown>;
  if ("extensionDecided" in ext) {
    return false;
  }
  if (
    typeof ext.proposal_id !== "string" ||
    typeof ext.new_max_turns !== "number" ||
    !Number.isInteger(ext.new_max_turns) ||
    (ext.proposed_by !== "initiator" && ext.proposed_by !== "recipient") ||
    !EXTENSION_STATUSES.has(ext.status as string)
  ) {
    return false;
  }
  if ("envelope_bytes" in ext) {
    if (typeof ext.envelope_bytes !== "string" || !isValidBase64UrlString(ext.envelope_bytes)) {
      return false;
    }
  }
  return true;
}

function isSessionExtensionDecidedArray(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.every((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return false;
    }
    const decided = entry as Record<string, unknown>;
    return (
      typeof decided.proposal_id === "string" &&
      (decided.decision === "approved" || decided.decision === "rejected")
    );
  });
}

function hasApprovalFields(item: Record<string, unknown>): boolean {
  return (
    typeof item.approvalCodeVerifier === "string" &&
    item.approvalCodeVerifier.length > 0 &&
    typeof item.approvalAttempts === "number" &&
    Number.isInteger(item.approvalAttempts) &&
    item.approvalAttempts >= 0
  );
}

export function isBond(value: unknown): value is Bond {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const bond = value as Record<string, unknown>;
  if (
    typeof bond.peer !== "string" ||
    !Array.isArray(bond.scope) ||
    !bond.scope.every((entry) => typeof entry === "string") ||
    !BOND_MODES.has(bond.mode as Bond["mode"])
  ) {
    return false;
  }
  if ("profiles" in bond) {
    return isValidProfilesArray(bond.profiles);
  }
  return true;
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
    typeof session.budget.deadline === "string" &&
    typeof session.mandate === "object" &&
    session.mandate !== null &&
    Array.isArray(session.mandate.agent_may) &&
    Array.isArray(session.mandate.human_required) &&
    typeof session.createdAt === "number" &&
    typeof session.expiresAt === "number" &&
    typeof session.turnCount === "number" &&
    Array.isArray(session.peerMessages) &&
    Array.isArray(session.lockedSections) &&
    isValidTestReports(session.testReports) &&
    typeof session.challenges === "object" &&
    session.challenges !== null &&
    typeof session.signHashes === "object" &&
    session.signHashes !== null &&
    typeof session.ratifyApproved === "object" &&
    session.ratifyApproved !== null &&
    (!("extension" in session) ||
      session.extension === undefined ||
      isSessionExtension(session.extension)) &&
    (!("extensionDecided" in session) ||
      session.extensionDecided === undefined ||
      isSessionExtensionDecidedArray(session.extensionDecided))
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
  if (!hasApprovalFields(item)) {
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
        typeof (item.budget as { max_turns?: unknown }).max_turns === "number" &&
        typeof (item.budget as { deadline?: unknown }).deadline === "string" &&
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
    case "budget_extend": {
      if (typeof item.thread !== "string" || typeof item.peer !== "string") {
        return false;
      }
      if (
        "new_max_turns" in item &&
        (typeof item.new_max_turns !== "number" || !Number.isInteger(item.new_max_turns))
      ) {
        return false;
      }
      if ("proposal_id" in item && typeof item.proposal_id !== "string") {
        return false;
      }
      return true;
    }
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
      console.error(`[agentpair] dropping invalid pending entry ${id}`);
      continue;
    }
    parsed[id] = item as Record<string, unknown>;
  }
  return parsed;
}
