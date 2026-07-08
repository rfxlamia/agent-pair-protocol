import {
  createEnvelope,
  generateKeyPair,
  publicKeyToAgentId,
  serializeEnvelope,
} from "@agentpair/protocol";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { utf8ToBytes } from "@noble/ciphers/utils.js";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRateLimiter } from "../middleware/rate-limit.js";
import { createRelayApp } from "../server.js";
import { type AllowlistBody, signChallenge } from "./allowlist.js";
import { createInboxRoutes } from "./inbox.js";

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
    const spoofId = crypto.randomUUID();
    const envelope = createEnvelope({
      sender: stranger,
      recipientAgentId: bobId,
      type: "chat.message",
      thread: "550e8400-e29b-41d4-a716-446655440000",
      seq: 99,
      ttl: 3600,
      payload: utf8ToBytes("spoof"),
      id: spoofId,
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
      db.prepare("SELECT COUNT(*) AS count FROM inbox WHERE id = ?").get(spoofId) as {
        count: number;
      }
    ).count;
    expect(count).toBe(0);
  });

  it("returns 400 for invalid JSON syntax on POST", async () => {
    const res = await fetch(`${BASE_URL}/inbox/${bobId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{broken",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_envelope");
  });

  it("returns 400 for non-positive ttl on POST", async () => {
    const envelope = createEnvelope({
      sender: alice,
      recipientAgentId: bobId,
      type: "chat.message",
      thread: "550e8400-e29b-41d4-a716-446655440000",
      seq: 1,
      ttl: 3600,
      payload: utf8ToBytes("bad-ttl"),
      id: crypto.randomUUID(),
    });
    const tampered = JSON.parse(serializeEnvelope(envelope)) as Record<string, unknown>;
    tampered.ttl = 0;

    const res = await fetch(`${BASE_URL}/inbox/${bobId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tampered),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_envelope");
  });

  it("returns 400 for malformed from agent id on POST", async () => {
    const envelope = createEnvelope({
      sender: alice,
      recipientAgentId: bobId,
      type: "chat.message",
      thread: "550e8400-e29b-41d4-a716-446655440000",
      seq: 1,
      ttl: 3600,
      payload: utf8ToBytes("bad-from"),
      id: crypto.randomUUID(),
    });
    const tampered = JSON.parse(serializeEnvelope(envelope)) as Record<string, unknown>;
    tampered.from = "not-a-valid-agent-id";

    const res = await fetch(`${BASE_URL}/inbox/${bobId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tampered),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_envelope");
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

  async function pullBobInbox(since: number, bondedOnly = true) {
    const bondedQuery = bondedOnly ? "" : "&bonded_only=0";
    const challengeRes = await fetch(`${BASE_URL}/inbox/${bobId}?since=${since}${bondedQuery}`);
    const { challenge } = (await challengeRes.json()) as { challenge: string };
    const sig = signChallenge(challenge, bob.secretKey);
    return fetch(
      `${BASE_URL}/inbox/${bobId}?since=${since}${bondedQuery}&challenge=${encodeURIComponent(challenge)}&sig=${encodeURIComponent(sig)}`,
    );
  }

  async function purgeBobInbox(senderId: string) {
    const senderQuery = `sender=${encodeURIComponent(senderId)}`;
    const challengeRes = await fetch(`${BASE_URL}/inbox/${bobId}/purge?${senderQuery}`, {
      method: "DELETE",
    });
    const { challenge } = (await challengeRes.json()) as { challenge: string };
    const sig = signChallenge(challenge, bob.secretKey);
    return fetch(
      `${BASE_URL}/inbox/${bobId}/purge?${senderQuery}&challenge=${encodeURIComponent(challenge)}&sig=${encodeURIComponent(sig)}`,
      { method: "DELETE" },
    );
  }

  it("filters GET inbox to current allowlist senders by default", async () => {
    const strangerAllowlist = signedAllowlist(bob, [aliceId, strangerId]);
    let res = await fetch(`${BASE_URL}/allowlist/${bobId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(strangerAllowlist),
    });
    expect(res.status).toBe(204);

    const strangerPost = await postEnvelope(bobId, stranger, 1);
    expect(strangerPost.status).toBe(204);
    const alicePost = await postEnvelope(bobId, alice, 2);
    expect(alicePost.status).toBe(204);

    const bobOnlyAlice = signedAllowlist(bob, [aliceId]);
    res = await fetch(`${BASE_URL}/allowlist/${bobId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bobOnlyAlice),
    });
    expect(res.status).toBe(204);

    const filtered = await pullBobInbox(0, true);
    expect(filtered.status).toBe(200);
    const filteredBody = (await filtered.json()) as {
      envelopes: Array<{ from: string }>;
      cursor: number;
      filtered_count: number;
    };
    expect(filteredBody.envelopes.every((envelope) => envelope.from === aliceId)).toBe(true);
    expect(filteredBody.envelopes.some((envelope) => envelope.from === strangerId)).toBe(false);
    expect(filteredBody.filtered_count).toBeGreaterThanOrEqual(1);
    expect(filteredBody.cursor).toBeGreaterThan(0);

    const full = await pullBobInbox(0, false);
    expect(full.status).toBe(200);
    const fullBody = (await full.json()) as { envelopes: Array<{ from: string }> };
    expect(fullBody.envelopes.some((envelope) => envelope.from === strangerId)).toBe(true);
  });

  it("purges dyadic inbox rows with challenge-response auth", async () => {
    const aliceAllowlist = signedAllowlist(alice, [bobId]);
    const allowRes = await fetch(`${BASE_URL}/allowlist/${aliceId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(aliceAllowlist),
    });
    expect(allowRes.status).toBe(204);

    const aliceToBob = await postEnvelope(bobId, alice, 11);
    expect(aliceToBob.status).toBe(204);

    const bobToAlice = await fetch(`${BASE_URL}/inbox/${aliceId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: serializeEnvelope(
        createEnvelope({
          sender: bob,
          recipientAgentId: aliceId,
          type: "chat.message",
          thread: "purge-thread",
          seq: 1,
          ttl: 3600,
          payload: utf8ToBytes("reply"),
          id: crypto.randomUUID(),
        }),
      ),
    });
    expect(bobToAlice.status).toBe(204);

    const bobRows = db
      .prepare("SELECT COUNT(*) AS count FROM inbox WHERE recipient_agent_id = ?")
      .get(bobId) as { count: number };
    const aliceRows = db
      .prepare("SELECT COUNT(*) AS count FROM inbox WHERE recipient_agent_id = ?")
      .get(aliceId) as { count: number };
    expect(bobRows.count).toBeGreaterThan(0);
    expect(aliceRows.count).toBeGreaterThan(0);

    const purgeRes = await purgeBobInbox(aliceId);
    expect(purgeRes.status).toBe(200);
    const purgeBody = (await purgeRes.json()) as { deleted: number };
    expect(purgeBody.deleted).toBeGreaterThan(0);

    const bobAfter = db
      .prepare(
        "SELECT COUNT(*) AS count FROM inbox WHERE recipient_agent_id = ? AND sender_agent_id = ?",
      )
      .get(bobId, aliceId) as { count: number };
    const aliceAfter = db
      .prepare(
        "SELECT COUNT(*) AS count FROM inbox WHERE recipient_agent_id = ? AND sender_agent_id = ?",
      )
      .get(aliceId, bobId) as { count: number };
    expect(bobAfter.count).toBe(0);
    expect(aliceAfter.count).toBe(0);
  });

  it("returns 401 for purge without challenge-response auth", async () => {
    const res = await fetch(
      `${BASE_URL}/inbox/${bobId}/purge?sender=${encodeURIComponent(aliceId)}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 for purge without sender query param", async () => {
    const challengeRes = await fetch(`${BASE_URL}/inbox/${bobId}/purge`, { method: "DELETE" });
    expect(challengeRes.status).toBe(400);
    const body = (await challengeRes.json()) as { error: string };
    expect(body.error).toBe("sender_required");
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

    const challengeBefore = await fetch(`${BASE_URL}/inbox/${aliceId}?since=0`);
    const { challenge: beforeChallenge } = (await challengeBefore.json()) as { challenge: string };
    const beforeSig = signChallenge(beforeChallenge, alice.secretKey);
    const beforePull = await fetch(
      `${BASE_URL}/inbox/${aliceId}?since=0&challenge=${encodeURIComponent(beforeChallenge)}&sig=${encodeURIComponent(beforeSig)}`,
    );
    const beforeBody = (await beforePull.json()) as { cursor: number };
    const since = beforeBody.cursor ?? 0;

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

    const challengeRes = await fetch(`${BASE_URL}/inbox/${aliceId}?since=${since}`);
    const { challenge } = (await challengeRes.json()) as { challenge: string };
    const sig = signChallenge(challenge, alice.secretKey);

    const res = await fetch(
      `${BASE_URL}/inbox/${aliceId}?since=${since}&challenge=${encodeURIComponent(challenge)}&sig=${encodeURIComponent(sig)}`,
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
    const body = (await pullRes.json()) as {
      envelopes: Array<{ id: string }>;
      cursor: number;
    };
    expect(body.envelopes.some((envelope) => envelope.id === envelopeId)).toBe(true);
    expect(body.cursor).toBeLessThan(1_000_000_000_000);
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

    const syncPull = await authenticatedInboxPull(0);
    const syncBody = (await syncPull.json()) as { cursor: number };
    const cursor = syncBody.cursor;

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
      if (sql.includes("MIN(seq)") && sql.includes("MAX(seq)") && sql.includes("rowid <=")) {
        anchorQueries += 1;
      }
      return originalPrepare(sql, ...(rest as []));
    }) as typeof db.prepare;

    const pullRes = await authenticatedInboxPull(cursor);
    expect(pullRes.status).toBe(200);
    expect(anchorQueries).toBe(1);
    const body = (await pullRes.json()) as { gaps?: unknown[] };
    expect(body.gaps ?? []).toHaveLength(0);
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

const GAP_PORT = 3007;
const GAP_BASE = `http://127.0.0.1:${GAP_PORT}`;

describe("inbox gap detection (isolated db)", () => {
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
      server = serve({ fetch: relay.app.fetch, port: GAP_PORT }, resolve);
    });

    const bobAllowlist = signedAllowlist(bob, [aliceId]);
    const res = await fetch(`${GAP_BASE}/allowlist/${bobId}`, {
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
    const challengeRes = await fetch(`${GAP_BASE}/inbox/${bobId}?since=${since}`);
    const { challenge } = (await challengeRes.json()) as { challenge: string };
    const sig = signChallenge(challenge, bob.secretKey);
    return fetch(
      `${GAP_BASE}/inbox/${bobId}?since=${since}&challenge=${encodeURIComponent(challenge)}&sig=${encodeURIComponent(sig)}`,
    );
  }

  it("reports no gaps on incremental pull after long consecutive history", async () => {
    const thread = "110e8400-e29b-41d4-a716-446655440011";
    for (let seq = 1; seq <= 50; seq += 1) {
      const postRes = await fetch(`${GAP_BASE}/inbox/${bobId}`, {
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
            payload: utf8ToBytes(`long-${seq}`),
            id: crypto.randomUUID(),
          }),
        ),
      });
      expect(postRes.status).toBe(204);
    }

    const syncPull = await authenticatedInboxPull(0);
    const syncBody = (await syncPull.json()) as { cursor: number };
    const cursor = syncBody.cursor;

    for (let seq = 51; seq <= 55; seq += 1) {
      const postRes = await fetch(`${GAP_BASE}/inbox/${bobId}`, {
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
            payload: utf8ToBytes(`long-${seq}`),
            id: crypto.randomUUID(),
          }),
        ),
      });
      expect(postRes.status).toBe(204);
    }

    const incrementalPull = await authenticatedInboxPull(cursor);
    expect(incrementalPull.status).toBe(200);
    const body = (await incrementalPull.json()) as { gaps?: unknown[] };
    expect(body.gaps ?? []).toHaveLength(0);
  });

  it("reports boundary gap on incremental pull after long history", async () => {
    const thread = "120e8400-e29b-41d4-a716-446655440022";
    for (let seq = 1; seq <= 2; seq += 1) {
      const postRes = await fetch(`${GAP_BASE}/inbox/${bobId}`, {
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
            payload: utf8ToBytes(`bound-${seq}`),
            id: crypto.randomUUID(),
          }),
        ),
      });
      expect(postRes.status).toBe(204);
    }

    const syncPull = await authenticatedInboxPull(0);
    const syncBody = (await syncPull.json()) as { cursor: number };

    const gapPost = await fetch(`${GAP_BASE}/inbox/${bobId}`, {
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
          payload: utf8ToBytes("bound-4"),
          id: crypto.randomUUID(),
        }),
      ),
    });
    expect(gapPost.status).toBe(204);

    const gapPull = await authenticatedInboxPull(syncBody.cursor);
    expect(gapPull.status).toBe(200);
    const body = (await gapPull.json()) as {
      gaps: Array<{ last_good_seq: number; expected_seq: number }>;
    };
    expect(body.gaps[0]?.last_good_seq).toBe(2);
    expect(body.gaps[0]?.expected_seq).toBe(3);
  });
});

const CURSOR_PORT = 3006;
const CURSOR_BASE = `http://127.0.0.1:${CURSOR_PORT}`;

describe("inbox rowid cursor (isolated db)", () => {
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
      server = serve({ fetch: relay.app.fetch, port: CURSOR_PORT }, resolve);
    });

    const bobAllowlist = signedAllowlist(bob, [aliceId]);
    const res = await fetch(`${CURSOR_BASE}/allowlist/${bobId}`, {
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
    const challengeRes = await fetch(`${CURSOR_BASE}/inbox/${bobId}?since=${since}`);
    const { challenge } = (await challengeRes.json()) as { challenge: string };
    const sig = signChallenge(challenge, bob.secretKey);
    return fetch(
      `${CURSOR_BASE}/inbox/${bobId}?since=${since}&challenge=${encodeURIComponent(challenge)}&sig=${encodeURIComponent(sig)}`,
    );
  }

  it("does not lose envelopes after a partial pull", async () => {
    const thread = "dd0e8400-e29b-41d4-a716-446655440066";
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()] as const;
    const firstId = ids[0];

    const firstPost = await fetch(`${CURSOR_BASE}/inbox/${bobId}`, {
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
          payload: utf8ToBytes("burst-1"),
          id: firstId,
        }),
      ),
    });
    expect(firstPost.status).toBe(204);

    const firstPull = await authenticatedInboxPull(0);
    expect(firstPull.status).toBe(200);
    const firstBody = (await firstPull.json()) as {
      envelopes: Array<{ id: string }>;
      cursor: number;
    };
    expect(firstBody.envelopes).toHaveLength(1);
    expect(firstBody.envelopes[0]?.id).toBe(firstId);

    const receivedAt = Date.now();
    for (const [index, id] of ids.slice(1).entries()) {
      if (id === undefined) {
        continue;
      }
      const envelope = createEnvelope({
        sender: alice,
        recipientAgentId: bobId,
        type: "chat.message",
        thread,
        seq: index + 2,
        ttl: 3600,
        payload: utf8ToBytes(`burst-${index + 2}`),
        id,
      });
      const postRes = await fetch(`${CURSOR_BASE}/inbox/${bobId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: serializeEnvelope(envelope),
      });
      expect(postRes.status).toBe(204);
      db.prepare("UPDATE inbox SET received_at = ? WHERE id = ?").run(receivedAt, id);
    }

    const secondPull = await authenticatedInboxPull(firstBody.cursor);
    expect(secondPull.status).toBe(200);
    const secondBody = (await secondPull.json()) as {
      envelopes: Array<{ id: string }>;
    };
    expect(secondBody.envelopes.map((envelope) => envelope.id).sort()).toEqual(
      [ids[1], ids[2]].sort(),
    );
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

const INBOX_GC_GET_PORT = 3008;
const INBOX_GC_GET_BASE = `http://127.0.0.1:${INBOX_GC_GET_PORT}`;

describe("inbox ttl gc via GET (isolated db)", () => {
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
      server = serve({ fetch: relay.app.fetch, port: INBOX_GC_GET_PORT }, resolve);
    });

    const bobAllowlist = signedAllowlist(bob, [aliceId]);
    const res = await fetch(`${INBOX_GC_GET_BASE}/allowlist/${bobId}`, {
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
    const challengeRes = await fetch(`${INBOX_GC_GET_BASE}/inbox/${bobId}?since=${since}`);
    const { challenge } = (await challengeRes.json()) as { challenge: string };
    const sig = signChallenge(challenge, bob.secretKey);
    return fetch(
      `${INBOX_GC_GET_BASE}/inbox/${bobId}?since=${since}&challenge=${encodeURIComponent(challenge)}&sig=${encodeURIComponent(sig)}`,
    );
  }

  it("garbage-collects expired inbox rows on GET and hides them from pulls", async () => {
    const expiredId = crypto.randomUUID();
    const freshId = crypto.randomUUID();
    const now = Date.now();

    const expiredEnvelope = createEnvelope({
      sender: alice,
      recipientAgentId: bobId,
      type: "chat.message",
      thread: "bb1e8400-e29b-41d4-a716-446655440001",
      seq: 1,
      ttl: 3600,
      payload: utf8ToBytes("expired-pull"),
      id: expiredId,
    });
    const freshEnvelope = createEnvelope({
      sender: alice,
      recipientAgentId: bobId,
      type: "chat.message",
      thread: "bb1e8400-e29b-41d4-a716-446655440002",
      seq: 1,
      ttl: 3600,
      payload: utf8ToBytes("fresh-pull"),
      id: freshId,
    });

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

    const challengeRes = await fetch(`${INBOX_GC_GET_BASE}/inbox/${bobId}?since=0`);
    expect(challengeRes.status).toBe(401);

    const pullRes = await authenticatedInboxPull(0);
    expect(pullRes.status).toBe(200);
    const body = (await pullRes.json()) as { envelopes: Array<{ id: string }> };
    expect(body.envelopes.some((envelope) => envelope.id === expiredId)).toBe(false);
    expect(body.envelopes.some((envelope) => envelope.id === freshId)).toBe(true);
  });
});

const INBOX_GC_THROTTLE_PORT = 3009;
const INBOX_GC_THROTTLE_BASE = `http://127.0.0.1:${INBOX_GC_THROTTLE_PORT}`;

describe("inbox ttl gc throttle (isolated db)", () => {
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
      server = serve({ fetch: relay.app.fetch, port: INBOX_GC_THROTTLE_PORT }, resolve);
    });

    const bobAllowlist = signedAllowlist(bob, [aliceId]);
    const res = await fetch(`${INBOX_GC_THROTTLE_BASE}/allowlist/${bobId}`, {
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

  it("throttles inbox garbage collection within the gc interval", async () => {
    const expiredId = crypto.randomUUID();
    const now = Date.now();
    db.prepare(
      `INSERT INTO inbox (
         id, recipient_agent_id, envelope_json, sender_agent_id,
         thread_id, seq, msg_type, received_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      expiredId,
      bobId,
      serializeEnvelope(
        createEnvelope({
          sender: alice,
          recipientAgentId: bobId,
          type: "chat.message",
          thread: "cc1e8400-e29b-41d4-a716-446655440001",
          seq: 1,
          ttl: 3600,
          payload: utf8ToBytes("throttle"),
          id: expiredId,
        }),
      ),
      aliceId,
      "cc1e8400-e29b-41d4-a716-446655440001",
      1,
      "chat.message",
      now - 7200_000,
      now - 3600_000,
    );

    const triggerGc = () =>
      fetch(`${INBOX_GC_THROTTLE_BASE}/inbox/${bobId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: serializeEnvelope(
          createEnvelope({
            sender: alice,
            recipientAgentId: bobId,
            type: "chat.message",
            thread: "cc1e8400-e29b-41d4-a716-446655440099",
            seq: 1,
            ttl: 3600,
            payload: utf8ToBytes("gc-trigger"),
            id: crypto.randomUUID(),
          }),
        ),
      });

    await triggerGc();
    expect(
      (
        db.prepare("SELECT COUNT(*) AS count FROM inbox WHERE id = ?").get(expiredId) as {
          count: number;
        }
      ).count,
    ).toBe(0);

    const secondExpiredId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO inbox (
         id, recipient_agent_id, envelope_json, sender_agent_id,
         thread_id, seq, msg_type, received_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      secondExpiredId,
      bobId,
      serializeEnvelope(
        createEnvelope({
          sender: alice,
          recipientAgentId: bobId,
          type: "chat.message",
          thread: "cc1e8400-e29b-41d4-a716-446655440002",
          seq: 1,
          ttl: 3600,
          payload: utf8ToBytes("throttle-2"),
          id: secondExpiredId,
        }),
      ),
      aliceId,
      "cc1e8400-e29b-41d4-a716-446655440002",
      1,
      "chat.message",
      now - 7200_000,
      now - 3600_000,
    );

    await triggerGc();
    expect(
      (
        db.prepare("SELECT COUNT(*) AS count FROM inbox WHERE id = ?").get(secondExpiredId) as {
          count: number;
        }
      ).count,
    ).toBe(1);
  });
});

describe("inbox ttl schema migration", () => {
  const alice = generateKeyPair();
  const bob = generateKeyPair();
  const aliceId = publicKeyToAgentId(alice.publicKey);
  const bobId = publicKeyToAgentId(bob.publicKey);

  it("backfills expires_at when migrating brownfield inbox schema", () => {
    const legacyDb = new Database(":memory:");
    legacyDb.exec(`
      CREATE TABLE inbox (
        id TEXT PRIMARY KEY,
        recipient_agent_id TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        sender_agent_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        msg_type TEXT NOT NULL,
        received_at INTEGER NOT NULL
      );
    `);

    const rowId = crypto.randomUUID();
    const receivedAt = Date.now() - 1800_000;
    const envelope = createEnvelope({
      sender: alice,
      recipientAgentId: bobId,
      type: "chat.message",
      thread: "dd1e8400-e29b-41d4-a716-446655440001",
      seq: 1,
      ttl: 1800,
      payload: utf8ToBytes("legacy"),
      id: rowId,
    });
    legacyDb
      .prepare(
        `INSERT INTO inbox (
           id, recipient_agent_id, envelope_json, sender_agent_id,
           thread_id, seq, msg_type, received_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rowId,
        bobId,
        serializeEnvelope(envelope),
        aliceId,
        envelope.thread,
        1,
        "chat.message",
        receivedAt,
      );

    const rateLimit = createRateLimiter({ windowMs: 60_000, maxRequests: 100 });
    createInboxRoutes(legacyDb, rateLimit);

    const row = legacyDb.prepare("SELECT expires_at FROM inbox WHERE id = ?").get(rowId) as {
      expires_at: number;
    };
    expect(row.expires_at).toBe(receivedAt + 1800 * 1000);
    legacyDb.close();
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
