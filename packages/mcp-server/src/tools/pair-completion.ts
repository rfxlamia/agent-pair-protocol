import { type PairFlowResult, publicKeyToAgentId } from "@agentpair/protocol";
import { pairInitComplete } from "@agentpair/protocol";
import { type AgentContext, ensureAllowlistReady } from "./pair.js";

const inFlight = new Map<string, Promise<PairFlowResult>>();
const completed = new Map<string, PairFlowResult>();

function logCompletionEvent(code: string, event: Record<string, unknown>): void {
  console.error("[agentpair] initiator_pairing", { code, ...event });
}

async function runInitiatorCompletion(ctx: AgentContext, code: string): Promise<PairFlowResult> {
  await ensureAllowlistReady(ctx);
  const keyPair = await ctx.keyStore.loadOrCreate();
  const flow = await pairInitComplete({
    code,
    keyPair,
    relay: ctx.relay,
    registry: ctx.registry,
    localAllowlist: ctx.allowlist,
  });
  if (flow.status === "bonded") {
    const agentId = publicKeyToAgentId(keyPair.publicKey);
    ctx.bonds.add(agentId, flow.bond);
    completed.set(code, flow);
    logCompletionEvent(code, { status: "bonded", peer: flow.bond.peer });
  } else {
    logCompletionEvent(code, {
      status: flow.status,
      ...(flow.status === "rejected" ? { reason: flow.reason } : {}),
    });
  }
  return flow;
}

/** Single in-flight initiator completion per pairing code. */
export function runInitiatorCompletionOnce(
  ctx: AgentContext,
  code: string,
): Promise<PairFlowResult> {
  const bonded = completed.get(code);
  if (bonded) {
    return Promise.resolve(bonded);
  }

  const existing = inFlight.get(code);
  if (existing) {
    return existing;
  }

  const task = runInitiatorCompletion(ctx, code)
    .catch((error: unknown) => {
      logCompletionEvent(code, {
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    })
    .finally(() => {
      inFlight.delete(code);
    });
  inFlight.set(code, task);
  return task;
}

/** Fire-and-forget after pair_init; joiner approval can arrive later. */
export function scheduleInitiatorPairingCompletion(ctx: AgentContext, code: string): void {
  runInitiatorCompletionOnce(ctx, code).catch(() => {
    // Error already logged in runInitiatorCompletionOnce.
  });
}

export function getInitiatorCompletionTask(code: string): Promise<PairFlowResult> | undefined {
  return inFlight.get(code);
}

export function resetInitiatorCompletionsForTests(): void {
  inFlight.clear();
  completed.clear();
}
