import {
  createOuterEnvelope,
  defaultEnvelopeTtl,
  generateKeyPair,
  serializeOuterEnvelope,
} from "@agentpair/protocol";
/**
 * M3.3 adversarial e2e suite (issue #37).
 * Six ROADMAP defenses + nego.open redelivery matrix via handleInbox / relay POST
 * (not syncInboxes — that bypasses §4.3).
 *
 * Session statuses covered here: pending, live, signed, closed, open_rejected.
 * open_expired redelivery is credited to protocol unit tests (see conformance checklist).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readApprovalCodeForAgent } from "../tools/approval-test-helpers.js";
import { handleHumanApprove } from "../tools/human-approve.js";
import { handleClose, handleInbox } from "../tools/inbox.js";
import { handlePairInit, handlePairJoin } from "../tools/pair.js";
import {
  handleSessionMsg,
  handleSessionOpen,
  handleSessionSign,
  handleSessionStatus,
} from "../tools/session.js";
import {
  type DualAgent,
  type DualRelayEnv,
  createDualAgent,
  runPairingFlow,
  startDualRelay,
} from "./dual-server.js";

function structured<T>(result: { structuredContent: T }): T {
  return result.structuredContent;
}

const OPEN_PAYLOAD = {
  goal: "benign adversarial goal",
  acceptance: [
    {
      id: "A1",
      test: "executable" as const,
      desc: "adversarial",
      runner: "payload-size",
    },
  ],
  budget: { max_turns: 10, deadline: new Date(Date.now() + 86_400_000).toISOString() },
  mandate: {
    agent_may: ["propose"],
    human_required: ["sign_final"],
  },
};

const HIJACK_GOAL = "HIJACKED after state settled";

function unwrapGoal(goal: unknown): unknown {
  if (typeof goal === "string") {
    return goal;
  }
  if (
    goal &&
    typeof goal === "object" &&
    "data" in goal &&
    typeof (goal as { data: unknown }).data === "string"
  ) {
    return (goal as { data: string }).data;
  }
  return goal;
}

async function redeliverNegoOpen(
  sender: DualAgent,
  recipient: DualAgent,
  thread: string,
  payload: typeof OPEN_PAYLOAD & { goal?: string },
): Promise<{ seq: number }> {
  await recipient.ctx.envelopeSeq.init(recipient.agentId);
  const lastAccepted = recipient.ctx.envelopeSeq.getLastAccepted(thread, sender.agentId);
  const seq = lastAccepted + 1;

  const senderKeys = await sender.ctx.keyStore.loadOrCreate();
  const envelope = createOuterEnvelope({
    sender: senderKeys,
    recipientAgentId: recipient.agentId,
    type: "nego.open",
    thread,
    seq,
    ttl: defaultEnvelopeTtl(),
    payload: new TextEncoder().encode(JSON.stringify(payload)),
  });
  await sender.ctx.relay.sendEnvelope(recipient.agentId, envelope);
  const after = structured(await handleInbox(recipient.ctx, {}));
  expect(after.ok).toBe(true);
  // Confirm the redelivery reached session dispatch (not dropped at seq/transport).
  expect(
    after.envelopes.some(
      (envelope: { type?: string; seq?: number }) =>
        envelope.type === "nego.open" && envelope.seq === seq,
    ),
  ).toBe(true);
  return { seq };
}

async function openSessionToPending(
  alice: DualAgent,
  bob: DualAgent,
): Promise<{ thread: string; pendingId: string }> {
  const opened = structured(
    await handleSessionOpen(alice.ctx, {
      to: bob.agentId,
      ...OPEN_PAYLOAD,
    }),
  );
  expect(opened.ok).toBe(true);
  if (!opened.ok) {
    throw new Error("session_open failed");
  }
  const thread = opened.thread as string;

  const bootstrap = structured(await handleInbox(bob.ctx, { since: 0 }));
  expect(bootstrap.ok).toBe(true);

  const pending = bob.ctx.pending.list().find((p) => p.kind === "session_open");
  expect(pending).toBeDefined();
  if (!pending) {
    throw new Error("missing session_open pending");
  }
  return { thread, pendingId: pending.id };
}

async function openSessionToLive(alice: DualAgent, bob: DualAgent): Promise<{ thread: string }> {
  const { thread, pendingId } = await openSessionToPending(alice, bob);
  const code = readApprovalCodeForAgent(bob.ctx, pendingId);
  const approved = structured(
    await handleHumanApprove(bob.ctx, {
      pending_id: pendingId,
      decision: "approve",
      approval_code: code,
    }),
  );
  expect(approved.ok).toBe(true);
  await handleInbox(alice.ctx, {});

  const liveStatus = structured(await handleSessionStatus(bob.ctx, { thread }));
  expect(liveStatus.ok).toBe(true);
  if (!liveStatus.ok) {
    throw new Error("live status failed");
  }
  expect(liveStatus.status).toBe("live");
  return { thread };
}

/** Light path: msg + synthetic test_report + dual sign (no atest). Uses handleInbox only. */
async function openSessionToSigned(alice: DualAgent, bob: DualAgent): Promise<{ thread: string }> {
  const { thread } = await openSessionToLive(alice, bob);
  const artifactHash = "sha256:m33-adversarial-signed";

  for (const agent of [alice, bob]) {
    await handleSessionMsg(agent.ctx, {
      thread,
      type: "challenge",
      body: JSON.stringify({ report: "pass" }),
    });
    const peer = agent === alice ? bob : alice;
    await handleInbox(peer.ctx, {});
  }

  for (const agent of [alice, bob]) {
    await handleSessionMsg(agent.ctx, {
      thread,
      type: "test_report",
      body: JSON.stringify({
        artifact_hash: artifactHash,
        passed: true,
        runner: "payload-size",
      }),
    });
    const peer = agent === alice ? bob : alice;
    await handleInbox(peer.ctx, {});
  }

  const aliceSign = structured(
    await handleSessionSign(alice.ctx, { thread, artifact_hash: artifactHash }),
  );
  expect(aliceSign.ok).toBe(true);
  await handleInbox(bob.ctx, {});

  const bobSign = structured(
    await handleSessionSign(bob.ctx, { thread, artifact_hash: artifactHash }),
  );
  expect(bobSign.ok).toBe(true);
  await handleInbox(alice.ctx, {});

  const status = structured(await handleSessionStatus(bob.ctx, { thread }));
  expect(status.ok).toBe(true);
  if (!status.ok) {
    throw new Error("signed status failed");
  }
  expect(status.status).toBe("signed");
  return { thread };
}

async function assertStatusAndGoal(
  bob: DualAgent,
  thread: string,
  expectedStatus: string,
  expectedGoal: string,
): Promise<void> {
  const status = structured(await handleSessionStatus(bob.ctx, { thread }));
  expect(status.ok).toBe(true);
  if (!status.ok) {
    return;
  }
  expect(status.status).toBe(expectedStatus);
  expect(unwrapGoal(status.goal)).toBe(expectedGoal);
}

describe("M3.3 adversarial e2e (#37)", () => {
  let env: DualRelayEnv;

  beforeAll(async () => {
    env = await startDualRelay(13230);
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it("1: tampered outer.to → relay routing_mismatch (400)", async () => {
    const alice = await createDualAgent(env, "tamper-a");
    const bob = await createDualAgent(env, "tamper-b");
    await runPairingFlow(alice, bob);

    const aliceKeys = await alice.ctx.keyStore.loadOrCreate();
    const outer = createOuterEnvelope({
      sender: aliceKeys,
      recipientAgentId: bob.agentId,
      type: "core.msg",
      thread: crypto.randomUUID(),
      seq: 1,
      ttl: defaultEnvelopeTtl(),
      payload: new TextEncoder().encode(JSON.stringify({ body: "x" })),
    });
    const wire = JSON.parse(serializeOuterEnvelope(outer)) as Record<string, unknown>;
    wire.to = "ed25519:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    const res = await fetch(`${env.relayUrl}/inbox/${encodeURIComponent(bob.agentId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(wire),
    });
    const body = (await res.json()) as { error?: string };
    expect(res.status).toBe(400);
    expect(body.error).toBe("routing_mismatch");
  }, 30000);

  it("2: replayed seq → host stale_seq via handleInbox", async () => {
    const alice = await createDualAgent(env, "replay-a");
    const bob = await createDualAgent(env, "replay-b");
    await runPairingFlow(alice, bob);

    const aliceKeys = await alice.ctx.keyStore.loadOrCreate();
    const thread = crypto.randomUUID();
    const ttl = defaultEnvelopeTtl();
    const first = createOuterEnvelope({
      sender: aliceKeys,
      recipientAgentId: bob.agentId,
      type: "core.msg",
      thread,
      seq: 1,
      ttl,
      payload: new TextEncoder().encode(JSON.stringify({ body: "first" })),
    });
    const replay = createOuterEnvelope({
      sender: aliceKeys,
      recipientAgentId: bob.agentId,
      type: "core.msg",
      thread,
      seq: 1,
      ttl,
      id: crypto.randomUUID(),
      payload: new TextEncoder().encode(JSON.stringify({ body: "replay" })),
    });

    await alice.ctx.relay.sendEnvelope(bob.agentId, first);
    const okInbox = structured(await handleInbox(bob.ctx, { since: 0 }));
    expect(okInbox.ok).toBe(true);
    if (!okInbox.ok) return;
    expect(okInbox.envelopes.some((e) => e.type === "core.msg")).toBe(true);

    await alice.ctx.relay.sendEnvelope(bob.agentId, replay);
    const replayInbox = structured(await handleInbox(bob.ctx, {}));
    expect(replayInbox.ok).toBe(true);
    if (!replayInbox.ok) return;
    expect(replayInbox.rejected?.some((r) => r.error === "stale_seq")).toBe(true);
  }, 30000);

  it("3: oversized wire → relay envelope_too_large (413)", async () => {
    const bob = await createDualAgent(env, "oversize-b");
    const huge = "x".repeat(70_000);
    const res = await fetch(`${env.relayUrl}/inbox/${encodeURIComponent(bob.agentId)}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: huge,
    });
    const body = (await res.json()) as { error?: string };
    expect(res.status).toBe(413);
    expect(body.error).toBe("envelope_too_large");
  }, 15000);

  it("4: unbonded sender → relay recipient_not_allowed (403)", async () => {
    const bob = await createDualAgent(env, "unbond-b");
    const stranger = generateKeyPair();
    const outer = createOuterEnvelope({
      sender: stranger,
      recipientAgentId: bob.agentId,
      type: "core.msg",
      thread: crypto.randomUUID(),
      seq: 1,
      ttl: defaultEnvelopeTtl(),
      payload: new TextEncoder().encode(JSON.stringify({ body: "nope" })),
    });

    const res = await fetch(`${env.relayUrl}/inbox/${encodeURIComponent(bob.agentId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: serializeOuterEnvelope(outer),
    });
    const body = (await res.json()) as { error?: string };
    expect(res.status).toBe(403);
    expect(body.error).toBe("recipient_not_allowed");
  }, 15000);

  // Missing/empty approval_code is treated as self-approval (A4 / human-approve normalize path).
  it("5: self-approval without approval_code → self_approval_forbidden", async () => {
    const alice = await createDualAgent(env, "self-a");
    const bob = await createDualAgent(env, "self-b");
    const init = structured(
      await handlePairInit(alice.ctx, {
        scope: ["session.negotiate"],
        mode: "ephemeral_until_session_closes",
      }),
    );
    expect(init.ok).toBe(true);
    if (!init.ok) return;

    const join = structured(await handlePairJoin(bob.ctx, { code: init.code }));
    expect(join.ok).toBe(true);
    if (!join.ok) return;

    const denied = structured(
      await handleHumanApprove(bob.ctx, {
        pending_id: join.pending_id,
        decision: "approve",
      }),
    );
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error).toBe("self_approval_forbidden");
  }, 30000);

  describe("6: redelivered nego.open — no harmful side effects", () => {
    it("pending: status + first-open terms frozen", async () => {
      const alice = await createDualAgent(env, "redo-pend-a");
      const bob = await createDualAgent(env, "redo-pend-b");
      await runPairingFlow(alice, bob);

      const { thread } = await openSessionToPending(alice, bob);
      await assertStatusAndGoal(bob, thread, "pending", OPEN_PAYLOAD.goal);

      await redeliverNegoOpen(alice, bob, thread, {
        ...OPEN_PAYLOAD,
        goal: HIJACK_GOAL,
      });
      await assertStatusAndGoal(bob, thread, "pending", OPEN_PAYLOAD.goal);
    }, 45000);

    it("live: status + terms unchanged", async () => {
      const alice = await createDualAgent(env, "redo-live-a");
      const bob = await createDualAgent(env, "redo-live-b");
      await runPairingFlow(alice, bob);

      const { thread } = await openSessionToLive(alice, bob);
      await redeliverNegoOpen(alice, bob, thread, {
        ...OPEN_PAYLOAD,
        goal: HIJACK_GOAL,
      });
      await assertStatusAndGoal(bob, thread, "live", OPEN_PAYLOAD.goal);
    }, 45000);

    it("signed: status + terms unchanged (light msg/report/sign path)", async () => {
      const alice = await createDualAgent(env, "redo-sign-a");
      const bob = await createDualAgent(env, "redo-sign-b");
      await runPairingFlow(alice, bob);

      const { thread } = await openSessionToSigned(alice, bob);
      await redeliverNegoOpen(alice, bob, thread, {
        ...OPEN_PAYLOAD,
        goal: HIJACK_GOAL,
      });
      await assertStatusAndGoal(bob, thread, "signed", OPEN_PAYLOAD.goal);
    }, 60000);

    it("closed: status unchanged after handleClose from live", async () => {
      const alice = await createDualAgent(env, "redo-close-a");
      const bob = await createDualAgent(env, "redo-close-b");
      await runPairingFlow(alice, bob);

      const { thread } = await openSessionToLive(alice, bob);
      const closed = structured(
        await handleClose(alice.ctx, {
          thread,
          to: bob.agentId,
          reason: "adversarial-close",
        }),
      );
      expect(closed.ok).toBe(true);
      await handleInbox(bob.ctx, {});

      await assertStatusAndGoal(bob, thread, "closed", OPEN_PAYLOAD.goal);
      await redeliverNegoOpen(alice, bob, thread, {
        ...OPEN_PAYLOAD,
        goal: HIJACK_GOAL,
      });
      await assertStatusAndGoal(bob, thread, "closed", OPEN_PAYLOAD.goal);
    }, 45000);

    it("open_rejected: status unchanged after human reject", async () => {
      const alice = await createDualAgent(env, "redo-rej-a");
      const bob = await createDualAgent(env, "redo-rej-b");
      await runPairingFlow(alice, bob);

      const { thread, pendingId } = await openSessionToPending(alice, bob);
      const code = readApprovalCodeForAgent(bob.ctx, pendingId);
      const rejected = structured(
        await handleHumanApprove(bob.ctx, {
          pending_id: pendingId,
          decision: "reject:adversarial",
          approval_code: code,
        }),
      );
      expect(rejected.ok).toBe(true);

      await assertStatusAndGoal(bob, thread, "open_rejected", OPEN_PAYLOAD.goal);
      await redeliverNegoOpen(alice, bob, thread, {
        ...OPEN_PAYLOAD,
        goal: HIJACK_GOAL,
      });
      await assertStatusAndGoal(bob, thread, "open_rejected", OPEN_PAYLOAD.goal);
    }, 45000);
  });
});
