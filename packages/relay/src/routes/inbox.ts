import { agentIdToPublicKey, verify } from "@agentpair/protocol";
import { utf8ToBytes } from "@noble/ciphers/utils.js";
import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import type { RelayDatabase } from "../db/index.js";
import { createRateLimiter } from "../middleware/rate-limit.js";
import {
  isSenderAllowed,
  parseEnvelopeRoutingFields,
} from "./allowlist.js";

const CHALLENGE_TTL_MS = 60 * 1000;

interface GapInfo {
  thread: string;
  last_good_seq: number;
  expected_seq: number;
}

function detectGaps(
  rows: Array<{ thread_id: string; seq: number }>,
): GapInfo[] {
  const byThread = new Map<string, number[]>();
  for (const row of rows) {
    const seqs = byThread.get(row.thread_id) ?? [];
    seqs.push(row.seq);
    byThread.set(row.thread_id, seqs);
  }

  const gaps: GapInfo[] = [];
  for (const [thread, seqs] of byThread) {
    const sorted = [...new Set(seqs)].sort((a, b) => a - b);
    if (sorted.length === 0) {
      continue;
    }

    if (sorted[0]! > 1) {
      gaps.push({
        thread,
        last_good_seq: 0,
        expected_seq: 1,
      });
      continue;
    }

    let lastGood = sorted[0]!;
    for (let i = 1; i < sorted.length; i += 1) {
      const current = sorted[i]!;
      if (current !== lastGood + 1) {
        gaps.push({
          thread,
          last_good_seq: lastGood,
          expected_seq: lastGood + 1,
        });
        break;
      }
      lastGood = current;
    }
  }

  return gaps;
}

function garbageCollectExpiredChallenges(db: RelayDatabase): void {
  db.prepare("DELETE FROM challenges WHERE expires_at < ? OR used = 1").run(
    Date.now(),
  );
}

function issueChallenge(db: RelayDatabase, agentId: string) {
  garbageCollectExpiredChallenges(db);
  db.prepare("DELETE FROM challenges WHERE agent_id = ? AND used = 0").run(
    agentId,
  );
  const nonce = Buffer.from(randomBytes(32)).toString("base64url");
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;

  db.prepare(
    `INSERT INTO challenges (nonce, agent_id, expires_at, used)
     VALUES (?, ?, ?, 0)`,
  ).run(nonce, agentId, expiresAt);

  return { challenge: nonce, expires_at: expiresAt };
}

function verifyChallenge(
  db: RelayDatabase,
  agentId: string,
  nonce: string,
  sig: string,
): { ok: true } | { ok: false; status: 403 } {
  const row = db
    .prepare(
      "SELECT expires_at, used FROM challenges WHERE nonce = ? AND agent_id = ?",
    )
    .get(nonce, agentId) as { expires_at: number; used: number } | undefined;

  if (!row) {
    return { ok: false, status: 403 };
  }

  if (row.used) {
    return { ok: false, status: 403 };
  }

  if (row.expires_at < Date.now()) {
    return { ok: false, status: 403 };
  }

  try {
    const publicKey = agentIdToPublicKey(agentId);
    const signature = Buffer.from(sig, "base64url");
    const valid = verify(signature, utf8ToBytes(nonce), publicKey);
    if (!valid) {
      return { ok: false, status: 403 };
    }
  } catch {
    return { ok: false, status: 403 };
  }

  db.prepare("UPDATE challenges SET used = 1 WHERE nonce = ?").run(nonce);
  return { ok: true };
}

export function createInboxRoutes(
  db: RelayDatabase,
  rateLimit: ReturnType<typeof createRateLimiter>,
) {
  const routes = new Hono();

  routes.post("/inbox/:agentId", rateLimit, async (c) => {
    const recipientAgentId = c.req.param("agentId");
    const envelopeJson = await c.req.text();

    let routing;
    try {
      routing = parseEnvelopeRoutingFields(envelopeJson);
    } catch {
      return c.json({ error: "invalid_envelope" }, 400);
    }

    if (routing.to !== recipientAgentId) {
      return c.json({ error: "recipient_mismatch" }, 400);
    }

    if (!isSenderAllowed(db, recipientAgentId, routing.from)) {
      return c.json({ error: "sender_not_allowed" }, 403);
    }

    const now = Date.now();
    db.prepare(
      `INSERT INTO inbox (
         id, recipient_agent_id, envelope_json, sender_agent_id,
         thread_id, seq, msg_type, received_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).run(
      routing.id,
      recipientAgentId,
      envelopeJson,
      routing.from,
      routing.thread,
      routing.seq,
      routing.type,
      now,
    );

    return c.body(null, 204);
  });

  routes.get("/inbox/:agentId", (c) => {
    const agentId = c.req.param("agentId");
    const since = Number(c.req.query("since") ?? "0");
    const challenge = c.req.query("challenge");
    const sig = c.req.query("sig");

    if (!challenge || !sig) {
      const body = issueChallenge(db, agentId);
      return c.json(body, 401);
    }

    const auth = verifyChallenge(db, agentId, challenge, sig);
    if (!auth.ok) {
      return c.json({ error: "challenge_invalid" }, auth.status);
    }

    const rows = db
      .prepare(
        `SELECT envelope_json, thread_id, seq, received_at
         FROM inbox
         WHERE recipient_agent_id = ? AND received_at > ?
         ORDER BY received_at ASC`,
      )
      .all(agentId, since) as Array<{
      envelope_json: string;
      thread_id: string;
      seq: number;
      received_at: number;
    }>;

    const threadIds = [...new Set(rows.map((row) => row.thread_id))];
    const gapRows: Array<{ thread_id: string; seq: number }> = [];
    for (const threadId of threadIds) {
      const threadSeqs = db
        .prepare(
          `SELECT thread_id, seq
           FROM inbox
           WHERE recipient_agent_id = ? AND thread_id = ?
           ORDER BY seq ASC`,
        )
        .all(agentId, threadId) as Array<{ thread_id: string; seq: number }>;
      gapRows.push(...threadSeqs);
    }

    const gaps = detectGaps(gapRows);
    if (gaps.length > 0) {
      const firstGap = gaps[0]!;
      return c.json(
        {
          error: "gap_detected",
          thread: firstGap.thread,
          last_good_seq: firstGap.last_good_seq,
          expected_seq: firstGap.expected_seq,
        },
        409,
      );
    }

    const envelopes = rows.map((row) => JSON.parse(row.envelope_json));
    const cursor =
      rows.length > 0
        ? Math.max(...rows.map((row) => row.received_at))
        : since;
    return c.json({ envelopes, cursor });
  });

  return routes;
}
