import {
  type PairFlowResult,
  type PairingRelayClient,
  publicKeyToAgentId,
} from "@agentpair/protocol";
import { pairInitComplete } from "@agentpair/protocol";
import { scheduleAgentContextFlush } from "../store/flush-context.js";
import { type AgentContext, ensureAllowlistReady } from "./pair.js";

const inFlight = new Map<string, Promise<PairFlowResult>>();
const completed = new Map<string, PairFlowResult>();
let pairingGeneration = 0;

function logCompletionEvent(code: string, event: Record<string, unknown>): void {
  console.error("[agentpair] initiator_pairing", { code, ...event });
}

function wrapRelayForCancellation(
  relay: PairingRelayClient,
  generation: number,
): PairingRelayClient {
  return {
    postPakeMessage: async (sessionId, body) => {
      if (generation !== pairingGeneration) {
        throw new Error("pairing_cancelled");
      }
      return relay.postPakeMessage(sessionId, body);
    },
    pollPakeMessage: async (sessionId, timeoutMs) => {
      if (generation !== pairingGeneration) {
        return null;
      }
      return relay.pollPakeMessage(sessionId, timeoutMs);
    },
    consumePakeMessage: (sessionId) => {
      relay.consumePakeMessage?.(sessionId);
    },
    putAllowlist: (agentId, allowed, secretKey) => relay.putAllowlist(agentId, allowed, secretKey),
  };
}

async function runInitiatorCompletion(
  ctx: AgentContext,
  code: string,
  profiles?: string[],
): Promise<PairFlowResult> {
  const generation = pairingGeneration;
  await ensureAllowlistReady(ctx);
  const keyPair = await ctx.keyStore.loadOrCreate();
  const flow = await pairInitComplete({
    code,
    keyPair,
    relay: wrapRelayForCancellation(ctx.relay, generation),
    registry: ctx.registry,
    localAllowlist: ctx.allowlist,
    profiles,
  });
  if (generation !== pairingGeneration) {
    return { status: "pake_failed" };
  }
  if (flow.status === "bonded") {
    const agentId = publicKeyToAgentId(keyPair.publicKey);
    ctx.bonds.add(agentId, flow.bond);
    scheduleAgentContextFlush(ctx);
    completed.set(code, flow);
    logCompletionEvent(code, { status: "bonded", peer: flow.bond.peer });
  } else {
    logCompletionEvent(code, {
      status: flow.status,
      ...(flow.status === "rejected" || flow.status === "rolled_back"
        ? { reason: flow.reason }
        : {}),
    });
  }
  return flow;
}

/** Single in-flight initiator completion per pairing code. */
export function runInitiatorCompletionOnce(
  ctx: AgentContext,
  code: string,
  profiles?: string[],
): Promise<PairFlowResult> {
  const bonded = completed.get(code);
  if (bonded) {
    return Promise.resolve(bonded);
  }

  const existing = inFlight.get(code);
  if (existing) {
    return existing;
  }

  const task = runInitiatorCompletion(ctx, code, profiles)
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
export function scheduleInitiatorPairingCompletion(
  ctx: AgentContext,
  code: string,
  profiles?: string[],
): void {
  runInitiatorCompletionOnce(ctx, code, profiles).catch(() => {
    // Error already logged in runInitiatorCompletionOnce.
  });
}

export function getInitiatorCompletionTask(code: string): Promise<PairFlowResult> | undefined {
  return inFlight.get(code);
}

/** Cancel in-flight initiator polls (vitest teardown). */
export function resetInitiatorCompletionsForTests(): void {
  pairingGeneration++;
  inFlight.clear();
  completed.clear();
}
