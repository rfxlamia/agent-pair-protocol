import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOuterEnvelope,
  defaultEnvelopeTtl,
  deserializeOuterEnvelope,
  generateKeyPair,
  init as initPake,
  parseEnvelopeBody,
  publicKeyToAgentId,
  serializeOuterEnvelope,
  verifyOuterEnvelope,
} from "@agentpair/protocol";
import { createRelayApp } from "@agentpair/relay";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
import { handleSessionOpen, handleSessionStatus } from "./session.js";

const SESSION_OPEN_INPUT = {
  acceptance: [{ id: "A1", test: "executable" as const, desc: "probe", runner: "payload-size" }],
  budget: { max_turns: 10 },
  mandate: { agent_may: ["propose"], human_required: ["sign_final"] },
};

async function pairBondedAgents(
  alice: Awaited<ReturnType<typeof createAgentContext>>,
  bob: Awaited<ReturnType<typeof createAgentContext>>,
) {
  const initResult = structured(
    await handlePairInit(alice, {
      scope: ["session.negotiate"],
      mode: "bonded_contact",
    }),
  );
  if (!initResult.ok) throw new Error("pair init failed");

  const joinQueued = structured(await handlePairJoin(bob, { code: initResult.code }));
  if (!joinQueued.ok) throw new Error("pair join failed");

  const completeInitPromise = completeInitiatorPairing(alice, initResult.code);
  await handleHumanApprove(bob, {
    pending_id: joinQueued.pending_id,
    decision: "approve",
    via_human: true,
  });
  await completeInitPromise;

  const aliceKeys = await alice.keyStore.loadOrCreate();
  const bobKeys = await bob.keyStore.loadOrCreate();
  return {
    aliceId: publicKeyToAgentId(aliceKeys.publicKey),
    bobId: publicKeyToAgentId(bobKeys.publicKey),
    aliceKeys,
    bobKeys,
  };
}

const TEST_PORT = 13111;
const RELAY_URL = `http://127.0.0.1:${TEST_PORT}`;

class FailAllowlistOnRevokeRelay extends HttpRelayClient {
  failPutFor: string | null = null;
  failPurge = false;
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
    if (this.failPurge) {
      return { ok: false as const, error: "inbox_purge_failed_500" };
    }
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

  it("handleInbox verifies v1 outer envelopes with sender public key", async () => {
    const bob = await makeAgent("inbox-crash");
    const aliceKeys = generateKeyPair();
    const bobKeys = await bob.keyStore.loadOrCreate();
    const aliceId = publicKeyToAgentId(aliceKeys.publicKey);
    const bobId = publicKeyToAgentId(bobKeys.publicKey);

    const outer = createOuterEnvelope({
      sender: aliceKeys,
      recipientAgentId: bobId,
      type: "core.msg",
      thread: "thread-verify",
      seq: 1,
      ttl: defaultEnvelopeTtl(),
      payload: new TextEncoder().encode(JSON.stringify({ body: "hello" })),
    });

    expect(verifyOuterEnvelope(outer, bobKeys.publicKey)).toBe(false);
    expect(verifyOuterEnvelope(outer, aliceKeys.publicKey)).toBe(true);

    bob.allowlist.set(bobId, [aliceId]);
    await bob.relay.putAllowlist(bobId, [aliceId], bobKeys.secretKey);
    await bob.relay.sendEnvelope(bobId, outer);

    const inboxResult = structured(await handleInbox(bob, { since: 0 }));
    expect(inboxResult.ok).toBe(true);
    if (!inboxResult.ok) {
      return;
    }
    expect(inboxResult.envelopes).toHaveLength(1);
    expect(inboxResult.envelopes[0]?.verified).toBe(true);
    expect(inboxResult.envelopes[0]?.payload).toEqual({ body: "hello" });
  });

  it("relay client round-trips v1 outer wire via deserializeOuterEnvelope", async () => {
    const aliceKeys = generateKeyPair();
    const bobKeys = generateKeyPair();
    const bobId = publicKeyToAgentId(bobKeys.publicKey);

    const outer = createOuterEnvelope({
      sender: aliceKeys,
      recipientAgentId: bobId,
      type: "core.msg",
      thread: "thread-wire",
      seq: 1,
      ttl: 3600,
      payload: new TextEncoder().encode(JSON.stringify({ body: "wire-test" })),
    });
    const wire = serializeOuterEnvelope(outer);

    const challenge = "test-challenge-nonce";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/inbox/") && !url.includes("challenge=")) {
        return new Response(JSON.stringify({ challenge }), { status: 401 });
      }
      if (url.includes("challenge=") && url.includes("sig=")) {
        return new Response(JSON.stringify({ envelopes: [wire], rowids: [1], cursor: 1 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(input, init);
    };

    try {
      const client = new HttpRelayClient(RELAY_URL);
      const pull = await client.pullInbox(bobKeys, 0, { bonded_only: false });
      expect(pull.ok).toBe(true);
      if (!pull.ok) {
        return;
      }
      expect(pull.wires).toHaveLength(1);
      expect(pull.rowids).toEqual([1]);
      const wire = pull.wires[0];
      if (!wire) {
        return;
      }
      const pulled = deserializeOuterEnvelope(wire);
      expect(pulled).toEqual(outer);
      if (!pulled) {
        return;
      }
      expect(serializeOuterEnvelope(pulled)).toBe(wire);
      expect(verifyOuterEnvelope(pulled, aliceKeys.publicKey)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
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

    const first = structured(await handleSend(alice, { to: bobId, body: "one", thread }));
    const second = structured(await handleSend(alice, { to: bobId, body: "two", thread }));

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

  it("handleRevoke clears bonds store without sending revoke.notice", async () => {
    const alice = await makeAgent("alice-revoke");
    const bob = await makeAgent("bob-revoke");
    const { aliceId, bobId } = await pairBondedAgents(alice, bob);

    const sent = structured(
      await handleSend(bob, {
        to: aliceId,
        body: "before revoke",
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

    const inboxBefore = await bob.relay.pullInbox(await bob.keyStore.loadOrCreate(), 0, {
      bonded_only: false,
    });
    expect(inboxBefore.ok).toBe(true);
    if (inboxBefore.ok) {
      const revokeNotice = inboxBefore.wires.find((wire) => {
        try {
          return parseEnvelopeBody(deserializeOuterEnvelope(wire)).type === "revoke.notice";
        } catch {
          return false;
        }
      });
      expect(revokeNotice).toBeUndefined();
      expect(
        inboxBefore.wires.some((wire) => {
          try {
            const body = parseEnvelopeBody(deserializeOuterEnvelope(wire));
            return body.type === "core.msg" && body.from === aliceId;
          } catch {
            return false;
          }
        }),
      ).toBe(false);
    }
  });

  describe("handleRevoke N5 contract", () => {
    it("closes live session locally and returns revoked peer id", async () => {
      const alice = await makeAgent("revoke-live-alice");
      const bob = await makeAgent("revoke-live-bob");
      const { aliceId, bobId } = await pairBondedAgents(alice, bob);

      const opened = structured(
        await handleSessionOpen(alice, {
          to: bobId,
          goal: "revoke closes live",
          ...SESSION_OPEN_INPUT,
        }),
      );
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;

      const bobBootstrap = structured(await handleInbox(bob, { since: 0 }));
      expect(bobBootstrap.ok).toBe(true);
      if (!bobBootstrap.ok) return;
      const bobPending = bob.pending.list().find((item) => item.kind === "session_open");
      expect(bobPending).toBeDefined();
      if (!bobPending) return;

      await handleHumanApprove(bob, {
        pending_id: bobPending.id,
        decision: "approve",
        via_human: true,
      });
      structured(await handleInbox(alice, { since: 0 }));

      const liveStatus = structured(await handleSessionStatus(alice, { thread: opened.thread }));
      expect(liveStatus.status).toBe("live");

      const revoked = structured(await handleRevoke(alice, { peer: bobId }));
      expect(revoked.ok).toBe(true);
      if (!revoked.ok) return;
      expect(revoked.revoked).toBe(bobId);

      const closedStatus = structured(await handleSessionStatus(alice, { thread: opened.thread }));
      expect(closedStatus.status).toBe("closed");
      expect(closedStatus.reject_reason).toBe("bond_revoked");
      expect(alice.bonds.find(aliceId, bobId)).toBeUndefined();
    });

    it("closes sessions and removes bond when allowlist push fails (convergent)", async () => {
      const aliceRelay = new FailAllowlistOnRevokeRelay(RELAY_URL);
      const alice = await makeAgent("revoke-push-fail-alice");
      alice.relay = aliceRelay;
      const bob = await makeAgent("revoke-push-fail-bob");
      const { aliceId, bobId } = await pairBondedAgents(alice, bob);

      const opened = structured(
        await handleSessionOpen(alice, {
          to: bobId,
          goal: "push fail still closes",
          ...SESSION_OPEN_INPUT,
        }),
      );
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;

      aliceRelay.failPutFor = aliceId;
      const revoked = structured(await handleRevoke(alice, { peer: bobId }));

      expect(revoked.ok).toBe(true);
      if (!revoked.ok) return;
      expect(revoked.allowlist_push_incomplete).toBe(true);
      expect(aliceRelay.purgeCalled).toBe(true);
      expect(alice.allowlist.get(aliceId)).not.toContain(bobId);
      expect(alice.bonds.find(aliceId, bobId)).toBeUndefined();

      const status = structured(await handleSessionStatus(alice, { thread: opened.thread }));
      expect(status.status).toBe("closed");
      expect(status.reject_reason).toBe("bond_revoked");
    });

    it("reports inbox_purge_incomplete only when purge fails but push succeeds", async () => {
      const aliceRelay = new FailAllowlistOnRevokeRelay(RELAY_URL);
      aliceRelay.failPurge = true;
      const alice = await makeAgent("revoke-purge-only-fail");
      alice.relay = aliceRelay;
      const bob = await makeAgent("revoke-purge-only-bob");
      const { aliceId, bobId } = await pairBondedAgents(alice, bob);

      const revoked = structured(await handleRevoke(alice, { peer: bobId }));
      expect(revoked.ok).toBe(true);
      if (!revoked.ok) return;
      expect(revoked.inbox_purge_incomplete).toBe(true);
      expect(revoked.purge_warning).toBe("inbox_purge_failed_500");
      expect(revoked.allowlist_push_incomplete).toBeUndefined();
      expect(aliceRelay.purgeCalled).toBe(true);
      expect(alice.allowlist.get(aliceId)).not.toContain(bobId);
      expect(alice.bonds.find(aliceId, bobId)).toBeUndefined();
    });

    it("reports both incomplete flags when purge and push both fail", async () => {
      const aliceRelay = new FailAllowlistOnRevokeRelay(RELAY_URL);
      aliceRelay.failPurge = true;
      const alice = await makeAgent("revoke-both-fail");
      alice.relay = aliceRelay;
      const bob = await makeAgent("revoke-both-fail-bob");
      const { aliceId, bobId } = await pairBondedAgents(alice, bob);

      aliceRelay.failPutFor = aliceId;
      const revoked = structured(await handleRevoke(alice, { peer: bobId }));
      expect(revoked.ok).toBe(true);
      if (!revoked.ok) return;
      expect(revoked.inbox_purge_incomplete).toBe(true);
      expect(revoked.allowlist_push_incomplete).toBe(true);
      expect(alice.bonds.find(aliceId, bobId)).toBeUndefined();
      expect(alice.allowlist.get(aliceId)).not.toContain(bobId);
    });

    it("retries purge and push on idempotent revoke with no_bond_found", async () => {
      const aliceRelay = new FailAllowlistOnRevokeRelay(RELAY_URL);
      const alice = await makeAgent("revoke-retry");
      alice.relay = aliceRelay;
      const bob = await makeAgent("revoke-retry-bob");
      const { aliceId, bobId } = await pairBondedAgents(alice, bob);

      const opened = structured(
        await handleSessionOpen(alice, {
          to: bobId,
          goal: "idempotent retry",
          ...SESSION_OPEN_INPUT,
        }),
      );
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;

      aliceRelay.failPutFor = aliceId;
      const first = structured(await handleRevoke(alice, { peer: bobId }));
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.allowlist_push_incomplete).toBe(true);

      aliceRelay.failPutFor = null;
      aliceRelay.failPurge = false;
      aliceRelay.purgeCalled = false;
      const putSpy = vi.spyOn(aliceRelay, "putAllowlist");

      const second = structured(await handleRevoke(alice, { peer: bobId }));
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.no_bond_found).toBe(true);
      expect(aliceRelay.purgeCalled).toBe(true);
      expect(putSpy).toHaveBeenCalled();

      const status = structured(await handleSessionStatus(alice, { thread: opened.thread }));
      expect(status.status).toBe("closed");
      expect(status.reject_reason).toBe("bond_revoked");
    });

    it("reports no_bond_found for never-bonded peer but still pushes allowlist", async () => {
      const alice = await makeAgent("revoke-no-bond");
      const aliceKeys = await alice.keyStore.loadOrCreate();
      const aliceId = publicKeyToAgentId(aliceKeys.publicKey);
      const unknownPeer = publicKeyToAgentId(generateKeyPair().publicKey);
      const putSpy = vi.spyOn(alice.relay, "putAllowlist");

      const revoked = structured(await handleRevoke(alice, { peer: unknownPeer }));
      expect(revoked.ok).toBe(true);
      if (!revoked.ok) return;
      expect(revoked.no_bond_found).toBe(true);
      expect(putSpy.mock.calls.length).toBeGreaterThan(0);
      expect(alice.allowlist.get(aliceId)).not.toContain(unknownPeer);
    });
  });

  describe("N5 revoke integration", () => {
    it("revoke then human_approve returns pending_not_found with no outbound", async () => {
      const alice = await makeAgent("n5-revoke-approve-alice");
      const bob = await makeAgent("n5-revoke-approve-bob");
      const { aliceId, bobId, bobKeys } = await pairBondedAgents(alice, bob);

      const opened = structured(
        await handleSessionOpen(bob, {
          to: aliceId,
          goal: "revoke wins over approve",
          ...SESSION_OPEN_INPUT,
        }),
      );
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;

      const aliceBootstrap = structured(await handleInbox(alice, { since: 0 }));
      expect(aliceBootstrap.ok).toBe(true);
      if (!aliceBootstrap.ok) return;
      const sessionOpenPending = alice.pending.list().find((item) => item.kind === "session_open");
      expect(sessionOpenPending).toBeDefined();
      if (!sessionOpenPending) return;
      const pendingId = sessionOpenPending.id;

      const inboxBefore = await bob.relay.pullInbox(bobKeys, 0, { bonded_only: false });
      const cursorBefore = inboxBefore.ok ? (inboxBefore.cursor ?? 0) : 0;

      const revoked = structured(await handleRevoke(alice, { peer: bobId }));
      expect(revoked.ok).toBe(true);

      const approve = structured(
        await handleHumanApprove(alice, {
          pending_id: pendingId,
          decision: "approve",
          via_human: true,
        }),
      );
      expect(approve.ok).toBe(false);
      if (approve.ok) return;
      expect(approve.error).toBe("pending_not_found");

      const inboxAfter = await bob.relay.pullInbox(bobKeys, cursorBefore, { bonded_only: false });
      expect(inboxAfter.ok).toBe(true);
      if (!inboxAfter.ok) return;
      const openApproved = inboxAfter.wires.filter((wire) => {
        try {
          const body = parseEnvelopeBody(deserializeOuterEnvelope(wire));
          return body.type === "nego.open_approved" && body.thread === opened.thread;
        } catch {
          return false;
        }
      });
      expect(openApproved).toHaveLength(0);
    });

    it("inbound nego.open_approved on bond_revoked session returns thread_closed", async () => {
      const alice = await makeAgent("n5-inbound-guard-alice");
      const bob = await makeAgent("n5-inbound-guard-bob");
      const { bobId } = await pairBondedAgents(alice, bob);

      const opened = structured(
        await handleSessionOpen(alice, {
          to: bobId,
          goal: "inbound guard after revoke",
          ...SESSION_OPEN_INPUT,
        }),
      );
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;

      const bobBootstrap = structured(await handleInbox(bob, { since: 0 }));
      expect(bobBootstrap.ok).toBe(true);
      if (!bobBootstrap.ok) return;
      const bobPending = bob.pending.list().find((item) => item.kind === "session_open");
      expect(bobPending).toBeDefined();
      if (!bobPending) return;

      await handleHumanApprove(bob, {
        pending_id: bobPending.id,
        decision: "approve",
        via_human: true,
      });
      structured(await handleInbox(alice, { since: 0 }));

      const revoked = structured(await handleRevoke(alice, { peer: bobId }));
      expect(revoked.ok).toBe(true);

      const before = alice.sessionStore.get(opened.thread);
      expect(before?.rejectReason).toBe("bond_revoked");

      const { processSessionInboxEnvelope } = await import("./session.js");
      const result = structured(
        await processSessionInboxEnvelope(alice, {
          from: bobId,
          type: "nego.open_approved",
          thread: opened.thread,
          payload: JSON.stringify({ thread: opened.thread }),
        }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe("thread_closed");
      expect(alice.sessionStore.get(opened.thread)).toEqual(before);
    });
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
