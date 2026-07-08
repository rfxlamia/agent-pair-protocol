import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Envelope,
  type KeyPair,
  createEnvelope,
  generateKeyPair,
  publicKeyToAgentId,
} from "@agentpair/protocol";
import { describe, expect, it } from "vitest";
import type { HttpRelayClient } from "../relay/client.js";
import { MemoryAllowlistStore } from "../store/allowlist.js";
import { MemoryBondStore } from "../store/bonds.js";
import { MemoryInboxCursorStore } from "../store/inbox-cursor.js";
import { createKeyStore } from "../store/keys.js";
import { createPendingQueue } from "../store/pending.js";
import { handleInbox } from "./inbox.js";
import { createAgentContext } from "./pair.js";

function structured<T>(result: { structuredContent: T }): T {
  return result.structuredContent;
}

class StubInboxRelay {
  pulls: number[] = [];
  pullBondedOnly: boolean[] = [];
  private pullIndex = 0;
  responses: Array<{
    envelopes: Envelope[];
    cursor?: number;
  }>;

  constructor(responses: Array<{ envelopes: Envelope[]; cursor?: number }>) {
    this.responses = responses;
  }

  async pullInbox(_keyPair: KeyPair, since = 0, options: { bonded_only?: boolean } = {}) {
    this.pulls.push(since);
    this.pullBondedOnly.push(options.bonded_only !== false);
    const next = this.responses[this.pullIndex] ?? { envelopes: [], cursor: since };
    this.pullIndex += 1;
    return {
      ok: true as const,
      envelopes: next.envelopes,
      cursor: next.cursor,
    };
  }
}

function makeEnvelope(sender: KeyPair, recipientId: string, body: string, seq: number): Envelope {
  return createEnvelope({
    sender,
    recipientAgentId: recipientId,
    type: "chat.message",
    thread: `thread-${seq}`,
    seq,
    ttl: 3600,
    payload: new TextEncoder().encode(body),
  });
}

describe("inbox hygiene — cursor persistence and bonded filter", () => {
  it("persists cursor across new AgentContext with same dataDir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentpair-inbox-cursor-"));
    try {
      const relay = new StubInboxRelay([{ envelopes: [], cursor: 42 }]);
      const ctx1 = createAgentContext({
        keyStore: createKeyStore({ keyPath: join(dir, "keys.json") }),
        relay: relay as unknown as HttpRelayClient,
        dataDir: dir,
      });
      const keys = await ctx1.keyStore.loadOrCreate();
      void publicKeyToAgentId(keys.publicKey);

      const first = structured(await handleInbox(ctx1, {}));
      expect(first.ok).toBe(true);
      if (!first.ok) {
        return;
      }
      expect(first.cursor).toBe(42);
      expect(relay.pulls).toEqual([0]);
      await ctx1.inboxCursor.flush();

      const ctx2 = createAgentContext({
        keyStore: createKeyStore({ keyPath: join(dir, "keys.json") }),
        relay: relay as unknown as HttpRelayClient,
        dataDir: dir,
      });
      relay.responses.push({ envelopes: [], cursor: 55 });
      const second = structured(await handleInbox(ctx2, {}));
      expect(second.ok).toBe(true);
      if (!second.ok) {
        return;
      }
      expect(relay.pulls).toEqual([0, 42]);
      expect(second.since_used).toBe(42);
      await ctx2.inboxCursor.flush();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns disjoint envelope sets on two consecutive inbox() calls", async () => {
    const peer = generateKeyPair();
    const peerId = publicKeyToAgentId(peer.publicKey);

    const relay = new StubInboxRelay([
      { envelopes: [], cursor: 10 },
      { envelopes: [], cursor: 11 },
    ]);

    const bonds = new MemoryBondStore();
    const ctx = createAgentContext({
      keyStore: createKeyStore(),
      relay: relay as unknown as HttpRelayClient,
      bonds,
      allowlist: new MemoryAllowlistStore(),
      pending: createPendingQueue(),
      inboxCursor: new MemoryInboxCursorStore(),
    });
    const recipientKeys = await ctx.keyStore.loadOrCreate();
    const recipientId = publicKeyToAgentId(recipientKeys.publicKey);
    relay.responses[0] = { envelopes: [makeEnvelope(peer, recipientId, "first", 1)], cursor: 10 };
    relay.responses[1] = { envelopes: [makeEnvelope(peer, recipientId, "second", 2)], cursor: 11 };

    bonds.add(recipientId, {
      peer: peerId,
      scope: ["session.negotiate"],
      mode: "bonded_contact",
      profiles: ["core/1"],
    });

    const first = structured(await handleInbox(ctx, {}));
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(first.envelopes).toHaveLength(1);
    expect(first.envelopes[0]?.payload).toBe("first");

    const second = structured(await handleInbox(ctx, {}));
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    expect(second.envelopes).toHaveLength(1);
    expect(second.envelopes[0]?.payload).toBe("second");
    expect(relay.pulls).toEqual([0, 10]);
  });

  it("filters stale peers by default and reports filtered_count", async () => {
    const currentPeer = generateKeyPair();
    const stalePeer = generateKeyPair();
    const currentPeerId = publicKeyToAgentId(currentPeer.publicKey);
    const stalePeerId = publicKeyToAgentId(stalePeer.publicKey);

    const relay = new StubInboxRelay([{ envelopes: [], cursor: 20 }]);
    const bonds = new MemoryBondStore();
    const ctx = createAgentContext({
      keyStore: createKeyStore(),
      relay: relay as unknown as HttpRelayClient,
      bonds,
      allowlist: new MemoryAllowlistStore(),
      pending: createPendingQueue(),
      inboxCursor: new MemoryInboxCursorStore(),
    });
    const recipientKeys = await ctx.keyStore.loadOrCreate();
    const recipientId = publicKeyToAgentId(recipientKeys.publicKey);

    const staleEnvelopes = Array.from({ length: 18 }, (_, index) =>
      makeEnvelope(stalePeer, recipientId, `stale-${index}`, index + 1),
    );
    const currentEnvelopes = [
      makeEnvelope(currentPeer, recipientId, "current-1", 1),
      makeEnvelope(currentPeer, recipientId, "current-2", 2),
    ];
    relay.responses[0] = { envelopes: [...staleEnvelopes, ...currentEnvelopes], cursor: 20 };

    bonds.add(recipientId, {
      peer: currentPeerId,
      scope: ["session.negotiate"],
      mode: "bonded_contact",
      profiles: ["core/1"],
    });

    const result = structured(await handleInbox(ctx, { since: 0 }));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.envelopes).toHaveLength(2);
    expect(result.filtered_count).toBe(18);
    expect(result.new_count).toBe(2);
    expect(result.envelopes.every((envelope) => envelope.from === currentPeerId)).toBe(true);
    expect(result.envelopes.some((envelope) => envelope.from === stalePeerId)).toBe(false);
  });

  it("returns all envelopes when include_history is true", async () => {
    const currentPeer = generateKeyPair();
    const stalePeer = generateKeyPair();
    const currentPeerId = publicKeyToAgentId(currentPeer.publicKey);

    const relay = new StubInboxRelay([{ envelopes: [], cursor: 20 }]);
    const bonds = new MemoryBondStore();
    const ctx = createAgentContext({
      keyStore: createKeyStore(),
      relay: relay as unknown as HttpRelayClient,
      bonds,
      allowlist: new MemoryAllowlistStore(),
      pending: createPendingQueue(),
      inboxCursor: new MemoryInboxCursorStore(),
    });
    const recipientKeys = await ctx.keyStore.loadOrCreate();
    const recipientId = publicKeyToAgentId(recipientKeys.publicKey);

    const staleEnvelopes = Array.from({ length: 18 }, (_, index) =>
      makeEnvelope(stalePeer, recipientId, `stale-${index}`, index + 1),
    );
    const currentEnvelopes = [
      makeEnvelope(currentPeer, recipientId, "current-1", 1),
      makeEnvelope(currentPeer, recipientId, "current-2", 2),
    ];
    relay.responses[0] = { envelopes: [...staleEnvelopes, ...currentEnvelopes], cursor: 20 };

    bonds.add(recipientId, {
      peer: currentPeerId,
      scope: ["session.negotiate"],
      mode: "bonded_contact",
      profiles: ["core/1"],
    });

    const result = structured(await handleInbox(ctx, { since: 0, include_history: true }));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.envelopes).toHaveLength(20);
    expect(result.filtered_count).toBe(0);
    expect(result.new_count).toBe(20);
  });

  it("passes bonded_only=false to relay when include_history is true", async () => {
    const peer = generateKeyPair();
    const peerId = publicKeyToAgentId(peer.publicKey);
    const relay = new StubInboxRelay([{ envelopes: [], cursor: 0 }]);
    const bonds = new MemoryBondStore();
    const ctx = createAgentContext({
      keyStore: createKeyStore(),
      relay: relay as unknown as HttpRelayClient,
      bonds,
      allowlist: new MemoryAllowlistStore(),
      pending: createPendingQueue(),
      inboxCursor: new MemoryInboxCursorStore(),
    });
    const recipientKeys = await ctx.keyStore.loadOrCreate();
    const recipientId = publicKeyToAgentId(recipientKeys.publicKey);
    relay.responses[0] = {
      envelopes: [makeEnvelope(peer, recipientId, "history", 1)],
      cursor: 1,
    };
    bonds.add(recipientId, {
      peer: peerId,
      scope: ["session.negotiate"],
      mode: "bonded_contact",
      profiles: ["core/1"],
    });

    structured(await handleInbox(ctx, { since: 0, include_history: true }));
    expect(relay.pullBondedOnly).toEqual([false]);
  });

  it("falls back to allowlist peers when bonds are empty", async () => {
    const peer = generateKeyPair();
    const stranger = generateKeyPair();
    const peerId = publicKeyToAgentId(peer.publicKey);

    const relay = new StubInboxRelay([{ envelopes: [], cursor: 2 }]);
    const allowlist = new MemoryAllowlistStore();
    const ctx = createAgentContext({
      keyStore: createKeyStore(),
      relay: relay as unknown as HttpRelayClient,
      bonds: new MemoryBondStore(),
      allowlist,
      pending: createPendingQueue(),
      inboxCursor: new MemoryInboxCursorStore(),
    });
    const recipientKeys = await ctx.keyStore.loadOrCreate();
    const recipientId = publicKeyToAgentId(recipientKeys.publicKey);
    relay.responses[0] = {
      envelopes: [
        makeEnvelope(peer, recipientId, "allowed", 1),
        makeEnvelope(stranger, recipientId, "blocked", 2),
      ],
      cursor: 2,
    };

    allowlist.set(recipientId, [peerId]);

    const result = structured(await handleInbox(ctx, { since: 0 }));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.bonds_empty).toBe(true);
    expect(result.envelopes).toHaveLength(1);
    expect(result.envelopes[0]?.payload).toBe("allowed");
  });

  it("reports cursor_reset when cursor file is corrupt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentpair-inbox-cursor-corrupt-"));
    try {
      const cursorPath = join(dir, "inbox-cursor.json");
      await writeFile(cursorPath, "{not-json", "utf8");

      const relay = new StubInboxRelay([{ envelopes: [], cursor: 3 }]);
      const ctx = createAgentContext({
        keyStore: createKeyStore({ keyPath: join(dir, "keys.json") }),
        relay: relay as unknown as HttpRelayClient,
        dataDir: dir,
      });

      const result = structured(await handleInbox(ctx, {}));
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.cursor_reset).toBe(true);
      expect(result.since_used).toBe(0);
      expect(relay.pulls).toEqual([0]);
      await ctx.inboxCursor.flush();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("honors explicit since: 0 over persisted cursor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentpair-inbox-cursor-explicit-"));
    try {
      const relay = new StubInboxRelay([{ envelopes: [], cursor: 7 }]);
      const ctx1 = createAgentContext({
        keyStore: createKeyStore({ keyPath: join(dir, "keys.json") }),
        relay: relay as unknown as HttpRelayClient,
        dataDir: dir,
      });
      structured(await handleInbox(ctx1, {}));
      await ctx1.inboxCursor.flush();

      const ctx2 = createAgentContext({
        keyStore: createKeyStore({ keyPath: join(dir, "keys.json") }),
        relay: relay as unknown as HttpRelayClient,
        dataDir: dir,
      });
      relay.responses.push({ envelopes: [], cursor: 9 });
      const result = structured(await handleInbox(ctx2, { since: 0 }));
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(relay.pulls).toEqual([0, 0]);
      expect(result.since_used).toBe(0);
      await ctx2.inboxCursor.flush();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
