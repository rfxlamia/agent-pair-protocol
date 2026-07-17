import {
  type BondMode,
  InMemoryPairingRegistry,
  type LocalAllowlistStore,
  type PairFlowResult,
  type PairingRegistry,
  type SessionStore,
  createSessionStore,
  pairInit,
  pairJoin,
  publicKeyToAgentId,
} from "@agentpair/protocol";
import type { HttpRelayClient } from "../relay/client.js";
import { MemoryAllowlistStore, createFileAllowlistStore } from "../store/allowlist.js";
import { type BondStore, FileBondStore, MemoryBondStore } from "../store/bonds.js";
import {
  type ClosedThreadStore,
  MemoryClosedThreadStore,
  createFileClosedThreadStore,
} from "../store/closed-threads.js";
import {
  type EnvelopeSeqStore,
  MemoryEnvelopeSeqStore,
  createFileEnvelopeSeqStore,
} from "../store/envelope-seq.js";
import { scheduleAgentContextFlush } from "../store/flush-context.js";
import {
  type InboxCursorStore,
  MemoryInboxCursorStore,
  createFileInboxCursorStore,
} from "../store/inbox-cursor.js";
import type { KeyStore } from "../store/keys.js";
import { type PendingQueue, createFilePendingQueue, createPendingQueue } from "../store/pending.js";
import { createFileSessionStore } from "../store/session-store.js";
import {
  approvalChannelUnavailableResult,
  isApprovalChannelError,
  withPendingApprovalSurface,
} from "./approval-surface.js";
import {
  runInitiatorCompletionOnce,
  scheduleInitiatorPairingCompletion,
} from "./pair-completion.js";
import { processBondRevoke } from "./session.js";
import { assertNoSecrets, parseBondMode, toolTextResult } from "./util.js";

export interface AgentContext {
  keyStore: KeyStore;
  relay: HttpRelayClient;
  dataDir?: string;
  registry: PairingRegistry;
  allowlist: LocalAllowlistStore;
  bonds: BondStore;
  inboxCursor: InboxCursorStore;
  envelopeSeq: EnvelopeSeqStore;
  pending: PendingQueue;
  sessionStore: SessionStore;
  closedThreads: ClosedThreadStore;
}

type AllowlistWithInit = LocalAllowlistStore & {
  init?: (forAgentId: string) => Promise<void>;
};

type PendingWithInit = PendingQueue & {
  init?: (secretKey: Uint8Array) => void;
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

export async function ensurePendingApprovalReady(ctx: AgentContext): Promise<void> {
  const pending = ctx.pending as PendingWithInit;
  if (typeof pending.init !== "function") {
    return;
  }
  const keyPair = await ctx.keyStore.loadOrCreate();
  pending.init(keyPair.secretKey);
}

export function createAgentContext(options: {
  keyStore: KeyStore;
  relay: HttpRelayClient;
  dataDir?: string;
  registry?: PairingRegistry;
  allowlist?: LocalAllowlistStore;
  bonds?: BondStore;
  inboxCursor?: InboxCursorStore;
  envelopeSeq?: EnvelopeSeqStore;
  pending?: PendingQueue;
  sessionStore?: SessionStore;
  closedThreads?: ClosedThreadStore;
}): AgentContext {
  const useFileStores = options.dataDir !== undefined;

  return {
    keyStore: options.keyStore,
    relay: options.relay,
    dataDir: options.dataDir,
    registry: options.registry ?? new InMemoryPairingRegistry(),
    allowlist:
      options.allowlist ??
      (useFileStores
        ? createFileAllowlistStore({ dataDir: options.dataDir })
        : new MemoryAllowlistStore()),
    bonds:
      options.bonds ??
      (useFileStores ? new FileBondStore({ dataDir: options.dataDir }) : new MemoryBondStore()),
    inboxCursor:
      options.inboxCursor ??
      (useFileStores
        ? createFileInboxCursorStore({ dataDir: options.dataDir })
        : new MemoryInboxCursorStore()),
    envelopeSeq:
      options.envelopeSeq ??
      (useFileStores
        ? createFileEnvelopeSeqStore({ dataDir: options.dataDir })
        : new MemoryEnvelopeSeqStore()),
    pending:
      options.pending ??
      (useFileStores ? createFilePendingQueue({ dataDir: options.dataDir }) : createPendingQueue()),
    sessionStore:
      options.sessionStore ??
      (useFileStores ? createFileSessionStore({ dataDir: options.dataDir }) : createSessionStore()),
    closedThreads:
      options.closedThreads ??
      (useFileStores
        ? createFileClosedThreadStore({ dataDir: options.dataDir })
        : new MemoryClosedThreadStore()),
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
  input: { scope: string[]; mode: string; profiles?: string[] },
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
    profiles: input.profiles,
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
  scheduleInitiatorPairingCompletion(ctx, output.code, input.profiles);
  return toolTextResult(result);
}

export async function handlePairInitComplete(
  ctx: AgentContext,
  input: { code: string; profiles?: string[] },
): Promise<PairFlowResult> {
  return runInitiatorCompletionOnce(ctx, input.code, input.profiles);
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

  await ensurePendingApprovalReady(ctx);

  try {
    const pending = ctx.pending.add({
      code: input.code,
      proposal: pendingEntry.proposal,
    });

    const result = withPendingApprovalSurface(ctx, {
      ok: true as const,
      pending_id: pending.id,
      proposal: pending.proposal,
      message: "Human approval required before pairing completes",
    });
    assertNoSecrets(result);
    return toolTextResult(result);
  } catch (error) {
    if (isApprovalChannelError(error)) {
      const result = approvalChannelUnavailableResult();
      assertNoSecrets(result);
      return toolTextResult(result);
    }
    throw error;
  }
}

export async function executePairJoinApproval(
  ctx: AgentContext,
  input: {
    code: string;
    decision: { approve: true } | { reject: string };
    profiles?: string[];
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
    profiles: input.profiles,
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
    ...(flow.status === "rejected" || flow.status === "rolled_back" ? { reason: flow.reason } : {}),
  };
  assertNoSecrets(result);
  return toolTextResult(result);
}

export async function handleRevoke(ctx: AgentContext, input: { peer: string }) {
  await ensureAllowlistReady(ctx);
  const keyPair = await ctx.keyStore.loadOrCreate();
  const agentId = publicKeyToAgentId(keyPair.publicKey);

  const noBondFound = !ctx.bonds.find(agentId, input.peer);

  await processBondRevoke(ctx, input.peer);

  ctx.bonds.remove(agentId, input.peer);

  const previous = ctx.allowlist.get(agentId);
  const next = previous.filter((peer) => peer !== input.peer);
  ctx.allowlist.set(agentId, next);

  const purge = await purgeInboxWithRetry(ctx, input.peer, keyPair);
  const push = await putAllowlistWithRetry(ctx, agentId, next, keyPair);

  scheduleAgentContextFlush(ctx);

  const result = {
    ok: true,
    revoked: input.peer,
    allowed: next,
    ...(noBondFound ? { no_bond_found: true } : {}),
    ...(purge.ok
      ? { purged: purge.deleted, ...(purge.peer_purged ? { peer_purged: true } : {}) }
      : { purge_warning: purge.error, inbox_purge_incomplete: true }),
    ...(push.ok ? {} : { allowlist_push_incomplete: true }),
  };
  assertNoSecrets(result);
  return toolTextResult(result);
}

async function putAllowlistWithRetry(
  ctx: AgentContext,
  agentId: string,
  allowed: string[],
  keyPair: Awaited<ReturnType<AgentContext["keyStore"]["loadOrCreate"]>>,
  attempts = 2,
) {
  let last = await ctx.relay.putAllowlist(agentId, allowed, keyPair.secretKey);
  for (let attempt = 1; attempt < attempts && !last.ok; attempt += 1) {
    last = await ctx.relay.putAllowlist(agentId, allowed, keyPair.secretKey);
  }
  return last;
}

async function purgeInboxWithRetry(
  ctx: AgentContext,
  peerAgentId: string,
  keyPair: Awaited<ReturnType<AgentContext["keyStore"]["loadOrCreate"]>>,
  attempts = 2,
) {
  let last = await ctx.relay.purgeInboxDyad(peerAgentId, keyPair);
  for (let attempt = 1; attempt < attempts && !last.ok; attempt += 1) {
    last = await ctx.relay.purgeInboxDyad(peerAgentId, keyPair);
  }
  return last;
}
