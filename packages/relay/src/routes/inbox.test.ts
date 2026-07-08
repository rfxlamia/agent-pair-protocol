import {
  createEnvelope,
  generateKeyPair,
  publicKeyToAgentId,
  serializeEnvelope,
} from "@agentpair/protocol";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { utf8ToBytes } from "@noble/ciphers/utils.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRelayApp } from "../server.js";
import { type AllowlistBody, signChallenge } from "./allowlist.js";

const TEST_PORT = 3001;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

function signedAllowlist(
  owner: ReturnType<typeof generateKeyPair>,
  allowed: string[],
): AllowlistBody {
  const agentId = publicKeyToAgentId(owner.publicKey);
  const ordered = { agent_id: agentId, allowed: [...allowed].sort() };
  const sig = signChallenge(JSON.stringify(ordered), owner.secretKey);
  return { agent_id: agentId, allowed, sig };
}

describe("inbox relay routes", () => {
  let server: ServerType;
  let db: ReturnType<typeof createRelayApp>["db"];
  const alice = generateKeyPair();
  const bob = generateKeyPair();
  const stranger = generateKeyPair();
  const aliceId = publicKeyToAgentId(alice.publicKey);
  const bobId = publicKeyToAgentId(bob.publicKey);
  const strangerId = publicKeyToAgentId(stranger.publicKey);

  beforeAll(async () => {
    const relay = createRelayApp({
      rateLimitWindowMs: 60_000,
      rateLimitMax: 100,
    });
    const { app } = relay;
    db = relay.db;

    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: TEST_PORT }, resolve);
    });

    const bobAllowlist = signedAllowlist(bob, [aliceId]);
    const res = await fetch(`${BASE_URL}/allowlist/${bobId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bobAllowlist),
    });
    expect(res.status).toBe(204);
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
  });

  async function postEnvelope(
    recipientId: string,
    sender: ReturnType<typeof generateKeyPair>,
    seq: number,
  ) {
    const envelope = createEnvelope({
      sender,
      recipientAgentId: recipientId,
      type: "chat.message",
      thread: "550e8400-e29b-41d4-a716-446655440000",
      seq,
      ttl: 3600,
      payload: utf8ToBytes(`message-${seq}`),
      id: crypto.randomUUID(),
    });

    return fetch(`${BASE_URL}/inbox/${recipientId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: serializeEnvelope(envelope),
    });
  }

  it("rejects inbox POST from non-bonded sender", async () => {
    const res = await postEnvelope(bobId, stranger, 1);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("sender_not_allowed");
  });

  it("rejects spoofed envelope with invalid signature", async () => {
    const envelope = createEnvelope({
      sender: stranger,
      recipientAgentId: bobId,
      type: "chat.message",
      thread: "550e8400-e29b-41d4-a716-446655440000",
      seq: 99,
      ttl: 3600,
      payload: utf8ToBytes("spoof"),
      id: crypto.randomUUID(),
    });
    const tampered = JSON.parse(serializeEnvelope(envelope)) as Record<string, unknown>;
    tampered.from = aliceId;

    const res = await fetch(`${BASE_URL}/inbox/${bobId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tampered),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_signature");

    const count = (
      db.prepare("SELECT COUNT(*) AS count FROM inbox WHERE seq = 99").get() as { count: number }
    ).count;
    expect(count).toBe(0);
  });

  it("returns 400 for malformed envelope JSON on POST", async () => {
    const res = await fetch(`${BASE_URL}/inbox/${bobId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: aliceId, not_an_envelope: true }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_envelope");
  });

  it("round-trips a legit signed envelope via POST then GET", async () => {
    const thread = "cc0e8400-e29b-41d4-a716-446655440011";
    const envelopeId = crypto.randomUUID();
    const postRes = await fetch(`${BASE_URL}/inbox/${bobId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: serializeEnvelope(
        createEnvelope({
          sender: alice,
          recipientAgentId: bobId,
          type: "chat.message",
          thread,
          seq: 42,
          ttl: 3600,
          payload: utf8ToBytes("round-trip"),
          id: envelopeId,
        }),
      ),
    });
    expect(postRes.status).toBe(204);

    const challengeRes = await fetch(`${BASE_URL}/inbox/${bobId}?since=0`);
    const { challenge } = (await challengeRes.json()) as { challenge: string };
    const sig = signChallenge(challenge, bob.secretKey);
    const pullRes = await fetch(
      `${BASE_URL}/inbox/${bobId}?since=0&challenge=${encodeURIComponent(challenge)}&sig=${encodeURIComponent(sig)}`,
    );
    expect(pullRes.status).toBe(200);
    const body = (await pullRes.json()) as { envelopes: Array<{ id: string; seq: number }> };
    const delivered = body.envelopes.find((item) => item.id === envelopeId);
    expect(delivered?.seq).toBe(42);
  });

  it("returns 401 challenge when GET inbox has no signature", async () => {
    const res = await fetch(`${BASE_URL}/inbox/${bobId}?since=0`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      challenge: string;
      expires_at: number;
    };
    expect(typeof body.challenge).toBe("string");
    expect(body.challenge.length).toBeGreaterThan(10);
    expect(body.expires_at).toBeGreaterThan(Date.now());
  });

  it("rejects reused challenge nonce with 403", async () => {
    const challengeRes = await fetch(`${BASE_URL}/inbox/${bobId}?since=0`);
    const { challenge } = (await challengeRes.json()) as { challenge: string };
    const sig = signChallenge(challenge, bob.secretKey);

    const first = await fetch(
      `${BASE_URL}/inbox/${bobId}?since=0&challenge=${encodeURIComponent(challenge)}&sig=${encodeURIComponent(sig)}`,
    );
    expect(first.status).toBe(200);

    const second = await fetch(
      `${BASE_URL}/inbox/${bobId}?since=0&challenge=${encodeURIComponent(challenge)}&sig=${encodeURIComponent(sig)}`,
    );
    expect(second.status).toBe(403);
    const body = (await second.json()) as { error: string };
    expect(body.error).toBe("challenge_invalid");
  });

  it("returns advisory gaps when sequence numbers have a gap", async () => {
    const gapThread = "660e8400-e29b-41d4-a716-446655440099";
    for (const seq of [1, 2, 4]) {
      const envelope = createEnvelope({
        sender: alice,
        recipientAgentId: bobId,
        type: "chat.message",
        thread: gapThread,
        seq,
        ttl: 3600,
        payload: utf8ToBytes(`gap-${seq}`),
        id: crypto.randomUUID(),
      });
      const postRes = await fetch(`${BASE_URL}/inbox/${bobId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: serializeEnvelope(envelope),
      });
      expect(postRes.status).toBe(204);
    }

    const challengeRes = await fetch(`${BASE_URL}/inbox/${bobId}?since=0`);
    const { challenge } = (await challengeRes.json()) as { challenge: string };
    const sig = signChallenge(challenge, bob.secretKey);

    const res = await fetch(
      `${BASE_URL}/inbox/${bobId}?since=0&challenge=${encodeURIComponent(challenge)}&sig=${encodeURIComponent(sig)}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      envelopes: unknown[];
      gaps: Array<{
        thread: string;
        last_good_seq: number;
        expected_seq: number;
      }>;
    };
    expect(body.gaps[0]?.thread).toBe(gapThread);
    expect(body.gaps[0]?.last_good_seq).toBe(2);
    expect(body.gaps[0]?.expected_seq).toBe(3);
  });

  it("allows bidirectional alternating seq on the same thread", async () => {
    const thread = "770e8400-e29b-41d4-a716-446655440088";
    const aliceAllowlist = signedAllowlist(alice, [bobId]);
    const allowRes = await fetch(`${BASE_URL}/allowlist/${aliceId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(aliceAllowlist),
    });
    expect(allowRes.status).toBe(204);

    const toBob = createEnvelope({
      sender: alice,
      recipientAgentId: bobId,
      type: "count",
      thread,
      seq: 1,
      ttl: 3600,
      payload: utf8ToBytes("1"),
      id: crypto.randomUUID(),
    });
    const toAlice = createEnvelope({
      sender: bob,
      recipientAgentId: aliceId,
      type: "count",
      thread,
      seq: 2,
      ttl: 3600,
      payload: utf8ToBytes("2"),
      id: crypto.randomUUID(),
    });

    for (const [recipient, envelope] of [
      [bobId, toBob],
      [aliceId, toAlice],
    ] as const) {
      const postRes = await fetch(`${BASE_URL}/inbox/${recipient}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: serializeEnvelope(envelope),
      });
      expect(postRes.status).toBe(204);
    }

    const challengeRes = await fetch(`${BASE_URL}/inbox/${aliceId}?since=0`);
    const { challenge } = (await challengeRes.json()) as { challenge: string };
    const sig = signChallenge(challenge, alice.secretKey);

    const res = await fetch(
      `${BASE_URL}/inbox/${aliceId}?since=0&challenge=${encodeURIComponent(challenge)}&sig=${encodeURIComponent(sig)}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { envelopes: Array<{ seq: number }> };
    expect(body.envelopes).toHaveLength(1);
    expect(body.envelopes[0]?.seq).toBe(2);
  });

  it("returns 403 (not 404) for unknown challenge nonce per spec", async () => {
    const sig = signChallenge("nonexistent-nonce", bob.secretKey);
    const res = await fetch(
      `${BASE_URL}/inbox/${bobId}?since=0&challenge=nonexistent-nonce&sig=${encodeURIComponent(sig)}`,
    );
    expect(res.status).toBe(403);
  });

  it("enforces per-IP rate limits on POST /pair", async () => {
    const { app } = createRelayApp({
      rateLimitWindowMs: 60_000,
      rateLimitMax: 3,
    });
    const rateLimitServer = serve({ fetch: app.fetch, port: 3002 });
    const rateBase = "http://127.0.0.1:3002";

    try {
      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          fetch(`${rateBase}/pair/rate-limit-session`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ opaque: "pake" }),
          }),
        ),
      );

      const limited = responses.filter((res) => res.status === 429);
      expect(limited.length).toBeGreaterThan(0);
      const body = (await limited[0]?.json()) as { error: string };
      expect(body.error).toBe("rate_limit_exceeded");
    } finally {
      await new Promise<void>((resolve, reject) => {
        rateLimitServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });
});

const ISOLATED_PORT = 3003;
const ISOLATED_BASE = `http://127.0.0.1:${ISOLATED_PORT}`;

describe("inbox relay regressions (isolated db)", () => {
  let server: ServerType;
  let db: ReturnType<typeof createRelayApp>["db"];
  const alice = generateKeyPair();
  const bob = generateKeyPair();
  const aliceId = publicKeyToAgentId(alice.publicKey);
  const bobId = publicKeyToAgentId(bob.publicKey);

  beforeAll(async () => {
    const relay = createRelayApp({
      rateLimitWindowMs: 60_000,
      rateLimitMax: 100,
    });
    db = relay.db;

    await new Promise<void>((resolve) => {
      server = serve({ fetch: relay.app.fetch, port: ISOLATED_PORT }, resolve);
    });

    const bobAllowlist = signedAllowlist(bob, [aliceId]);
    const res = await fetch(`${ISOLATED_BASE}/allowlist/${bobId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bobAllowlist),
    });
    expect(res.status).toBe(204);
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
  });

  async function authenticatedInboxPull(since: number) {
    const challengeRes = await fetch(`${ISOLATED_BASE}/inbox/${bobId}?since=${since}`);
    const { challenge } = (await challengeRes.json()) as { challenge: string };
    const sig = signChallenge(challenge, bob.secretKey);
    return fetch(
      `${ISOLATED_BASE}/inbox/${bobId}?since=${since}&challenge=${encodeURIComponent(challenge)}&sig=${encodeURIComponent(sig)}`,
    );
  }

  it("returns cursor with max rowid for incremental inbox pulls", async () => {
    const thread = "770e8400-e29b-41d4-a716-446655440088";
    const postRes = await fetch(`${ISOLATED_BASE}/inbox/${bobId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: serializeEnvelope(
        createEnvelope({
          sender: alice,
          recipientAgentId: bobId,
          type: "chat.message",
          thread,
          seq: 1,
          ttl: 3600,
          payload: utf8ToBytes("cursor-test"),
          id: crypto.randomUUID(),
        }),
      ),
    });
    expect(postRes.status).toBe(204);

    const res = await authenticatedInboxPull(0);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      envelopes: unknown[];
      cursor?: number;
    };
    const row = db
      .prepare("SELECT rowid FROM inbox WHERE thread_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(thread) as { rowid: number };
    expect(body.cursor).toBe(row.rowid);
  });

  it("does not lose envelopes inserted in the same millisecond", async () => {
    const thread = "dd0e8400-e29b-41d4-a716-446655440066";
    const receivedAt = Date.now();
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const rowids: number[] = [];

    for (const [index, id] of ids.entries()) {
      const envelope = createEnvelope({
        sender: alice,
        recipientAgentId: bobId,
        type: "chat.message",
        thread,
        seq: index + 1,
        ttl: 3600,
        payload: utf8ToBytes(`burst-${index + 1}`),
        id,
      });
      const result = db
        .prepare(
          `INSERT INTO inbox (
           id, recipient_agent_id, envelope_json, sender_agent_id,
           thread_id, seq, msg_type, received_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          bobId,
          serializeEnvelope(envelope),
          aliceId,
          thread,
          index + 1,
          "chat.message",
          receivedAt,
          receivedAt + 3_600_000,
        );
      rowids.push(Number(result.lastInsertRowid));
    }

    const secondPull = await authenticatedInboxPull(rowids[0] ?? 0);
    expect(secondPull.status).toBe(200);
    const secondBody = (await secondPull.json()) as {
      envelopes: Array<{ id: string }>;
    };
    expect(secondBody.envelopes.map((envelope) => envelope.id).sort()).toEqual(
      [ids[1], ids[2]].sort(),
    );
  });

  it("returns the same cursor on an empty pull", async () => {
    const thread = "ee0e8400-e29b-41d4-a716-446655440055";
    const postRes = await fetch(`${ISOLATED_BASE}/inbox/${bobId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: serializeEnvelope(
        createEnvelope({
          sender: alice,
          recipientAgentId: bobId,
          type: "chat.message",
          thread,
          seq: 1,
          ttl: 3600,
          payload: utf8ToBytes("empty-pull"),
          id: crypto.randomUUID(),
        }),
      ),
    });
    expect(postRes.status).toBe(204);

    const firstPull = await authenticatedInboxPull(0);
    const firstBody = (await firstPull.json()) as { cursor: number };
    const cursor = firstBody.cursor;

    const emptyPull = await authenticatedInboxPull(cursor);
    expect(emptyPull.status).toBe(200);
    const emptyBody = (await emptyPull.json()) as {
      envelopes: unknown[];
      cursor: number;
    };
    expect(emptyBody.envelopes).toHaveLength(0);
    expect(emptyBody.cursor).toBe(cursor);
  });

  it("treats legacy millisecond cursors as zero for one-time re-delivery", async () => {
    const thread = "ff0e8400-e29b-41d4-a716-446655440044";
    const envelopeId = crypto.randomUUID();
    const postRes = await fetch(`${ISOLATED_BASE}/inbox/${bobId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: serializeEnvelope(
        createEnvelope({
          sender: alice,
          recipientAgentId: bobId,
          type: "chat.message",
          thread,
          seq: 1,
          ttl: 3600,
          payload: utf8ToBytes("legacy-cursor"),
          id: envelopeId,
        }),
      ),
    });
    expect(postRes.status).toBe(204);

    const legacySince = Date.now();
    const challengeRes = await fetch(`${ISOLATED_BASE}/inbox/${bobId}?since=${legacySince}`);
    const { challenge } = (await challengeRes.json()) as { challenge: string };
    const sig = signChallenge(challenge, bob.secretKey);
    const pullRes = await fetch(
      `${ISOLATED_BASE}/inbox/${bobId}?since=${legacySince}&challenge=${encodeURIComponent(challenge)}&sig=${encodeURIComponent(sig)}`,
    );
    expect(pullRes.status).toBe(200);
    const body = (await pullRes.json()) as { envelopes: Array<{ id: string }> };
    expect(body.envelopes.some((envelope) => envelope.id === envelopeId)).toBe(true);
  });

  it("detects seq gaps when pulling incrementally with since cursor", async () => {
    const thread = "880e8400-e29b-41d4-a716-446655440077";
    for (const seq of [1, 2]) {
      const postRes = await fetch(`${ISOLATED_BASE}/inbox/${bobId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: serializeEnvelope(
          createEnvelope({
            sender: alice,
            recipientAgentId: bobId,
            type: "chat.message",
            thread,
            seq,
            ttl: 3600,
            payload: utf8ToBytes(`incr-${seq}`),
            id: crypto.randomUUID(),
          }),
        ),
      });
      expect(postRes.status).toBe(204);
    }

    const firstPull = await authenticatedInboxPull(0);
    expect(firstPull.status).toBe(200);
    const firstBody = (await firstPull.json()) as { cursor: number };
    const cursor = firstBody.cursor;

    const gapPost = await fetch(`${ISOLATED_BASE}/inbox/${bobId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: serializeEnvelope(
        createEnvelope({
          sender: alice,
          recipientAgentId: bobId,
          type: "chat.message",
          thread,
          seq: 4,
          ttl: 3600,
          payload: utf8ToBytes("incr-4"),
          id: crypto.randomUUID(),
        }),
      ),
    });
    expect(gapPost.status).toBe(204);

    const gapPull = await authenticatedInboxPull(cursor);
    expect(gapPull.status).toBe(200);
    const body = (await gapPull.json()) as {
      gaps: Array<{
        last_good_seq: number;
        expected_seq: number;
      }>;
    };
    expect(body.gaps[0]?.last_good_seq).toBe(2);
    expect(body.gaps[0]?.expected_seq).toBe(3);
  });

  it("bounds gap detection queries for large thread history", async () => {
    const thread = "990e8400-e29b-41d4-a716-446655440033";
    for (let seq = 1; seq <= 50; seq += 1) {
      const envelope = createEnvelope({
        sender: alice,
        recipientAgentId: bobId,
        type: "chat.message",
        thread,
        seq,
        ttl: 3600,
        payload: utf8ToBytes(`hist-${seq}`),
        id: crypto.randomUUID(),
      });
      const receivedAt = Date.now();
      db.prepare(
        `INSERT INTO inbox (
           id, recipient_agent_id, envelope_json, sender_agent_id,
           thread_id, seq, msg_type, received_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        crypto.randomUUID(),
        bobId,
        serializeEnvelope(envelope),
        aliceId,
        thread,
        seq,
        "chat.message",
        receivedAt,
        receivedAt + 3_600_000,
      );
    }

    for (let seq = 51; seq <= 55; seq += 1) {
      const postRes = await fetch(`${ISOLATED_BASE}/inbox/${bobId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: serializeEnvelope(
          createEnvelope({
            sender: alice,
            recipientAgentId: bobId,
            type: "chat.message",
            thread,
            seq,
            ttl: 3600,
            payload: utf8ToBytes(`new-${seq}`),
            id: crypto.randomUUID(),
          }),
        ),
      });
      expect(postRes.status).toBe(204);
    }

    let anchorQueries = 0;
    const originalPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string, ...rest: unknown[]) => {
      if (sql.includes("MIN(seq)") && sql.includes("MAX(seq)")) {
        anchorQueries += 1;
      }
      return originalPrepare(sql, ...(rest as []));
    }) as typeof db.prepare;

    const pullRes = await authenticatedInboxPull(0);
    expect(pullRes.status).toBe(200);
    expect(anchorQueries).toBeLessThanOrEqual(3);
  });

  it("garbage-collects expired challenge rows", async () => {
    const before = (
      db.prepare("SELECT COUNT(*) AS count FROM challenges").get() as {
        count: number;
      }
    ).count;

    for (let i = 0; i < 5; i += 1) {
      await fetch(`${ISOLATED_BASE}/inbox/${bobId}?since=0`);
    }

    const after = (
      db.prepare("SELECT COUNT(*) AS count FROM challenges").get() as {
        count: number;
      }
    ).count;
    expect(after).toBe(before);
  });
});

const INBOX_GC_PORT = 3005;
const INBOX_GC_BASE = `http://127.0.0.1:${INBOX_GC_PORT}`;

describe("inbox ttl garbage collection (isolated db)", () => {
  let server: ServerType;
  let db: ReturnType<typeof createRelayApp>["db"];
  const alice = generateKeyPair();
  const bob = generateKeyPair();
  const aliceId = publicKeyToAgentId(alice.publicKey);
  const bobId = publicKeyToAgentId(bob.publicKey);

  beforeAll(async () => {
    const relay = createRelayApp({
      rateLimitWindowMs: 60_000,
      rateLimitMax: 100,
    });
    db = relay.db;

    await new Promise<void>((resolve) => {
      server = serve({ fetch: relay.app.fetch, port: INBOX_GC_PORT }, resolve);
    });

    const bobAllowlist = signedAllowlist(bob, [aliceId]);
    const res = await fetch(`${INBOX_GC_BASE}/allowlist/${bobId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bobAllowlist),
    });
    expect(res.status).toBe(204);
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
  });

  it("garbage-collects expired inbox rows on POST", async () => {
    const expiredId = crypto.randomUUID();
    const expiredEnvelope = createEnvelope({
      sender: alice,
      recipientAgentId: bobId,
      type: "chat.message",
      thread: "aa1e8400-e29b-41d4-a716-446655440001",
      seq: 1,
      ttl: 3600,
      payload: utf8ToBytes("expired"),
      id: expiredId,
    });
    const freshId = crypto.randomUUID();
    const freshEnvelope = createEnvelope({
      sender: alice,
      recipientAgentId: bobId,
      type: "chat.message",
      thread: "aa1e8400-e29b-41d4-a716-446655440002",
      seq: 1,
      ttl: 3600,
      payload: utf8ToBytes("fresh"),
      id: freshId,
    });

    const now = Date.now();
    db.prepare(
      `INSERT INTO inbox (
         id, recipient_agent_id, envelope_json, sender_agent_id,
         thread_id, seq, msg_type, received_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      expiredId,
      bobId,
      serializeEnvelope(expiredEnvelope),
      aliceId,
      expiredEnvelope.thread,
      1,
      "chat.message",
      now - 7200_000,
      now - 3600_000,
    );
    db.prepare(
      `INSERT INTO inbox (
         id, recipient_agent_id, envelope_json, sender_agent_id,
         thread_id, seq, msg_type, received_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      freshId,
      bobId,
      serializeEnvelope(freshEnvelope),
      aliceId,
      freshEnvelope.thread,
      1,
      "chat.message",
      now,
      now + 3600_000,
    );

    const postRes = await fetch(`${INBOX_GC_BASE}/inbox/${bobId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: serializeEnvelope(
        createEnvelope({
          sender: alice,
          recipientAgentId: bobId,
          type: "chat.message",
          thread: "aa1e8400-e29b-41d4-a716-446655440003",
          seq: 1,
          ttl: 3600,
          payload: utf8ToBytes("trigger-gc"),
          id: crypto.randomUUID(),
        }),
      ),
    });
    expect(postRes.status).toBe(204);

    const expiredCount = (
      db.prepare("SELECT COUNT(*) AS count FROM inbox WHERE id = ?").get(expiredId) as {
        count: number;
      }
    ).count;
    const freshCount = (
      db.prepare("SELECT COUNT(*) AS count FROM inbox WHERE id = ?").get(freshId) as {
        count: number;
      }
    ).count;
    expect(expiredCount).toBe(0);
    expect(freshCount).toBe(1);
  });
});

const GLOBAL_SEQ_PORT = 3004;
const GLOBAL_SEQ_BASE = `http://127.0.0.1:${GLOBAL_SEQ_PORT}`;

describe("inbox global turn-taking seq (isolated db)", () => {
  let server: ServerType;
  const alice = generateKeyPair();
  const bob = generateKeyPair();
  const aliceId = publicKeyToAgentId(alice.publicKey);
  const bobId = publicKeyToAgentId(bob.publicKey);

  beforeAll(async () => {
    const relay = createRelayApp({
      rateLimitWindowMs: 60_000,
      rateLimitMax: 100,
    });

    await new Promise<void>((resolve) => {
      server = serve({ fetch: relay.app.fetch, port: GLOBAL_SEQ_PORT }, resolve);
    });

    const bobAllowlist = signedAllowlist(bob, [aliceId]);
    const res = await fetch(`${GLOBAL_SEQ_BASE}/allowlist/${bobId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bobAllowlist),
    });
    expect(res.status).toBe(204);
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
  });

  async function pullBobInbox(since: number) {
    const challengeRes = await fetch(`${GLOBAL_SEQ_BASE}/inbox/${bobId}?since=${since}`);
    const { challenge } = (await challengeRes.json()) as { challenge: string };
    const sig = signChallenge(challenge, bob.secretKey);
    return fetch(
      `${GLOBAL_SEQ_BASE}/inbox/${bobId}?since=${since}&challenge=${encodeURIComponent(challenge)}&sig=${encodeURIComponent(sig)}`,
    );
  }

  it("allows peer seq 1 and 3 after local reply consumed seq 2", async () => {
    const thread = "a0fe1394-aefb-4e7b-87dc-fae782e63ecd";
    for (const seq of [1, 3] as const) {
      const postRes = await fetch(`${GLOBAL_SEQ_BASE}/inbox/${bobId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: serializeEnvelope(
          createEnvelope({
            sender: alice,
            recipientAgentId: bobId,
            type: "suggestion",
            thread,
            seq,
            ttl: 3600,
            payload: utf8ToBytes(`turn-${seq}`),
            id: crypto.randomUUID(),
          }),
        ),
      });
      expect(postRes.status).toBe(204);
    }

    const res = await pullBobInbox(0);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { envelopes: Array<{ seq: number }> };
    expect(body.envelopes.map((envelope) => envelope.seq).sort()).toEqual([1, 3]);
  });

  it("detects true gaps when global turn-taking skips an odd slot", async () => {
    const thread = "990e8400-e29b-41d4-a716-446655440088";
    for (const seq of [1, 5] as const) {
      const postRes = await fetch(`${GLOBAL_SEQ_BASE}/inbox/${bobId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: serializeEnvelope(
          createEnvelope({
            sender: alice,
            recipientAgentId: bobId,
            type: "suggestion",
            thread,
            seq,
            ttl: 3600,
            payload: utf8ToBytes(`turn-${seq}`),
            id: crypto.randomUUID(),
          }),
        ),
      });
      expect(postRes.status).toBe(204);
    }

    const res = await pullBobInbox(0);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      gaps: Array<{
        last_good_seq: number;
        expected_seq: number;
      }>;
    };
    expect(body.gaps[0]?.last_good_seq).toBe(1);
    expect(body.gaps[0]?.expected_seq).toBe(3);
  });

  it("delivers envelopes even when relay sees burst-shaped peer stream", async () => {
    const thread = "aa0e8400-e29b-41d4-a716-446655440099";
    for (const seq of [1, 4] as const) {
      const postRes = await fetch(`${GLOBAL_SEQ_BASE}/inbox/${bobId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: serializeEnvelope(
          createEnvelope({
            sender: alice,
            recipientAgentId: bobId,
            type: "suggestion",
            thread,
            seq,
            ttl: 3600,
            payload: utf8ToBytes(`burst-${seq}`),
            id: crypto.randomUUID(),
          }),
        ),
      });
      expect(postRes.status).toBe(204);
    }

    const res = await pullBobInbox(0);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      envelopes: Array<{ seq: number; thread: string }>;
    };
    const burstEnvelopes = body.envelopes.filter((envelope) => envelope.thread === thread);
    expect(burstEnvelopes.map((envelope) => envelope.seq).sort()).toEqual([1, 4]);
  });

  it("returns 409 for duplicate envelope id on POST", async () => {
    const thread = "bb0e8400-e29b-41d4-a716-446655440099";
    const envelope = createEnvelope({
      sender: alice,
      recipientAgentId: bobId,
      type: "suggestion",
      thread,
      seq: 1,
      ttl: 3600,
      payload: utf8ToBytes("dup"),
      id: crypto.randomUUID(),
    });

    const first = await fetch(`${GLOBAL_SEQ_BASE}/inbox/${bobId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: serializeEnvelope(envelope),
    });
    expect(first.status).toBe(204);

    const second = await fetch(`${GLOBAL_SEQ_BASE}/inbox/${bobId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: serializeEnvelope(envelope),
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: string };
    expect(body.error).toBe("duplicate_envelope_id");
  });
});
