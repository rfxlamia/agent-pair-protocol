import { utf8ToBytes } from "@noble/ciphers/utils.js";
import { encodeBase64Url } from "../crypto/base64url.js";
import { sign } from "../crypto/sign.js";
import {
  parseAtestReportPayload,
  parseEnvelopePayload,
  parseNegoOpenPayload,
  parseNegoOpenRejectPayload,
  parseNegoSignedPayload,
  parseNegoTurnPayload,
} from "../envelope/schema.js";
import { isEphemeralBond } from "./bond.js";
import type { SessionStateMachineDeps } from "./deps.js";
import { type SessionStore, createSessionStore } from "./store.js";
import type {
  AcceptanceCriterion,
  SessionBudget,
  SessionMandate,
  SessionRecord,
  SessionStatus,
  TestReport,
} from "./types.js";
import { SESSION_OPEN_TTL_MS } from "./types.js";

/** Recipient sessions past open must not be reset by a redelivered nego.open. */
const NON_REOPENABLE_OPEN_STATUSES: SessionStatus[] = [
  "live",
  "signed",
  "closed",
  "open_rejected",
  "open_expired",
];

/** Terminal negotiation states for wire precision guards (§8.3 / N5). */
const TERMINAL_NEGOTIATION_STATUSES: SessionStatus[] = ["closed", "open_rejected", "open_expired"];

function isTerminalNegotiationStatus(status: SessionStatus): boolean {
  return TERMINAL_NEGOTIATION_STATUSES.includes(status);
}

function peerFor(session: SessionRecord, agentId: string): string {
  return session.initiator === agentId ? session.recipient : session.initiator;
}

function roleFor(session: SessionRecord, agentId: string): "initiator" | "recipient" {
  return session.initiator === agentId ? "initiator" : "recipient";
}

function assertParticipant(
  session: SessionRecord,
  from: string,
): { ok: true; role: "initiator" | "recipient" } | { ok: false; error: "not_a_participant" } {
  if (from === session.initiator) {
    return { ok: true, role: "initiator" };
  }
  if (from === session.recipient) {
    return { ok: true, role: "recipient" };
  }
  return { ok: false, error: "not_a_participant" };
}

function assertRecipientSender(
  session: SessionRecord,
  from: string,
): { ok: true; role: "recipient" } | { ok: false; error: "not_a_participant" | "wrong_role" } {
  const participant = assertParticipant(session, from);
  if (!participant.ok) {
    return participant;
  }
  if (participant.role !== "recipient") {
    return { ok: false, error: "wrong_role" };
  }
  return { ok: true, role: "recipient" };
}

function parseJsonBody<T>(body: string): T | { error: string } {
  try {
    return JSON.parse(body) as T;
  } catch {
    return { error: "invalid_json" };
  }
}

function bothTestReportsPass(session: SessionRecord, artifactHash: string): boolean {
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

function effectiveOpenExpiry(session: SessionRecord): number {
  return Math.min(session.expiresAt, Date.parse(session.budget.deadline));
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

  function removeBudgetExtendPendingForThread(thread: string) {
    for (const pending of deps.pending.list()) {
      if (pending.kind === "budget_extend" && pending.thread === thread) {
        deps.pending.remove(pending.id);
      }
    }
  }

  function expireOpenPendingSync(session: SessionRecord): SessionRecord {
    const expired = upsert({ ...session, status: "open_expired" });
    removeSessionOpenPendingForThread(session.thread);
    return expired;
  }

  async function expireOpenPending(session: SessionRecord): Promise<SessionRecord> {
    const expired = expireOpenPendingSync(session);
    if (session.role === "recipient") {
      await notifyPeer(expired, "nego.open_expired", {
        thread: expired.thread,
      });
    }
    return expired;
  }

  function ensureLiveNotExpired(session: SessionRecord): SessionRecord {
    if (session.status !== "live") {
      return session;
    }
    if (now() <= Date.parse(session.budget.deadline)) {
      return session;
    }
    removeBudgetExtendPendingForThread(session.thread);
    return upsert({
      ...session,
      status: "closed",
      rejectReason: "deadline_expired",
    });
  }

  function ensureRecipientOpenPending(session: SessionRecord) {
    if (session.status !== "pending" || session.role !== "recipient") {
      return undefined;
    }
    if (now() > effectiveOpenExpiry(session)) {
      // Read-path side effect: used by handleStatus and resolveOpenPendingId.
      expireOpenPendingSync(session);
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

  function findRatifyPending(thread: string) {
    return deps.pending.list().find((item) => item.kind === "ratify" && item.thread === thread);
  }

  function removeRatifyPendingForThread(thread: string) {
    const pending = findRatifyPending(thread);
    if (pending) {
      deps.pending.remove(pending.id);
    }
  }

  function removeSessionOpenPendingForThread(thread: string) {
    const pending = findSessionOpenPending(thread);
    if (pending) {
      deps.pending.remove(pending.id);
    }
  }

  function ensureRatifyPending(session: SessionRecord) {
    if (session.status !== "signed" && session.status !== "closed") {
      return undefined;
    }
    const peer = peerFor(session, deps.agentId);
    // Ephemeral finalize is safe: bothRatified sets ratifyApproved before bond removal.
    if (session.rejectReason === "bond_revoked") {
      return undefined;
    }
    if (!deps.bonds.find(deps.agentId, peer)) {
      return undefined;
    }
    const role = roleFor(session, deps.agentId);
    if (session.ratifyApproved[role]) {
      return undefined;
    }
    // Read-path side effect: used by handleStatus and resolveRatifyPendingId.
    const existing = findRatifyPending(session.thread);
    if (existing) {
      return existing;
    }
    if (!session.artifactHash) {
      return undefined;
    }
    // Read-path side effect: re-queues a lost ratify entry for human_approve.
    return deps.pending.addRatify({
      thread: session.thread,
      peer: peerFor(session, deps.agentId),
      artifactHash: session.artifactHash,
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
    const signature = encodeBase64Url(sign(message, deps.keyPair.secretKey));
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
  }) {
    const existing = store.get(input.thread);
    if (existing && NON_REOPENABLE_OPEN_STATUSES.includes(existing.status)) {
      return {
        ok: true,
        thread: input.thread,
        status: existing.status,
      };
    }

    if (existing && existing.initiator !== input.from) {
      return { ok: false, error: "initiator_mismatch" };
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
      expiresAt: createdAt + SESSION_OPEN_TTL_MS,
      turnCount: preserveProgress ? existing.turnCount : 0,
      peerMessages: preserveProgress ? existing.peerMessages : [],
      lockedSections: preserveProgress ? existing.lockedSections : [],
      testReports: preserveProgress ? existing.testReports : {},
      challenges: preserveProgress ? existing.challenges : {},
      signHashes: preserveProgress ? existing.signHashes : {},
      ratifyApproved: preserveProgress ? existing.ratifyApproved : {},
    };
    upsert(session);

    if (now() > Date.parse(input.budget.deadline)) {
      await expireOpenPending(session);
      return {
        ok: true,
        thread: input.thread,
        status: "open_expired",
      };
    }

    const pending = ensureRecipientOpenPending(session);
    if (!pending) {
      const current = store.get(input.thread);
      return {
        ok: true,
        thread: input.thread,
        status: current?.status ?? "open_expired",
      };
    }

    return {
      ok: true,
      thread: input.thread,
      pending_id: pending.id,
      status: "pending",
    };
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
        return { ok: false, error: "recipient_not_allowed" };
      }

      if (now() > Date.parse(input.budget.deadline)) {
        return { ok: false, error: "invalid_payload" };
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

      const sent = await deps.relay.send({
        to: input.to,
        type: "nego.open",
        payload: JSON.stringify({
          goal: input.goal,
          acceptance: input.acceptance,
          budget: input.budget,
          mandate: input.mandate,
          from: deps.agentId,
        }),
        thread,
      });
      if (!sent.ok) {
        return { ok: false, error: sent.error ?? "relay_unavailable" };
      }

      return {
        ok: true,
        thread,
        status: "pending",
        expires_at: session.expiresAt,
      };
    },

    handleIncomingOpen,

    async handleApproveOpen(input: { pending_id: string; via_human?: boolean }) {
      if (!input.via_human) {
        return { ok: false, error: "human_required" };
      }

      const pending = deps.pending.get(input.pending_id);
      if (!pending || pending.kind !== "session_open") {
        return { ok: false, error: "pending_not_found" };
      }

      const session = store.get(pending.thread);
      if (!session) {
        return { ok: false, error: "session_not_found" };
      }

      if (now() > effectiveOpenExpiry(session)) {
        await expireOpenPending(session);
        return { ok: false, error: "session_open_expired" };
      }

      const live = upsert({ ...session, status: "live" });
      deps.pending.remove(pending.id);

      await notifyPeer(live, "nego.open_approved", {
        thread: live.thread,
        approved_by: deps.agentId,
      });

      return { ok: true, thread: live.thread, status: "live" };
    },

    async handleRejectOpen(input: {
      pending_id: string;
      reason: string;
      via_human?: boolean;
    }) {
      if (!input.via_human) {
        return { ok: false, error: "human_required" };
      }

      const pending = deps.pending.get(input.pending_id);
      if (!pending || pending.kind !== "session_open") {
        return { ok: false, error: "pending_not_found" };
      }

      const session = store.get(pending.thread);
      if (!session) {
        return { ok: false, error: "session_not_found" };
      }

      if (now() > effectiveOpenExpiry(session)) {
        await expireOpenPending(session);
        return { ok: false, error: "session_open_expired" };
      }

      const rejected = upsert({
        ...session,
        status: "open_rejected",
        rejectReason: input.reason,
      });
      deps.pending.remove(pending.id);

      await notifyPeer(rejected, "nego.open_reject", {
        thread: rejected.thread,
        reason: input.reason,
      });

      return {
        ok: true,
        thread: rejected.thread,
        status: "open_rejected",
      };
    },

    async handleExpireSessions() {
      const expiredThreads: string[] = [];

      for (const session of store.list()) {
        if (session.status === "pending" && now() > effectiveOpenExpiry(session)) {
          const expired = await expireOpenPending(session);
          expiredThreads.push(expired.thread);
          continue;
        }
        if (session.status === "live" && now() > Date.parse(session.budget.deadline)) {
          ensureLiveNotExpired(session);
          expiredThreads.push(session.thread);
        }
      }

      for (const pending of deps.pending.list()) {
        if (pending.kind === "session_open") {
          const session = store.get(pending.thread);
          if (!session || session.status !== "pending") {
            deps.pending.remove(pending.id);
          }
          continue;
        }
        if (pending.kind === "ratify") {
          const session = store.get(pending.thread);
          if (!session) {
            deps.pending.remove(pending.id);
            continue;
          }
          const role = roleFor(session, deps.agentId);
          if (session.status === "closed" || session.ratifyApproved[role]) {
            deps.pending.remove(pending.id);
          }
        }
      }

      return { ok: true, expired: [...new Set(expiredThreads)] };
    },

    async handleIncomingEnvelope(input: {
      from: string;
      type: string;
      thread: string;
      payload: string;
    }) {
      const preloaded = store.get(input.thread);
      if (preloaded) {
        ensureLiveNotExpired(preloaded);
      }

      const raw = parseJsonBody<unknown>(input.payload);
      if (typeof raw === "object" && raw !== null && "error" in raw) {
        return { ok: false, error: (raw as { error: string }).error };
      }
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        return { ok: false, error: "invalid_payload" };
      }
      const parsed = raw as Record<string, unknown>;

      switch (input.type) {
        case "nego.open": {
          const openPayload = parseNegoOpenPayload(parsed);
          if (!openPayload.ok) {
            return openPayload;
          }
          return handleIncomingOpen({
            thread: input.thread,
            from: input.from,
            goal: openPayload.data.goal,
            acceptance: openPayload.data.acceptance,
            budget: openPayload.data.budget,
            mandate: openPayload.data.mandate,
          });
        }
        case "nego.open_approved": {
          const found = getOrError(input.thread);
          if (!found.ok) {
            return found;
          }
          const openApprovedPayload = parseEnvelopePayload("nego.open_approved", parsed);
          if (!openApprovedPayload.ok) {
            return openApprovedPayload;
          }
          const recipient = assertRecipientSender(found.session, input.from);
          if (!recipient.ok) {
            return recipient;
          }
          if (isTerminalNegotiationStatus(found.session.status)) {
            return { ok: false, error: "thread_closed" };
          }
          upsert({ ...found.session, status: "live" });
          return { ok: true, thread: input.thread, status: "live" };
        }
        case "nego.open_reject": {
          const found = getOrError(input.thread);
          if (!found.ok) {
            return found;
          }
          const openRejectPayload = parseNegoOpenRejectPayload(parsed);
          if (!openRejectPayload.ok) {
            return openRejectPayload;
          }
          const recipient = assertRecipientSender(found.session, input.from);
          if (!recipient.ok) {
            return recipient;
          }
          if (found.session.status === "open_rejected") {
            return { ok: true, thread: input.thread, status: "open_rejected" };
          }
          if (found.session.status === "closed") {
            return { ok: false, error: "thread_closed" };
          }
          upsert({
            ...found.session,
            status: "open_rejected",
            rejectReason: openRejectPayload.data.reason ?? "",
          });
          return {
            ok: true,
            thread: input.thread,
            status: "open_rejected",
          };
        }
        case "nego.open_expired": {
          const found = getOrError(input.thread);
          if (!found.ok) {
            return found;
          }
          const openExpiredPayload = parseEnvelopePayload("nego.open_expired", parsed);
          if (!openExpiredPayload.ok) {
            return openExpiredPayload;
          }
          const recipient = assertRecipientSender(found.session, input.from);
          if (!recipient.ok) {
            return recipient;
          }
          if (found.session.status === "open_expired") {
            return { ok: true, thread: input.thread, status: "open_expired" };
          }
          if (found.session.status === "closed") {
            return { ok: false, error: "thread_closed" };
          }
          upsert({ ...found.session, status: "open_expired" });
          return {
            ok: true,
            thread: input.thread,
            status: "open_expired",
          };
        }
        case "atest.challenge": {
          const found = getOrError(input.thread);
          if (!found.ok) {
            return found;
          }
          const challengePayload = parseEnvelopePayload("atest.challenge", parsed);
          if (!challengePayload.ok) {
            return challengePayload;
          }
          const participant = assertParticipant(found.session, input.from);
          if (!participant.ok) {
            return participant;
          }
          if (isTerminalNegotiationStatus(found.session.status)) {
            return { ok: false, error: "thread_closed" };
          }
          const challenges = { ...found.session.challenges, [participant.role]: true };
          upsert({ ...found.session, challenges });
          return { ok: true, thread: input.thread, type: "challenge" };
        }
        case "atest.report": {
          const found = getOrError(input.thread);
          if (!found.ok) {
            return found;
          }
          const testReportPayload = parseAtestReportPayload(parsed);
          if (!testReportPayload.ok) {
            return testReportPayload;
          }
          const participant = assertParticipant(found.session, input.from);
          if (!participant.ok) {
            return participant;
          }
          if (isTerminalNegotiationStatus(found.session.status)) {
            return { ok: false, error: "thread_closed" };
          }
          const { artifact_hash: artifactHash, passed, runner, details } = testReportPayload.data;
          const existing = found.session.testReports[artifactHash] ?? {};
          const testReports = {
            ...found.session.testReports,
            [artifactHash]: {
              ...existing,
              [participant.role]: {
                artifact_hash: artifactHash,
                passed,
                runner,
                details,
              },
            },
          };
          upsert({ ...found.session, testReports });
          return { ok: true, thread: input.thread, type: "test_report" };
        }
        case "nego.signed": {
          const found = getOrError(input.thread);
          if (!found.ok) {
            return found;
          }
          const signedPayload = parseNegoSignedPayload(parsed);
          if (!signedPayload.ok) {
            return signedPayload;
          }
          const participant = assertParticipant(found.session, input.from);
          if (!participant.ok) {
            return participant;
          }
          if (isTerminalNegotiationStatus(found.session.status)) {
            return { ok: false, error: "thread_closed" };
          }
          const { artifact_hash: artifactHash } = signedPayload.data;
          const signHashes = { ...found.session.signHashes };
          if (participant.role === "initiator") {
            signHashes.initiator = artifactHash;
          } else {
            signHashes.recipient = artifactHash;
          }
          const updated = upsert({
            ...found.session,
            signHashes,
            artifactHash,
            status: bothSigned({ ...found.session, signHashes }) ? "signed" : found.session.status,
          });
          const pendingRatify =
            updated.status === "signed" ? ensureRatifyPending(updated) : undefined;
          return {
            ok: true,
            thread: input.thread,
            status: updated.status,
            ...(pendingRatify
              ? { pending_id: pendingRatify.id, pending_kind: "ratify" as const }
              : {}),
          };
        }
        case "nego.turn": {
          const found = getOrError(input.thread);
          if (!found.ok) {
            return found;
          }
          const turnPayload = parseNegoTurnPayload(parsed);
          if (!turnPayload.ok) {
            return turnPayload;
          }
          const participant = assertParticipant(found.session, input.from);
          if (!participant.ok) {
            return participant;
          }
          if (isTerminalNegotiationStatus(found.session.status)) {
            return { ok: false, error: "thread_closed" };
          }
          if (found.session.status !== "live") {
            return { ok: false, error: "session_not_live" };
          }
          const turnCount = turnPayload.data.turn_count ?? found.session.turnCount;
          const nextTurnCount = Math.max(found.session.turnCount, turnCount);
          const msgType = turnPayload.data.msg_type;
          const msgBody = turnPayload.data.body;
          let lockedSections = found.session.lockedSections;
          let peerMessages = found.session.peerMessages;

          if (msgType && msgBody) {
            peerMessages = [
              ...peerMessages,
              { from: participant.role, type: msgType, body: msgBody, turn: nextTurnCount },
            ];
            if (msgType === "accept") {
              const acceptBody = parseJsonBody<{ section_id?: string }>(msgBody);
              if (!("error" in acceptBody) && acceptBody.section_id) {
                lockedSections = [...new Set([...lockedSections, acceptBody.section_id])];
              }
            }
          }

          upsert({
            ...found.session,
            turnCount: nextTurnCount,
            peerMessages,
            lockedSections,
          });
          return { ok: true, thread: input.thread, type: "turn" };
        }
        case "nego.ratified": {
          const found = getOrError(input.thread);
          if (!found.ok) {
            return found;
          }
          const ratifiedPayload = parseEnvelopePayload("nego.ratified", parsed);
          if (!ratifiedPayload.ok) {
            return ratifiedPayload;
          }
          const participant = assertParticipant(found.session, input.from);
          if (!participant.ok) {
            return participant;
          }
          if (found.session.status === "closed" && found.session.coSignedHash) {
            return { ok: true, thread: input.thread, status: "closed" };
          }
          if (isTerminalNegotiationStatus(found.session.status)) {
            return { ok: false, error: "thread_closed" };
          }
          const ratifyApproved = { ...found.session.ratifyApproved };
          if (participant.role === "initiator") {
            ratifyApproved.initiator = true;
          } else {
            ratifyApproved.recipient = true;
          }
          const updated = upsert({ ...found.session, ratifyApproved });
          if (bothRatified(updated) && updated.artifactHash && updated.status !== "closed") {
            const closed = await finalizeSession(updated, updated.artifactHash);
            return {
              ok: true,
              thread: input.thread,
              status: closed.status,
              co_signed_hash: closed.coSignedHash,
            };
          }
          return { ok: true, thread: input.thread, status: updated.status };
        }
        default:
          return { ok: false, error: "unsupported_envelope_type" };
      }
    },

    async handleMsg(input: { thread: string; type: string; body: string }) {
      const found = getOrError(input.thread);
      if (!found.ok) {
        return found;
      }
      const session = ensureLiveNotExpired(found.session);
      if (session.status !== "live" && session.status !== "signed") {
        return { ok: false, error: "session_not_live" };
      }

      if (input.type === "test_report") {
        const report = parseJsonBody<TestReport>(input.body);
        if ("error" in report) {
          return { ok: false, error: report.error };
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
        await notifyPeer(updated, "atest.report", {
          thread: updated.thread,
          artifact_hash: report.artifact_hash,
          passed: report.passed,
          runner: report.runner,
          details: report.details,
        });
        return { ok: true, thread: input.thread, type: "test_report" };
      }

      if (input.type === "challenge") {
        const role = roleFor(session, deps.agentId);
        const challenges = { ...session.challenges, [role]: true };
        const updated = upsert({ ...session, challenges });
        await notifyPeer(updated, "atest.challenge", {
          thread: updated.thread,
        });
        return { ok: true, thread: input.thread, type: "challenge" };
      }

      if (!["propose", "counter", "accept"].includes(input.type)) {
        return { ok: false, error: "invalid_payload" };
      }

      if (session.turnCount >= session.budget.max_turns) {
        const peer = peerFor(session, deps.agentId);
        const existing = deps.pending
          .list()
          .find((item) => item.kind === "budget_extend" && item.thread === session.thread);
        if (!existing) {
          deps.pending.addBudgetExtend({
            thread: session.thread,
            peer,
          });
        }
        return { ok: false, error: "budget_exhausted" };
      }

      if (input.type === "accept") {
        const body = parseJsonBody<{ section_id?: string }>(input.body);
        if ("error" in body || !body.section_id) {
          return { ok: false, error: "invalid_payload" };
        }
        const lockedSections = [...new Set([...session.lockedSections, body.section_id])];
        const updated = upsert({
          ...session,
          lockedSections,
          turnCount: session.turnCount + 1,
        });
        await notifyPeer(updated, "nego.turn", {
          thread: updated.thread,
          turn_count: updated.turnCount,
          msg_type: input.type,
          body: input.body,
        });
        return {
          ok: true,
          thread: input.thread,
          type: input.type,
          locked_sections: lockedSections,
        };
      }

      const updated = upsert({ ...session, turnCount: session.turnCount + 1 });
      await notifyPeer(updated, "nego.turn", {
        thread: updated.thread,
        turn_count: updated.turnCount,
        msg_type: input.type,
        body: input.body,
      });
      return { ok: true, thread: input.thread, type: input.type };
    },

    async handleSign(input: { thread: string; artifact_hash: string }) {
      const found = getOrError(input.thread);
      if (!found.ok) {
        return found;
      }
      const session = ensureLiveNotExpired(found.session);
      if (session.status !== "live" && session.status !== "signed") {
        return { ok: false, error: "session_not_live" };
      }

      if (!bothChallengesFiled(session)) {
        return { ok: false, error: "challenges_incomplete" };
      }
      if (!bothTestReportsPass(session, input.artifact_hash)) {
        return { ok: false, error: "tests_not_green" };
      }

      const role = roleFor(session, deps.agentId);
      const signHashes = { ...session.signHashes, [role]: input.artifact_hash };
      const updated = upsert({
        ...session,
        signHashes,
        artifactHash: input.artifact_hash,
        status: bothSigned({ ...session, signHashes }) ? "signed" : session.status,
      });

      await notifyPeer(updated, "nego.signed", {
        thread: updated.thread,
        artifact_hash: input.artifact_hash,
      });

      const pendingRatify = updated.status === "signed" ? ensureRatifyPending(updated) : undefined;

      return {
        ok: true,
        thread: input.thread,
        status: updated.status,
        artifact_hash: input.artifact_hash,
        ...(pendingRatify ? { pending_id: pendingRatify.id, pending_kind: "ratify" as const } : {}),
      };
    },

    async handleRatify(input: {
      thread?: string;
      artifact_hash?: string;
      pending_id?: string;
      via_human?: boolean;
    }) {
      if (!input.via_human) {
        return { ok: false, error: "human_required" };
      }

      let thread = input.thread;
      let artifactHash = input.artifact_hash;

      if (input.pending_id) {
        const pending = deps.pending.get(input.pending_id);
        if (!pending || pending.kind !== "ratify") {
          return { ok: false, error: "pending_not_found" };
        }
        thread = pending.thread;
        artifactHash = pending.artifactHash;
      }

      if (!thread) {
        return { ok: false, error: "invalid_payload" };
      }

      const found = getOrError(thread);
      if (!found.ok) {
        return found;
      }
      const session = found.session;
      if (session.status !== "signed" && session.status !== "closed") {
        return { ok: false, error: "session_not_signed" };
      }

      const hash = artifactHash ?? session.artifactHash;
      if (!hash) {
        return { ok: false, error: "invalid_payload" };
      }

      const role = roleFor(session, deps.agentId);
      const ratifyApproved = { ...session.ratifyApproved, [role]: true };
      const updated = upsert({ ...session, ratifyApproved });
      removeRatifyPendingForThread(thread);

      await notifyPeer(updated, "nego.ratified", {
        thread: updated.thread,
        artifact_hash: hash,
      });

      if (bothRatified(updated)) {
        const closed = await finalizeSession(updated, hash);
        return {
          ok: true,
          thread: closed.thread,
          status: closed.status,
          co_signed_hash: closed.coSignedHash,
          signatures: closed.signatures,
        };
      }

      return {
        ok: true,
        thread: updated.thread,
        status: "awaiting_peer_ratify",
      };
    },

    resolveOpenPendingId(thread: string) {
      const session = store.get(thread);
      if (!session) {
        return undefined;
      }
      return ensureRecipientOpenPending(session)?.id;
    },

    resolveRatifyPendingId(thread: string) {
      const session = store.get(thread);
      if (!session) {
        return undefined;
      }
      return ensureRatifyPending(session)?.id;
    },

    peekSessionOpenStatus(thread: string) {
      return store.get(thread)?.status;
    },

    async handleStatus(input: { thread: string }) {
      const found = getOrError(input.thread);
      if (!found.ok) {
        return found;
      }
      const session = ensureLiveNotExpired(store.get(found.session.thread) ?? found.session);
      const pendingOpen =
        session.status === "pending" && session.role === "recipient"
          ? ensureRecipientOpenPending(session)
          : undefined;
      const pendingRatify =
        session.status === "signed" || session.status === "closed"
          ? ensureRatifyPending(session)
          : undefined;
      const current = store.get(session.thread) ?? session;
      return {
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
        ...(pendingOpen
          ? { pending_id: pendingOpen.id, pending_kind: "session_open" as const }
          : {}),
        ...(pendingRatify ? { pending_id: pendingRatify.id, pending_kind: "ratify" as const } : {}),
      };
    },

    handleBondRevoke(peer: string) {
      const nonTerminal: SessionStatus[] = ["pending", "live", "signed"];

      for (const session of store.list()) {
        if (peerFor(session, deps.agentId) !== peer) {
          continue;
        }
        if (!nonTerminal.includes(session.status)) {
          continue;
        }
        if (session.status === "pending") {
          removeSessionOpenPendingForThread(session.thread);
        }
        if (session.status === "signed") {
          removeRatifyPendingForThread(session.thread);
        }
        upsert({
          ...session,
          status: "closed",
          rejectReason: "bond_revoked",
        });
      }

      for (const pending of deps.pending.list()) {
        let shouldRemove = false;
        if (pending.kind === "budget_extend" || pending.kind === "ratify") {
          if (pending.peer === peer) {
            shouldRemove = true;
          }
        }
        if (pending.kind === "session_open" && pending.from === peer) {
          shouldRemove = true;
        }
        if (pending.kind !== "pair_join") {
          const session = store.get(pending.thread);
          if (session && peerFor(session, deps.agentId) === peer) {
            shouldRemove = true;
          }
        }
        if (shouldRemove) {
          deps.pending.remove(pending.id);
        }
      }
    },

    async handleThreadClose(thread: string, reason?: string) {
      const found = store.get(thread);
      if (!found) {
        return { ok: true as const, thread };
      }
      const session = ensureLiveNotExpired(found);
      const closeReason = reason ?? session.rejectReason ?? "thread_closed";
      if (session.status === "closed") {
        return { ok: true as const, thread, status: "closed" as const };
      }
      const terminal: SessionStatus[] = ["open_rejected", "open_expired"];
      if (terminal.includes(session.status)) {
        return { ok: true as const, thread, status: session.status };
      }
      if (session.status === "pending") {
        removeSessionOpenPendingForThread(thread);
      }
      if (session.status === "signed") {
        removeRatifyPendingForThread(thread);
      }
      const updated = upsert({
        ...session,
        status: "closed",
        rejectReason: closeReason,
      });
      return { ok: true as const, thread, status: updated.status };
    },
  };
}

export type SessionStateMachine = ReturnType<typeof createSessionStateMachine>;
