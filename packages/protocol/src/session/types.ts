export const SESSION_OPEN_TTL_MS = 60 * 60 * 1000;

/** Terminal `closed`: ratify success when `coSignedHash` is set; unilateral `core.close` when `rejectReason` is set (§8.3). */
export type SessionStatus =
  | "pending"
  | "live"
  | "open_rejected"
  | "open_expired"
  | "signed"
  | "closed";

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

export interface TestReport {
  artifact_hash: string;
  passed: boolean;
  runner: string;
  details?: string;
}

export interface PeerNegotiationMessage {
  from: "initiator" | "recipient";
  type: string;
  body: string;
  turn: number;
}

export interface SessionRecord {
  thread: string;
  initiator: string;
  recipient: string;
  role: "initiator" | "recipient";
  status: SessionStatus;
  goal: string;
  acceptance: AcceptanceCriterion[];
  budget: SessionBudget;
  mandate: SessionMandate;
  createdAt: number;
  expiresAt: number;
  rejectReason?: string;
  turnCount: number;
  peerMessages: PeerNegotiationMessage[];
  lockedSections: string[];
  testReports: Record<string, { initiator?: TestReport; recipient?: TestReport }>;
  challenges: { initiator?: boolean; recipient?: boolean };
  signHashes: { initiator?: string; recipient?: string };
  ratifyApproved: { initiator?: boolean; recipient?: boolean };
  artifactHash?: string;
  coSignedHash?: string;
  signatures?: Record<string, string>;
}
