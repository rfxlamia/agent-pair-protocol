import {
  sign,
  type KeyPair,
  type LocalAllowlistStore,
} from "@agentpair/protocol";
import { utf8ToBytes } from "@noble/ciphers/utils.js";
import type { BondStore } from "../store/bonds.js";
import { isEphemeralBond } from "../store/bonds.js";
import type {
  AcceptanceCriterion,
  PendingQueue,
  SessionBudget,
  SessionMandate,
} from "../store/pending.js";
import { toolTextResult } from "../tools/util.js";

export const SESSION_OPEN_TTL_MS = 60 * 60 * 1000;

export type SessionStatus =
  | "pending"
  | "live"
  | "open_rejected"
  | "open_expired"
  | "signed"
  | "closed";

/** Recipient sessions past open must not be reset by a redelivered session.open. */
const NON_REOPENABLE_OPEN_STATUSES: SessionStatus[] = [
  "live",
  "signed",
  "closed",
  "open_rejected",
];

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
  testReports: Record<
    string,
    { initiator?: TestReport; recipient?: TestReport }
  >;
  challenges: { initiator?: boolean; recipient?: boolean };
  signHashes: { initiator?: string; recipient?: string };
  ratifyApproved: { initiator?: boolean; recipient?: boolean };
  artifactHash?: string;
  coSignedHash?: string;
  signatures?: Record<string, string>;
}

export interface SessionEnvelopeSender {
  send(input: {
    to: string;
    type: string;
    payload: string;
    thread: string;
    seq?: number;
  }): Promise<{ ok: boolean }>;
}

export interface SessionStateMachineDeps {
  agentId: string;
  keyPair: KeyPair;
  pending: PendingQueue;
  allowlist: LocalAllowlistStore;
  bonds: BondStore;
  relay: SessionEnvelopeSender;
  now?: () => number;
}

export interface SessionStore {
  get(thread: string): SessionRecord | undefined;
  upsert(session: SessionRecord): void;
  list(): SessionRecord[];
}

export function createSessionStore(): SessionStore {
  const sessions = new Map<string, SessionRecord>();
  return {
    get(thread) {
      return sessions.get(thread);
    },
    upsert(session) {
      sessions.set(session.thread, session);
    },
    list() {
      return [...sessions.values()];
    },
  };
}

function result(data: Record<string, unknown>) {
  return toolTextResult(data);
}

function peerFor(session: SessionRecord, agentId: string): string {
  return session.initiator === agentId ? session.recipient : session.initiator;
}

function roleFor(session: SessionRecord, agentId: string): "initiator" | "recipient" {
  return session.initiator === agentId ? "initiator" : "recipient";
}

function parseJsonBody<T>(body: string): T | { error: string } {
  try {
    return JSON.parse(body) as T;
  } catch {
    return { error: "invalid_json" };
  }
}

function bothTestReportsPass(
  session: SessionRecord,
  artifactHash: string,
): boolean {
  const reports = session.testReports[artifactHash];
  return Boolean(reports?.initiator?.passed && reports?.recipient?.passed);
}

function bothChallengesFiled(session: SessionRecord): boolean {
  return Boolean(session.challenges.initiator && session.challenges.recipient);
}

function bothSigned(session: SessionRecord): boolean {
  return Boolean(session.signHashes.initiator && session.signHashes.recipient);
}

function bothRatified(session: SessionRecord): boolean {
  return Boolean(session.ratifyApproved.initiator && session.ratifyApproved.recipient);
}

export function createSessionStateMachine(
  deps: SessionStateMachineDeps,
  store: SessionStore = createSessionStore(),
) {
  const now = deps.now ?? (() => Date.now());

  function upsert(session: SessionRecord): SessionRecord {
    store.upsert(session);
    return session;
  }

  function getOrError(thread: string) {
    const session = store.get(thread);
    if (!session) {
      return { ok: false as const, error: "session_not_found" };
    }
    return { ok: true as const, session };
  }

  function findSessionOpenPending(thread: string) {
    return deps.pending
      .list()
      .find((item) => item.kind === "session_open" && item.thread === thread);
  }

  function ensureRecipientOpenPending(session: SessionRecord) {
    if (session.status !== "pending" || session.role !== "recipient") {
      return undefined;
    }
    if (now() > session.expiresAt) {
      // Read-path side effect: used by handleStatus and resolveOpenPendingId.
      upsert({ ...session, status: "open_expired" });
      return undefined;
    }
    const existing = findSessionOpenPending(session.thread);
    if (existing) {
      return existing;
    }
    // Read-path side effect: re-queues a lost session_open entry for human_approve.
    return deps.pending.addSessionOpen({
      thread: session.thread,
      from: session.initiator,
      goal: session.goal,
      acceptance: session.acceptance,
      budget: session.budget,
      mandate: session.mandate,
      expiresAt: session.expiresAt,
    });
  }

  async function notifyPeer(
    session: SessionRecord,
    type: string,
    payload: Record<string, unknown>,
  ) {
    const peer = peerFor(session, deps.agentId);
    await deps.relay.send({
      to: peer,
      type,
      payload: JSON.stringify(payload),
      thread: session.thread,
    });
  }

  async function removeEphemeralBond(peer: string) {
    const bond = deps.bonds.find(deps.agentId, peer);
    if (!isEphemeralBond(bond)) {
      return;
    }
    deps.bonds.remove(deps.agentId, peer);
    const allowed = deps.allowlist.get(deps.agentId).filter((id) => id !== peer);
    deps.allowlist.set(deps.agentId, allowed);
  }

  async function finalizeSession(session: SessionRecord, artifactHash: string) {
    const peer = peerFor(session, deps.agentId);
    const message = utf8ToBytes(artifactHash);
    const signature = Buffer.from(sign(message, deps.keyPair.secretKey)).toString(
      "base64url",
    );
    const signatures = {
      ...(session.signatures ?? {}),
      [deps.agentId]: signature,
    };

    const closed: SessionRecord = {
      ...session,
      status: "closed",
      artifactHash,
      coSignedHash: artifactHash,
      signatures,
    };
    upsert(closed);
    await removeEphemeralBond(peer);
    return closed;
  }

  async function handleIncomingOpen(input: {
    thread: string;
    from: string;
    goal: string;
    acceptance: AcceptanceCriterion[];
    budget: SessionBudget;
    mandate: SessionMandate;
    expires_at: number;
  }) {
    const existing = store.get(input.thread);
    if (
      existing &&
      NON_REOPENABLE_OPEN_STATUSES.includes(existing.status)
    ) {
      return result({
        ok: true,
        thread: input.thread,
        status: existing.status,
      });
    }

    const preserveProgress = existing?.status === "pending";
    const createdAt = existing?.createdAt ?? now();
    const session: SessionRecord = {
      thread: input.thread,
      initiator: input.from,
      recipient: deps.agentId,
      role: "recipient",
      status: "pending",
      goal: input.goal,
      acceptance: input.acceptance,
      budget: input.budget,
      mandate: input.mandate,
      createdAt,
      expiresAt: input.expires_at,
      turnCount: preserveProgress ? existing.turnCount : 0,
      peerMessages: preserveProgress ? existing.peerMessages : [],
      lockedSections: preserveProgress ? existing.lockedSections : [],
      testReports: preserveProgress ? existing.testReports : {},
      challenges: preserveProgress ? existing.challenges : {},
      signHashes: preserveProgress ? existing.signHashes : {},
      ratifyApproved: preserveProgress ? existing.ratifyApproved : {},
    };
    upsert(session);

    const pending = ensureRecipientOpenPending(session);
    if (!pending) {
      const current = store.get(input.thread);
      return result({
        ok: true,
        thread: input.thread,
        status: current?.status ?? "open_expired",
      });
    }

    return result({
      ok: true,
      thread: input.thread,
      pending_id: pending.id,
      status: "pending",
    });
  }

  return {
    store,
    async handleOpen(input: {
      to: string;
      goal: string;
      acceptance: AcceptanceCriterion[];
      budget: SessionBudget;
      mandate: SessionMandate;
    }) {
      const allowed = deps.allowlist.get(deps.agentId);
      if (!allowed.includes(input.to)) {
        return result({ ok: false, error: "recipient_not_allowed" });
      }

      const thread = crypto.randomUUID();
      const createdAt = now();
      const session: SessionRecord = {
        thread,
        initiator: deps.agentId,
        recipient: input.to,
        role: "initiator",
        status: "pending",
        goal: input.goal,
        acceptance: input.acceptance,
        budget: input.budget,
        mandate: input.mandate,
        createdAt,
        expiresAt: createdAt + SESSION_OPEN_TTL_MS,
        turnCount: 0,
        peerMessages: [],
        lockedSections: [],
        testReports: {},
        challenges: {},
        signHashes: {},
        ratifyApproved: {},
      };
      upsert(session);

      await deps.relay.send({
        to: input.to,
        type: "session.open",
        payload: JSON.stringify({
          goal: input.goal,
          acceptance: input.acceptance,
          budget: input.budget,
          mandate: input.mandate,
          from: deps.agentId,
          expires_at: session.expiresAt,
        }),
        thread,
      });

      return result({
        ok: true,
        thread,
        status: "pending",
        expires_at: session.expiresAt,
      });
    },

    handleIncomingOpen,

    async handleApproveOpen(input: { pending_id: string; via_human?: boolean }) {
      if (!input.via_human) {
        return result({ ok: false, error: "human_required" });
      }

      const pending = deps.pending.get(input.pending_id);
      if (!pending || pending.kind !== "session_open") {
        return result({ ok: false, error: "pending_not_found" });
      }

      if (now() > pending.expiresAt) {
        return result({ ok: false, error: "session_open_expired" });
      }

      const session = store.get(pending.thread);
      if (!session) {
        return result({ ok: false, error: "session_not_found" });
      }

      const live = upsert({ ...session, status: "live" });
      deps.pending.remove(pending.id);

      await notifyPeer(live, "session.open_approved", {
        thread: live.thread,
        approved_by: deps.agentId,
      });

      return result({ ok: true, thread: live.thread, status: "live" });
    },

    async handleRejectOpen(input: {
      pending_id: string;
      reason: string;
      via_human?: boolean;
    }) {
      if (!input.via_human) {
        return result({ ok: false, error: "human_required" });
      }

      const pending = deps.pending.get(input.pending_id);
      if (!pending || pending.kind !== "session_open") {
        return result({ ok: false, error: "pending_not_found" });
      }

      const session = store.get(pending.thread);
      if (!session) {
        return result({ ok: false, error: "session_not_found" });
      }

      const rejected = upsert({
        ...session,
        status: "open_rejected",
        rejectReason: input.reason,
      });
      deps.pending.remove(pending.id);

      await notifyPeer(rejected, "session.open_reject", {
        thread: rejected.thread,
        reason: input.reason,
      });

      return result({
        ok: true,
        thread: rejected.thread,
        status: "open_rejected",
      });
    },

    async handleExpirePendingOpens() {
      const expiredThreads: string[] = [];

      for (const session of store.list()) {
        if (session.status !== "pending" || now() <= session.expiresAt) {
          continue;
        }
        const expired = upsert({ ...session, status: "open_expired" });
        if (session.role === "recipient") {
          await notifyPeer(expired, "session.open_expired", {
            thread: expired.thread,
          });
        }
        expiredThreads.push(session.thread);
      }

      for (const pending of deps.pending.list()) {
        if (pending.kind !== "session_open") {
          continue;
        }
        const session = store.get(pending.thread);
        if (!session || session.status !== "pending") {
          deps.pending.remove(pending.id);
        }
      }

      return result({ ok: true, expired: [...new Set(expiredThreads)] });
    },

    async handleIncomingEnvelope(input: {
      from: string;
      type: string;
      thread: string;
      payload: string;
    }) {
      const parsed = parseJsonBody<Record<string, unknown>>(input.payload);
      if ("error" in parsed) {
        return result({ ok: false, error: parsed.error });
      }

      switch (input.type) {
        case "session.open":
          return handleIncomingOpen({
            thread: input.thread,
            from: input.from,
            goal: String(parsed.goal ?? ""),
            acceptance: (parsed.acceptance as AcceptanceCriterion[]) ?? [],
            budget: (parsed.budget as SessionBudget) ?? { max_turns: 30 },
            mandate: (parsed.mandate as SessionMandate) ?? {
              agent_may: [],
              human_required: [],
            },
            expires_at: Number(parsed.expires_at ?? now() + SESSION_OPEN_TTL_MS),
          });
        case "session.open_approved": {
          const found = getOrError(input.thread);
          if (!found.ok) {
            return result(found);
          }
          upsert({ ...found.session, status: "live" });
          return result({ ok: true, thread: input.thread, status: "live" });
        }
        case "session.open_reject": {
          const found = getOrError(input.thread);
          if (!found.ok) {
            return result(found);
          }
          upsert({
            ...found.session,
            status: "open_rejected",
            rejectReason: String(parsed.reason ?? ""),
          });
          return result({
            ok: true,
            thread: input.thread,
            status: "open_rejected",
          });
        }
        case "session.open_expired": {
          const found = getOrError(input.thread);
          if (!found.ok) {
            return result(found);
          }
          upsert({ ...found.session, status: "open_expired" });
          return result({
            ok: true,
            thread: input.thread,
            status: "open_expired",
          });
        }
        case "session.peer_challenge": {
          const found = getOrError(input.thread);
          if (!found.ok) {
            return result(found);
          }
          const role = roleFor(found.session, input.from);
          const challenges = { ...found.session.challenges, [role]: true };
          upsert({ ...found.session, challenges });
          return result({ ok: true, thread: input.thread, type: "challenge" });
        }
        case "session.peer_test_report": {
          const found = getOrError(input.thread);
          if (!found.ok) {
            return result(found);
          }
          const role = roleFor(found.session, input.from);
          const artifactHash = String(parsed.artifact_hash ?? "");
          const existing = found.session.testReports[artifactHash] ?? {};
          const testReports = {
            ...found.session.testReports,
            [artifactHash]: {
              ...existing,
              [role]: {
                artifact_hash: artifactHash,
                passed: Boolean(parsed.passed),
                runner: String(parsed.runner ?? ""),
                details:
                  parsed.details === undefined
                    ? undefined
                    : String(parsed.details),
              },
            },
          };
          upsert({ ...found.session, testReports });
          return result({ ok: true, thread: input.thread, type: "test_report" });
        }
        case "session.peer_signed": {
          const found = getOrError(input.thread);
          if (!found.ok) {
            return result(found);
          }
          const role = roleFor(found.session, input.from);
          const signHashes = { ...found.session.signHashes };
          if (role === "initiator") {
            signHashes.initiator = String(parsed.artifact_hash ?? "");
          } else {
            signHashes.recipient = String(parsed.artifact_hash ?? "");
          }
          const updated = upsert({
            ...found.session,
            signHashes,
            artifactHash: String(parsed.artifact_hash ?? found.session.artifactHash),
            status: bothSigned({ ...found.session, signHashes })
              ? "signed"
              : found.session.status,
          });
          if (updated.status === "signed") {
            deps.pending.addRatify({
              thread: updated.thread,
              peer: input.from,
              artifactHash: updated.artifactHash ?? "",
            });
          }
          return result({ ok: true, thread: input.thread, status: updated.status });
        }
        case "session.peer_turn": {
          const found = getOrError(input.thread);
          if (!found.ok) {
            return result(found);
          }
          const turnCount = Number(parsed.turn_count ?? found.session.turnCount);
          const nextTurnCount = Math.max(found.session.turnCount, turnCount);
          const msgType =
            typeof parsed.msg_type === "string" ? parsed.msg_type : undefined;
          const msgBody = typeof parsed.body === "string" ? parsed.body : undefined;
          let lockedSections = found.session.lockedSections;
          let peerMessages = found.session.peerMessages;

          if (msgType && msgBody) {
            const role = roleFor(found.session, input.from);
            peerMessages = [
              ...peerMessages,
              { from: role, type: msgType, body: msgBody, turn: nextTurnCount },
            ];
            if (msgType === "accept") {
              const acceptBody = parseJsonBody<{ section_id?: string }>(msgBody);
              if (!("error" in acceptBody) && acceptBody.section_id) {
                lockedSections = [
                  ...new Set([...lockedSections, acceptBody.section_id]),
                ];
              }
            }
          }

          upsert({
            ...found.session,
            turnCount: nextTurnCount,
            peerMessages,
            lockedSections,
          });
          return result({ ok: true, thread: input.thread, type: "turn" });
        }
        case "session.peer_ratified": {
          const found = getOrError(input.thread);
          if (!found.ok) {
            return result(found);
          }
          const role = roleFor(found.session, input.from);
          const ratifyApproved = { ...found.session.ratifyApproved };
          if (role === "initiator") {
            ratifyApproved.initiator = true;
          } else {
            ratifyApproved.recipient = true;
          }
          const updated = upsert({ ...found.session, ratifyApproved });
          if (
            bothRatified(updated) &&
            updated.artifactHash &&
            updated.status !== "closed"
          ) {
            const closed = await finalizeSession(updated, updated.artifactHash);
            return result({
              ok: true,
              thread: input.thread,
              status: closed.status,
              co_signed_hash: closed.coSignedHash,
            });
          }
          return result({ ok: true, thread: input.thread, status: updated.status });
        }
        default:
          return result({ ok: false, error: "unsupported_envelope_type" });
      }
    },

    async handleMsg(input: { thread: string; type: string; body: string }) {
      const found = getOrError(input.thread);
      if (!found.ok) {
        return result(found);
      }
      const session = found.session;
      if (session.status !== "live" && session.status !== "signed") {
        return result({ ok: false, error: "session_not_live" });
      }

      if (input.type === "test_report") {
        const report = parseJsonBody<TestReport>(input.body);
        if ("error" in report) {
          return result({ ok: false, error: report.error });
        }
        const role = roleFor(session, deps.agentId);
        const existing = session.testReports[report.artifact_hash] ?? {};
        const testReports = {
          ...session.testReports,
          [report.artifact_hash]: {
            ...existing,
            [role]: report,
          },
        };
        const updated = upsert({ ...session, testReports });
        await notifyPeer(updated, "session.peer_test_report", {
          thread: updated.thread,
          artifact_hash: report.artifact_hash,
          passed: report.passed,
          runner: report.runner,
          details: report.details,
        });
        return result({ ok: true, thread: input.thread, type: "test_report" });
      }

      if (input.type === "challenge") {
        const role = roleFor(session, deps.agentId);
        const challenges = { ...session.challenges, [role]: true };
        const updated = upsert({ ...session, challenges });
        await notifyPeer(updated, "session.peer_challenge", {
          thread: updated.thread,
        });
        return result({ ok: true, thread: input.thread, type: "challenge" });
      }

      if (!["propose", "counter", "accept"].includes(input.type)) {
        return result({ ok: false, error: "invalid_msg_type" });
      }

      if (session.turnCount >= session.budget.max_turns) {
        const peer = peerFor(session, deps.agentId);
        const existing = deps.pending
          .list()
          .find(
            (item) => item.kind === "budget_extend" && item.thread === session.thread,
          );
        if (!existing) {
          deps.pending.addBudgetExtend({
            thread: session.thread,
            peer,
          });
        }
        return result({ ok: false, error: "budget_exhausted" });
      }

      if (input.type === "accept") {
        const body = parseJsonBody<{ section_id?: string }>(input.body);
        if ("error" in body || !body.section_id) {
          return result({ ok: false, error: "invalid_accept_body" });
        }
        const lockedSections = [...new Set([...session.lockedSections, body.section_id])];
        const updated = upsert({
          ...session,
          lockedSections,
          turnCount: session.turnCount + 1,
        });
        await notifyPeer(updated, "session.peer_turn", {
          thread: updated.thread,
          turn_count: updated.turnCount,
          msg_type: input.type,
          body: input.body,
        });
        return result({
          ok: true,
          thread: input.thread,
          type: input.type,
          locked_sections: lockedSections,
        });
      }

      const updated = upsert({ ...session, turnCount: session.turnCount + 1 });
      await notifyPeer(updated, "session.peer_turn", {
        thread: updated.thread,
        turn_count: updated.turnCount,
        msg_type: input.type,
        body: input.body,
      });
      return result({ ok: true, thread: input.thread, type: input.type });
    },

    async handleSign(input: { thread: string; artifact_hash: string }) {
      const found = getOrError(input.thread);
      if (!found.ok) {
        return result(found);
      }
      const session = found.session;
      if (session.status !== "live" && session.status !== "signed") {
        return result({ ok: false, error: "session_not_live" });
      }

      if (!bothChallengesFiled(session)) {
        return result({ ok: false, error: "challenges_incomplete" });
      }
      if (!bothTestReportsPass(session, input.artifact_hash)) {
        return result({ ok: false, error: "tests_not_green" });
      }

      const role = roleFor(session, deps.agentId);
      const signHashes = { ...session.signHashes, [role]: input.artifact_hash };
      const updated = upsert({
        ...session,
        signHashes,
        artifactHash: input.artifact_hash,
        status: bothSigned({ ...session, signHashes }) ? "signed" : session.status,
      });

      await notifyPeer(updated, "session.peer_signed", {
        thread: updated.thread,
        artifact_hash: input.artifact_hash,
      });

      if (updated.status === "signed") {
        deps.pending.addRatify({
          thread: updated.thread,
          peer: peerFor(updated, deps.agentId),
          artifactHash: input.artifact_hash,
        });
      }

      return result({
        ok: true,
        thread: input.thread,
        status: updated.status,
        artifact_hash: input.artifact_hash,
      });
    },

    async handleRatify(input: {
      thread?: string;
      artifact_hash?: string;
      pending_id?: string;
      via_human?: boolean;
    }) {
      if (!input.via_human) {
        return result({ ok: false, error: "human_required" });
      }

      let thread = input.thread;
      let artifactHash = input.artifact_hash;

      if (input.pending_id) {
        const pending = deps.pending.get(input.pending_id);
        if (!pending || pending.kind !== "ratify") {
          return result({ ok: false, error: "pending_not_found" });
        }
        thread = pending.thread;
        artifactHash = pending.artifactHash;
      }

      if (!thread) {
        return result({ ok: false, error: "thread_required" });
      }

      const found = getOrError(thread);
      if (!found.ok) {
        return result(found);
      }
      const session = found.session;
      if (session.status !== "signed" && session.status !== "closed") {
        return result({ ok: false, error: "session_not_signed" });
      }

      const hash = artifactHash ?? session.artifactHash;
      if (!hash) {
        return result({ ok: false, error: "artifact_hash_required" });
      }

      const role = roleFor(session, deps.agentId);
      const ratifyApproved = { ...session.ratifyApproved, [role]: true };
      const updated = upsert({ ...session, ratifyApproved });
      if (input.pending_id) {
        deps.pending.remove(input.pending_id);
      }

      await notifyPeer(updated, "session.peer_ratified", {
        thread: updated.thread,
        artifact_hash: hash,
      });

      if (bothRatified(updated)) {
        const closed = await finalizeSession(updated, hash);
        return result({
          ok: true,
          thread: closed.thread,
          status: closed.status,
          co_signed_hash: closed.coSignedHash,
          signatures: closed.signatures,
        });
      }

      return result({
        ok: true,
        thread: updated.thread,
        status: "awaiting_peer_ratify",
      });
    },

    resolveOpenPendingId(thread: string) {
      const session = store.get(thread);
      if (!session) {
        return undefined;
      }
      return ensureRecipientOpenPending(session)?.id;
    },

    peekSessionOpenStatus(thread: string) {
      return store.get(thread)?.status;
    },

    async handleStatus(input: { thread: string }) {
      const found = getOrError(input.thread);
      if (!found.ok) {
        return result(found);
      }
      const session = store.get(found.session.thread) ?? found.session;
      const pendingOpen =
        session.status === "pending" && session.role === "recipient"
          ? ensureRecipientOpenPending(session)
          : undefined;
      const current = store.get(session.thread) ?? session;
      return result({
        ok: true,
        thread: current.thread,
        status: current.status,
        goal: current.goal,
        locked_sections: current.lockedSections,
        turn_count: current.turnCount,
        peer_messages: current.peerMessages,
        reject_reason: current.rejectReason,
        artifact_hash: current.artifactHash,
        co_signed_hash: current.coSignedHash,
        tests_legal:
          current.artifactHash !== undefined &&
          bothTestReportsPass(current, current.artifactHash) &&
          bothChallengesFiled(current),
        ratify_approved: current.ratifyApproved,
        expires_at: current.expiresAt,
        ...(pendingOpen ? { pending_id: pendingOpen.id } : {}),
      });
    },
  };
}

export type SessionStateMachine = ReturnType<typeof createSessionStateMachine>;
