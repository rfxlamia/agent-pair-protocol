import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type DualRelayEnv,
  createDualAgent,
  runPairingFlow,
  startDualRelay,
  syncInboxes,
} from "../e2e/dual-server.js";
import { readApprovalCodeForAgent } from "./approval-test-helpers.js";
import { handleHumanApprove } from "./human-approve.js";
import { handleClose, handleInbox, handleSend } from "./inbox.js";
import {
  handleSessionMsg,
  handleSessionOpen,
  handleSessionSign,
  handleSessionStatus,
} from "./session.js";

function structured<T>(result: { structuredContent: T }): T {
  return result.structuredContent;
}

const TEST_DEADLINE = "2030-06-01T12:00:00.000Z";

const SESSION_OPEN_INPUT = {
  acceptance: [
    {
      id: "A1",
      test: "executable" as const,
      desc: "probe",
      runner: "payload-size",
    },
  ],
  budget: { max_turns: 10, deadline: TEST_DEADLINE },
  mandate: {
    agent_may: ["propose"],
    human_required: ["sign_final"],
  },
};

async function runSessionToSigned(
  alice: Awaited<ReturnType<typeof createDualAgent>>,
  bob: Awaited<ReturnType<typeof createDualAgent>>,
  goal: string,
  artifactHash = "sha256:ratify-pending-probe",
) {
  const opened = structured(
    await handleSessionOpen(alice.ctx, {
      to: bob.agentId,
      goal,
      ...SESSION_OPEN_INPUT,
    }),
  );
  expect(opened.ok).toBe(true);
  if (!opened.ok) {
    throw new Error("session_open failed");
  }

  await syncInboxes([alice.ctx, bob.ctx]);

  const bobStatus = structured(await handleSessionStatus(bob.ctx, { thread: opened.thread }));
  expect(bobStatus.pending_id).toBeTypeOf("string");
  if (!bobStatus.pending_id) {
    throw new Error("missing session_open pending_id");
  }

  const sessionApprovalCode = readApprovalCodeForAgent(bob.ctx, bobStatus.pending_id);
  const approved = structured(
    await handleHumanApprove(bob.ctx, {
      pending_id: bobStatus.pending_id,
      decision: "approve",
      approval_code: sessionApprovalCode,
    }),
  );
  expect(approved.ok).toBe(true);
  if (!approved.ok) {
    throw new Error("session_open approve failed");
  }

  await syncInboxes([alice.ctx, bob.ctx]);

  for (const agent of [alice, bob]) {
    await handleSessionMsg(agent.ctx, {
      thread: opened.thread,
      type: "challenge",
      body: JSON.stringify({ report: "pass" }),
    });
    await syncInboxes([alice.ctx, bob.ctx]);
  }

  for (const agent of [alice, bob]) {
    await handleSessionMsg(agent.ctx, {
      thread: opened.thread,
      type: "test_report",
      body: JSON.stringify({
        artifact_hash: artifactHash,
        passed: true,
        runner: "payload-size",
      }),
    });
    await syncInboxes([alice.ctx, bob.ctx]);
  }

  const aliceSign = structured(
    await handleSessionSign(alice.ctx, {
      thread: opened.thread,
      artifact_hash: artifactHash,
    }),
  );
  expect(aliceSign.ok).toBe(true);
  if (!aliceSign.ok) {
    throw new Error("alice sign failed");
  }

  await syncInboxes([alice.ctx, bob.ctx]);

  const bobSign = structured(
    await handleSessionSign(bob.ctx, {
      thread: opened.thread,
      artifact_hash: artifactHash,
    }),
  );
  expect(bobSign.ok).toBe(true);
  if (!bobSign.ok) {
    throw new Error("bob sign failed");
  }

  await syncInboxes([alice.ctx, bob.ctx]);

  return { thread: opened.thread, artifactHash };
}

describe("inbox production path", () => {
  let env: DualRelayEnv;

  beforeAll(async () => {
    env = await startDualRelay(13222);
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it("handleInbox routes nego.open envelopes into session state", async () => {
    const alice = await createDualAgent(env, "inbox-alice");
    const bob = await createDualAgent(env, "inbox-bob");
    await runPairingFlow(alice, bob);

    const opened = structured(
      await handleSessionOpen(alice.ctx, {
        to: bob.agentId,
        goal: "Inbox routing probe",
        acceptance: [
          {
            id: "A1",
            test: "executable",
            desc: "probe",
            runner: "payload-size",
          },
        ],
        budget: { max_turns: 10, deadline: TEST_DEADLINE },
        mandate: {
          agent_may: ["propose"],
          human_required: ["sign_final"],
        },
      }),
    );
    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      return;
    }

    const bobStatusBefore = structured(
      await handleSessionStatus(bob.ctx, { thread: opened.thread }),
    );
    expect(bobStatusBefore.ok).toBe(false);
    if (bobStatusBefore.ok) {
      return;
    }
    expect(bobStatusBefore.error).toBe("session_not_found");

    const inboxResult = structured(await handleInbox(bob.ctx, { since: 0 }));
    expect(inboxResult.ok).toBe(true);
    if (!inboxResult.ok) {
      return;
    }
    expect(inboxResult.envelopes.some((envelope) => envelope.type === "nego.open")).toBe(true);

    const bobPendingAfter = bob.ctx.pending.list().filter((item) => item.kind === "session_open");
    expect(bobPendingAfter).toHaveLength(1);

    const bobStatusAfter = structured(
      await handleSessionStatus(bob.ctx, { thread: opened.thread }),
    );
    expect(bobStatusAfter.ok).toBe(true);
    if (!bobStatusAfter.ok) {
      return;
    }
    expect(bobStatusAfter.status).toBe("pending");
  });

  it("exposes pending_id from nego.open so MCP clients can human_approve", async () => {
    const alice = await createDualAgent(env, "pending-id-alice");
    const bob = await createDualAgent(env, "pending-id-bob");
    await runPairingFlow(alice, bob);

    const opened = structured(
      await handleSessionOpen(alice.ctx, {
        to: bob.agentId,
        goal: "Pending id exposure probe",
        acceptance: [
          {
            id: "A1",
            test: "executable",
            desc: "probe",
            runner: "payload-size",
          },
        ],
        budget: { max_turns: 10, deadline: TEST_DEADLINE },
        mandate: {
          agent_may: ["propose"],
          human_required: ["sign_final"],
        },
      }),
    );
    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      return;
    }

    const inboxResult = structured(await handleInbox(bob.ctx, { since: 0 }));
    expect(inboxResult.ok).toBe(true);
    if (!inboxResult.ok) {
      return;
    }

    const sessionOpen = inboxResult.envelopes.find((envelope) => envelope.type === "nego.open");
    expect(sessionOpen?.pending_id).toBeTypeOf("string");
    if (!sessionOpen?.pending_id) {
      return;
    }

    const statusBefore = structured(await handleSessionStatus(bob.ctx, { thread: opened.thread }));
    expect(statusBefore.ok).toBe(true);
    if (!statusBefore.ok) {
      return;
    }
    expect(statusBefore.status).toBe("pending");
    expect(statusBefore.pending_id).toBe(sessionOpen.pending_id);

    const sessionApprovalCode = readApprovalCodeForAgent(bob.ctx, sessionOpen.pending_id);
    const approved = structured(
      await handleHumanApprove(bob.ctx, {
        pending_id: sessionOpen.pending_id,
        decision: "approve",
        approval_code: sessionApprovalCode,
      }),
    );
    expect(approved.ok).toBe(true);
    if (!approved.ok) {
      return;
    }
    expect(approved.status).toBe("live");

    const statusAfter = structured(await handleSessionStatus(bob.ctx, { thread: opened.thread }));
    expect(statusAfter.ok).toBe(true);
    if (!statusAfter.ok) {
      return;
    }
    expect(statusAfter.status).toBe("live");
    expect(statusAfter.pending_id).toBeUndefined();
  });

  it("recovers pending_id when session_open pending queue entry was lost", async () => {
    const alice = await createDualAgent(env, "orphan-alice");
    const bob = await createDualAgent(env, "orphan-bob");
    await runPairingFlow(alice, bob);

    const opened = structured(
      await handleSessionOpen(alice.ctx, {
        to: bob.agentId,
        goal: "Orphan pending recovery probe",
        acceptance: [
          {
            id: "A1",
            test: "executable",
            desc: "probe",
            runner: "payload-size",
          },
        ],
        budget: { max_turns: 10, deadline: TEST_DEADLINE },
        mandate: {
          agent_may: ["propose"],
          human_required: ["sign_final"],
        },
      }),
    );
    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      return;
    }

    const inboxResult = structured(await handleInbox(bob.ctx, { since: 0 }));
    expect(inboxResult.ok).toBe(true);
    if (!inboxResult.ok) {
      return;
    }

    const sessionOpen = inboxResult.envelopes.find((envelope) => envelope.type === "nego.open");
    expect(sessionOpen?.pending_id).toBeTypeOf("string");
    if (!sessionOpen?.pending_id) {
      return;
    }

    bob.ctx.pending.remove(sessionOpen.pending_id);

    const statusBefore = structured(await handleSessionStatus(bob.ctx, { thread: opened.thread }));
    expect(statusBefore.ok).toBe(true);
    if (!statusBefore.ok) {
      return;
    }
    expect(statusBefore.status).toBe("pending");
    expect(statusBefore.pending_id).toBeTypeOf("string");
    expect(statusBefore.pending_id).not.toBe(sessionOpen.pending_id);

    const statusAfter = structured(await handleSessionStatus(bob.ctx, { thread: opened.thread }));
    expect(statusAfter.ok).toBe(true);
    if (!statusAfter.ok) {
      return;
    }
    expect(statusAfter.pending_id).toBe(statusBefore.pending_id);
  });

  it("exposes pending_id from session_status when signed so MCP clients can ratify", async () => {
    const alice = await createDualAgent(env, "ratify-pending-alice");
    const bob = await createDualAgent(env, "ratify-pending-bob");
    await runPairingFlow(alice, bob);

    const { thread } = await runSessionToSigned(alice, bob, "Ratify pending id exposure probe");

    const aliceStatus = structured(await handleSessionStatus(alice.ctx, { thread }));
    expect(aliceStatus.ok).toBe(true);
    if (!aliceStatus.ok) {
      return;
    }
    expect(aliceStatus.status).toBe("signed");
    expect(aliceStatus.pending_id).toBeTypeOf("string");
    expect(aliceStatus.pending_kind).toBe("ratify");
    if (!aliceStatus.pending_id) {
      return;
    }

    const ratifyApprovalCode = readApprovalCodeForAgent(alice.ctx, aliceStatus.pending_id);
    const approved = structured(
      await handleHumanApprove(alice.ctx, {
        pending_id: aliceStatus.pending_id,
        decision: "approve",
        approval_code: ratifyApprovalCode,
      }),
    );
    expect(approved.ok).toBe(true);
    if (!approved.ok) {
      return;
    }
    expect(approved.status).toBe("awaiting_peer_ratify");

    const statusAfter = structured(await handleSessionStatus(alice.ctx, { thread }));
    expect(statusAfter.ok).toBe(true);
    if (!statusAfter.ok) {
      return;
    }
    expect(statusAfter.pending_id).toBeUndefined();
    expect(statusAfter.ratify_approved?.initiator).toBe(true);
  });

  it("recovers ratify pending_id when pending queue entry was lost", async () => {
    const alice = await createDualAgent(env, "ratify-orphan-alice");
    const bob = await createDualAgent(env, "ratify-orphan-bob");
    await runPairingFlow(alice, bob);

    const { thread } = await runSessionToSigned(alice, bob, "Ratify orphan pending recovery probe");

    const statusBefore = structured(await handleSessionStatus(alice.ctx, { thread }));
    expect(statusBefore.pending_id).toBeTypeOf("string");
    if (!statusBefore.pending_id) {
      return;
    }

    alice.ctx.pending.remove(statusBefore.pending_id);

    const statusAfter = structured(await handleSessionStatus(alice.ctx, { thread }));
    expect(statusAfter.ok).toBe(true);
    if (!statusAfter.ok) {
      return;
    }
    expect(statusAfter.status).toBe("signed");
    expect(statusAfter.pending_id).toBeTypeOf("string");
    expect(statusAfter.pending_kind).toBe("ratify");
    expect(statusAfter.pending_id).not.toBe(statusBefore.pending_id);
  });

  it("exposes pending_id from nego.signed inbox envelopes", async () => {
    const alice = await createDualAgent(env, "ratify-inbox-alice");
    const bob = await createDualAgent(env, "ratify-inbox-bob");
    await runPairingFlow(alice, bob);

    const { thread } = await runSessionToSigned(
      alice,
      bob,
      "Ratify inbox pending id probe",
      "sha256:ratify-inbox-probe",
    );

    const inboxResult = structured(await handleInbox(alice.ctx, { since: 0 }));
    expect(inboxResult.ok).toBe(true);
    if (!inboxResult.ok) {
      return;
    }

    const peerSigned = inboxResult.envelopes.find((envelope) => envelope.type === "nego.signed");
    expect(peerSigned?.pending_id).toBeTypeOf("string");

    const aliceStatus = structured(await handleSessionStatus(alice.ctx, { thread }));
    expect(aliceStatus.pending_id).toBe(peerSigned?.pending_id);
    expect(aliceStatus.pending_kind).toBe("ratify");
  });

  it("includes session_status on nego.open envelopes", async () => {
    const alice = await createDualAgent(env, "status-alice");
    const bob = await createDualAgent(env, "status-bob");
    await runPairingFlow(alice, bob);

    const opened = structured(
      await handleSessionOpen(alice.ctx, {
        to: bob.agentId,
        goal: "Session status on inbox probe",
        acceptance: [
          {
            id: "A1",
            test: "executable",
            desc: "probe",
            runner: "payload-size",
          },
        ],
        budget: { max_turns: 10, deadline: TEST_DEADLINE },
        mandate: {
          agent_may: ["propose"],
          human_required: ["sign_final"],
        },
      }),
    );
    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      return;
    }

    const inboxResult = structured(await handleInbox(bob.ctx, { since: 0 }));
    expect(inboxResult.ok).toBe(true);
    if (!inboxResult.ok) {
      return;
    }

    const sessionOpen = inboxResult.envelopes.find((envelope) => envelope.type === "nego.open");
    expect(sessionOpen?.session_status).toBe("pending");
  });

  it("tracks bidirectional thread seq after explicit send and inbox pull", async () => {
    const alice = await createDualAgent(env, "seq-alice");
    const bob = await createDualAgent(env, "seq-bob");
    await runPairingFlow(alice, bob);
    const thread = crypto.randomUUID();

    const opened = structured(
      await handleSend(alice.ctx, {
        to: bob.agentId,
        body: "Saran 1",
        thread,
        seq: 1,
      }),
    );
    expect(opened.ok).toBe(true);

    const bobInbox1 = structured(await handleInbox(bob.ctx, { since: 0 }));
    expect(bobInbox1.ok).toBe(true);
    if (!bobInbox1.ok) {
      return;
    }
    expect(bobInbox1.envelopes).toHaveLength(1);

    const bobReply = structured(
      await handleSend(bob.ctx, {
        to: alice.agentId,
        body: "Setuju",
        thread,
        seq: 2,
      }),
    );
    expect(bobReply.ok).toBe(true);

    const aliceInbox = structured(await handleInbox(alice.ctx, { since: 0 }));
    expect(aliceInbox.ok).toBe(true);

    const aliceAgreement = structured(
      await handleSend(alice.ctx, {
        to: bob.agentId,
        body: "Makasih",
        thread,
      }),
    );
    expect(aliceAgreement.ok).toBe(true);
    if (!aliceAgreement.ok) {
      return;
    }
    expect(aliceAgreement.seq).toBe(2);

    const bobInbox2 = structured(await handleInbox(bob.ctx, {}));
    expect(bobInbox2.ok).toBe(true);
    if (!bobInbox2.ok) {
      return;
    }
    expect(bobInbox2.envelopes.map((envelope) => envelope.seq)).toEqual([2]);
  });

  it("auto-assigns next seq after explicit send without resetting to 1", async () => {
    const alice = await createDualAgent(env, "seq2-alice");
    const bob = await createDualAgent(env, "seq2-bob");
    await runPairingFlow(alice, bob);
    const thread = crypto.randomUUID();

    structured(
      await handleSend(alice.ctx, {
        to: bob.agentId,
        body: "Saran 1",
        thread,
        seq: 1,
      }),
    );

    structured(await handleInbox(bob.ctx, { since: 0 }));

    structured(
      await handleSend(bob.ctx, {
        to: alice.agentId,
        body: "Setuju",
        thread,
        seq: 2,
      }),
    );

    const bobFollowUp = structured(
      await handleSend(bob.ctx, {
        to: alice.agentId,
        body: "Saran dari bob",
        thread,
      }),
    );
    expect(bobFollowUp.ok).toBe(true);
    if (!bobFollowUp.ok) {
      return;
    }
    expect(bobFollowUp.seq).toBe(3);
  });

  it("inbox succeeds after burst sends without client gap_warnings", async () => {
    const alice = await createDualAgent(env, "burst-alice");
    const bob = await createDualAgent(env, "burst-bob");
    await runPairingFlow(alice, bob);
    const thread = crypto.randomUUID();

    structured(
      await handleSend(alice.ctx, {
        to: bob.agentId,
        body: "Saran 1",
        thread,
        seq: 1,
      }),
    );

    structured(await handleInbox(bob.ctx, { since: 0 }));

    structured(
      await handleSend(bob.ctx, {
        to: alice.agentId,
        body: "Balas 1",
        thread,
        seq: 2,
      }),
    );
    structured(
      await handleSend(bob.ctx, {
        to: alice.agentId,
        body: "Balas 2",
        thread,
        seq: 3,
      }),
    );

    structured(await handleInbox(alice.ctx, { since: 0 }));

    structured(
      await handleSend(alice.ctx, {
        to: bob.agentId,
        body: "Saran 2",
        thread,
        seq: 4,
      }),
    );

    const bobInbox = structured(await handleInbox(bob.ctx, {}));
    expect(bobInbox.ok).toBe(true);
    if (!bobInbox.ok) {
      return;
    }
    expect(bobInbox.gap_warnings).toBeUndefined();
    expect(bobInbox.envelopes.map((envelope) => envelope.seq)).toEqual([4]);
  }, 15_000);

  it("handleClose on live nego thread uses seq after session traffic and peer accepts", async () => {
    const alice = await createDualAgent(env, "close-nego-alice");
    const bob = await createDualAgent(env, "close-nego-bob");
    await runPairingFlow(alice, bob);

    const opened = structured(
      await handleSessionOpen(alice.ctx, {
        to: bob.agentId,
        goal: "Close after nego traffic",
        ...SESSION_OPEN_INPUT,
      }),
    );
    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      return;
    }

    await syncInboxes([alice.ctx, bob.ctx]);

    const bobStatus = structured(await handleSessionStatus(bob.ctx, { thread: opened.thread }));
    expect(bobStatus.pending_id).toBeTypeOf("string");
    if (!bobStatus.pending_id) {
      return;
    }

    const closeApprovalCode = readApprovalCodeForAgent(bob.ctx, bobStatus.pending_id);
    structured(
      await handleHumanApprove(bob.ctx, {
        pending_id: bobStatus.pending_id,
        decision: "approve",
        approval_code: closeApprovalCode,
      }),
    );
    await syncInboxes([alice.ctx, bob.ctx]);

    await handleSessionMsg(alice.ctx, {
      thread: opened.thread,
      type: "propose",
      body: JSON.stringify({ diff: "v1" }),
    });
    await syncInboxes([alice.ctx, bob.ctx]);

    const closed = structured(
      await handleClose(alice.ctx, {
        thread: opened.thread,
        to: bob.agentId,
        reason: "done",
      }),
    );
    expect(closed.ok).toBe(true);
    if (!closed.ok) {
      return;
    }
    expect(closed.seq).toBeGreaterThan(1);

    const bobInbox = structured(await handleInbox(bob.ctx, {}));
    expect(bobInbox.ok).toBe(true);
    if (!bobInbox.ok) {
      return;
    }
    expect(bobInbox.rejected?.some((entry) => entry.error === "stale_seq") ?? false).toBe(false);
    expect(bob.ctx.closedThreads.isClosed(opened.thread)).toBe(true);

    const bobStatusAfter = structured(
      await handleSessionStatus(bob.ctx, { thread: opened.thread }),
    );
    expect(bobStatusAfter.status).toBe("closed");
  }, 15_000);
});
