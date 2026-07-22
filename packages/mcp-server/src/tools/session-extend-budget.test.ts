import { stat } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DualRelayEnv, startDualRelay, syncInboxes } from "../e2e/dual-server.js";
import { openLiveBudgetPair } from "./budget-extend-test-helpers.js";
import { handleInbox } from "./inbox.js";
import { handleSessionExtendBudget } from "./session.js";

function structured<T>(result: { structuredContent: T }): T {
  return result.structuredContent;
}

describe("session_extend_budget", () => {
  let env: DualRelayEnv;

  beforeAll(async () => {
    env = await startDualRelay(13320);
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it("extend_budget(30) creates numbered pending with approval_path and no wire; replaces numberless", async () => {
    const { initiator, joiner, thread } = await openLiveBudgetPair(env, "numbered", {
      maxTurns: 20,
    });

    const numberless = initiator.ctx.pending.addBudgetExtend({
      thread,
      peer: joiner.agentId,
    });

    const beforeInbox = structured(await handleInbox(joiner.ctx, { since: 0 }));
    const beforeCursor = beforeInbox.ok ? (beforeInbox.cursor ?? 0) : 0;

    const result = structured(
      await handleSessionExtendBudget(initiator.ctx, {
        thread,
        new_max_turns: 30,
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      thread,
      new_max_turns: 30,
    });
    expect(typeof result.pending_id).toBe("string");
    expect(typeof result.proposal_id).toBe("string");
    expect(typeof result.approval_path).toBe("string");
    expect(result.approval_path).toContain(result.pending_id);
    expect(result.suggested_next).toBeDefined();

    const fileStat = await stat(result.approval_path as string);
    expect(fileStat.mode & 0o777).toBe(0o600);

    const pending = initiator.ctx.pending
      .list()
      .find((item) => item.kind === "budget_extend" && item.thread === thread);
    expect(pending).toBeDefined();
    expect(pending?.id).toBe(result.pending_id);
    expect(pending?.new_max_turns).toBe(30);
    expect(pending?.proposal_id).toBe(result.proposal_id);
    expect(pending?.id).not.toBe(numberless.id);

    expect(initiator.ctx.sessionStore.get(thread)?.extension).toBeUndefined();

    await syncInboxes([initiator.ctx, joiner.ctx]);
    const afterInbox = structured(await handleInbox(joiner.ctx, { since: beforeCursor }));
    expect(afterInbox.ok).toBe(true);
    if (!afterInbox.ok) return;
    const budgetWire = afterInbox.envelopes?.filter((e) => e.type === "nego.budget_propose");
    expect(budgetWire).toHaveLength(0);
  });

  it("extend_budget(20) at current max_turns returns invalid_payload", async () => {
    const { initiator, thread } = await openLiveBudgetPair(env, "invalid", { maxTurns: 20 });

    const result = structured(
      await handleSessionExtendBudget(initiator.ctx, {
        thread,
        new_max_turns: 20,
      }),
    );

    expect(result).toEqual({ ok: false, error: "invalid_payload" });
    const pending = initiator.ctx.pending
      .list()
      .find((item) => item.kind === "budget_extend" && item.thread === thread);
    expect(pending).toBeUndefined();
  });
});
