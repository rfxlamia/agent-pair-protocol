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
    const result = await extendAttach(thread, 30);
    expect(result).toMatchObject({
      ok: true,
      thread,
      new_max_turns: 30,
    });
    const pending = budgetPending(thread);
    expect(pending?.new_max_turns).toBe(30);
    expect(pending?.proposal_id).toBeDefined();
    expect(pending?.proposed_by).toBe("initiator");
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

  it("rejects budget_propose when payload.thread mismatches body.thread", async () => {
    const thread = await liveThread(20);
    const proposalId = crypto.randomUUID();
    const result = await bobMachine.handleIncomingEnvelope({
      from: fixtures.aliceId,
      type: "nego.budget_propose",
      thread,
      payload: JSON.stringify({
        thread: "other-thread",
        proposal_id: proposalId,
        new_max_turns: 30,
      }),
    });
    expect(result).toEqual({ ok: false, error: "invalid_payload" });
    expect(budgetPending(thread, bobPending)).toBeUndefined();
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
    relink({ capture: { aliceSends } });

    const thread = await liveThread(20);
    const aliceProposal = crypto.randomUUID();
    const bobProposal = crypto.randomUUID();

    aliceMachine.store.upsert({
      ...requireSession(thread),
      extension: {
        proposal_id: aliceProposal,
        new_max_turns: 30,
        proposed_by: "initiator",
        status: "awaiting_peer",
      },
    });
    bobMachine.store.upsert({
      ...requireSession(thread, bobMachine),
      extension: {
        proposal_id: bobProposal,
        new_max_turns: 40,
        proposed_by: "recipient",
        status: "awaiting_peer",
      },
    });

    await bobMachine.handleIncomingEnvelope({
      from: fixtures.aliceId,
      type: "nego.budget_propose",
      thread,
      payload: JSON.stringify({
        thread,
        proposal_id: aliceProposal,
        new_max_turns: 30,
      }),
    });
    await aliceMachine.handleIncomingEnvelope({
      from: fixtures.bobId,
      type: "nego.budget_propose",
      thread,
      payload: JSON.stringify({
        thread,
        proposal_id: bobProposal,
        new_max_turns: 40,
      }),
    });

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
  });

  it("emit failure leaves *_emitting and retryBudgetExtendEmit resends identical bytes", async () => {
    let failPropose = true;
    relink({
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
