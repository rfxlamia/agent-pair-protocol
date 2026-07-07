import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import {
  createEnvelope,
  generateKeyPair,
  publicKeyToAgentId,
  serializeEnvelope,
} from "@agentpair/protocol";
import { utf8ToBytes } from "@noble/ciphers/utils.js";
import { createRelayApp } from "../server.js";
import {
  signChallenge,
  type AllowlistBody,
} from "./allowlist.js";

const TEST_PORT = 3001;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

function signedAllowlist(
  owner: ReturnType<typeof generateKeyPair>,
  allowed: string[],
): AllowlistBody {
  const agentId = publicKeyToAgentId(owner.publicKey);
  const ordered = { agent_id: agentId, allowed: [...allowed].sort() };
  const sig = signChallenge(
    JSON.stringify(ordered),
    owner.secretKey,
  );
  return { agent_id: agentId, allowed, sig };
}

describe("inbox relay routes", () => {
  let server: ServerType;
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

  it("returns gap_detected when sequence numbers have a gap", async () => {
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
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string;
      thread: string;
      last_good_seq: number;
    };
    expect(body.error).toBe("gap_detected");
    expect(body.thread).toBe(gapThread);
    expect(body.last_good_seq).toBe(2);
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
      const body = (await limited[0]!.json()) as { error: string };
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
    const challengeRes = await fetch(
      `${ISOLATED_BASE}/inbox/${bobId}?since=${since}`,
    );
    const { challenge } = (await challengeRes.json()) as { challenge: string };
    const sig = signChallenge(challenge, bob.secretKey);
    return fetch(
      `${ISOLATED_BASE}/inbox/${bobId}?since=${since}&challenge=${encodeURIComponent(challenge)}&sig=${encodeURIComponent(sig)}`,
    );
  }

  it("returns cursor with max received_at for incremental inbox pulls", async () => {
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
      .prepare(
        "SELECT received_at FROM inbox WHERE thread_id = ? ORDER BY received_at DESC LIMIT 1",
      )
      .get(thread) as { received_at: number };
    expect(body.cursor).toBe(row.received_at);
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

    const maxReceived = db
      .prepare(
        "SELECT MAX(received_at) AS received_at FROM inbox WHERE thread_id = ?",
      )
      .get(thread) as { received_at: number };

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

    const gapPull = await authenticatedInboxPull(maxReceived.received_at);
    expect(gapPull.status).toBe(409);
    const body = (await gapPull.json()) as {
      error: string;
      last_good_seq: number;
      expected_seq: number;
    };
    expect(body.error).toBe("gap_detected");
    expect(body.last_good_seq).toBe(2);
    expect(body.expected_seq).toBe(3);
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
