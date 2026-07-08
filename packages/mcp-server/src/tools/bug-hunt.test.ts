import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEnvelope,
  generateKeyPair,
  init as initPake,
  publicKeyToAgentId,
  verifyEnvelope,
} from "@agentpair/protocol";
import { createRelayApp } from "@agentpair/relay";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpRelayClient } from "../relay/client.js";
import { MemoryAllowlistStore, createFileAllowlistStore } from "../store/allowlist.js";
import { MemoryBondStore } from "../store/bonds.js";
import { createKeyStore } from "../store/keys.js";
import { createPendingQueue } from "../store/pending.js";
import { handleHumanApprove } from "./human-approve.js";
import { completeInitiatorPairing } from "./human-approve.js";
import { handleInbox, handleSend } from "./inbox.js";
import {
  createAgentContext,
  handlePairInit,
  handlePairInitComplete,
  handlePairJoin,
  handleRevoke,
} from "./pair.js";

const TEST_PORT = 3011;
const RELAY_URL = `http://127.0.0.1:${TEST_PORT}`;

class FailAllowlistOnRevokeRelay extends HttpRelayClient {
  failPutFor: string | null = null;
  purgeCalled = false;

  override async putAllowlist(
    agentId: string,
    allowed: string[],
    secretKey: Uint8Array,
  ): Promise<{ ok: boolean }> {
    if (this.failPutFor === agentId) {
      return { ok: false };
    }
    return super.putAllowlist(agentId, allowed, secretKey);
  }

  override async purgeInboxDyad(
    peerAgentId: string,
    keyPair: Parameters<HttpRelayClient["purgeInboxDyad"]>[1],
  ) {
    this.purgeCalled = true;
    return super.purgeInboxDyad(peerAgentId, keyPair);
  }
}

function structured<T>(result: { structuredContent: T }): T {
  return result.structuredContent;
}

describe("bug hunt — T4/T6 behavioral gaps", () => {
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
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function makeAgent(label: string) {
    const dir = await mkdtemp(join(tmpdir(), `agentpair-bughunt-${label}-`));
    tempDirs.push(dir);
    return createAgentContext({
      keyStore: createKeyStore({ keyPath: join(dir, "keys.json") }),
      relay: new HttpRelayClient(RELAY_URL),
      allowlist: new MemoryAllowlistStore(),
      bonds: new MemoryBondStore(),
      pending: createPendingQueue(),
    });
  }

  it("handleInbox verifies envelopes with sender public key", async () => {
    const bob = await makeAgent("inbox-crash");
    const aliceKeys = generateKeyPair();
    const bobKeys = await bob.keyStore.loadOrCreate();
    const aliceId = publicKeyToAgentId(aliceKeys.publicKey);
    const bobId = publicKeyToAgentId(bobKeys.publicKey);

    const envelope = createEnvelope({
      sender: aliceKeys,
      recipientAgentId: bobId,
      type: "chat.message",
      thread: "thread-verify",
      seq: 1,
      ttl: 3600,
      payload: new TextEncoder().encode("hello"),
    });

    expect(() => verifyEnvelope(envelope)).toThrow(/publicKey/);
    expect(verifyEnvelope(envelope, aliceKeys.publicKey)).toBe(true);

    bob.allowlist.set(bobId, [aliceId]);
    await bob.relay.putAllowlist(bobId, [aliceId], bobKeys.secretKey);
    await bob.relay.sendEnvelope(bobId, envelope);

    const inboxResult = structured(await handleInbox(bob, { since: 0 }));
    expect(inboxResult.ok).toBe(true);
    if (!inboxResult.ok) {
      return;
    }
    expect(inboxResult.envelopes).toHaveLength(1);
    expect(inboxResult.envelopes[0]?.verified).toBe(true);
    expect(inboxResult.envelopes[0]?.payload).toBe("hello");
  });

  it("handleSend increments seq per thread", async () => {
    const alice = await makeAgent("alice-seq");
    const bob = await makeAgent("bob-seq");

    const aliceKeys = await alice.keyStore.loadOrCreate();
    const bobKeys = await bob.keyStore.loadOrCreate();
    const aliceId = publicKeyToAgentId(aliceKeys.publicKey);
    const bobId = publicKeyToAgentId(bobKeys.publicKey);

    alice.allowlist.set(aliceId, [bobId]);
    bob.allowlist.set(bobId, [aliceId]);
    await alice.relay.putAllowlist(aliceId, [bobId], aliceKeys.secretKey);
    await bob.relay.putAllowlist(bobId, [aliceId], bobKeys.secretKey);

    const thread = "fixed-thread-id";

    const first = structured(
      await handleSend(alice, { to: bobId, type: "chat.message", payload: "one", thread }),
    );
    const second = structured(
      await handleSend(alice, { to: bobId, type: "chat.message", payload: "two", thread }),
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(first.thread).toBe(thread);
    expect(second.thread).toBe(thread);
  });

  it("handlePairInitComplete populates initiator bonds store", async () => {
    const alice = await makeAgent("alice-bonds");
    const bob = await makeAgent("bob-bonds");

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
      throw new Error("pair join failed");
    }

    const completeInitPromise = handlePairInitComplete(alice, { code: initResult.code });
    const approved = structured(
      await handleHumanApprove(bob, {
        pending_id: joinQueued.pending_id,
        decision: "approve",
        via_human: true,
      }),
    );
    const initComplete = await completeInitPromise;

    expect(approved.ok).toBe(true);
    expect(initComplete.status).toBe("bonded");

    const aliceKeys = await alice.keyStore.loadOrCreate();
    const bobKeys = await bob.keyStore.loadOrCreate();
    const aliceId = publicKeyToAgentId(aliceKeys.publicKey);
    const bobId = publicKeyToAgentId(bobKeys.publicKey);

    expect(alice.bonds.find(aliceId, bobId)).toBeDefined();
    expect(bob.bonds.find(bobId, aliceId)).toBeDefined();
  });

  it("completeInitiatorPairing populates initiator bonds", async () => {
    const alice = await makeAgent("alice-complete");
    const bob = await makeAgent("bob-complete");

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
      throw new Error("pair join failed");
    }

    const completeInitPromise = completeInitiatorPairing(alice, initResult.code);
    await handleHumanApprove(bob, {
      pending_id: joinQueued.pending_id,
      decision: "approve",
      via_human: true,
    });
    const initComplete = await completeInitPromise;

    expect(initComplete.status).toBe("bonded");

    const aliceKeys = await alice.keyStore.loadOrCreate();
    const bobKeys = await bob.keyStore.loadOrCreate();
    const aliceId = publicKeyToAgentId(aliceKeys.publicKey);
    const bobId = publicKeyToAgentId(bobKeys.publicKey);

    expect(alice.bonds.find(aliceId, bobId)).toBeDefined();
    expect(bob.bonds.find(bobId, aliceId)).toBeDefined();
  });

  it("handleRevoke sends revoke.notice and clears bonds store", async () => {
    const alice = await makeAgent("alice-revoke");
    const bob = await makeAgent("bob-revoke");

    const initResult = structured(
      await handlePairInit(alice, {
        scope: ["session.negotiate"],
        mode: "bonded_contact",
      }),
    );
    if (!initResult.ok) {
      throw new Error("pair init failed");
    }

    const joinQueued = structured(await handlePairJoin(bob, { code: initResult.code }));
    if (!joinQueued.ok) {
      throw new Error("pair join failed");
    }

    const completeInitPromise = completeInitiatorPairing(alice, initResult.code);
    await handleHumanApprove(bob, {
      pending_id: joinQueued.pending_id,
      decision: "approve",
      via_human: true,
    });
    await completeInitPromise;

    const aliceKeys = await alice.keyStore.loadOrCreate();
    const bobKeys = await bob.keyStore.loadOrCreate();
    const aliceId = publicKeyToAgentId(aliceKeys.publicKey);
    const bobId = publicKeyToAgentId(bobKeys.publicKey);

    const sent = structured(
      await handleSend(alice, {
        to: bobId,
        type: "chat.message",
        payload: "before revoke",
      }),
    );
    expect(sent.ok).toBe(true);

    const revoked = structured(await handleRevoke(alice, { peer: bobId }));
    expect(revoked.ok).toBe(true);
    if (revoked.ok) {
      expect(revoked.purged).toBeGreaterThan(0);
    }

    expect(alice.allowlist.get(aliceId)).not.toContain(bobId);
    expect(alice.bonds.find(aliceId, bobId)).toBeUndefined();

    const inboxBefore = await bob.relay.pullInbox(bobKeys, 0, { bonded_only: false });
    expect(inboxBefore.ok).toBe(true);
    if (inboxBefore.ok) {
      const revokeNotice = inboxBefore.envelopes.find((e) => e.type === "revoke.notice");
      expect(revokeNotice).toBeDefined();
      expect(
        inboxBefore.envelopes.some(
          (envelope) => envelope.type === "chat.message" && envelope.from === aliceId,
        ),
      ).toBe(false);
    }
  });

  it("handleRevoke does not purge or mutate bonds when allowlist push fails", async () => {
    const aliceRelay = new FailAllowlistOnRevokeRelay(RELAY_URL);
    const alice = await makeAgent("alice-revoke-fail");
    alice.relay = aliceRelay;
    const bob = await makeAgent("bob-revoke-fail");

    const initResult = structured(
      await handlePairInit(alice, {
        scope: ["session.negotiate"],
        mode: "bonded_contact",
      }),
    );
    if (!initResult.ok) {
      throw new Error("pair init failed");
    }

    const joinQueued = structured(await handlePairJoin(bob, { code: initResult.code }));
    if (!joinQueued.ok) {
      throw new Error("pair join failed");
    }

    const completeInitPromise = completeInitiatorPairing(alice, initResult.code);
    await handleHumanApprove(bob, {
      pending_id: joinQueued.pending_id,
      decision: "approve",
      via_human: true,
    });
    await completeInitPromise;

    const aliceKeys = await alice.keyStore.loadOrCreate();
    const bobKeys = await bob.keyStore.loadOrCreate();
    const aliceId = publicKeyToAgentId(aliceKeys.publicKey);
    const bobId = publicKeyToAgentId(bobKeys.publicKey);

    aliceRelay.failPutFor = aliceId;
    const revoked = structured(await handleRevoke(alice, { peer: bobId }));
    expect(revoked.ok).toBe(false);
    expect(aliceRelay.purgeCalled).toBe(false);
    expect(alice.allowlist.get(aliceId)).toContain(bobId);
    expect(alice.bonds.find(aliceId, bobId)).toBeDefined();
  });

  it("createFileAllowlistStore get() reads persisted allowlist synchronously", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentpair-allowlist-race-"));
    tempDirs.push(dir);
    const filePath = join(dir, "allowlist.json");
    const store = createFileAllowlistStore({ filePath, agentId: "agent-a" });

    await store.init("agent-a");
    store.set("agent-a", ["peer-1"]);
    await store.flush();

    const cold = createFileAllowlistStore({ filePath, agentId: "agent-a" });
    const immediate = cold.get("agent-a");
    expect(immediate).toContain("peer-1");

    await cold.init("agent-a");
    expect(cold.get("agent-a")).toContain("peer-1");
  });
});
