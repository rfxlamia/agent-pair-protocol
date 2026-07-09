import {
  type SessionStateMachine,
  type SessionStatus,
  createOuterEnvelope,
  createSessionStateMachine,
  defaultEnvelopeTtl,
  publicKeyToAgentId,
} from "@agentpair/protocol";
import { utf8ToBytes } from "@noble/ciphers/utils.js";
import { type AgentContext, ensureAllowlistReady } from "./pair.js";
import { assertNoSecrets, toolTextResult } from "./util.js";

const sessionMachines = new WeakMap<AgentContext, SessionStateMachine>();
const sessionThreadSeq = new WeakMap<AgentContext, Map<string, number>>();

function nextSessionSeq(ctx: AgentContext, thread: string): number {
  const counters = sessionThreadSeq.get(ctx) ?? new Map<string, number>();
  sessionThreadSeq.set(ctx, counters);
  const next = (counters.get(thread) ?? 0) + 1;
  counters.set(thread, next);
  return next;
}

export async function expirePendingSessions(ctx: AgentContext): Promise<void> {
  const machine = sessionMachines.get(ctx);
  if (machine) {
    await machine.handleExpirePendingOpens();
  }
}

export async function resolveSessionOpenPendingId(
  ctx: AgentContext,
  thread: string,
): Promise<string | undefined> {
  const machine = sessionMachines.get(ctx);
  if (!machine) {
    return undefined;
  }
  return machine.resolveOpenPendingId(thread);
}

export async function resolveRatifyPendingId(
  ctx: AgentContext,
  thread: string,
): Promise<string | undefined> {
  const machine = sessionMachines.get(ctx);
  if (!machine) {
    return undefined;
  }
  return machine.resolveRatifyPendingId(thread);
}

export function peekSessionOpenStatus(
  ctx: AgentContext,
  thread: string,
): SessionStatus | undefined {
  const machine = sessionMachines.get(ctx);
  if (!machine) {
    return undefined;
  }
  return machine.peekSessionOpenStatus(thread);
}

async function getSessionMachine(ctx: AgentContext): Promise<SessionStateMachine> {
  const cached = sessionMachines.get(ctx);
  if (cached) {
    return cached;
  }

  await ensureAllowlistReady(ctx);
  const keyPair = await ctx.keyStore.loadOrCreate();
  const agentId = publicKeyToAgentId(keyPair.publicKey);
  const machine = createSessionStateMachine(
    {
      agentId,
      keyPair,
      pending: ctx.pending,
      allowlist: ctx.allowlist,
      bonds: ctx.bonds,
      relay: {
        async send(input) {
          const seq = input.seq ?? nextSessionSeq(ctx, input.thread);
          const outer = createOuterEnvelope({
            sender: keyPair,
            recipientAgentId: input.to,
            type: input.type,
            thread: input.thread,
            seq,
            ttl: defaultEnvelopeTtl(),
            payload: utf8ToBytes(input.payload),
          });
          await ctx.relay.sendEnvelope(input.to, outer);
          return { ok: true };
        },
      },
    },
    ctx.sessionStore,
  );
  sessionMachines.set(ctx, machine);
  return machine;
}

async function withSessionMachine<T extends Record<string, unknown>>(
  ctx: AgentContext,
  fn: (machine: SessionStateMachine) => Promise<T>,
) {
  const machine = await getSessionMachine(ctx);
  const result = await fn(machine);
  assertNoSecrets(result);
  return toolTextResult(result);
}

export async function handleSessionOpen(
  ctx: AgentContext,
  input: {
    to: string;
    goal: string;
    acceptance: Array<{
      id: string;
      test: "executable" | "judgment";
      desc: string;
      runner?: string;
    }>;
    budget: { max_turns: number; deadline?: string };
    mandate: {
      agent_may: string[];
      human_required: string[];
      escalate_on?: string[];
    };
  },
) {
  return withSessionMachine(ctx, (machine) => machine.handleOpen(input));
}

export async function handleSessionMsg(
  ctx: AgentContext,
  input: { thread: string; type: string; body: string },
) {
  return withSessionMachine(ctx, (machine) => machine.handleMsg(input));
}

export async function handleSessionSign(
  ctx: AgentContext,
  input: { thread: string; artifact_hash: string },
) {
  return withSessionMachine(ctx, (machine) => machine.handleSign(input));
}

export async function handleSessionStatus(ctx: AgentContext, input: { thread: string }) {
  await expirePendingSessions(ctx);
  return withSessionMachine(ctx, (machine) => machine.handleStatus(input));
}

export async function handleSessionApproveOpen(
  ctx: AgentContext,
  input: { pending_id: string; via_human?: boolean },
) {
  return withSessionMachine(ctx, (machine) => machine.handleApproveOpen(input));
}

export async function handleSessionRejectOpen(
  ctx: AgentContext,
  input: { pending_id: string; reason: string; via_human?: boolean },
) {
  return withSessionMachine(ctx, (machine) => machine.handleRejectOpen(input));
}

export async function handleSessionRatify(
  ctx: AgentContext,
  input: {
    pending_id?: string;
    thread?: string;
    artifact_hash?: string;
    via_human?: boolean;
  },
) {
  return withSessionMachine(ctx, (machine) => machine.handleRatify(input));
}

export async function processSessionInboxEnvelope(
  ctx: AgentContext,
  input: { from: string; type: string; thread: string; payload: string },
) {
  return withSessionMachine(ctx, (machine) => machine.handleIncomingEnvelope(input));
}
