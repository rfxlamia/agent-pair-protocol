import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDualAgent,
  runPairingFlow,
  startDualRelay,
  type DualRelayEnv,
} from "../e2e/dual-server.js";
import { handleHumanApprove } from "./human-approve.js";
import { handleInbox, handleSend } from "./inbox.js";
import { handleSessionOpen, handleSessionStatus } from "./session.js";

function structured<T>(result: { structuredContent: T }): T {
  return result.structuredContent;
}

describe("inbox production path", () => {
  let env: DualRelayEnv;

  beforeAll(async () => {
    env = await startDualRelay(3022);
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it("handleInbox routes session.open envelopes into session state", async () => {
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
        budget: { max_turns: 10 },
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
    expect(
      inboxResult.envelopes.some((envelope) => envelope.type === "session.open"),
    ).toBe(true);

    const bobPendingAfter = bob.ctx.pending
      .list()
      .filter((item) => item.kind === "session_open");
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

  it("exposes pending_id from session.open so MCP clients can human_approve", async () => {
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
        budget: { max_turns: 10 },
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

    const sessionOpen = inboxResult.envelopes.find(
      (envelope) => envelope.type === "session.open",
    );
    expect(sessionOpen?.pending_id).toBeTypeOf("string");
    if (!sessionOpen?.pending_id) {
      return;
    }

    const statusBefore = structured(
      await handleSessionStatus(bob.ctx, { thread: opened.thread }),
    );
    expect(statusBefore.ok).toBe(true);
    if (!statusBefore.ok) {
      return;
    }
    expect(statusBefore.status).toBe("pending");
    expect(statusBefore.pending_id).toBe(sessionOpen.pending_id);

    const approved = structured(
      await handleHumanApprove(bob.ctx, {
        pending_id: sessionOpen.pending_id,
        decision: "approve",
        via_human: true,
      }),
    );
    expect(approved.ok).toBe(true);
    if (!approved.ok) {
      return;
    }
    expect(approved.status).toBe("live");

    const statusAfter = structured(
      await handleSessionStatus(bob.ctx, { thread: opened.thread }),
    );
    expect(statusAfter.ok).toBe(true);
    if (!statusAfter.ok) {
      return;
    }
    expect(statusAfter.status).toBe("live");
    expect(statusAfter.pending_id).toBeUndefined();
  });

  it("tracks bidirectional thread seq after explicit send and inbox pull", async () => {
    const alice = await createDualAgent(env, "seq-alice");
    const bob = await createDualAgent(env, "seq-bob");
    await runPairingFlow(alice, bob);
    const thread = crypto.randomUUID();

    const opened = structured(
      await handleSend(alice.ctx, {
        to: bob.agentId,
        type: "suggestion",
        payload: "Saran 1",
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
        type: "reply",
        payload: "Setuju",
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
        type: "reply",
        payload: "Makasih",
        thread,
      }),
    );
    expect(aliceAgreement.ok).toBe(true);
    if (!aliceAgreement.ok) {
      return;
    }
    expect(aliceAgreement.seq).toBe(3);

    const bobInbox2 = structured(await handleInbox(bob.ctx, { since: 0 }));
    expect(bobInbox2.ok).toBe(true);
    if (!bobInbox2.ok) {
      return;
    }
    expect(bobInbox2.envelopes.map((envelope) => envelope.seq).sort()).toEqual([
      1, 3,
    ]);
  });

  it("auto-assigns next seq after explicit send without resetting to 1", async () => {
    const alice = await createDualAgent(env, "seq2-alice");
    const bob = await createDualAgent(env, "seq2-bob");
    await runPairingFlow(alice, bob);
    const thread = crypto.randomUUID();

    structured(
      await handleSend(alice.ctx, {
        to: bob.agentId,
        type: "suggestion",
        payload: "Saran 1",
        thread,
        seq: 1,
      }),
    );

    structured(await handleInbox(bob.ctx, { since: 0 }));

    structured(
      await handleSend(bob.ctx, {
        to: alice.agentId,
        type: "reply",
        payload: "Setuju",
        thread,
        seq: 2,
      }),
    );

    const bobFollowUp = structured(
      await handleSend(bob.ctx, {
        to: alice.agentId,
        type: "suggestion",
        payload: "Saran dari bob",
        thread,
      }),
    );
    expect(bobFollowUp.ok).toBe(true);
    if (!bobFollowUp.ok) {
      return;
    }
    expect(bobFollowUp.seq).toBe(3);
  });

  it(
    "inbox succeeds after burst sends without client gap_warnings",
    async () => {
    const alice = await createDualAgent(env, "burst-alice");
    const bob = await createDualAgent(env, "burst-bob");
    await runPairingFlow(alice, bob);
    const thread = crypto.randomUUID();

    structured(
      await handleSend(alice.ctx, {
        to: bob.agentId,
        type: "suggestion",
        payload: "Saran 1",
        thread,
        seq: 1,
      }),
    );

    structured(await handleInbox(bob.ctx, { since: 0 }));

    structured(
      await handleSend(bob.ctx, {
        to: alice.agentId,
        type: "reply",
        payload: "Balas 1",
        thread,
        seq: 2,
      }),
    );
    structured(
      await handleSend(bob.ctx, {
        to: alice.agentId,
        type: "reply",
        payload: "Balas 2",
        thread,
        seq: 3,
      }),
    );

    structured(await handleInbox(alice.ctx, { since: 0 }));

    structured(
      await handleSend(alice.ctx, {
        to: bob.agentId,
        type: "suggestion",
        payload: "Saran 2",
        thread,
        seq: 4,
      }),
    );

    const bobInbox = structured(await handleInbox(bob.ctx, { since: 0 }));
    expect(bobInbox.ok).toBe(true);
    if (!bobInbox.ok) {
      return;
    }
    expect(bobInbox.gap_warnings).toBeUndefined();
    expect(bobInbox.envelopes.map((envelope) => envelope.seq).sort()).toEqual([
      1, 4,
    ]);
    },
    15_000,
  );
});
