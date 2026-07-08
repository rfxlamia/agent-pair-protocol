import {
  type BondMode,
  InMemoryPairingRegistry,
  type LocalAllowlistStore,
  type PairFlowResult,
  type PairingRegistry,
  createEnvelope,
  pairInit,
  pairJoin,
  publicKeyToAgentId,
} from "@agentpair/protocol";
import { utf8ToBytes } from "@noble/ciphers/utils.js";
import type { HttpRelayClient } from "../relay/client.js";
import { type SessionStore, createSessionStore } from "../session/store.js";
import { MemoryAllowlistStore, createFileAllowlistStore } from "../store/allowlist.js";
import { type BondStore, FileBondStore, MemoryBondStore } from "../store/bonds.js";
import type { KeyStore } from "../store/keys.js";
import { type PendingQueue, createFilePendingQueue, createPendingQueue } from "../store/pending.js";
import { createFileSessionStore } from "../store/session-store.js";
import {
  runInitiatorCompletionOnce,
  scheduleInitiatorPairingCompletion,
} from "./pair-completion.js";
import { assertNoSecrets, parseBondMode, toolTextResult } from "./util.js";

export interface AgentContext {
  keyStore: KeyStore;
  relay: HttpRelayClient;
  registry: PairingRegistry;
  allowlist: LocalAllowlistStore;
  bonds: BondStore;
  pending: PendingQueue;
  sessionStore: SessionStore;
}

type AllowlistWithInit = LocalAllowlistStore & {
  init?: (forAgentId: string) => Promise<void>;
};

export async function ensureAllowlistReady(ctx: AgentContext): Promise<void> {
  const allowlist = ctx.allowlist as AllowlistWithInit;
  if (typeof allowlist.init !== "function") {
    return;
  }
  const keyPair = await ctx.keyStore.loadOrCreate();
  const agentId = publicKeyToAgentId(keyPair.publicKey);
  await allowlist.init(agentId);
}

export function createAgentContext(options: {
  keyStore: KeyStore;
  relay: HttpRelayClient;
  dataDir?: string;
  registry?: PairingRegistry;
  allowlist?: LocalAllowlistStore;
  bonds?: BondStore;
  pending?: PendingQueue;
  sessionStore?: SessionStore;
}): AgentContext {
  const useFileStores = options.dataDir !== undefined;

  return {
    keyStore: options.keyStore,
    relay: options.relay,
    registry: options.registry ?? new InMemoryPairingRegistry(),
    allowlist:
      options.allowlist ??
      (useFileStores
        ? createFileAllowlistStore({ dataDir: options.dataDir })
        : new MemoryAllowlistStore()),
    bonds:
      options.bonds ??
      (useFileStores ? new FileBondStore({ dataDir: options.dataDir }) : new MemoryBondStore()),
    pending:
      options.pending ??
      (useFileStores ? createFilePendingQueue({ dataDir: options.dataDir }) : createPendingQueue()),
    sessionStore:
      options.sessionStore ??
      (useFileStores ? createFileSessionStore({ dataDir: options.dataDir }) : createSessionStore()),
  };
}

async function ensureJoinerRegistry(
  ctx: AgentContext,
  code: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (ctx.registry.lookup(code)) {
    return { ok: true };
  }

  const manifest = await ctx.relay.fetchPairManifest(code);
  if (!manifest) {
    return { ok: false, error: "pair_not_found" };
  }

  ctx.registry.register({
    code: manifest.code,
    sessionId: manifest.sessionId,
    proposal: {
      scope: [...manifest.proposal.scope],
      mode: manifest.proposal.mode as BondMode,
      initiatorAgentId: manifest.proposal.initiatorAgentId,
    },
    createdAt: manifest.createdAt,
    expiresAt: manifest.expiresAt,
  });
  return { ok: true };
}

export async function handlePairInit(ctx: AgentContext, input: { scope: string[]; mode: string }) {
  const parsedMode = parseBondMode(input.mode);
  if (!parsedMode.ok) {
    const result = { ok: false, error: parsedMode.error };
    assertNoSecrets(result);
    return toolTextResult(result);
  }

  const keyPair = await ctx.keyStore.loadOrCreate();
  const output = await pairInit({
    scope: input.scope,
    mode: parsedMode.mode,
    keyPair,
    relay: ctx.relay,
    registry: ctx.registry,
  });

  await ctx.relay.publishPairManifest({
    code: output.code,
    sessionId: output.sessionId,
    proposal: output.proposal,
    createdAt: Date.now(),
    expiresAt: output.expiresAt,
  });

  const result = {
    ok: true,
    code: output.code,
    session_id: output.sessionId,
    proposal: output.proposal,
    expires_at: output.expiresAt,
    agent_id: output.proposal.initiatorAgentId,
    completion: "initiator_auto_scheduled",
  };
  assertNoSecrets(result);
  scheduleInitiatorPairingCompletion(ctx, output.code);
  return toolTextResult(result);
}

export async function handlePairInitComplete(
  ctx: AgentContext,
  input: { code: string },
): Promise<PairFlowResult> {
  return runInitiatorCompletionOnce(ctx, input.code);
}

export async function handlePairJoin(ctx: AgentContext, input: { code: string }) {
  const ensured = await ensureJoinerRegistry(ctx, input.code);
  if (!ensured.ok) {
    const result = { ok: false, error: ensured.error };
    assertNoSecrets(result);
    return toolTextResult(result);
  }

  const pendingEntry = ctx.registry.lookup(input.code);
  if (!pendingEntry) {
    const result = { ok: false, error: "pair_not_found" };
    assertNoSecrets(result);
    return toolTextResult(result);
  }

  const pending = ctx.pending.add({
    code: input.code,
    proposal: pendingEntry.proposal,
  });

  const result = {
    ok: true,
    pending_id: pending.id,
    proposal: pending.proposal,
    message: "Human approval required before pairing completes",
  };
  assertNoSecrets(result);
  return toolTextResult(result);
}

export async function executePairJoinApproval(
  ctx: AgentContext,
  input: {
    code: string;
    decision: { approve: true } | { reject: string };
  },
): Promise<PairFlowResult> {
  await ensureJoinerRegistry(ctx, input.code);
  await ensureAllowlistReady(ctx);
  const keyPair = await ctx.keyStore.loadOrCreate();
  return pairJoin({
    code: input.code,
    keyPair,
    relay: ctx.relay,
    registry: ctx.registry,
    localAllowlist: ctx.allowlist,
    decision: input.decision,
  });
}

export async function handlePairInitCompleteTool(ctx: AgentContext, input: { code: string }) {
  try {
    const flow = await runInitiatorCompletionOnce(ctx, input.code);
    return pairFlowToolResult(flow);
  } catch {
    const result = {
      ok: false,
      status: "pake_failed",
      error: "pair_completion_failed",
    };
    assertNoSecrets(result);
    return toolTextResult(result);
  }
}

function pairFlowToolResult(flow: PairFlowResult) {
  if (flow.status === "bonded") {
    const result = { ok: true, status: flow.status, bond: flow.bond };
    assertNoSecrets(result);
    return toolTextResult(result);
  }
  if (flow.status === "not_found") {
    const result = {
      ok: false,
      status: flow.status,
      error: "pair_session_lost",
      message:
        "Pairing session not found in memory (MCP may have restarted). Run pair_init again with a new code.",
    };
    assertNoSecrets(result);
    return toolTextResult(result);
  }
  const result = {
    ok: false,
    status: flow.status,
    ...(flow.status === "rejected" ? { reason: flow.reason } : {}),
  };
  assertNoSecrets(result);
  return toolTextResult(result);
}

export async function handleRevoke(ctx: AgentContext, input: { peer: string }) {
  await ensureAllowlistReady(ctx);
  const keyPair = await ctx.keyStore.loadOrCreate();
  const agentId = publicKeyToAgentId(keyPair.publicKey);

  const previous = ctx.allowlist.get(agentId);
  const next = previous.filter((peer) => peer !== input.peer);
  ctx.allowlist.set(agentId, next);
  ctx.bonds.remove(agentId, input.peer);

  const push = await ctx.relay.putAllowlist(agentId, next, keyPair.secretKey);
  if (!push.ok) {
    ctx.allowlist.set(agentId, previous);
    const result = { ok: false, error: "allowlist_push_failed" };
    assertNoSecrets(result);
    return toolTextResult(result);
  }

  const notice = createEnvelope({
    sender: keyPair,
    recipientAgentId: input.peer,
    type: "revoke.notice",
    thread: `revoke:${agentId}`,
    seq: 1,
    ttl: 3600,
    payload: utf8ToBytes(JSON.stringify({ from: agentId })),
  });
  await ctx.relay.sendEnvelope(input.peer, notice);

  const result = { ok: true, revoked: input.peer, allowed: next };
  assertNoSecrets(result);
  return toolTextResult(result);
}
