import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { init as initPake } from "@agentpair/protocol";
import { createRelayApp } from "@agentpair/relay";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKeyStore } from "../store/keys.js";
import { createPendingQueue } from "../store/pending.js";
import { MemoryAllowlistStore } from "../store/allowlist.js";
import { HttpRelayClient } from "../relay/client.js";
import {
  createAgentContext,
  handlePairInit,
  handlePairJoin,
  handlePairInitComplete,
} from "./pair.js";
import { handleHumanApprove } from "./human-approve.js";
import { assertNoSecrets } from "./util.js";
import { chmod, readFile, stat } from "node:fs/promises";

const TEST_PORT = 3010;
const RELAY_URL = `http://127.0.0.1:${TEST_PORT}`;

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

  async function makeAgent(label: string, hooks: { failAllowlistFor?: string | null } = {}) {
    const dir = await mkdtemp(join(tmpdir(), `agentpair-${label}-`));
    tempDirs.push(dir);
    const keyPath = join(dir, "keys.json");
    return createAgentContext({
      keyStore: createKeyStore({ keyPath }),
      relay: new HttpRelayClient(RELAY_URL, hooks),
      allowlist: new MemoryAllowlistStore(),
      pending: createPendingQueue(),
    });
  }

  function structured<T>(result: { structuredContent: T }): T {
    return result.structuredContent;
  }

  it(
    "pair_init then pair_join with human approval bonds both agents",
    async () => {
      const alice = await makeAgent("alice");
      const bob = await makeAgent("bob");

      const initResult = structured(await handlePairInit(alice, {
        scope: ["session.negotiate"],
        mode: "ephemeral_until_session_closes",
      }));
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

      const approved = structured(
        await handleHumanApprove(bob, {
          pending_id: joinQueued.pending_id,
          decision: "approve",
          via_human: true,
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
    },
    20000,
  );

  it(
    "rolls back allowlists when allowlist push fails",
    async () => {
      const alice = await makeAgent("alice-rollback");
      const bob = await makeAgent("bob-rollback", { failAllowlistFor: "dynamic" });

      const initResult = structured(await handlePairInit(alice, {
        scope: ["session.negotiate"],
        mode: "ephemeral_until_session_closes",
      }));
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
      (bob.relay as HttpRelayClient).testHooks = { failAllowlistFor: bobId };

      const completeInitPromise = handlePairInitComplete(alice, { code: initResult.code });
      const approved = structured(
        await handleHumanApprove(bob, {
          pending_id: joinQueued.pending_id,
          decision: "approve",
          via_human: true,
        }),
      );
      const initComplete = await completeInitPromise;

      expect(approved.ok).toBe(false);
      expect(approved.status).toBe("rolled_back");
      expect(initComplete.status).toBe("rolled_back");

      const aliceKeys = await alice.keyStore.loadOrCreate();
      const aliceId = publicKeyToAgentId(aliceKeys.publicKey);
      expect(alice.allowlist.get(aliceId)).toEqual([]);
      expect(bob.allowlist.get(bobId)).toEqual([]);
    },
    20000,
  );

  it("human_approve rejects agent self-approval without via_human", async () => {
    const bob = await makeAgent("bob-self-approve");
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
