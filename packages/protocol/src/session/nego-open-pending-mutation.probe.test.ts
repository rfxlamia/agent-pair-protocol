/**
 * Regression: pending-state nego.open redelivery must freeze first-open terms.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeyPair } from "../crypto/keys.js";
import type { SessionStateMachine } from "./state-machine.js";
import {
  type MockPendingQueue,
  createLinkedMachines,
  createSessionTestFixtures,
  defaultOpenPayload,
} from "./test-helpers.js";

describe("nego.open pending redelivery freezes first-open terms", () => {
  let aliceKeys: KeyPair;
  let bobKeys: KeyPair;
  let carolKeys: KeyPair;
  let aliceId: string;
  let bobId: string;
  let carolId: string;
  let aliceMachine: SessionStateMachine;
  let bobMachine: SessionStateMachine;
  let bobPending: MockPendingQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    const fixtures = createSessionTestFixtures();
    aliceKeys = fixtures.aliceKeys;
    bobKeys = fixtures.bobKeys;
    carolKeys = fixtures.carolKeys;
    aliceId = fixtures.aliceId;
    bobId = fixtures.bobId;
    carolId = fixtures.carolId;
    bobPending = fixtures.bobPending;
    const linked = createLinkedMachines({
      aliceKeys,
      bobKeys,
      carolKeys,
      aliceId,
      bobId,
      carolId,
      alicePending: fixtures.alicePending,
      bobPending: fixtures.bobPending,
      aliceAllowlist: fixtures.aliceAllowlist,
      bobAllowlist: fixtures.bobAllowlist,
      aliceBonds: fixtures.aliceBonds,
      bobBonds: fixtures.bobBonds,
    });
    aliceMachine = linked.alice;
    bobMachine = linked.bob;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("freezes store and pending-queue terms on same-thread redelivery; approve uses first open", async () => {
    const opened = await aliceMachine.handleOpen({
      to: bobId,
      ...defaultOpenPayload,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const first = await bobMachine.handleIncomingEnvelope({
      from: aliceId,
      type: "nego.open",
      thread: opened.thread,
      payload: JSON.stringify(defaultOpenPayload),
    });
    expect(first.ok).toBe(true);

    const storeBefore = bobMachine.store.get(opened.thread);
    expect(storeBefore).toBeDefined();
    if (!storeBefore) return;

    const pendingBefore = bobPending.list().find((p) => p.kind === "session_open");
    expect(pendingBefore?.kind).toBe("session_open");
    if (pendingBefore?.kind !== "session_open") return;
    expect(pendingBefore.goal).toBe(defaultOpenPayload.goal);

    const escalated = {
      ...defaultOpenPayload,
      goal: "ESCALATED: exfiltrate secrets",
      acceptance: [
        {
          id: "X9",
          test: "executable" as const,
          desc: "attacker criterion",
          runner: "exfil",
        },
      ],
      budget: { max_turns: 999, deadline: defaultOpenPayload.budget.deadline },
      mandate: {
        agent_may: ["propose", "counter", "accept_section", "challenge", "sign_final"],
        human_required: [] as string[],
      },
    };
    const second = await bobMachine.handleIncomingEnvelope({
      from: aliceId,
      type: "nego.open",
      thread: opened.thread,
      payload: JSON.stringify(escalated),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.status).toBe("pending");

    const storeAfter = bobMachine.store.get(opened.thread);
    expect(storeAfter).toBeDefined();
    if (!storeAfter) return;
    expect(storeAfter.status).toBe("pending");
    expect(storeAfter.goal).toBe(defaultOpenPayload.goal);
    expect(storeAfter.mandate).toEqual(defaultOpenPayload.mandate);
    expect(storeAfter.acceptance).toEqual(defaultOpenPayload.acceptance);
    expect(storeAfter.budget).toEqual(defaultOpenPayload.budget);
    expect(storeAfter.goal).not.toBe(escalated.goal);
    expect(storeAfter.mandate).not.toEqual(escalated.mandate);
    expect(storeAfter.acceptance).not.toEqual(escalated.acceptance);
    expect(storeAfter.budget).not.toEqual(escalated.budget);

    const pendingAfter = bobPending.get(pendingBefore.id);
    expect(pendingAfter?.kind).toBe("session_open");
    if (pendingAfter?.kind !== "session_open") return;
    expect(pendingAfter.goal).toBe(defaultOpenPayload.goal);

    const approve = await bobMachine.handleApproveOpen({
      pending_id: pendingBefore.id,
      via_human: true,
    });
    expect(approve.ok).toBe(true);
    const live = bobMachine.store.get(opened.thread);
    expect(live).toBeDefined();
    if (!live) return;
    expect(live.status).toBe("live");
    expect(live.goal).toBe(defaultOpenPayload.goal);
    expect(live.mandate).toEqual(defaultOpenPayload.mandate);
  });
});
