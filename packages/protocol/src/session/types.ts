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
  deadline: string;
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

export interface SessionExtension {
  proposal_id: string;
  new_max_turns: number;
  proposed_by: "initiator" | "recipient";
  status: "emitting" | "awaiting_peer" | "approved_emitting" | "rejected_emitting";
  /** base64url-encoded build-once envelope body bytes; present only while status is *_emitting */
  envelope_bytes?: string;
}

export interface SessionExtensionDecided {
  proposal_id: string;
  decision: "approved" | "rejected";
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
  testReports: Record<string, Record<string, { initiator?: TestReport; recipient?: TestReport }>>;
  challenges: { initiator?: boolean; recipient?: boolean };
  signHashes: { initiator?: string; recipient?: string };
  ratifyApproved: { initiator?: boolean; recipient?: boolean };
  artifactHash?: string;
  coSignedHash?: string;
  signatures?: Record<string, string>;
  /** In-flight budget extension only; cleared when cycle completes or session leaves live */
  extension?: SessionExtension;
  /** Decided proposal ids; session-level, survives extension clears */
  extensionDecided?: SessionExtensionDecided[];
}
