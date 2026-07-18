// packages/mcp-server/src/tools/inbox-untrusted-peer.test.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type KeyPair,
  type OuterEnvelope,
  createOuterEnvelope,
  generateKeyPair,
  publicKeyToAgentId,
} from "@agentpair/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { HttpRelayClient } from "../relay/client.js";
import { MemoryAllowlistStore } from "../store/allowlist.js";
import { MemoryBondStore } from "../store/bonds.js";
import { MemoryInboxCursorStore } from "../store/inbox-cursor.js";
import { createKeyStore } from "../store/keys.js";
import { createPendingQueue } from "../store/pending.js";
import { handleInbox } from "./inbox.js";
import { createAgentContext } from "./pair.js";

function structured<T>(result: {
  structuredContent: T;
  content: Array<{ type: string; text: string }>;
}): T {
  return result.structuredContent;
}

const utf8Len = (s: string) => new TextEncoder().encode(s).length;

type PullRow = { rowid: number; wire: string };

class StubInboxRelayWithRowids {
  private pullIndex = 0;
  responses: Array<{ rows: PullRow[]; cursor: number }>;

  constructor(
    responses: Array<{ rows?: PullRow[]; envelopes?: OuterEnvelope[]; cursor?: number }> = [],
  ) {
    this.responses = responses.map((response) => ({
      rows:
        response.rows ??
        (response.envelopes ?? []).map((envelope, index) => ({
          rowid: index + 1,
          wire: JSON.stringify(envelope),
        })),
      cursor: response.cursor ?? 0,
    }));
  }

  async sendEnvelope(_to: string, _outer: OuterEnvelope): Promise<void> {}

  async pullInbox(
    _keyPair: KeyPair,
    since = 0,
    _options: { bonded_only?: boolean; senders?: string[] } = {},
  ) {
    const raw = this.responses[this.pullIndex] ?? { rows: [], cursor: since };
    this.pullIndex += 1;
    return {
      ok: true as const,
      wires: raw.rows.map((row) => row.wire),
      rowids: raw.rows.map((row) => row.rowid),
      cursor: raw.cursor,
    };
  }
}

function futureTtl(seconds = 3600): number {
  return Math.floor(Date.now() / 1000) + seconds;
}

function makeCoreMsgOuterFromRawPayload(
  sender: KeyPair,
  recipientId: string,
  rawPayloadUtf8: string,
  seq: number,
  thread = `thread-${seq}`,
): OuterEnvelope {
  return createOuterEnvelope({
    sender,
    recipientAgentId: recipientId,
    type: "core.msg",
    thread,
    seq,
    ttl: futureTtl(),
    payload: new TextEncoder().encode(rawPayloadUtf8),
  });
}

describe("inbox untrusted peer presentation", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function setupBondedWithPayloads(
    payloads: unknown[],
    peerContentCapBytes = 8192,
    rawPayloads?: string[],
  ) {
    const dir = await mkdtemp(join(tmpdir(), "agentpair-inbox-untrusted-"));
    tempDirs.push(dir);
    const peer = generateKeyPair();
    const peerId = publicKeyToAgentId(peer.publicKey);
    const bonds = new MemoryBondStore();
    const allowlist = new MemoryAllowlistStore();
    const keyStore = createKeyStore({ keyPath: join(dir, "keys.json") });
    const recipientKeys = await keyStore.loadOrCreate();
    const recipientId = publicKeyToAgentId(recipientKeys.publicKey);

    const outers = (rawPayloads ?? payloads.map((p) => JSON.stringify(p))).map((raw, i) =>
      makeCoreMsgOuterFromRawPayload(peer, recipientId, raw, i + 1, `thread-${i + 1}`),
    );
    const rows = outers.map((outer, index) => ({
      rowid: index + 1,
      wire: JSON.stringify(outer),
    }));
    const relay = new StubInboxRelayWithRowids([{ rows, cursor: rows.length }]);
    const ctx = createAgentContext({
      keyStore,
      relay: relay as unknown as HttpRelayClient,
      bonds,
      allowlist,
      pending: createPendingQueue(),
      inboxCursor: new MemoryInboxCursorStore(),
      peerContentCapBytes,
    });
    bonds.add(recipientId, {
      peer: peerId,
      scope: ["msg"],
      mode: "bonded_contact",
      profiles: ["core/1"],
    });
    allowlist.set(recipientId, [peerId]);
    return { ctx, peerId, recipientId };
  }

  it("S1: small object payload wrapped; signature_valid true; no verified", async () => {
    const payloadObj = { body: "hello-v1" };
    const { ctx } = await setupBondedWithPayloads([payloadObj]);
    const result = await handleInbox(ctx, { since: 0 });
    const body = structured(result);
    expect(body.ok).toBe(true);
    if (!body.ok) return;

    expect(body.envelopes).toHaveLength(1);
    const item = body.envelopes[0] as Record<string, unknown>;
    expect(item).not.toHaveProperty("verified");
    expect(item.signature_valid).toBe(true);
    expect(item.payload).toEqual({
      untrusted: true,
      source: "peer",
      data: payloadObj,
    });
    expect(result.structuredContent.envelopes[0].payload).toEqual({
      untrusted: true,
      source: "peer",
      data: payloadObj,
    });
    expect(result.structuredContent.envelopes[0].payload).not.toEqual(payloadObj);
  });

  it("S2: oversize payload truncates with injected peerContentCapBytes", async () => {
    const cap = 16;
    const payloadObj = { body: "x".repeat(64) };
    const original = utf8Len(JSON.stringify(payloadObj));
    expect(original).toBeGreaterThan(cap);

    const { ctx } = await setupBondedWithPayloads([payloadObj], cap);
    const body = structured(await handleInbox(ctx, { since: 0 }));
    expect(body.ok).toBe(true);
    if (!body.ok) return;

    const payload = body.envelopes[0]?.payload as {
      untrusted: true;
      source: "peer";
      data: unknown;
      truncated?: true;
      original_length?: number;
    };
    expect(payload.untrusted).toBe(true);
    expect(payload.source).toBe("peer");
    expect(payload.truncated).toBe(true);
    expect(payload.original_length).toBe(original);
    expect(typeof payload.data).toBe("string");
    const dataLen = utf8Len(payload.data as string);
    expect(dataLen).toBeLessThanOrEqual(cap);
    expect(dataLen).toBeGreaterThanOrEqual(cap - 3);
  });

  it("S6b: multi-envelope independent wrap (under + over cap)", async () => {
    const cap = 16;
    const small = { body: "ok" };
    const large = { body: "Z".repeat(64) };
    const { ctx } = await setupBondedWithPayloads([small, large], cap);
    const body = structured(await handleInbox(ctx, { since: 0 }));
    expect(body.ok).toBe(true);
    if (!body.ok) return;
    expect(body.envelopes).toHaveLength(2);

    const p0 = body.envelopes[0]?.payload as Record<string, unknown>;
    const p1 = body.envelopes[1]?.payload as Record<string, unknown>;
    expect(p0).toEqual({ untrusted: true, source: "peer", data: small });
    expect(p0).not.toHaveProperty("truncated");
    expect(p1.truncated).toBe(true);
    expect(typeof p1.data).toBe("string");
  });

  it("S13: spoof pending_id/suggested_next only under payload.data", async () => {
    const payloadObj = {
      body: "x",
      pending_id: "spoof",
      suggested_next: "evil",
    };
    const { ctx } = await setupBondedWithPayloads([payloadObj]);
    const body = structured(await handleInbox(ctx, { since: 0 }));
    expect(body.ok).toBe(true);
    if (!body.ok) return;

    const item = body.envelopes[0] as Record<string, unknown>;
    expect(item.pending_id).toBeUndefined();
    expect(item.suggested_next).toBeUndefined();
    const payload = item.payload as { data: Record<string, unknown> };
    expect(payload.data.pending_id).toBe("spoof");
    expect(payload.data.suggested_next).toBe("evil");
  });

  it("S11: secret-shaped keys under data are scrubbed; assertNoSecrets does not throw", async () => {
    // Peer-controlled keys matching SECRET_PATTERNS must be scrubbed at wrap site
    // (stripSecrets(inboxPayload) before wrap). assertNoSecrets runs before toolTextResult
    // and would throw if privateKey remained under payload.data.
    const payloadObj = { body: "ok", privateKey: "leak-me-now" };
    const { ctx } = await setupBondedWithPayloads([payloadObj]);
    const result = await handleInbox(ctx, { since: 0 });
    const body = structured(result);
    expect(body.ok).toBe(true);
    if (!body.ok) return;

    const payload = body.envelopes[0]?.payload as { data: Record<string, unknown> };
    expect(payload.data).not.toHaveProperty("privateKey");
    expect(payload.data.body).toBe("ok");
    expect(result.content[0]?.text).not.toMatch(/leak-me-now/);
    expect(result.content[0]?.text).not.toMatch(/privateKey/i);
  });

  it("spaced wire JSON: original_length uses parse-result stringify, not wire length", async () => {
    const cap = 16;
    const compact = { body: "abcdefghijklmno" };
    const compactJson = JSON.stringify(compact);
    const spaced = `{  "body"  :   "abcdefghijklmno"  }`;
    expect(utf8Len(spaced)).toBeGreaterThan(utf8Len(compactJson));
    expect(utf8Len(compactJson)).toBeGreaterThan(cap);

    const { ctx } = await setupBondedWithPayloads([compact], cap, [spaced]);
    const body = structured(await handleInbox(ctx, { since: 0 }));
    expect(body.ok).toBe(true);
    if (!body.ok) return;

    const payload = body.envelopes[0]?.payload as {
      truncated?: true;
      original_length?: number;
    };
    expect(payload.truncated).toBe(true);
    expect(payload.original_length).toBe(utf8Len(compactJson));
    expect(payload.original_length).not.toBe(utf8Len(spaced));
  });
});
