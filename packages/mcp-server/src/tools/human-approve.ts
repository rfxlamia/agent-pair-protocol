import type { AgentContext } from "./pair.js";
import {
  executePairJoinApproval,
  handlePairInitComplete,
} from "./pair.js";
import { parseHumanDecision } from "../store/pending.js";
import { assertNoSecrets, toolTextResult } from "./util.js";

export async function handleHumanApprove(
  ctx: AgentContext,
  input: { pending_id: string; decision: string; via_human?: boolean },
) {
  if (!input.via_human) {
    const result = { ok: false, error: "self_approval_forbidden" };
    assertNoSecrets(result);
    return toolTextResult(result);
  }

  const pending = ctx.pending.get(input.pending_id);
  if (!pending) {
    const result = { ok: false, error: "pending_not_found" };
    assertNoSecrets(result);
    return toolTextResult(result);
  }

  const parsed = parseHumanDecision(input.decision);
  if ("error" in parsed) {
    const result = { ok: false, error: parsed.error };
    assertNoSecrets(result);
    return toolTextResult(result);
  }

  if (pending.kind === "pair_join") {
    const flow = await executePairJoinApproval(ctx, {
      code: pending.code,
      decision: parsed,
    });

    ctx.pending.remove(pending.id);

    if (flow.status === "bonded") {
      const result = { ok: true, status: flow.status, bond: flow.bond };
      assertNoSecrets(result);
      return toolTextResult(result);
    }

    const result = { ok: false, status: flow.status, ...spreadFlowError(flow) };
    assertNoSecrets(result);
    return toolTextResult(result);
  }

  const result = { ok: false, error: "unsupported_pending_kind" };
  assertNoSecrets(result);
  return toolTextResult(result);
}

function spreadFlowError(
  flow: Awaited<ReturnType<typeof executePairJoinApproval>>,
): Record<string, unknown> {
  if (flow.status === "rejected") {
    return { reason: flow.reason };
  }
  return {};
}

export async function completeInitiatorPairing(
  ctx: AgentContext,
  code: string,
) {
  return handlePairInitComplete(ctx, { code });
}
