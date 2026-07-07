import {
  InMemoryPairingRegistry,
  pairInit,
  pairInitComplete,
  pairJoin,
  publicKeyToAgentId,
  type BondMode,
  type LocalAllowlistStore,
  type PairFlowResult,
  type PairingRegistry,
} from "@agentpair/protocol";
import type { HttpRelayClient } from "../relay/client.js";
import type { KeyStore } from "../store/keys.js";
import { MemoryAllowlistStore } from "../store/allowlist.js";
import { MemoryBondStore, type BondStore } from "../store/bonds.js";
import { createPendingQueue, type PendingQueue } from "../store/pending.js";
import { assertNoSecrets, parseBondMode, toolTextResult } from "./util.js";

export interface AgentContext {
  keyStore: KeyStore;
  relay: HttpRelayClient;
  registry: PairingRegistry;
  allowlist: LocalAllowlistStore;
  bonds: BondStore;
  pending: PendingQueue;
}

export function createAgentContext(options: {
  keyStore: KeyStore;
  relay: HttpRelayClient;
  registry?: PairingRegistry;
  allowlist?: LocalAllowlistStore;
  bonds?: BondStore;
  pending?: PendingQueue;
}): AgentContext {
  return {
    keyStore: options.keyStore,
    relay: options.relay,
    registry: options.registry ?? new InMemoryPairingRegistry(),
    allowlist: options.allowlist ?? new MemoryAllowlistStore(),
    bonds: options.bonds ?? new MemoryBondStore(),
    pending: options.pending ?? createPendingQueue(),
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

export async function handlePairInit(
  ctx: AgentContext,
  input: { scope: string[]; mode: string },
) {
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
  };
  assertNoSecrets(result);
  return toolTextResult(result);
}

export async function handlePairInitComplete(
  ctx: AgentContext,
  input: { code: string },
): Promise<PairFlowResult> {
  const keyPair = await ctx.keyStore.loadOrCreate();
  return pairInitComplete({
    code: input.code,
    keyPair,
    relay: ctx.relay,
    registry: ctx.registry,
    localAllowlist: ctx.allowlist,
  });
}

export async function handlePairJoin(
  ctx: AgentContext,
  input: { code: string },
) {
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

export async function handleRevoke(
  ctx: AgentContext,
  input: { peer: string },
) {
  const keyPair = await ctx.keyStore.loadOrCreate();
  const agentId = publicKeyToAgentId(keyPair.publicKey);

  const previous = ctx.allowlist.get(agentId);
  const next = previous.filter((peer) => peer !== input.peer);
  ctx.allowlist.set(agentId, next);

  const push = await ctx.relay.putAllowlist(agentId, next, keyPair.secretKey);
  if (!push.ok) {
    ctx.allowlist.set(agentId, previous);
    const result = { ok: false, error: "allowlist_push_failed" };
    assertNoSecrets(result);
    return toolTextResult(result);
  }

  const result = { ok: true, revoked: input.peer, allowed: next };
  assertNoSecrets(result);
  return toolTextResult(result);
}
