import {
  type DualAgent,
  type DualRelayEnv,
  createDualAgent,
  runPairingFlow,
  syncInboxes,
} from "../e2e/dual-server.js";
import { readApprovalCodeForAgent } from "./approval-test-helpers.js";
import { handleHumanApprove } from "./human-approve.js";
import { handleSessionOpen } from "./session.js";

const FUTURE_DEADLINE = "2030-06-01T12:00:00.000Z";

export interface LiveBudgetPair {
  initiator: DualAgent;
  joiner: DualAgent;
  thread: string;
}

export interface OpenLiveBudgetPairOptions {
  maxTurns?: number;
}

function structured<T>(result: { structuredContent: T }): T {
  return result.structuredContent;
}

const DEFAULT_MANDATE = {
  agent_may: ["propose", "counter", "accept_section", "challenge"],
  human_required: ["sign_final", "budget_extend", "constraint_change"],
};

export async function openLiveBudgetPair(
  env: DualRelayEnv,
  label: string,
  opts?: OpenLiveBudgetPairOptions,
): Promise<LiveBudgetPair> {
  const initiator = await createDualAgent(env, `${label}-init`);
  const joiner = await createDualAgent(env, `${label}-join`);
  await runPairingFlow(initiator, joiner);

  const maxTurns = opts?.maxTurns ?? 20;

  const opened = structured(
    await handleSessionOpen(initiator.ctx, {
      to: joiner.agentId,
      goal: `budget extend probe ${label}`,
      acceptance: [{ id: "A1", test: "executable", desc: "probe", runner: "payload-size" }],
      budget: { max_turns: maxTurns, deadline: FUTURE_DEADLINE },
      mandate: DEFAULT_MANDATE,
    }),
  );
  if (!opened.ok) {
    throw new Error(`session_open failed: ${JSON.stringify(opened)}`);
  }
  const thread = opened.thread as string;

  await syncInboxes([initiator.ctx, joiner.ctx]);

  const sessionOpenPending = joiner.ctx.pending
    .list()
    .find((item) => item.kind === "session_open" && item.thread === thread);
  if (!sessionOpenPending) {
    throw new Error("missing session_open pending");
  }

  const approvalCode = readApprovalCodeForAgent(joiner.ctx, sessionOpenPending.id);
  const approved = structured(
    await handleHumanApprove(joiner.ctx, {
      pending_id: sessionOpenPending.id,
      decision: "approve",
      approval_code: approvalCode,
    }),
  );
  if (!approved.ok) {
    throw new Error(`session open approve failed: ${JSON.stringify(approved)}`);
  }

  await syncInboxes([initiator.ctx, joiner.ctx]);

  return { initiator, joiner, thread };
}
