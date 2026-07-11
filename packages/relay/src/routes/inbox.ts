import { randomBytes } from "node:crypto";
import {
  type EnvelopeBody,
  type OuterEnvelope,
  agentIdToPublicKey,
  deserializeOuterEnvelope,
  parseEnvelopeBody,
  parseOuterVersion,
  tryParseEnvelopeBody,
  verify,
  verifyOuterEnvelope,
} from "@agentpair/protocol";
import { utf8ToBytes } from "@noble/ciphers/utils.js";
import { Hono } from "hono";
import type { RelayDatabase } from "../db/index.js";
import type { createRateLimiter } from "../middleware/rate-limit.js";
import { isSenderAllowed } from "./allowlist.js";

const CHALLENGE_TTL_MS = 60 * 1000;
const GC_INTERVAL_MS = 60_000;
const DEFAULT_ENVELOPE_TTL_SEC = 3600;
const LEGACY_CURSOR_THRESHOLD = 1_000_000_000_000;

// Millisecond timestamps from pre-rowid clients exceed this threshold. Reset once
// to 0 so those cursors re-deliver; MCP clients dedupe by envelope id.
function normalizeSince(since: number): number {
  if (!Number.isFinite(since) || since < 0) {
    return 0;
  }
  if (since > LEGACY_CURSOR_THRESHOLD) {
    return 0;
  }
  return since;
}

interface GapInfo {
  thread: string;
  last_good_seq: number;
  expected_seq: number;
}

function streamStep(seqs: number[]): number {
  const sorted = [...new Set(seqs)].sort((a, b) => a - b);
  if (sorted.length < 2) {
    return 1;
  }

  const first = sorted[0];
  const second = sorted[1];
  if (first === undefined || second === undefined) {
    return 1;
  }

  const delta = second - first;
  if (delta === 1 || delta === 2) {
    return delta;
  }

  const allOdd = sorted.every((seq) => seq % 2 === 1);
  const allEven = sorted.every((seq) => seq % 2 === 0);
  if (allOdd || allEven) {
    return 2;
  }

  return 1;
}

function findGapInSeqs(thread: string, seqs: number[]): GapInfo | null {
  const sorted = [...new Set(seqs)].sort((a, b) => a - b);
  if (sorted.length <= 1) {
    return null;
  }

  const step = streamStep(sorted);
  const firstSeq = sorted[0];
  if (firstSeq === undefined) {
    return null;
  }

  let lastGood = firstSeq;
  for (let i = 1; i < sorted.length; i += 1) {
    const current = sorted[i];
    if (current === undefined) {
      continue;
    }
    if (current !== lastGood + step) {
      return {
        thread,
        last_good_seq: lastGood,
        expected_seq: lastGood + step,
      };
    }
    lastGood = current;
  }

  return null;
}

function detectBoundedGaps(
  db: RelayDatabase,
  recipientAgentId: string,
  since: number,
  pageRows: Array<{ thread_id: string; seq: number; sender_agent_id: string }>,
): GapInfo[] {
  const anchorStmt = db.prepare(
    `SELECT MIN(seq) AS min_seq, MAX(seq) AS max_seq
     FROM inbox
     WHERE recipient_agent_id = ? AND thread_id = ? AND sender_agent_id = ?
       AND rowid <= ?`,
  );

  const byThreadSender = new Map<string, number[]>();
  for (const row of pageRows) {
    const key = `${row.thread_id}\0${row.sender_agent_id}`;
    const seqs = byThreadSender.get(key) ?? [];
    seqs.push(row.seq);
    byThreadSender.set(key, seqs);
  }

  const gaps: GapInfo[] = [];
  for (const [key, pageSeqs] of byThreadSender) {
    const [thread = "", sender = ""] = key.split("\0");
    const anchor = anchorStmt.get(recipientAgentId, thread, sender, since) as
      | { min_seq: number | null; max_seq: number | null }
      | undefined;

    if (pageSeqs.length >= 2) {
      const pageGap = findGapInSeqs(thread, pageSeqs);
      if (pageGap) {
        gaps.push(pageGap);
        continue;
      }
    }

    const maxSeq = anchor?.max_seq;
    if (maxSeq == null || pageSeqs.length === 0) {
      continue;
    }

    const historyStep =
      anchor?.min_seq != null
        ? streamStep([anchor.min_seq, maxSeq])
        : streamStep([maxSeq, Math.min(...pageSeqs)]);

    const minPage = Math.min(...pageSeqs);
    if (minPage !== maxSeq + historyStep) {
      gaps.push({
        thread,
        last_good_seq: maxSeq,
        expected_seq: maxSeq + historyStep,
      });
    }
  }

  return gaps;
}

function garbageCollectExpiredChallenges(db: RelayDatabase): void {
  db.prepare("DELETE FROM challenges WHERE expires_at < ? OR used = 1").run(Date.now());
}

function ensureInboxSchema(db: RelayDatabase): void {
  const columns = db.prepare("PRAGMA table_info(inbox)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "expires_at")) {
    db.exec("ALTER TABLE inbox ADD COLUMN expires_at INTEGER");
    const rows = db
      .prepare("SELECT id, envelope_json, received_at FROM inbox WHERE expires_at IS NULL")
      .all() as Array<{ id: string; envelope_json: string; received_at: number }>;
    const update = db.prepare("UPDATE inbox SET expires_at = ? WHERE id = ?");
    for (const row of rows) {
      let expiresAt = row.received_at + DEFAULT_ENVELOPE_TTL_SEC * 1000;
      try {
        const outer = deserializeOuterEnvelope(row.envelope_json);
        if (outer.v === 1) {
          const body = parseEnvelopeBody(outer);
          if (typeof body.ttl === "number" && body.ttl > 0) {
            expiresAt = body.ttl * 1000;
          }
        }
      } catch {
        // keep default ttl
      }
      update.run(expiresAt, row.id);
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_inbox_expires_at ON inbox (expires_at)");
  }
}

function maybeGarbageCollectInbox(db: RelayDatabase, state: { lastGcAt: number }): void {
  const now = Date.now();
  if (now - state.lastGcAt < GC_INTERVAL_MS) {
    return;
  }
  state.lastGcAt = now;
  db.prepare("DELETE FROM inbox WHERE expires_at IS NOT NULL AND expires_at <= ?").run(now);
}

function issueChallenge(db: RelayDatabase, agentId: string) {
  garbageCollectExpiredChallenges(db);
  db.prepare("DELETE FROM challenges WHERE agent_id = ? AND used = 0").run(agentId);
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
    .prepare("SELECT expires_at, used FROM challenges WHERE nonce = ? AND agent_id = ?")
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

function parseSenderFilter(raw: string | undefined): Set<string> | null {
  if (!raw) {
    return null;
  }
  const senders = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (senders.length === 0) {
    return null;
  }
  return new Set(senders);
}

function filterVisibleInboxRows(
  db: RelayDatabase,
  agentId: string,
  rows: Array<{
    rowid: number;
    envelope_json: string;
    thread_id: string;
    seq: number;
    sender_agent_id: string;
    received_at: number;
  }>,
  options: { bondedOnly: boolean; senderFilter: Set<string> | null },
) {
  let visibleRows = rows;
  if (options.bondedOnly) {
    visibleRows = visibleRows.filter((row) => isSenderAllowed(db, agentId, row.sender_agent_id));
  }
  if (options.senderFilter) {
    visibleRows = visibleRows.filter((row) => options.senderFilter?.has(row.sender_agent_id));
  }
  return visibleRows;
}

export function createInboxRoutes(
  db: RelayDatabase,
  rateLimit: ReturnType<typeof createRateLimiter>,
) {
  ensureInboxSchema(db);
  const inboxGcState = { lastGcAt: 0 };
  const routes = new Hono();

  routes.post("/inbox/:agentId", rateLimit, async (c) => {
    maybeGarbageCollectInbox(db, inboxGcState);
    const recipientAgentId = c.req.param("agentId");
    const wireText = await c.req.text();

    const outerVersion = parseOuterVersion(wireText);
    if (outerVersion !== null && outerVersion !== 1) {
      return c.json({ error: "unsupported_version" }, 400);
    }

    let outer: OuterEnvelope;
    try {
      outer = deserializeOuterEnvelope(wireText);
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }

    const parsedBody = tryParseEnvelopeBody(outer);
    if (parsedBody === null) {
      return c.json({ error: "invalid_json" }, 400);
    }
    const body = parsedBody;

    if (body.v !== outer.v) {
      return c.json({ error: "version_mismatch" }, 400);
    }

    if (body.to !== recipientAgentId) {
      return c.json({ error: "routing_mismatch" }, 400);
    }

    if (!Number.isFinite(body.ttl) || body.ttl <= 0) {
      return c.json({ error: "envelope_expired" }, 400);
    }

    let senderPublicKey: Uint8Array;
    try {
      senderPublicKey = agentIdToPublicKey(body.from);
    } catch {
      return c.json({ error: "invalid_signature" }, 403);
    }

    if (!verifyOuterEnvelope(outer, senderPublicKey)) {
      return c.json({ error: "invalid_signature" }, 403);
    }

    if (!isSenderAllowed(db, recipientAgentId, body.from)) {
      return c.json({ error: "recipient_not_allowed" }, 403);
    }

    const now = Date.now();
    const expiresAt = body.ttl * 1000;
    const insert = db
      .prepare(
        `INSERT INTO inbox (
         id, recipient_agent_id, envelope_json, sender_agent_id,
         thread_id, seq, msg_type, received_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        body.id,
        recipientAgentId,
        wireText,
        body.from,
        body.thread,
        body.seq,
        body.type,
        now,
        expiresAt,
      );

    if (insert.changes === 0) {
      return c.json({ error: "duplicate_envelope_id" }, 409);
    }

    return c.body(null, 204);
  });

  routes.get("/inbox/:agentId", (c) => {
    maybeGarbageCollectInbox(db, inboxGcState);
    const agentId = c.req.param("agentId");
    const since = normalizeSince(Number(c.req.query("since") ?? "0"));
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

    const bondedOnly = c.req.query("bonded_only") !== "0";
    const senderFilter = parseSenderFilter(c.req.query("senders"));
    const rows = db
      .prepare(
        `SELECT rowid, envelope_json, thread_id, seq, sender_agent_id, received_at
         FROM inbox
         WHERE recipient_agent_id = ? AND rowid > ?
         ORDER BY rowid ASC`,
      )
      .all(agentId, since) as Array<{
      rowid: number;
      envelope_json: string;
      thread_id: string;
      seq: number;
      sender_agent_id: string;
      received_at: number;
    }>;

    const cursor = rows.at(-1)?.rowid ?? since;
    const visibleRows = filterVisibleInboxRows(db, agentId, rows, { bondedOnly, senderFilter });
    const filteredCount = rows.length - visibleRows.length;

    const gaps = detectBoundedGaps(
      db,
      agentId,
      since,
      rows.map((row) => ({
        thread_id: row.thread_id,
        seq: row.seq,
        sender_agent_id: row.sender_agent_id,
      })),
    );
    const envelopes = visibleRows.map((row) => JSON.parse(row.envelope_json));
    const rowids = visibleRows.map((row) => row.rowid);
    return c.json({
      envelopes,
      rowids,
      cursor,
      filtered_count: filteredCount,
      ...(gaps.length > 0 ? { gaps } : {}),
    });
  });

  routes.delete("/inbox/:agentId/purge", rateLimit, (c) => {
    maybeGarbageCollectInbox(db, inboxGcState);
    const agentId = c.req.param("agentId");
    const sender = c.req.query("sender");
    const challenge = c.req.query("challenge");
    const sig = c.req.query("sig");

    if (!sender) {
      return c.json({ error: "sender_required" }, 400);
    }

    try {
      agentIdToPublicKey(sender);
    } catch {
      return c.json({ error: "invalid_sender" }, 400);
    }

    if (!challenge || !sig) {
      const body = issueChallenge(db, agentId);
      return c.json(body, 401);
    }

    const auth = verifyChallenge(db, agentId, challenge, sig);
    if (!auth.ok) {
      return c.json({ error: "challenge_invalid" }, auth.status);
    }

    const { deleted, peerPurged } = db.transaction(() => {
      const selfDeleted = db
        .prepare(
          `DELETE FROM inbox
           WHERE recipient_agent_id = ? AND sender_agent_id = ?`,
        )
        .run(agentId, sender);

      let peerDeleted = { changes: 0 };
      if (!isSenderAllowed(db, sender, agentId)) {
        peerDeleted = db
          .prepare(
            `DELETE FROM inbox
             WHERE recipient_agent_id = ? AND sender_agent_id = ?`,
          )
          .run(sender, agentId);
      }

      return {
        deleted: selfDeleted.changes + peerDeleted.changes,
        peerPurged: peerDeleted.changes > 0,
      };
    })();

    return c.json({ deleted, peer_purged: peerPurged });
  });

  return routes;
}
