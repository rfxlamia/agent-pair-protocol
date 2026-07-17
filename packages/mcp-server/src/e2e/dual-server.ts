import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init as initPake } from "@agentpair/protocol";
import {
  type EnvelopeBody,
  type OuterEnvelope,
  agentIdToPublicKey,
  decryptEnvelopePayload,
  deserializeOuterEnvelope,
  hashArtifactBlob,
  parseEnvelopeBody,
  publicKeyToAgentId,
} from "@agentpair/protocol";
import { createRelayApp } from "@agentpair/relay";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { HttpRelayClient } from "../relay/client.js";
import { MemoryAllowlistStore } from "../store/allowlist.js";
import { createKeyStore } from "../store/keys.js";
import { readApprovalCodeForAgent } from "../tools/approval-test-helpers.js";
import { handleAtestRun } from "../tools/atest-run.js";
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

const E2E_PAYLOAD_SIZE_SCHEMA = {
  type: "object",
  properties: { id: { type: "string" } },
};

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
  budget: { max_turns: 30, deadline: new Date(Date.now() + 86_400_000).toISOString() },
  mandate: {
    agent_may: ["propose", "counter", "accept_section", "challenge"],
    human_required: ["sign_final", "budget_extend", "constraint_change"],
  },
};

const processedEnvelopeIds = new WeakMap<AgentContext, Set<string>>();

function structured<T>(result: { structuredContent: T }): T {
  return result.structuredContent;
}

export async function startDualRelay(port = 13220): Promise<DualRelayEnv> {
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
      await Promise.all(
        tempDirs.map((dir) =>
          rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
        ),
      );
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
    dataDir: dir,
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

    for (const wire of pull.wires) {
      let outer: OuterEnvelope;
      try {
        outer = deserializeOuterEnvelope(wire);
      } catch {
        continue;
      }
      let body: EnvelopeBody;
      try {
        body = parseEnvelopeBody(outer);
      } catch {
        continue;
      }
      if (seen.has(body.id)) {
        continue;
      }
      const senderPublicKey = agentIdToPublicKey(body.from);
      const plaintext = decryptEnvelopePayload(body, keyPair, senderPublicKey);
      const payload = new TextDecoder().decode(plaintext);
      const processed = await processSessionInboxEnvelope(ctx, {
        from: body.from,
        type: body.type,
        thread: body.thread,
        payload,
      });
      if (processed.structuredContent.ok === true) {
        seen.add(body.id);
      }
    }
  }
}

const E2E_DEFAULT_PROFILES = ["core/1", "nego/1", "atest/1"];

export async function runPairingFlow(
  initiator: DualAgent,
  joiner: DualAgent,
  options?: { initiatorProfiles?: string[]; joinerProfiles?: string[] },
): Promise<PairingResult> {
  const initiatorProfiles = options?.initiatorProfiles ?? E2E_DEFAULT_PROFILES;
  const joinerProfiles = options?.joinerProfiles ?? E2E_DEFAULT_PROFILES;
  const initResult = structured(
    await handlePairInit(initiator.ctx, {
      scope: ["session.negotiate"],
      mode: "ephemeral_until_session_closes",
      profiles: initiatorProfiles,
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
    profiles: initiatorProfiles,
  });

  const joinApprovalCode = readApprovalCodeForAgent(joiner.ctx, joinResult.pending_id);
  const approved = structured(
    await handleHumanApprove(joiner.ctx, {
      pending_id: joinResult.pending_id,
      decision: "approve",
      approval_code: joinApprovalCode,
      profiles: joinerProfiles,
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

async function putE2eArtifact(agent: DualAgent, blob: Uint8Array, hash: string): Promise<void> {
  const keyPair = await agent.ctx.keyStore.loadOrCreate();
  await agent.ctx.relay.putArtifact(hash, blob, agent.agentId, keyPair.secretKey);
}

export async function runSessionHappyPath(
  initiator: DualAgent,
  joiner: DualAgent,
): Promise<SessionHappyPathResult> {
  const schemaBytes = new TextEncoder().encode(JSON.stringify(E2E_PAYLOAD_SIZE_SCHEMA));
  const artifactHash = hashArtifactBlob(schemaBytes);
  await putE2eArtifact(initiator, schemaBytes, artifactHash);

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

  const openApprovalCode = readApprovalCodeForAgent(joiner.ctx, bobPending.id);
  const approvedOpen = structured(
    await handleHumanApprove(joiner.ctx, {
      pending_id: bobPending.id,
      decision: "approve",
      approval_code: openApprovalCode,
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

  const initiatorAtest = structured(
    await handleAtestRun(initiator.ctx, {
      thread,
      criterion_id: "A1",
      artifact_hash: artifactHash,
    }),
  );
  if (!initiatorAtest.ok) {
    const detail =
      "error" in initiatorAtest && /unavailable/i.test(initiatorAtest.error)
        ? " (install json-schema-faker dev dependency for payload-size runner)"
        : "";
    throw new Error(`initiator atest_run failed: ${JSON.stringify(initiatorAtest)}${detail}`);
  }
  await syncInboxes([initiator.ctx, joiner.ctx]);

  const joinerAtest = structured(
    await handleAtestRun(joiner.ctx, {
      thread,
      criterion_id: "A1",
      artifact_hash: artifactHash,
    }),
  );
  if (!joinerAtest.ok) {
    const detail =
      "error" in joinerAtest && /unavailable/i.test(joinerAtest.error)
        ? " (install json-schema-faker dev dependency for payload-size runner)"
        : "";
    throw new Error(`joiner atest_run failed: ${JSON.stringify(joinerAtest)}${detail}`);
  }
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

  const aliceRatifyCode = readApprovalCodeForAgent(initiator.ctx, aliceRatifyStatus.pending_id);
  const aliceRatify = structured(
    await handleHumanApprove(initiator.ctx, {
      pending_id: aliceRatifyStatus.pending_id,
      decision: "approve",
      approval_code: aliceRatifyCode,
    }),
  );
  if (!aliceRatify.ok) {
    throw new Error(`alice ratify failed: ${JSON.stringify(aliceRatify)}`);
  }
  await syncInboxes([initiator.ctx, joiner.ctx]);

  const bobRatifyCode = readApprovalCodeForAgent(joiner.ctx, bobRatifyStatus.pending_id);
  const bobRatify = structured(
    await handleHumanApprove(joiner.ctx, {
      pending_id: bobRatifyStatus.pending_id,
      decision: "approve",
      approval_code: bobRatifyCode,
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
