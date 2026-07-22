import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type DualAgent,
  type DualRelayEnv,
  startDualRelay,
  syncInboxes,
} from "../e2e/dual-server.js";
import { readApprovalCodeForAgent } from "./approval-test-helpers.js";
import { openLiveBudgetPair } from "./budget-extend-test-helpers.js";
import { handleHumanApprove } from "./human-approve.js";
import { handleInbox } from "./inbox.js";
import {
  handleSessionExtendBudget,
  handleSessionMsg,
  handleSessionSign,
  handleSessionStatus,
} from "./session.js";

function structured<T>(result: { structuredContent: T }): T {
  return result.structuredContent;
}

function maxTurns(
  ctx: { sessionStore: { get: (thread: string) => { budget: { max_turns: number } } | undefined } },
  thread: string,
): number {
  return ctx.sessionStore.get(thread)?.budget.max_turns ?? -1;
}

async function signLiveSessionToSigned(
  initiator: DualAgent,
  joiner: DualAgent,
  thread: string,
  artifactHash = "sha256:test-artifact",
): Promise<void> {
  for (const agent of [initiator, joiner]) {
    const challenge = structured(
      await handleSessionMsg(agent.ctx, {
        thread,
        type: "challenge",
        body: JSON.stringify({ report: "pass" }),
      }),
    );
    expect(challenge.ok).toBe(true);
    await syncInboxes([initiator.ctx, joiner.ctx]);
  }

  for (const agent of [initiator, joiner]) {
    const report = structured(
      await handleSessionMsg(agent.ctx, {
        thread,
        type: "test_report",
        body: JSON.stringify({
          artifact_hash: artifactHash,
          passed: true,
          runner: "payload-size",
        }),
      }),
    );
    expect(report.ok).toBe(true);
    await syncInboxes([initiator.ctx, joiner.ctx]);
  }

  const initiatorSign = structured(
    await handleSessionSign(initiator.ctx, { thread, artifact_hash: artifactHash }),
  );
  expect(initiatorSign.ok).toBe(true);
  await syncInboxes([initiator.ctx, joiner.ctx]);

  const joinerSign = structured(
    await handleSessionSign(joiner.ctx, { thread, artifact_hash: artifactHash }),
  );
  expect(joinerSign.ok).toBe(true);
  await syncInboxes([initiator.ctx, joiner.ctx]);
}

describe("N4 budget extend bilateral (MCP)", () => {
  let env: DualRelayEnv;

  beforeAll(async () => {
    env = await startDualRelay(13330);
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it("both sides complete cycle → max_turns=30; one-side-only stays 20", async () => {
    const { initiator, joiner, thread } = await openLiveBudgetPair(env, "happy");

    const ext = structured(
      await handleSessionExtendBudget(initiator.ctx, { thread, new_max_turns: 30 }),
    );
    expect(ext.ok).toBe(true);
    if (!ext.ok || typeof ext.pending_id !== "string") {
      throw new Error("extend failed");
    }

    const initiatorApprove = structured(
      await handleHumanApprove(initiator.ctx, {
        pending_id: ext.pending_id,
        decision: "approve",
        approval_code: readApprovalCodeForAgent(initiator.ctx, ext.pending_id),
      }),
    );
    expect(initiatorApprove.ok).toBe(true);

    await handleInbox(joiner.ctx, { since: 0 });

    expect(maxTurns(initiator.ctx, thread)).toBe(20);
    expect(maxTurns(joiner.ctx, thread)).toBe(20);

    const joinerPend = joiner.ctx.pending
      .list()
      .find((p) => p.kind === "budget_extend" && p.thread === thread);
    expect(joinerPend).toBeDefined();
    if (!joinerPend) {
      throw new Error("joiner missing budget_extend pending");
    }

    const joinerApprove = structured(
      await handleHumanApprove(joiner.ctx, {
        pending_id: joinerPend.id,
        decision: "approve",
        approval_code: readApprovalCodeForAgent(joiner.ctx, joinerPend.id),
      }),
    );
    expect(joinerApprove.ok).toBe(true);

    await handleInbox(initiator.ctx, { since: 0 });

    expect(maxTurns(initiator.ctx, thread)).toBe(30);
    expect(maxTurns(joiner.ctx, thread)).toBe(30);

    const initiatorStatus = structured(await handleSessionStatus(initiator.ctx, { thread }));
    const joinerStatus = structured(await handleSessionStatus(joiner.ctx, { thread }));
    expect(initiatorStatus.extension).toBeUndefined();
    expect(joinerStatus.extension).toBeUndefined();
  }, 30_000);

  it("reject then same proposal_id resurrected → no pending; leave-live retains extensionDecided", async () => {
    const { initiator, joiner, thread } = await openLiveBudgetPair(env, "resurrect");

    const ext = structured(
      await handleSessionExtendBudget(initiator.ctx, { thread, new_max_turns: 30 }),
    );
    expect(ext.ok).toBe(true);
    if (!ext.ok || typeof ext.pending_id !== "string") {
      throw new Error("extend failed");
    }

    await handleHumanApprove(initiator.ctx, {
      pending_id: ext.pending_id,
      decision: "approve",
      approval_code: readApprovalCodeForAgent(initiator.ctx, ext.pending_id),
    });
    await handleInbox(joiner.ctx, { since: 0 });

    const joinerPend = joiner.ctx.pending
      .list()
      .find((p) => p.kind === "budget_extend" && p.thread === thread);
    expect(joinerPend).toBeDefined();
    if (!joinerPend?.proposal_id) {
      throw new Error("joiner missing numbered budget_extend pending");
    }
    const proposalId = joinerPend.proposal_id;

    await handleHumanApprove(joiner.ctx, {
      pending_id: joinerPend.id,
      decision: "reject:no",
      approval_code: readApprovalCodeForAgent(joiner.ctx, joinerPend.id),
    });
    await handleInbox(initiator.ctx, { since: 0 });

    expect(
      joiner.ctx.pending.list().filter((p) => p.kind === "budget_extend" && p.thread === thread),
    ).toHaveLength(0);

    await handleInbox(joiner.ctx, { since: 0 });

    expect(
      joiner.ctx.pending.list().filter((p) => p.kind === "budget_extend" && p.thread === thread),
    ).toHaveLength(0);

    await signLiveSessionToSigned(initiator, joiner, thread);

    const joinerSession = joiner.ctx.sessionStore.get(thread);
    expect(joinerSession?.status).toBe("signed");
    expect(joinerSession?.extension).toBeUndefined();
    expect(joinerSession?.extensionDecided?.some((d) => d.proposal_id === proposalId)).toBe(true);

    const lateExt = structured(
      await handleSessionExtendBudget(joiner.ctx, { thread, new_max_turns: 40 }),
    );
    expect(lateExt.ok).toBe(false);
    expect(lateExt.error).toBe("session_not_live");
  }, 30_000);

  it("wire-vs-wire race: initiator wins; recipient sees one superseded fact (deduped)", async () => {
    const { initiator, joiner, thread } = await openLiveBudgetPair(env, "race");

    const initiatorExt = structured(
      await handleSessionExtendBudget(initiator.ctx, { thread, new_max_turns: 30 }),
    );
    const joinerExt = structured(
      await handleSessionExtendBudget(joiner.ctx, { thread, new_max_turns: 40 }),
    );
    expect(initiatorExt.ok && joinerExt.ok).toBe(true);
    if (
      !initiatorExt.ok ||
      !joinerExt.ok ||
      typeof initiatorExt.pending_id !== "string" ||
      typeof joinerExt.pending_id !== "string"
    ) {
      throw new Error("extend failed");
    }

    await handleHumanApprove(initiator.ctx, {
      pending_id: initiatorExt.pending_id,
      decision: "approve",
      approval_code: readApprovalCodeForAgent(initiator.ctx, initiatorExt.pending_id),
    });
    await handleHumanApprove(joiner.ctx, {
      pending_id: joinerExt.pending_id,
      decision: "approve",
      approval_code: readApprovalCodeForAgent(joiner.ctx, joinerExt.pending_id),
    });

    await handleInbox(initiator.ctx, { since: 0 });
    await handleInbox(joiner.ctx, { since: 0 });
    await handleInbox(initiator.ctx, { since: 0 });
    await handleInbox(joiner.ctx, { since: 0 });

    const winnerStatus = structured(await handleSessionStatus(initiator.ctx, { thread }));
    expect(winnerStatus.extension?.new_max_turns).toBe(30);

    const loserInbox = structured(await handleInbox(joiner.ctx, { since: 0 }));
    expect(loserInbox.ok).toBe(true);
    if (!loserInbox.ok) {
      return;
    }

    const superseded = loserInbox.envelopes.filter(
      (e) => e.inbox_event === "budget_extend_superseded",
    );
    expect(superseded.length).toBeLessThanOrEqual(1);
    for (const envelope of superseded) {
      expect(JSON.stringify(envelope)).not.toMatch(/approval_code|approvalCodeVerifier/);
    }

    const joinerRemaining = joiner.ctx.pending
      .list()
      .filter((p) => p.kind === "budget_extend" && p.thread === thread);
    expect(joinerRemaining).toHaveLength(1);
    expect(joinerRemaining[0]?.new_max_turns).toBe(30);
    expect(joinerRemaining[0]?.proposal_id).toBe(
      initiator.ctx.sessionStore.get(thread)?.extension?.proposal_id,
    );
  }, 30_000);
});
