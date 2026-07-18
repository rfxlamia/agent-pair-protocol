import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type DualRelayEnv,
  createDualAgent,
  runPairingFlow,
  startDualRelay,
} from "../e2e/dual-server.js";
import { readApprovalCodeForAgent } from "./approval-test-helpers.js";
import { handleHumanApprove } from "./human-approve.js";
import { handleInbox } from "./inbox.js";
import { createAgentContext } from "./pair.js";
import {
  handleSessionMsg,
  handleSessionOpen,
  handleSessionStatus,
  processSessionInboxEnvelope,
} from "./session.js";

function structured<T>(result: { structuredContent: T }): T {
  return result.structuredContent;
}

const TEST_DEADLINE = "2030-06-01T12:00:00.000Z";

describe("inbox session negotiation fixes", () => {
  let env: DualRelayEnv;

  beforeAll(async () => {
    env = await startDualRelay(13310);
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it("delivers propose body to peer via inbox and session_status", async () => {
    const alice = await createDualAgent(env, "relay-alice");
    const bob = await createDualAgent(env, "relay-bob");
    await runPairingFlow(alice, bob);

    const opened = structured(
      await handleSessionOpen(alice.ctx, {
        to: bob.agentId,
        goal: "Relay propose body probe",
        acceptance: [{ id: "A1", test: "executable", desc: "probe", runner: "vitest" }],
        budget: { max_turns: 10, deadline: TEST_DEADLINE },
        mandate: { agent_may: ["propose"], human_required: ["sign_final"] },
      }),
    );
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const bootstrap = structured(await handleInbox(bob.ctx, { since: 0 }));
    expect(bootstrap.ok).toBe(true);
    if (!bootstrap.ok) return;

    const pending = bob.ctx.pending.list().find((item) => item.kind === "session_open");
    expect(pending).toBeDefined();
    if (!pending) return;

    const approvalCode = readApprovalCodeForAgent(bob.ctx, pending.id);
    await handleHumanApprove(bob.ctx, {
      pending_id: pending.id,
      decision: "approve",
      approval_code: approvalCode,
    });

    structured(await handleInbox(alice.ctx, { since: 0 }));

    const proposalBody = JSON.stringify({ diff: "timestamp: ISO-8601" });
    await handleSessionMsg(alice.ctx, {
      thread: opened.thread,
      type: "propose",
      body: proposalBody,
    });

    const bobInbox = structured(await handleInbox(bob.ctx, { since: bootstrap.cursor ?? 0 }));
    expect(bobInbox.ok).toBe(true);
    if (!bobInbox.ok) return;

    const peerTurn = bobInbox.envelopes.find(
      (envelope) => envelope.type === "nego.turn" && envelope.thread === opened.thread,
    );
    expect(peerTurn).toBeDefined();
    if (!peerTurn) return;

    const payload = peerTurn.payload as {
      untrusted?: true;
      source?: string;
      data?: { msg_type?: string; body?: string };
    };
    expect(payload).toMatchObject({
      untrusted: true,
      source: "peer",
      data: { msg_type: "propose", body: proposalBody },
    });

    const status = structured(await handleSessionStatus(bob.ctx, { thread: opened.thread }));
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.turn_count).toBe(1);
    expect(status.peer_messages).toEqual([
      {
        from: "initiator",
        type: "propose",
        body: { untrusted: true, source: "peer", data: proposalBody },
        turn: 1,
      },
    ]);
  });

  it("retries peer_turn after session is hydrated when first processing failed", async () => {
    const alice = await createDualAgent(env, "retry-alice");
    const bob = await createDualAgent(env, "retry-bob");
    await runPairingFlow(alice, bob);

    const opened = structured(
      await handleSessionOpen(alice.ctx, {
        to: bob.agentId,
        goal: "Retry peer_turn probe",
        acceptance: [{ id: "A1", test: "executable", desc: "probe", runner: "vitest" }],
        budget: { max_turns: 10, deadline: TEST_DEADLINE },
        mandate: { agent_may: ["propose"], human_required: ["sign_final"] },
      }),
    );
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const bootstrap = structured(await handleInbox(bob.ctx, { since: 0 }));
    expect(bootstrap.ok).toBe(true);
    if (!bootstrap.ok) return;

    const pending = bob.ctx.pending.list().find((item) => item.kind === "session_open");
    expect(pending).toBeDefined();
    if (!pending) return;

    const approvalCode = readApprovalCodeForAgent(bob.ctx, pending.id);
    await handleHumanApprove(bob.ctx, {
      pending_id: pending.id,
      decision: "approve",
      approval_code: approvalCode,
    });

    structured(await handleInbox(alice.ctx, { since: 0 }));

    await handleSessionMsg(alice.ctx, {
      thread: opened.thread,
      type: "propose",
      body: JSON.stringify({ diff: "timestamp: ISO-8601" }),
    });

    const cursorAfterLive = bootstrap.cursor ?? 0;
    const restartedBob = createAgentContext({
      keyStore: bob.ctx.keyStore,
      relay: bob.ctx.relay,
      bonds: bob.ctx.bonds,
      allowlist: bob.ctx.allowlist,
      sessionStore: bob.ctx.sessionStore,
      inboxCursor: bob.ctx.inboxCursor,
    });

    structured(await handleInbox(restartedBob, { since: cursorAfterLive }));
    structured(await handleInbox(restartedBob, { since: 0 }));

    const status = structured(await handleSessionStatus(restartedBob, { thread: opened.thread }));
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.turn_count).toBe(1);
    expect(status.peer_messages?.length).toBe(1);
  });

  it("allows negotiation bodies that mention privateKey in content", async () => {
    const alice = await createDualAgent(env, "secret-alice");
    const bob = await createDualAgent(env, "secret-bob");
    await runPairingFlow(alice, bob);

    const opened = structured(
      await handleSessionOpen(alice.ctx, {
        to: bob.agentId,
        goal: "Secret scan probe",
        acceptance: [{ id: "A1", test: "executable", desc: "probe", runner: "vitest" }],
        budget: { max_turns: 10, deadline: TEST_DEADLINE },
        mandate: { agent_may: ["propose"], human_required: ["sign_final"] },
      }),
    );
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const bootstrap = structured(await handleInbox(bob.ctx, { since: 0 }));
    const pending = bob.ctx.pending.list().find((item) => item.kind === "session_open");
    expect(pending).toBeDefined();
    if (!pending) return;

    const approvalCode = readApprovalCodeForAgent(bob.ctx, pending.id);
    await handleHumanApprove(bob.ctx, {
      pending_id: pending.id,
      decision: "approve",
      approval_code: approvalCode,
    });
    structured(await handleInbox(alice.ctx, { since: 0 }));

    const proposalBody = JSON.stringify({
      diff: "const privateKey = env.PRIVATE_KEY",
    });
    await handleSessionMsg(alice.ctx, {
      thread: opened.thread,
      type: "propose",
      body: proposalBody,
    });

    const bobInbox = structured(await handleInbox(bob.ctx, { since: bootstrap.cursor ?? 0 }));
    expect(bobInbox.ok).toBe(true);
    if (!bobInbox.ok) return;

    const status = structured(await handleSessionStatus(bob.ctx, { thread: opened.thread }));
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.peer_messages?.[0]?.body).toEqual({
      untrusted: true,
      source: "peer",
      data: proposalBody,
    });
  });

  it("ignores peer-reported turn_count on first nego.turn (wire-derived count)", async () => {
    const alice = await createDualAgent(env, "legacy-alice");
    const bob = await createDualAgent(env, "legacy-bob");
    await runPairingFlow(alice, bob);

    const opened = structured(
      await handleSessionOpen(alice.ctx, {
        to: bob.agentId,
        goal: "Wire-derived turn count probe",
        acceptance: [{ id: "A1", test: "executable", desc: "probe", runner: "vitest" }],
        budget: { max_turns: 10, deadline: TEST_DEADLINE },
        mandate: { agent_may: ["propose"], human_required: ["sign_final"] },
      }),
    );
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    structured(await handleInbox(bob.ctx, { since: 0 }));
    const pending = bob.ctx.pending.list().find((item) => item.kind === "session_open");
    expect(pending).toBeDefined();
    if (!pending) return;

    const approvalCode = readApprovalCodeForAgent(bob.ctx, pending.id);
    await handleHumanApprove(bob.ctx, {
      pending_id: pending.id,
      decision: "approve",
      approval_code: approvalCode,
    });

    const legacyTurn = structured(
      await processSessionInboxEnvelope(bob.ctx, {
        from: alice.agentId,
        type: "nego.turn",
        thread: opened.thread,
        payload: JSON.stringify({
          thread: opened.thread,
          turn_count: 7,
        }),
      }),
    );
    expect(legacyTurn.ok).toBe(true);

    const status = structured(await handleSessionStatus(bob.ctx, { thread: opened.thread }));
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.turn_count).toBe(1);
    expect(status.peer_messages).toEqual([]);
  });
});
