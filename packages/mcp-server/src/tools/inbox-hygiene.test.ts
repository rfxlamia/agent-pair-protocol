import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type KeyPair,
  type OuterEnvelope,
  createOuterEnvelope,
  generateKeyPair,
  publicKeyToAgentId,
} from "@agentpair/protocol";
import * as protocol from "@agentpair/protocol";
import { describe, expect, it, vi } from "vitest";
import type { HttpRelayClient } from "../relay/client.js";
import { MemoryAllowlistStore } from "../store/allowlist.js";
import { MemoryBondStore } from "../store/bonds.js";
import { MemoryInboxCursorStore } from "../store/inbox-cursor.js";
import { createKeyStore } from "../store/keys.js";
import { createPendingQueue } from "../store/pending.js";
import { filterBondedWires, handleInbox, handleSend } from "./inbox.js";
import { createAgentContext } from "./pair.js";
import { detectClientThreadGaps } from "./thread-seq.js";

function structured<T>(result: { structuredContent: T }): T {
  return result.structuredContent;
}

type PullRow = { rowid: number; wire: string };

type StubResponse = {
  rows?: PullRow[];
  envelopes?: OuterEnvelope[];
  cursor?: number;
};

class StubInboxRelayWithRowids {
  pulls: number[] = [];
  pullBondedOnly: boolean[] = [];
  pullSenders: Array<string[] | undefined> = [];
  private pullIndex = 0;
  responses: Array<{ rows: PullRow[]; cursor: number; envelopes?: OuterEnvelope[] }>;

  constructor(responses: StubResponse[] = []) {
    this.responses = responses.map((response, index) => ({
      rows:
        response.rows ?? envelopesToRows(response.envelopes ?? [], response.cursor ?? index + 1),
      cursor: response.cursor ?? 0,
    }));
  }

  async pullInbox(
    _keyPair: KeyPair,
    since = 0,
    options: { bonded_only?: boolean; senders?: string[] } = {},
  ) {
    this.pulls.push(since);
    this.pullBondedOnly.push(options.bonded_only !== false);
    this.pullSenders.push(options.senders);
    const raw = this.responses[this.pullIndex] ?? { rows: [], cursor: since };
    this.pullIndex += 1;
    const next = {
      rows: raw.rows ?? envelopesToRows((raw as StubResponse).envelopes ?? [], raw.cursor ?? since),
      cursor: raw.cursor ?? since,
    };
    let rows = next.rows;
    if (options.senders?.length) {
      const allowed = new Set(options.senders);
      rows = rows.filter((row) => {
        const parsed = JSON.parse(row.wire) as { from?: string };
        return parsed.from !== undefined && allowed.has(parsed.from);
      });
    }
    return {
      ok: true as const,
      wires: rows.map((row) => row.wire),
      rowids: rows.map((row) => row.rowid),
      cursor: next.cursor,
    };
  }
}

function envelopesToRows(envelopes: OuterEnvelope[], cursor: number): PullRow[] {
  return envelopes.map((envelope, index) => ({
    rowid: index + 1,
    wire: wireFromEnvelope(envelope),
  }));
}

function wireFromEnvelope(outer: OuterEnvelope): string {
  return JSON.stringify(outer);
}

function futureTtl(seconds = 3600): number {
  return Math.floor(Date.now() / 1000) + seconds;
}

function makeOuterEnvelope(
  sender: KeyPair,
  recipientId: string,
  body: string,
  seq: number,
): OuterEnvelope {
  return createOuterEnvelope({
    sender,
    recipientAgentId: recipientId,
    type: "chat.message",
    thread: `thread-${seq}`,
    seq,
    ttl: futureTtl(),
    payload: new TextEncoder().encode(body),
  });
}

function wireOver65536Bytes(sender: KeyPair, recipientId: string): string {
  const base = wireFromEnvelope(
    createOuterEnvelope({
      sender,
      recipientAgentId: recipientId,
      type: "chat.message",
      thread: "thread-big",
      seq: 1,
      ttl: futureTtl(),
      payload: new TextEncoder().encode("x"),
    }),
  );
  const obj = JSON.parse(base) as Record<string, unknown>;
  obj._pad = "p".repeat(70_000);
  return JSON.stringify(obj);
}

it("filterBondedWires parses outer from only (no full receiveEnvelope)", () => {
  const bonded = new Set([`ed25519:${"a".repeat(43)}`]);
  const bondedWire = JSON.stringify({ v: 1, from: `ed25519:${"a".repeat(43)}`, blob: "x" });
  const strangerWire = JSON.stringify({ v: 1, from: `ed25519:${"b".repeat(43)}`, blob: "y" });
  const { wires, filteredCount } = filterBondedWires(
    [bondedWire, strangerWire],
    [1, 2],
    bonded,
    false,
  );
  expect(wires).toEqual([bondedWire]);
  expect(filteredCount).toBe(1);
});

describe("inbox hygiene — cursor persistence and bonded filter", () => {
  it("persists cursor across new AgentContext with same dataDir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentpair-inbox-cursor-"));
    try {
      const relay = new StubInboxRelayWithRowids([{ envelopes: [], cursor: 42 }]);
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

    const relay = new StubInboxRelayWithRowids([
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
    relay.responses[0] = {
      rows: [
        { rowid: 10, wire: wireFromEnvelope(makeOuterEnvelope(peer, recipientId, "first", 1)) },
      ],
      cursor: 10,
    };
    relay.responses[1] = {
      rows: [
        { rowid: 11, wire: wireFromEnvelope(makeOuterEnvelope(peer, recipientId, "second", 2)) },
      ],
      cursor: 11,
    };

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

    const relay = new StubInboxRelayWithRowids([{ envelopes: [], cursor: 20 }]);
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
      makeOuterEnvelope(stalePeer, recipientId, `stale-${index}`, index + 1),
    );
    const currentEnvelopes = [
      makeOuterEnvelope(currentPeer, recipientId, "current-1", 1),
      makeOuterEnvelope(currentPeer, recipientId, "current-2", 2),
    ];
    relay.responses[0] = {
      rows: envelopesToRows([...staleEnvelopes, ...currentEnvelopes], 20),
      cursor: 20,
    };

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
    expect(result.filtered_count).toBe(0);
    expect(result.new_count).toBe(2);
    expect(result.envelopes.every((envelope) => envelope.from === currentPeerId)).toBe(true);
    expect(result.envelopes.some((envelope) => envelope.from === stalePeerId)).toBe(false);
  });

  it("returns all envelopes when include_history is true", async () => {
    const currentPeer = generateKeyPair();
    const stalePeer = generateKeyPair();
    const currentPeerId = publicKeyToAgentId(currentPeer.publicKey);

    const relay = new StubInboxRelayWithRowids([{ envelopes: [], cursor: 20 }]);
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
      makeOuterEnvelope(stalePeer, recipientId, `stale-${index}`, index + 1),
    );
    const currentEnvelopes = [
      makeOuterEnvelope(currentPeer, recipientId, "current-1", 1),
      makeOuterEnvelope(currentPeer, recipientId, "current-2", 2),
    ];
    relay.responses[0] = {
      rows: envelopesToRows([...staleEnvelopes, ...currentEnvelopes], 20),
      cursor: 20,
    };

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
    expect(result.envelopes).toHaveLength(2);
    expect(result.rejected).toHaveLength(18);
    expect(result.filtered_count).toBe(0);
    expect(result.new_count).toBe(2);
  });

  it("passes bonded_only=false to relay when include_history is true", async () => {
    const peer = generateKeyPair();
    const peerId = publicKeyToAgentId(peer.publicKey);
    const relay = new StubInboxRelayWithRowids([{ envelopes: [], cursor: 0 }]);
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
      rows: [
        { rowid: 1, wire: wireFromEnvelope(makeOuterEnvelope(peer, recipientId, "history", 1)) },
      ],
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

  it("passes bonded senders to relay when bonds are narrower than allowlist", async () => {
    const bondedPeer = generateKeyPair();
    const extraPeer = generateKeyPair();
    const bondedPeerId = publicKeyToAgentId(bondedPeer.publicKey);
    const extraPeerId = publicKeyToAgentId(extraPeer.publicKey);

    const relay = new StubInboxRelayWithRowids([{ envelopes: [], cursor: 1 }]);
    const allowlist = new MemoryAllowlistStore();
    const bonds = new MemoryBondStore();
    const ctx = createAgentContext({
      keyStore: createKeyStore(),
      relay: relay as unknown as HttpRelayClient,
      bonds,
      allowlist,
      pending: createPendingQueue(),
      inboxCursor: new MemoryInboxCursorStore(),
    });
    const recipientKeys = await ctx.keyStore.loadOrCreate();
    const recipientId = publicKeyToAgentId(recipientKeys.publicKey);
    relay.responses[0] = {
      rows: envelopesToRows(
        [
          makeOuterEnvelope(bondedPeer, recipientId, "bonded", 1),
          makeOuterEnvelope(extraPeer, recipientId, "extra", 2),
        ],
        2,
      ),
      cursor: 2,
    };

    allowlist.set(recipientId, [bondedPeerId, extraPeerId]);
    bonds.add(recipientId, {
      peer: bondedPeerId,
      scope: ["session.negotiate"],
      mode: "bonded_contact",
      profiles: ["core/1"],
    });

    const result = structured(await handleInbox(ctx, { since: 0 }));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(relay.pullSenders[0]).toEqual([bondedPeerId]);
    expect(result.envelopes).toHaveLength(1);
    expect(result.envelopes[0]?.payload).toBe("bonded");
    expect(result.filtered_count).toBe(0);
    expect(result.relay_filtered_count).toBeUndefined();
  });

  it("falls back to allowlist peers when bonds are empty", async () => {
    const peer = generateKeyPair();
    const stranger = generateKeyPair();
    const peerId = publicKeyToAgentId(peer.publicKey);

    const relay = new StubInboxRelayWithRowids([{ envelopes: [], cursor: 2 }]);
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
      rows: envelopesToRows(
        [
          makeOuterEnvelope(peer, recipientId, "allowed", 1),
          makeOuterEnvelope(stranger, recipientId, "blocked", 2),
        ],
        2,
      ),
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

      const relay = new StubInboxRelayWithRowids([{ envelopes: [], cursor: 3 }]);
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
      const relay = new StubInboxRelayWithRowids([{ envelopes: [], cursor: 7 }]);
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

describe("inbox v1 outer unwrap and v0 skip", () => {
  it("unwraps v1 outer envelopes to flat response with sig from outer", async () => {
    const peer = generateKeyPair();
    const peerId = publicKeyToAgentId(peer.publicKey);
    const relay = new StubInboxRelayWithRowids([{ envelopes: [], cursor: 1 }]);
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
    const outer = makeOuterEnvelope(peer, recipientId, "hello-v1", 1);
    relay.responses[0] = { rows: [{ rowid: 1, wire: wireFromEnvelope(outer) }], cursor: 1 };

    bonds.add(recipientId, {
      peer: peerId,
      scope: ["session.negotiate"],
      mode: "bonded_contact",
      profiles: ["core/1"],
    });

    const result = structured(await handleInbox(ctx, { since: 0 }));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.envelopes).toHaveLength(1);
    const item = result.envelopes[0];
    expect(item?.payload).toBe("hello-v1");
    expect(item?.verified).toBe(true);
    expect(item?.sig).toBe(outer.sig);
    expect(item?.from).toBe(peerId);
  });

  it("rejects v0 flat wire in rejected[] (not skipped_unsupported)", async () => {
    const peer = generateKeyPair();
    const peerId = publicKeyToAgentId(peer.publicKey);
    const relay = new StubInboxRelayWithRowids();
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
    const v0Wire = JSON.stringify({
      id: crypto.randomUUID(),
      from: peerId,
      to: recipientId,
      type: "chat.message",
      thread: "v0-stale-thread",
      seq: 99,
      ttl: futureTtl(),
      payload: "x",
      sig: "fake",
    });
    relay.responses = [{ rows: [{ rowid: 1, wire: v0Wire }], cursor: 1 }];

    bonds.add(recipientId, {
      peer: peerId,
      scope: ["session.negotiate"],
      mode: "bonded_contact",
      profiles: ["core/1"],
    });

    const result = structured(await handleInbox(ctx, { since: 0 }));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.envelopes).toHaveLength(0);
    expect(result.rejected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          error: expect.stringMatching(/unsupported_version|invalid_json/),
          cursor: 1,
        }),
      ]),
    );
    expect(result).not.toHaveProperty("skipped_unsupported");
    expect(result.new_count).toBe(0);
  });

  it("accepts v1 when mixed with rejected v0 row", async () => {
    const peer = generateKeyPair();
    const peerId = publicKeyToAgentId(peer.publicKey);
    const relay = new StubInboxRelayWithRowids([{ envelopes: [], cursor: 2 }]);
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
    const v0Wire = JSON.stringify({
      id: crypto.randomUUID(),
      from: peerId,
      to: recipientId,
      type: "chat.message",
      thread: "v0-stale-thread",
      seq: 99,
      ttl: futureTtl(),
      payload: "x",
      sig: "fake",
    });
    const v1 = makeOuterEnvelope(peer, recipientId, "still-here", 1);
    relay.responses[0] = {
      rows: [
        { rowid: 1, wire: v0Wire },
        { rowid: 2, wire: wireFromEnvelope(v1) },
      ],
      cursor: 2,
    };

    bonds.add(recipientId, {
      peer: peerId,
      scope: ["session.negotiate"],
      mode: "bonded_contact",
      profiles: ["core/1"],
    });

    const result = structured(await handleInbox(ctx, { since: 0 }));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.envelopes).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.envelopes[0]?.payload).toBe("still-here");
    expect(result).not.toHaveProperty("skipped_unsupported");
  });
});

describe("inbox receiveEnvelope wiring (M1.2 §4.3)", () => {
  it("mixed batch: 2 accepted, 1 stale_seq in rejected[], cursor advances", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentpair-inbox-rejected-"));
    try {
      const peer = generateKeyPair();
      const peerId = publicKeyToAgentId(peer.publicKey);
      const relay = new StubInboxRelayWithRowids();
      const ctx = createAgentContext({
        keyStore: createKeyStore({ keyPath: join(dir, "keys.json") }),
        relay: relay as unknown as HttpRelayClient,
        bonds: new MemoryBondStore(),
        allowlist: new MemoryAllowlistStore(),
        pending: createPendingQueue(),
        dataDir: dir,
      });
      const recipientKeys = await ctx.keyStore.loadOrCreate();
      const recipientId = publicKeyToAgentId(recipientKeys.publicKey);
      ctx.bonds.add(recipientId, {
        peer: peerId,
        scope: ["session.negotiate"],
        mode: "bonded_contact",
        profiles: ["core/1"],
      });

      relay.responses = [
        {
          rows: [
            { rowid: 1, wire: wireFromEnvelope(makeOuterEnvelope(peer, recipientId, "ok-1", 1)) },
            { rowid: 2, wire: wireFromEnvelope(makeOuterEnvelope(peer, recipientId, "stale", 1)) },
            { rowid: 3, wire: wireFromEnvelope(makeOuterEnvelope(peer, recipientId, "ok-2", 2)) },
          ],
          cursor: 3,
        },
      ];

      const result = structured(await handleInbox(ctx, { since: 0 }));
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      expect(result.envelopes).toHaveLength(2);
      expect(result.rejected).toEqual(
        expect.arrayContaining([expect.objectContaining({ error: "stale_seq", cursor: 2 })]),
      );
      expect(result.cursor).toBe(3);
      expect(result).not.toHaveProperty("skippedUnsupported");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("invalid_json → rejected[], not fatal pull error", async () => {
    const peer = generateKeyPair();
    const peerId = publicKeyToAgentId(peer.publicKey);
    const relay = new StubInboxRelayWithRowids();
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
    bonds.add(recipientId, {
      peer: peerId,
      scope: ["session.negotiate"],
      mode: "bonded_contact",
      profiles: ["core/1"],
    });

    relay.responses = [
      {
        rows: [
          {
            rowid: 9,
            wire: JSON.stringify({
              v: 1,
              from: peerId,
              to: recipientId,
              blob: Buffer.from("not-json", "utf8").toString("base64url"),
              sig: "a".repeat(86),
            }),
          },
        ],
        cursor: 9,
      },
    ];

    const result = structured(await handleInbox(ctx, {}));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.envelopes).toHaveLength(0);
    expect(result.rejected).toEqual([{ error: "invalid_json", cursor: 9 }]);
    expect(result.rejected?.[0]?.id).toBeUndefined();
  });

  it("envelope_too_large → rejected[{ error, cursor }], id omitted", async () => {
    const peer = generateKeyPair();
    const peerId = publicKeyToAgentId(peer.publicKey);
    const relay = new StubInboxRelayWithRowids();
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
    bonds.add(recipientId, {
      peer: peerId,
      scope: ["session.negotiate"],
      mode: "bonded_contact",
      profiles: ["core/1"],
    });

    relay.responses = [
      { rows: [{ rowid: 42, wire: wireOver65536Bytes(peer, recipientId) }], cursor: 42 },
    ];

    const result = structured(await handleInbox(ctx, {}));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.rejected).toEqual([{ error: "envelope_too_large", cursor: 42 }]);
    expect(result.rejected?.[0]?.id).toBeUndefined();
  });

  it("does not populate inbound gap state on receive path", async () => {
    const peer = generateKeyPair();
    const peerId = publicKeyToAgentId(peer.publicKey);
    const relay = new StubInboxRelayWithRowids();
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
    bonds.add(recipientId, {
      peer: peerId,
      scope: ["session.negotiate"],
      mode: "bonded_contact",
      profiles: ["core/1"],
    });
    relay.responses = [
      {
        rows: [{ rowid: 1, wire: wireFromEnvelope(makeOuterEnvelope(peer, recipientId, "x", 1)) }],
        cursor: 1,
      },
    ];

    await handleInbox(ctx, {});
    expect(detectClientThreadGaps(ctx)).toEqual([]);
  });

  it("include_history unbonded → recipient_not_allowed in rejected[]", async () => {
    const stranger = generateKeyPair();
    const strangerId = publicKeyToAgentId(stranger.publicKey);
    const relay = new StubInboxRelayWithRowids();
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

    relay.responses = [
      {
        rows: [
          { rowid: 1, wire: wireFromEnvelope(makeOuterEnvelope(stranger, recipientId, "x", 1)) },
        ],
        cursor: 1,
      },
    ];

    const result = structured(await handleInbox(ctx, { include_history: true }));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.envelopes).toHaveLength(0);
    expect(result.rejected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ error: "recipient_not_allowed", cursor: 1 }),
      ]),
    );
    expect(relay.pullBondedOnly).toEqual([false]);
  });
});

describe("inbox send absolute ttl (M1.2 §4.2)", () => {
  it("handleSend without explicit ttl uses absolute unix body.ttl", async () => {
    const peer = generateKeyPair();
    const peerId = publicKeyToAgentId(peer.publicKey);
    const allowlist = new MemoryAllowlistStore();
    const sendEnvelope = vi.fn(async () => undefined);
    const ctx = createAgentContext({
      keyStore: createKeyStore(),
      relay: { sendEnvelope } as unknown as HttpRelayClient,
      allowlist,
      bonds: new MemoryBondStore(),
      pending: createPendingQueue(),
      inboxCursor: new MemoryInboxCursorStore(),
    });
    const keys = await ctx.keyStore.loadOrCreate();
    const selfId = publicKeyToAgentId(keys.publicKey);
    allowlist.set(selfId, [peerId]);

    const beforeUnix = Math.floor(Date.now() / 1000);
    const createSpy = vi.spyOn(protocol, "createOuterEnvelope");

    const result = structured(
      await handleSend(ctx, { to: peerId, type: "chat.message", payload: "ttl-check" }),
    );
    expect(result.ok).toBe(true);

    expect(createSpy).toHaveBeenCalledTimes(1);
    const ttl = createSpy.mock.calls[0]?.[0]?.ttl;
    expect(typeof ttl).toBe("number");
    expect(ttl).toBeGreaterThanOrEqual(beforeUnix + 3500);
    expect(ttl).toBeLessThanOrEqual(beforeUnix + 3700);
    expect(ttl).toBeGreaterThan(1_000_000);

    createSpy.mockRestore();
  });
});
