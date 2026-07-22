import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeBase64UrlStrict } from "../crypto/base64url.js";
import type { SessionStateMachine } from "./state-machine.js";
import {
  FUTURE_DEADLINE,
  type MockPendingQueue,
  type RelayCapture,
  createLinkedMachines,
  createSessionTestFixtures,
  defaultOpenPayload,
  openLiveWithMaxTurns,
} from "./test-helpers.js";

describe("N4 budget extend human gate", () => {
  let fixtures: ReturnType<typeof createSessionTestFixtures>;
  let aliceMachine: SessionStateMachine;
  let bobMachine: SessionStateMachine;
  let alicePending: MockPendingQueue;
  let bobPending: MockPendingQueue;

  function relink(options?: Parameters<typeof createLinkedMachines>[1]) {
    const linked = createLinkedMachines(fixtures, options);
    aliceMachine = linked.alice;
    bobMachine = linked.bob;
    return linked;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    fixtures = createSessionTestFixtures();
    alicePending = fixtures.alicePending;
    bobPending = fixtures.bobPending;
    relink();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function liveThread(maxTurns = 20): Promise<string> {
    return openLiveWithMaxTurns(
      aliceMachine,
      bobMachine,
      bobPending,
      fixtures.bobId,
      maxTurns,
      defaultOpenPayload,
    );
  }

  function budgetPending(thread: string, queue: MockPendingQueue = alicePending) {
    return queue.list().find((item) => item.kind === "budget_extend" && item.thread === thread);
  }

  async function extendAttach(thread: string, newMaxTurns: number) {
    return aliceMachine.handleExtendBudget({ thread, new_max_turns: newMaxTurns });
  }

  async function approveExtend(machine: SessionStateMachine, pendingId: string, viaHuman = true) {
    return machine.handleApproveBudgetExtend({ pending_id: pendingId, via_human: viaHuman });
  }

  async function rejectExtend(
    machine: SessionStateMachine,
    pendingId: string,
    viaHuman = true,
    reason?: string,
  ) {
    return machine.handleRejectBudgetExtend({
      pending_id: pendingId,
      via_human: viaHuman,
      reason,
    });
  }

  it("extend attach creates numbered pending without wire", async () => {
    const thread = await liveThread(20);
    const numberless = alicePending.addBudgetExtend({ thread, peer: fixtures.bobId });
    expect(budgetPending(thread)?.id).toBe(numberless.id);

    const result = await extendAttach(thread, 30);
    expect(result).toMatchObject({
      ok: true,
      thread,
      new_max_turns: 30,
    });
    expect(alicePending.get(numberless.id)).toBeUndefined();
    const pending = budgetPending(thread);
    expect(pending?.new_max_turns).toBe(30);
    expect(pending?.proposal_id).toBeDefined();
    expect(pending?.proposed_by).toBe("initiator");
    expect(aliceMachine.store.get(thread)?.budget.max_turns).toBe(20);
    expect(aliceMachine.store.get(thread)?.extension).toBeUndefined();
  });

  it("rejects extend_budget at or below current max_turns", async () => {
    const thread = await liveThread(20);
    for (const value of [20, 15]) {
      const result = await extendAttach(thread, value);
      expect(result).toEqual({ ok: false, error: "invalid_payload" });
    }
    expect(budgetPending(thread)).toBeUndefined();
  });

  it("both-sides approve cycle raises max_turns", async () => {
    const thread = await liveThread(20);
    const attached = await extendAttach(thread, 30);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;

    const pending = budgetPending(thread);
    expect(pending).toBeDefined();
    if (!pending) return;

    const localApprove = await approveExtend(aliceMachine, pending.id);
    expect(localApprove.ok).toBe(true);
    expect(aliceMachine.store.get(thread)?.budget.max_turns).toBe(20);
    expect(aliceMachine.store.get(thread)?.extension?.status).toBe("awaiting_peer");

    const bobPendingItem = budgetPending(thread, bobPending);
    expect(bobPendingItem?.proposal_id).toBe(pending.proposal_id);
    if (!bobPendingItem) return;

    const peerApprove = await approveExtend(bobMachine, bobPendingItem.id);
    expect(peerApprove.ok).toBe(true);
    if (peerApprove.ok && "max_turns" in peerApprove) {
      expect(peerApprove.max_turns).toBe(30);
    }
    expect(bobMachine.store.get(thread)?.budget.max_turns).toBe(30);
    expect(aliceMachine.store.get(thread)?.budget.max_turns).toBe(30);
    expect(aliceMachine.store.get(thread)?.extension).toBeUndefined();
    expect(bobMachine.store.get(thread)?.extension).toBeUndefined();
  });

  it("one-side approve does not raise max_turns", async () => {
    const thread = await liveThread(20);
    const attached = await extendAttach(thread, 30);
    if (!attached.ok) throw new Error("attach failed");
    const pending = budgetPending(thread);
    if (!pending) throw new Error("missing pending");
    await approveExtend(aliceMachine, pending.id);
    expect(aliceMachine.store.get(thread)?.budget.max_turns).toBe(20);
    expect(bobMachine.store.get(thread)?.budget.max_turns).toBe(20);
  });

  it("numberless approve returns proposal_required", async () => {
    const thread = await liveThread(3);
    for (let i = 0; i < 3; i++) {
      await aliceMachine.handleMsg({
        thread,
        type: "propose",
        body: JSON.stringify({ diff: i }),
      });
    }
    const exhausted = await aliceMachine.handleMsg({
      thread,
      type: "propose",
      body: JSON.stringify({ diff: "over" }),
    });
    expect(exhausted).toEqual({ ok: false, error: "budget_exhausted" });
    const pending = budgetPending(thread);
    expect(pending?.new_max_turns).toBeUndefined();
    if (!pending) throw new Error("missing numberless pending");

    const approve = await approveExtend(aliceMachine, pending.id);
    expect(approve).toEqual({ ok: false, error: "proposal_required" });
    expect(budgetPending(thread)?.id).toBe(pending.id);
  });

  it("numberless reject consumes pending without wire", async () => {
    const thread = await liveThread(3);
    for (let i = 0; i < 3; i++) {
      await aliceMachine.handleMsg({ thread, type: "propose", body: "{}" });
    }
    await aliceMachine.handleMsg({ thread, type: "propose", body: "{}" });
    const pending = budgetPending(thread);
    if (!pending) throw new Error("missing pending");
    const rejected = await rejectExtend(aliceMachine, pending.id);
    expect(rejected.ok).toBe(true);
    expect(budgetPending(thread)).toBeUndefined();
    expect((await aliceMachine.handleStatus({ thread })).status).toBe("live");
  });

  it("rejects budget envelopes when payload.thread mismatches body.thread", async () => {
    const thread = await liveThread(20);
    const proposalId = crypto.randomUUID();
    const envelopeTypes = [
      "nego.budget_propose",
      "nego.budget_approved",
      "nego.budget_reject",
    ] as const;

    for (const type of envelopeTypes) {
      const payload =
        type === "nego.budget_reject"
          ? {
              thread: "other-thread",
              proposal_id: proposalId,
              new_max_turns: 30,
              reason: "rejected",
            }
          : {
              thread: "other-thread",
              proposal_id: proposalId,
              new_max_turns: 30,
            };
      const result = await bobMachine.handleIncomingEnvelope({
        from: fixtures.aliceId,
        type,
        thread,
        payload: JSON.stringify(payload),
      });
      expect(result).toEqual({ ok: false, error: "invalid_payload" });
      expect(budgetPending(thread, bobPending)).toBeUndefined();
      expect(bobMachine.store.get(thread)?.budget.max_turns).toBe(20);
    }
  });

  it("drops received propose with new_max_turns <= current", async () => {
    const thread = await liveThread(20);
    const result = await bobMachine.handleIncomingEnvelope({
      from: fixtures.aliceId,
      type: "nego.budget_propose",
      thread,
      payload: JSON.stringify({
        thread,
        proposal_id: crypto.randomUUID(),
        new_max_turns: 20,
      }),
    });
    expect(result).toMatchObject({ ok: true, dropped: true });
    expect(budgetPending(thread, bobPending)).toBeUndefined();
  });

  it("peer propose supersedes local numbered draft", async () => {
    const thread = await liveThread(20);
    const attached = await bobMachine.handleExtendBudget({ thread, new_max_turns: 32 });
    expect(attached.ok).toBe(true);
    const localPending = budgetPending(thread, bobPending);
    expect(localPending).toBeDefined();

    const proposalId = crypto.randomUUID();
    const receive = await bobMachine.handleIncomingEnvelope({
      from: fixtures.aliceId,
      type: "nego.budget_propose",
      thread,
      payload: JSON.stringify({
        thread,
        proposal_id: proposalId,
        new_max_turns: 35,
      }),
    });
    expect(receive).toMatchObject({ ok: true, superseded: true });
    expect(budgetPending(thread, bobPending)?.proposal_id).toBe(proposalId);
    expect(budgetPending(thread, bobPending)?.new_max_turns).toBe(35);
    expect(localPending?.id).not.toBe(budgetPending(thread, bobPending)?.id);
  });

  function requireSession(thread: string, machine = aliceMachine) {
    const session = machine.store.get(thread);
    if (!session) {
      throw new Error(`expected session ${thread}`);
    }
    return session;
  }

  it("wire-vs-wire race: initiator wins and emits budget_reject superseded", async () => {
    const aliceSends: RelayCapture[] = [];
    const { flush, setPauseDelivery } = relink({ capture: { aliceSends } });

    const thread = await liveThread(20);
    setPauseDelivery(true);

    const aliceAttached = await extendAttach(thread, 30);
    if (!aliceAttached.ok) throw new Error("alice attach failed");
    const aliceLocalPending = budgetPending(thread);
    if (!aliceLocalPending) throw new Error("missing alice pending");
    await approveExtend(aliceMachine, aliceLocalPending.id);

    const bobAttached = await bobMachine.handleExtendBudget({ thread, new_max_turns: 40 });
    if (!bobAttached.ok) throw new Error("bob attach failed");
    const bobLocalPending = budgetPending(thread, bobPending);
    if (!bobLocalPending) throw new Error("missing bob pending");
    await approveExtend(bobMachine, bobLocalPending.id);

    await flush();

    const aliceProposal = aliceLocalPending.proposal_id;
    const bobProposal = bobLocalPending.proposal_id;
    const rejectSend = aliceSends.find((s) => s.type === "nego.budget_reject");
    expect(rejectSend).toBeDefined();
    if (rejectSend) {
      const body = JSON.parse(rejectSend.payload) as { reason?: string; proposal_id: string };
      expect(body.reason).toBe("superseded");
      expect(body.proposal_id).toBe(bobProposal);
    }
    expect(aliceMachine.store.get(thread)?.extension?.proposal_id).toBe(aliceProposal);
    expect(budgetPending(thread, bobPending)?.proposal_id).toBe(aliceProposal);
  });

  it("drops redelivered propose after extensionDecided rejection", async () => {
    const thread = await liveThread(20);
    const proposalId = crypto.randomUUID();
    await bobMachine.handleIncomingEnvelope({
      from: fixtures.aliceId,
      type: "nego.budget_propose",
      thread,
      payload: JSON.stringify({
        thread,
        proposal_id: proposalId,
        new_max_turns: 30,
      }),
    });
    const pending = budgetPending(thread, bobPending);
    if (!pending) throw new Error("missing pending");
    const rejected = await rejectExtend(bobMachine, pending.id);
    expect(rejected.ok).toBe(true);
    expect(bobMachine.store.get(thread)?.extensionDecided).toEqual([
      { proposal_id: proposalId, decision: "rejected" },
    ]);
    expect(budgetPending(thread, bobPending)).toBeUndefined();

    const redeliver = await bobMachine.handleIncomingEnvelope({
      from: fixtures.aliceId,
      type: "nego.budget_propose",
      thread,
      payload: JSON.stringify({
        thread,
        proposal_id: proposalId,
        new_max_turns: 30,
      }),
    });
    expect(redeliver).toMatchObject({ ok: true, dropped: true });
    expect(budgetPending(thread, bobPending)).toBeUndefined();
    expect(bobMachine.store.get(thread)?.budget.max_turns).toBe(20);
  });

  it("proposal redelivery with same id is a no-op", async () => {
    const thread = await liveThread(20);
    const proposalId = crypto.randomUUID();
    const payload = JSON.stringify({
      thread,
      proposal_id: proposalId,
      new_max_turns: 30,
    });
    const first = await bobMachine.handleIncomingEnvelope({
      from: fixtures.aliceId,
      type: "nego.budget_propose",
      thread,
      payload,
    });
    expect(first).toMatchObject({ ok: true });
    const before = budgetPending(thread, bobPending);
    const second = await bobMachine.handleIncomingEnvelope({
      from: fixtures.aliceId,
      type: "nego.budget_propose",
      thread,
      payload,
    });
    expect(second).toMatchObject({ ok: true, noop: true });
    expect(budgetPending(thread, bobPending)?.id).toBe(before?.id);
  });

  it("leave-live via signed sweeps extension but retains extensionDecided", async () => {
    const thread = await liveThread(20);
    const attached = await extendAttach(thread, 30);
    if (!attached.ok) throw new Error("attach failed");
    const pending = budgetPending(thread);
    if (!pending) throw new Error("missing pending");
    await approveExtend(aliceMachine, pending.id);
    expect(aliceMachine.store.get(thread)?.extension).toBeDefined();

    aliceMachine.store.upsert({
      ...requireSession(thread),
      extensionDecided: [{ proposal_id: pending.proposal_id, decision: "approved" }],
    });

    await aliceMachine.handleSign({ thread, artifact_hash: "sha256:artifact" });
    await bobMachine.handleSign({ thread, artifact_hash: "sha256:artifact" });

    const aliceSession = aliceMachine.store.get(thread);
    expect(aliceSession?.status).toBe("signed");
    expect(aliceSession?.extension).toBeUndefined();
    expect(budgetPending(thread)).toBeUndefined();
    expect(aliceSession?.extensionDecided).toEqual([
      { proposal_id: pending.proposal_id, decision: "approved" },
    ]);

    const extendAfterSigned = await extendAttach(thread, 40);
    expect(extendAfterSigned).toEqual({ ok: false, error: "session_not_live" });
  });

  it("leave-live via deadline_expired sweeps extension", async () => {
    const thread = await liveThread(20);
    const attached = await extendAttach(thread, 30);
    if (!attached.ok) throw new Error("attach failed");
    const pending = budgetPending(thread);
    if (!pending) throw new Error("missing pending");
    await approveExtend(aliceMachine, pending.id);

    const session = requireSession(thread);
    aliceMachine.store.upsert({
      ...session,
      budget: { ...session.budget, deadline: new Date(Date.now() + 60_000).toISOString() },
      extensionDecided: [{ proposal_id: pending.proposal_id, decision: "approved" }],
    });
    vi.advanceTimersByTime(120_000);
    await aliceMachine.handleExpireSessions();

    const after = aliceMachine.store.get(thread);
    expect(after?.status).toBe("closed");
    expect(after?.rejectReason).toBe("deadline_expired");
    expect(after?.extension).toBeUndefined();
    expect(budgetPending(thread)).toBeUndefined();
    expect(after?.extensionDecided).toHaveLength(1);

    const extendAfterDeadline = await extendAttach(thread, 40);
    expect(extendAfterDeadline).toEqual({ ok: false, error: "session_not_live" });
  });

  it("retryBudgetExtendEmit after deadline returns session_not_live without relay send", async () => {
    const aliceSends: RelayCapture[] = [];
    let failPropose = true;
    relink({
      capture: { aliceSends },
      injectSendFailure: ({ type }) => type === "nego.budget_propose" && failPropose,
    });

    const thread = await liveThread(20);
    const attached = await extendAttach(thread, 30);
    if (!attached.ok) throw new Error("attach failed");
    const pending = budgetPending(thread);
    if (!pending) throw new Error("missing pending");

    const approved = await approveExtend(aliceMachine, pending.id);
    expect(approved).toMatchObject({ ok: true, emit_pending: true });
    expect(aliceMachine.store.get(thread)?.extension?.status).toBe("emitting");

    const session = requireSession(thread);
    aliceMachine.store.upsert({
      ...session,
      budget: { ...session.budget, deadline: new Date(Date.now() + 60_000).toISOString() },
    });

    failPropose = false;
    vi.advanceTimersByTime(120_000);

    const sendCountBefore = aliceSends.length;
    const retried = await aliceMachine.retryBudgetExtendEmit(thread);
    expect(retried).toEqual({ ok: false, error: "session_not_live" });
    expect(aliceSends.length).toBe(sendCountBefore);
    expect(aliceMachine.store.get(thread)?.status).toBe("closed");
    expect(aliceMachine.store.get(thread)?.extension).toBeUndefined();
  });

  it("emit failure leaves *_emitting and retryBudgetExtendEmit resends identical bytes", async () => {
    const aliceSends: RelayCapture[] = [];
    let failPropose = true;
    relink({
      capture: { aliceSends },
      injectSendFailure: ({ type }) => type === "nego.budget_propose" && failPropose,
    });

    const thread = await liveThread(20);
    const attached = await extendAttach(thread, 30);
    if (!attached.ok) throw new Error("attach failed");
    const pending = budgetPending(thread);
    if (!pending) throw new Error("missing pending");

    const approved = await approveExtend(aliceMachine, pending.id);
    expect(approved).toMatchObject({ ok: true, emit_pending: true });
    const extension = aliceMachine.store.get(thread)?.extension;
    expect(extension?.status).toBe("emitting");
    expect(extension?.envelope_bytes).toBeDefined();
    const bytes = extension?.envelope_bytes;
    if (!bytes) throw new Error("missing envelope bytes");

    const retryDenied = await approveExtend(aliceMachine, pending.id);
    expect(retryDenied).toEqual({ ok: false, error: "pending_not_found" });

    failPropose = false;
    const retried = await aliceMachine.retryBudgetExtendEmit(thread);
    expect(retried).toEqual({ ok: true, thread });
    expect(aliceMachine.store.get(thread)?.extension?.status).toBe("awaiting_peer");
    expect(aliceMachine.store.get(thread)?.extension?.envelope_bytes).toBeUndefined();
    expect(decodeBase64UrlStrict(bytes).length).toBeGreaterThan(0);

    const retrySend = aliceSends.find((send) => send.type === "nego.budget_propose");
    expect(retrySend).toBeDefined();
    if (!retrySend) return;
    const durablePayload = new TextDecoder().decode(decodeBase64UrlStrict(bytes));
    expect(retrySend.payload).toBe(durablePayload);
    expect(retrySend.thread).toBe(thread);
    const parsed = JSON.parse(retrySend.payload) as {
      thread: string;
      proposal_id: string;
      new_max_turns: number;
    };
    expect(parsed).toEqual({
      thread,
      proposal_id: pending.proposal_id,
      new_max_turns: 30,
    });
  });

  it("enforces N4 when mandate omits budget_extend", async () => {
    const mandateWithoutBudget = {
      agent_may: ["propose", "counter", "accept_section", "challenge"],
      human_required: ["sign_final", "constraint_change"],
    };
    const thread = await openLiveWithMaxTurns(
      aliceMachine,
      bobMachine,
      bobPending,
      fixtures.bobId,
      20,
      { ...defaultOpenPayload, mandate: mandateWithoutBudget },
    );
    const attached = await extendAttach(thread, 30);
    expect(attached.ok).toBe(true);
    const pending = budgetPending(thread);
    if (!pending) throw new Error("missing pending");

    const withoutHuman = await approveExtend(aliceMachine, pending.id, false);
    expect(withoutHuman).toEqual({ ok: false, error: "human_required" });
    expect(budgetPending(thread)?.id).toBe(pending.id);

    const approved = await approveExtend(aliceMachine, pending.id);
    expect(approved.ok).toBe(true);
    expect(aliceMachine.store.get(thread)?.extension?.status).toBe("awaiting_peer");
  });

  it("guardTurnBudget suppresses numberless pending while extension outstanding", async () => {
    const thread = await liveThread(3);
    const attached = await extendAttach(thread, 30);
    if (!attached.ok) throw new Error("attach failed");
    const pending = budgetPending(thread);
    if (!pending) throw new Error("missing pending");
    await approveExtend(aliceMachine, pending.id);

    for (let i = 0; i < 3; i++) {
      await aliceMachine.handleMsg({ thread, type: "propose", body: "{}" });
    }
    const exhausted = await aliceMachine.handleMsg({ thread, type: "propose", body: "{}" });
    expect(exhausted).toEqual({ ok: false, error: "budget_exhausted" });
    expect(
      alicePending.list().filter((item) => item.kind === "budget_extend" && item.thread === thread),
    ).toHaveLength(0);
  });

  it("stale budget_reject after raise does not decrease max_turns", async () => {
    const thread = await liveThread(20);
    const attached = await extendAttach(thread, 30);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;

    const pending = budgetPending(thread);
    expect(pending).toBeDefined();
    if (!pending) return;

    const localApprove = await approveExtend(aliceMachine, pending.id);
    expect(localApprove.ok).toBe(true);

    const bobPendingItem = budgetPending(thread, bobPending);
    expect(bobPendingItem).toBeDefined();
    if (!bobPendingItem) return;

    const peerApprove = await approveExtend(bobMachine, bobPendingItem.id);
    expect(peerApprove.ok).toBe(true);
    expect(aliceMachine.store.get(thread)?.budget.max_turns).toBe(30);
    expect(bobMachine.store.get(thread)?.budget.max_turns).toBe(30);

    const staleReject = await aliceMachine.handleIncomingEnvelope({
      from: fixtures.bobId,
      type: "nego.budget_reject",
      thread,
      payload: JSON.stringify({
        thread,
        proposal_id: crypto.randomUUID(),
        new_max_turns: 20,
        reason: "stale",
      }),
    });
    expect(staleReject).toMatchObject({ ok: true, dropped: true });
    expect(aliceMachine.store.get(thread)?.budget.max_turns).toBe(30);
    expect(bobMachine.store.get(thread)?.budget.max_turns).toBe(30);
  });

  it("extend_budget while outstanding returns extension_outstanding", async () => {
    const thread = await liveThread(20);
    const first = await extendAttach(thread, 30);
    expect(first.ok).toBe(true);
    const pending = budgetPending(thread);
    if (!pending) throw new Error("missing pending");
    await approveExtend(aliceMachine, pending.id);
    expect(aliceMachine.store.get(thread)?.extension?.status).toBe("awaiting_peer");

    const second = await extendAttach(thread, 40);
    expect(second).toEqual({
      ok: false,
      error: "extension_outstanding",
      outstanding: { awaiting: "peer" },
    });
    expect(aliceMachine.store.get(thread)?.extension?.new_max_turns).toBe(30);
  });
});
