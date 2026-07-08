import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init as initPake } from "@agentpair/protocol";
import {
  agentIdToPublicKey,
  decryptEnvelopePayload,
  publicKeyToAgentId,
} from "@agentpair/protocol";
import { createRelayApp } from "@agentpair/relay";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { HttpRelayClient } from "../relay/client.js";
import { MemoryAllowlistStore } from "../store/allowlist.js";
import { createKeyStore } from "../store/keys.js";
import { createPendingQueue } from "../store/pending.js";
import { handleHumanApprove } from "../tools/human-approve.js";
import {
  type AgentContext,
  createAgentContext,
  handlePairInit,
  handlePairInitComplete,
  handlePairJoin,
} from "../tools/pair.js";
import {
  handleSessionMsg,
  handleSessionOpen,
  handleSessionRatify,
  handleSessionSign,
  handleSessionStatus,
  processSessionInboxEnvelope,
} from "../tools/session.js";

export interface DualRelayEnv {
  relayUrl: string;
  server: ServerType;
  tempDirs: string[];
  cleanup: () => Promise<void>;
}

export interface DualAgent {
  ctx: AgentContext;
  agentId: string;
}

export interface PairingResult {
  initiator: DualAgent;
  joiner: DualAgent;
  code: string;
}

export interface SessionHappyPathResult {
  thread: string;
  artifactHash: string;
  coSignedHash: string;
}

const SESSION_OPEN_PAYLOAD = {
  goal: "Agree telemetry API contract v1",
  acceptance: [
    {
      id: "A1",
      test: "executable" as const,
      desc: "payload <= 4096 bytes",
      runner: "payload-size",
    },
  ],
  budget: { max_turns: 30 },
  mandate: {
    agent_may: ["propose", "counter", "accept_section", "challenge"],
    human_required: ["sign_final", "budget_extend", "constraint_change"],
  },
};

const processedEnvelopeIds = new WeakMap<AgentContext, Set<string>>();

function structured<T>(result: { structuredContent: T }): T {
  return result.structuredContent;
}

export async function startDualRelay(port = 3020): Promise<DualRelayEnv> {
  await initPake();
  const tempDirs: string[] = [];
  const { app } = createRelayApp({
    rateLimitWindowMs: 60_000,
    rateLimitMax: 200,
  });

  let server!: ServerType;
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port }, resolve);
  });

  const relayUrl = `http://127.0.0.1:${port}`;

  return {
    relayUrl,
    server,
    tempDirs,
    cleanup: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    },
  };
}

export async function createDualAgent(env: DualRelayEnv, label: string): Promise<DualAgent> {
  const dir = await mkdtemp(join(tmpdir(), `agentpair-e2e-${label}-`));
  env.tempDirs.push(dir);
  const keyPath = join(dir, "keys.json");
  const ctx = createAgentContext({
    keyStore: createKeyStore({ keyPath }),
    relay: new HttpRelayClient(env.relayUrl),
    allowlist: new MemoryAllowlistStore(),
    pending: createPendingQueue(),
  });
  const keyPair = await ctx.keyStore.loadOrCreate();
  const agentId = publicKeyToAgentId(keyPair.publicKey);
  return { ctx, agentId };
}

export async function syncInboxes(agents: AgentContext[]): Promise<void> {
  for (const ctx of agents) {
    const keyPair = await ctx.keyStore.loadOrCreate();
    const seen = processedEnvelopeIds.get(ctx) ?? new Set<string>();
    processedEnvelopeIds.set(ctx, seen);

    const pull = await ctx.relay.pullInbox(keyPair, 0);
    if (!pull.ok) {
      throw new Error(`inbox pull failed: ${pull.error}`);
    }

    for (const envelope of pull.envelopes) {
      if (seen.has(envelope.id)) {
        continue;
      }
      const senderPublicKey = agentIdToPublicKey(envelope.from);
      const plaintext = decryptEnvelopePayload(envelope, keyPair, senderPublicKey);
      const payload = new TextDecoder().decode(plaintext);
      const processed = await processSessionInboxEnvelope(ctx, {
        from: envelope.from,
        type: envelope.type,
        thread: envelope.thread,
        payload,
      });
      if (processed.structuredContent.ok === true) {
        seen.add(envelope.id);
      }
    }
  }
}

export async function runPairingFlow(
  initiator: DualAgent,
  joiner: DualAgent,
): Promise<PairingResult> {
  const initResult = structured(
    await handlePairInit(initiator.ctx, {
      scope: ["session.negotiate"],
      mode: "ephemeral_until_session_closes",
    }),
  );
  if (!initResult.ok) {
    throw new Error(`pair_init failed: ${JSON.stringify(initResult)}`);
  }

  const joinResult = structured(await handlePairJoin(joiner.ctx, { code: initResult.code }));
  if (!joinResult.ok) {
    throw new Error(`pair_join failed: ${JSON.stringify(joinResult)}`);
  }

  const completeInitPromise = handlePairInitComplete(initiator.ctx, {
    code: initResult.code,
  });

  const approved = structured(
    await handleHumanApprove(joiner.ctx, {
      pending_id: joinResult.pending_id,
      decision: "approve",
      via_human: true,
    }),
  );
  if (!approved.ok) {
    throw new Error(`human_approve failed: ${JSON.stringify(approved)}`);
  }

  const initComplete = await completeInitPromise;
  if (initComplete.status !== "bonded") {
    throw new Error(`pair init complete failed: ${initComplete.status}`);
  }

  return {
    initiator,
    joiner,
    code: initResult.code,
  };
}

export async function runSessionHappyPath(
  initiator: DualAgent,
  joiner: DualAgent,
  artifactHash = "sha256:e2e-happy-path-artifact",
): Promise<SessionHappyPathResult> {
  const opened = structured(
    await handleSessionOpen(initiator.ctx, {
      to: joiner.agentId,
      ...SESSION_OPEN_PAYLOAD,
    }),
  );
  if (!opened.ok) {
    throw new Error(`session_open failed: ${JSON.stringify(opened)}`);
  }
  const thread = opened.thread as string;

  await syncInboxes([initiator.ctx, joiner.ctx]);

  const bobPending = joiner.ctx.pending.list().find((item) => item.kind === "session_open");
  if (!bobPending) {
    throw new Error("joiner missing session_open pending");
  }

  const approvedOpen = structured(
    await handleHumanApprove(joiner.ctx, {
      pending_id: bobPending.id,
      decision: "approve",
      via_human: true,
    }),
  );
  if (!approvedOpen.ok) {
    throw new Error(`session approve failed: ${JSON.stringify(approvedOpen)}`);
  }

  await syncInboxes([initiator.ctx, joiner.ctx]);

  await handleSessionMsg(initiator.ctx, {
    thread,
    type: "challenge",
    body: JSON.stringify({ report: "adversarial pass" }),
  });
  await syncInboxes([initiator.ctx, joiner.ctx]);

  await handleSessionMsg(joiner.ctx, {
    thread,
    type: "challenge",
    body: JSON.stringify({ report: "adversarial pass" }),
  });
  await syncInboxes([initiator.ctx, joiner.ctx]);

  await handleSessionMsg(initiator.ctx, {
    thread,
    type: "test_report",
    body: JSON.stringify({
      artifact_hash: artifactHash,
      passed: true,
      runner: "payload-size",
    }),
  });
  await syncInboxes([initiator.ctx, joiner.ctx]);

  await handleSessionMsg(joiner.ctx, {
    thread,
    type: "test_report",
    body: JSON.stringify({
      artifact_hash: artifactHash,
      passed: true,
      runner: "payload-size",
    }),
  });
  await syncInboxes([initiator.ctx, joiner.ctx]);

  const aliceSign = structured(
    await handleSessionSign(initiator.ctx, { thread, artifact_hash: artifactHash }),
  );
  if (!aliceSign.ok) {
    throw new Error(`alice sign failed: ${JSON.stringify(aliceSign)}`);
  }
  await syncInboxes([initiator.ctx, joiner.ctx]);

  const bobSign = structured(
    await handleSessionSign(joiner.ctx, { thread, artifact_hash: artifactHash }),
  );
  if (!bobSign.ok) {
    throw new Error(`bob sign failed: ${JSON.stringify(bobSign)}`);
  }
  await syncInboxes([initiator.ctx, joiner.ctx]);

  const aliceRatifyStatus = structured(await handleSessionStatus(initiator.ctx, { thread }));
  const bobRatifyStatus = structured(await handleSessionStatus(joiner.ctx, { thread }));
  if (
    !aliceRatifyStatus.ok ||
    !bobRatifyStatus.ok ||
    !aliceRatifyStatus.pending_id ||
    !bobRatifyStatus.pending_id
  ) {
    throw new Error(
      `missing ratify pending_id in session_status: ${JSON.stringify({
        alice: aliceRatifyStatus,
        bob: bobRatifyStatus,
      })}`,
    );
  }

  const aliceRatify = structured(
    await handleSessionRatify(initiator.ctx, {
      pending_id: aliceRatifyStatus.pending_id,
      via_human: true,
    }),
  );
  if (!aliceRatify.ok) {
    throw new Error(`alice ratify failed: ${JSON.stringify(aliceRatify)}`);
  }
  await syncInboxes([initiator.ctx, joiner.ctx]);

  const bobRatify = structured(
    await handleSessionRatify(joiner.ctx, {
      pending_id: bobRatifyStatus.pending_id,
      via_human: true,
    }),
  );
  if (!bobRatify.ok) {
    throw new Error(`bob ratify failed: ${JSON.stringify(bobRatify)}`);
  }
  await syncInboxes([initiator.ctx, joiner.ctx]);

  const finalStatus = structured(await handleSessionStatus(initiator.ctx, { thread }));
  if (!finalStatus.ok || finalStatus.status !== "closed") {
    throw new Error(`session not closed: ${JSON.stringify(finalStatus)}`);
  }
  if (!finalStatus.co_signed_hash) {
    throw new Error("missing co_signed_hash");
  }

  return {
    thread,
    artifactHash,
    coSignedHash: finalStatus.co_signed_hash,
  };
}

export { SESSION_OPEN_PAYLOAD };
