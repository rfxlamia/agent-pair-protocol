import { mkdtemp, rm } from "node:fs/promises";
import { chmod, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init as initPake } from "@agentpair/protocol";
import { createRelayApp } from "@agentpair/relay";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpRelayClient } from "../relay/client.js";
import { MemoryAllowlistStore } from "../store/allowlist.js";
import { createKeyStore } from "../store/keys.js";
import { readApprovalCodeForAgent } from "./approval-test-helpers.js";
import { handleHumanApprove } from "./human-approve.js";
import { getInitiatorCompletionTask } from "./pair-completion.js";
import {
  createAgentContext,
  ensurePendingApprovalReady,
  handlePairInit,
  handlePairInitComplete,
  handlePairInitCompleteTool,
  handlePairJoin,
} from "./pair.js";
import { assertNoSecrets } from "./util.js";

const TEST_PORT = 13110;
const RELAY_URL = `http://127.0.0.1:${TEST_PORT}`;

class FailAllowlistRelay extends HttpRelayClient {
  failAllowlistFor: string | null = null;

  override async putAllowlist(
    agentId: string,
    allowed: string[],
    secretKey: Uint8Array,
  ): Promise<{ ok: boolean }> {
    if (this.failAllowlistFor === agentId) {
      return { ok: false };
    }
    return super.putAllowlist(agentId, allowed, secretKey);
  }
}

describe("mcp pair tools", () => {
  let server: ServerType;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    await initPake();
    const { app } = createRelayApp({
      rateLimitWindowMs: 60_000,
      rateLimitMax: 200,
    });
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: TEST_PORT }, resolve);
    });
  });

  afterAll(async () => {
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
  });

  async function makeAgent(label: string, relay: HttpRelayClient = new HttpRelayClient(RELAY_URL)) {
    const dir = await mkdtemp(join(tmpdir(), `agentpair-${label}-`));
    tempDirs.push(dir);
    const keyPath = join(dir, "keys.json");
    return createAgentContext({
      keyStore: createKeyStore({ keyPath }),
      relay,
      dataDir: dir,
      allowlist: new MemoryAllowlistStore(),
    });
  }

  function structured<T>(result: { structuredContent: T }): T {
    return result.structuredContent;
  }

  it("pair_init then pair_join with human approval bonds both agents", async () => {
    const alice = await makeAgent("alice");
    const bob = await makeAgent("bob");

    const initResult = structured(
      await handlePairInit(alice, {
        scope: ["session.negotiate"],
        mode: "ephemeral_until_session_closes",
      }),
    );
    assertNoSecrets(initResult);
    expect(initResult.ok).toBe(true);
    if (!initResult.ok) {
      return;
    }

    const joinQueued = structured(await handlePairJoin(bob, { code: initResult.code }));
    assertNoSecrets(joinQueued);
    expect(joinQueued.ok).toBe(true);
    if (!joinQueued.ok) {
      return;
    }

    const completeInitPromise = handlePairInitComplete(alice, { code: initResult.code });

    const joinApprovalCode = readApprovalCodeForAgent(bob, joinQueued.pending_id);
    const approved = structured(
      await handleHumanApprove(bob, {
        pending_id: joinQueued.pending_id,
        decision: "approve",
        approval_code: joinApprovalCode,
      }),
    );
    assertNoSecrets(approved);
    expect(approved.ok).toBe(true);
    if (!approved.ok) {
      return;
    }
    expect(approved.status).toBe("bonded");

    const initComplete = await completeInitPromise;
    expect(initComplete.status).toBe("bonded");

    const aliceKeys = await alice.keyStore.loadOrCreate();
    const bobKeys = await bob.keyStore.loadOrCreate();
    const { publicKeyToAgentId } = await import("@agentpair/protocol");
    const aliceId = publicKeyToAgentId(aliceKeys.publicKey);
    const bobId = publicKeyToAgentId(bobKeys.publicKey);

    expect(alice.allowlist.get(aliceId)).toContain(bobId);
    expect(bob.allowlist.get(bobId)).toContain(aliceId);
  }, 20000);

  it("pair_init auto-completes in background without explicit pair_init_complete", async () => {
    const alice = await makeAgent("alice-auto");
    const bob = await makeAgent("bob-auto");

    const initResult = structured(
      await handlePairInit(alice, {
        scope: ["session.negotiate"],
        mode: "ephemeral_until_session_closes",
      }),
    );
    expect(initResult.ok).toBe(true);
    expect(initResult.completion).toBe("initiator_auto_scheduled");
    if (!initResult.ok) {
      return;
    }

    const joinQueued = structured(await handlePairJoin(bob, { code: initResult.code }));
    expect(joinQueued.ok).toBe(true);
    if (!joinQueued.ok) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 3000));

    const joinApprovalCode = readApprovalCodeForAgent(bob, joinQueued.pending_id);
    const approved = structured(
      await handleHumanApprove(bob, {
        pending_id: joinQueued.pending_id,
        decision: "approve",
        approval_code: joinApprovalCode,
      }),
    );
    expect(approved.ok).toBe(true);
    expect(approved.status).toBe("bonded");

    const background = getInitiatorCompletionTask(initResult.code);
    expect(background).toBeDefined();
    if (!background) {
      throw new Error("expected initiator completion task");
    }
    const initComplete = await background;
    expect(initComplete.status).toBe("bonded");

    const aliceKeys = await alice.keyStore.loadOrCreate();
    const bobKeys = await bob.keyStore.loadOrCreate();
    const { publicKeyToAgentId } = await import("@agentpair/protocol");
    const aliceId = publicKeyToAgentId(aliceKeys.publicKey);
    const bobId = publicKeyToAgentId(bobKeys.publicKey);

    expect(alice.bonds.find(aliceId, bobId)).toBeDefined();
    expect(bob.bonds.find(bobId, aliceId)).toBeDefined();
  }, 30000);

  it("pair_init_complete returns cached bond without re-running handshake", async () => {
    const alice = await makeAgent("alice-cache");
    const bob = await makeAgent("bob-cache");

    const initResult = structured(
      await handlePairInit(alice, {
        scope: ["session.negotiate"],
        mode: "ephemeral_until_session_closes",
      }),
    );
    if (!initResult.ok) {
      return;
    }

    const joinQueued = structured(await handlePairJoin(bob, { code: initResult.code }));
    if (!joinQueued.ok) {
      return;
    }

    const joinApprovalCode = readApprovalCodeForAgent(bob, joinQueued.pending_id);
    const approved = structured(
      await handleHumanApprove(bob, {
        pending_id: joinQueued.pending_id,
        decision: "approve",
        approval_code: joinApprovalCode,
      }),
    );
    expect(approved.ok).toBe(true);

    const background = getInitiatorCompletionTask(initResult.code);
    if (background) {
      await background;
    }

    const retry = structured(await handlePairInitCompleteTool(alice, { code: initResult.code }));
    expect(retry.ok).toBe(true);
    expect(retry.status).toBe("bonded");
  }, 20000);

  it("pair_init_complete reports pair_session_lost for unknown code", async () => {
    const alice = await makeAgent("alice-lost");
    const result = structured(await handlePairInitCompleteTool(alice, { code: "9-fake-codes" }));
    expect(result.ok).toBe(false);
    expect(result.error).toBe("pair_session_lost");
  });

  it("pair_init_complete tool bonds initiator when called in parallel with joiner approval", async () => {
    const alice = await makeAgent("alice-tool");
    const bob = await makeAgent("bob-tool");

    const initResult = structured(
      await handlePairInit(alice, {
        scope: ["session.negotiate"],
        mode: "ephemeral_until_session_closes",
      }),
    );
    expect(initResult.ok).toBe(true);
    if (!initResult.ok) {
      return;
    }

    const joinQueued = structured(await handlePairJoin(bob, { code: initResult.code }));
    expect(joinQueued.ok).toBe(true);
    if (!joinQueued.ok) {
      return;
    }

    const completeInitPromise = handlePairInitCompleteTool(alice, {
      code: initResult.code,
    });

    const joinApprovalCode = readApprovalCodeForAgent(bob, joinQueued.pending_id);
    const approved = structured(
      await handleHumanApprove(bob, {
        pending_id: joinQueued.pending_id,
        decision: "approve",
        approval_code: joinApprovalCode,
      }),
    );
    expect(approved.ok).toBe(true);
    if (!approved.ok) {
      return;
    }

    const initComplete = structured(await completeInitPromise);
    expect(initComplete.ok).toBe(true);
    expect(initComplete.status).toBe("bonded");
    assertNoSecrets(initComplete);

    const aliceKeys = await alice.keyStore.loadOrCreate();
    const bobKeys = await bob.keyStore.loadOrCreate();
    const { publicKeyToAgentId } = await import("@agentpair/protocol");
    const aliceId = publicKeyToAgentId(aliceKeys.publicKey);
    const bobId = publicKeyToAgentId(bobKeys.publicKey);

    expect(alice.bonds.find(aliceId, bobId)).toBeDefined();
    expect(bob.bonds.find(bobId, aliceId)).toBeDefined();
  }, 20000);

  it("rolls back allowlists when allowlist push fails", async () => {
    const bobRelay = new FailAllowlistRelay(RELAY_URL);
    const alice = await makeAgent("alice-rollback");
    const bob = await makeAgent("bob-rollback", bobRelay);

    const initResult = structured(
      await handlePairInit(alice, {
        scope: ["session.negotiate"],
        mode: "ephemeral_until_session_closes",
      }),
    );
    if (!initResult.ok) {
      throw new Error("pair init failed");
    }

    const joinQueued = structured(await handlePairJoin(bob, { code: initResult.code }));
    if (!joinQueued.ok) {
      throw new Error("pair join queue failed");
    }

    const bobKeys = await bob.keyStore.loadOrCreate();
    const { publicKeyToAgentId } = await import("@agentpair/protocol");
    const bobId = publicKeyToAgentId(bobKeys.publicKey);
    bobRelay.failAllowlistFor = bobId;

    const completeInitPromise = handlePairInitComplete(alice, { code: initResult.code });
    const joinApprovalCode = readApprovalCodeForAgent(bob, joinQueued.pending_id);
    const approved = structured(
      await handleHumanApprove(bob, {
        pending_id: joinQueued.pending_id,
        decision: "approve",
        approval_code: joinApprovalCode,
      }),
    );
    const initComplete = await completeInitPromise;

    expect(approved.ok).toBe(false);
    expect(approved.status).toBe("rolled_back");
    expect(approved.reason).toBe("allowlist_push_failed");
    expect(initComplete.status).toBe("rolled_back");
    if (initComplete.status === "rolled_back") {
      expect(initComplete.reason).toBe("bond_aborted");
    }

    const aliceKeys = await alice.keyStore.loadOrCreate();
    const aliceId = publicKeyToAgentId(aliceKeys.publicKey);
    expect(alice.allowlist.get(aliceId)).toEqual([]);
    expect(bob.allowlist.get(bobId)).toEqual([]);
  }, 20000);

  it("human_approve rejects agent self-approval without via_human", async () => {
    const bob = await makeAgent("bob-self-approve");
    await ensurePendingApprovalReady(bob);
    const pending = bob.pending.add({
      code: "1-kancil-senja",
      proposal: {
        scope: ["session.negotiate"],
        mode: "ephemeral_until_session_closes",
        initiatorAgentId: "ed25519:fake",
      },
    });

    const result = structured(
      await handleHumanApprove(bob, {
        pending_id: pending.id,
        decision: "approve",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe("self_approval_forbidden");
    assertNoSecrets(result);
  });

  it("stores keys in a local file with mode 0600", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentpair-keys-"));
    tempDirs.push(dir);
    const keyPath = join(dir, "keys.json");
    const store = createKeyStore({ keyPath });
    await store.loadOrCreate();

    const fileStat = await stat(keyPath);
    expect(fileStat.mode & 0o777).toBe(0o600);

    const raw = await readFile(keyPath, "utf8");
    const parsed = JSON.parse(raw) as { secretKey: string; publicKey: string };
    expect(typeof parsed.secretKey).toBe("string");
    expect(typeof parsed.publicKey).toBe("string");

    await chmod(keyPath, 0o600);
  });
});
