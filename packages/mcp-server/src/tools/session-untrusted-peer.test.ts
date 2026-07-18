// packages/mcp-server/src/tools/session-untrusted-peer.test.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type SessionRecord,
  createSessionStore,
  generateKeyPair,
  publicKeyToAgentId,
} from "@agentpair/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryAllowlistStore } from "../store/allowlist.js";
import { MemoryBondStore } from "../store/bonds.js";
import { createKeyStore } from "../store/keys.js";
import { createPendingQueue } from "../store/pending.js";
import { createAgentContext } from "./pair.js";
import { handleSessionStatus } from "./session.js";
import { LOCKED_SECTION_ID_CAP_BYTES } from "./util.js";

function structured<T>(result: { structuredContent: T }): T {
  return result.structuredContent;
}

const utf8Len = (s: string) => new TextEncoder().encode(s).length;
const TEST_DEADLINE = "2030-06-01T12:00:00.000Z";

type Untrusted = {
  untrusted: true;
  source: "peer";
  data: unknown;
  truncated?: true;
  original_length?: number;
};

function isUntrusted(value: unknown): value is Untrusted {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Untrusted).untrusted === true &&
    (value as Untrusted).source === "peer"
  );
}

describe("session_status untrusted peer presentation", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function makeCtx(opts?: { peerContentCapBytes?: number }) {
    const dir = await mkdtemp(join(tmpdir(), "agentpair-session-untrusted-"));
    tempDirs.push(dir);
    const bonds = new MemoryBondStore();
    const allowlist = new MemoryAllowlistStore();
    const sessionStore = createSessionStore();
    const ctx = createAgentContext({
      keyStore: createKeyStore({ keyPath: join(dir, "keys.json") }),
      relay: {
        sendEnvelope: async () => undefined,
        pullInbox: async () => ({ ok: true as const, wires: [], rowids: [], cursor: 0 }),
      } as never,
      bonds,
      allowlist,
      pending: createPendingQueue(),
      sessionStore,
      peerContentCapBytes: opts?.peerContentCapBytes ?? 8192,
    });
    const keys = await ctx.keyStore.loadOrCreate();
    const agentId = publicKeyToAgentId(keys.publicKey);
    const peer = publicKeyToAgentId(generateKeyPair().publicKey);
    allowlist.set(agentId, [peer]);
    bonds.add(agentId, {
      peer,
      scope: ["session.negotiate"],
      mode: "bonded_contact",
      profiles: ["core/1", "nego/1"],
    });
    return { ctx, agentId, peer, sessionStore };
  }

  function baseSession(
    thread: string,
    agentId: string,
    peer: string,
    role: "initiator" | "recipient",
    overrides: Partial<SessionRecord> = {},
  ): SessionRecord {
    return {
      thread,
      initiator: role === "initiator" ? agentId : peer,
      recipient: role === "recipient" ? agentId : peer,
      role,
      status: "live",
      goal: "Negotiate API contract",
      acceptance: [{ id: "A1", test: "judgment", desc: "ok" }],
      budget: { max_turns: 10, deadline: TEST_DEADLINE },
      mandate: { agent_may: ["propose"], human_required: ["sign_final"] },
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
      turnCount: 1,
      peerMessages: [],
      lockedSections: [],
      testReports: {},
      challenges: {},
      signHashes: {},
      ratifyApproved: {},
      ...overrides,
    };
  }

  it("S6: peer_messages body always wrapped; from/type/turn stay plain metadata", async () => {
    const { ctx, agentId, peer, sessionStore } = await makeCtx();
    const thread = crypto.randomUUID();
    const body = JSON.stringify({ diff: "timestamp: ISO-8601" });
    sessionStore.upsert(
      baseSession(thread, agentId, peer, "recipient", {
        peerMessages: [{ from: "initiator", type: "propose", body, turn: 1 }],
        turnCount: 1,
      }),
    );

    const status = structured(await handleSessionStatus(ctx, { thread }));
    expect(status.ok).toBe(true);
    if (!status.ok) return;

    expect(status.peer_messages).toHaveLength(1);
    const row = status.peer_messages[0] as {
      from: string;
      type: string;
      turn: number;
      body: unknown;
    };
    expect(row.from).toBe("initiator");
    expect(row.type).toBe("propose");
    expect(row.turn).toBe(1);
    expect(isUntrusted(row.body)).toBe(true);
    expect(row.body).toEqual({ untrusted: true, source: "peer", data: body });
    expect(row.body).not.toHaveProperty("truncated");
  });

  it("S6: each peer_messages body capped independently", async () => {
    const cap = 16;
    const { ctx, agentId, peer, sessionStore } = await makeCtx({ peerContentCapBytes: cap });
    const thread = crypto.randomUUID();
    const small = "ok";
    const large = "L".repeat(64);
    sessionStore.upsert(
      baseSession(thread, agentId, peer, "initiator", {
        peerMessages: [
          { from: "recipient", type: "counter", body: small, turn: 1 },
          { from: "initiator", type: "propose", body: large, turn: 2 },
        ],
        turnCount: 2,
      }),
    );

    const status = structured(await handleSessionStatus(ctx, { thread }));
    expect(status.ok).toBe(true);
    if (!status.ok) return;

    const [a, b] = status.peer_messages as Array<{ body: Untrusted }>;
    expect(a.body).toEqual({ untrusted: true, source: "peer", data: small });
    expect(a.body).not.toHaveProperty("truncated");
    expect(b.body.truncated).toBe(true);
    expect(typeof b.body.data).toBe("string");
    expect(utf8Len(b.body.data as string)).toBeLessThanOrEqual(cap);
  });

  it("S7: goal wrapped only for recipient; plain string for initiator", async () => {
    const goal = "Peer-authored goal text";
    const {
      ctx: recipientCtx,
      agentId: recipientId,
      peer: initiatorId,
      sessionStore: rStore,
    } = await makeCtx();
    const rThread = crypto.randomUUID();
    rStore.upsert(baseSession(rThread, recipientId, initiatorId, "recipient", { goal }));

    const recipientStatus = structured(
      await handleSessionStatus(recipientCtx, { thread: rThread }),
    );
    expect(recipientStatus.ok).toBe(true);
    if (!recipientStatus.ok) return;
    expect(isUntrusted(recipientStatus.goal)).toBe(true);
    expect(recipientStatus.goal).toEqual({
      untrusted: true,
      source: "peer",
      data: goal,
    });

    const {
      ctx: initiatorCtx,
      agentId: initiatorAgent,
      peer: recipientPeer,
      sessionStore: iStore,
    } = await makeCtx();
    const iThread = crypto.randomUUID();
    iStore.upsert(baseSession(iThread, initiatorAgent, recipientPeer, "initiator", { goal }));

    const initiatorStatus = structured(
      await handleSessionStatus(initiatorCtx, { thread: iThread }),
    );
    expect(initiatorStatus.ok).toBe(true);
    if (!initiatorStatus.ok) return;
    expect(initiatorStatus.goal).toBe(goal);
    expect(isUntrusted(initiatorStatus.goal)).toBe(false);
  });

  it("S8: reject_reason empty and present are wrapped; absent stays absent", async () => {
    const { ctx, agentId, peer, sessionStore } = await makeCtx();

    const emptyThread = crypto.randomUUID();
    sessionStore.upsert(
      baseSession(emptyThread, agentId, peer, "initiator", {
        status: "open_rejected",
        rejectReason: "",
      }),
    );
    const emptyStatus = structured(await handleSessionStatus(ctx, { thread: emptyThread }));
    expect(emptyStatus.ok).toBe(true);
    if (!emptyStatus.ok) return;
    expect(isUntrusted(emptyStatus.reject_reason)).toBe(true);
    expect(emptyStatus.reject_reason).toEqual({
      untrusted: true,
      source: "peer",
      data: "",
    });

    const absentThread = crypto.randomUUID();
    sessionStore.upsert(baseSession(absentThread, agentId, peer, "initiator"));
    const absentStatus = structured(await handleSessionStatus(ctx, { thread: absentThread }));
    expect(absentStatus.ok).toBe(true);
    if (!absentStatus.ok) return;
    // Presentation must not invent reject_reason when protocol has none
    expect(absentStatus.reject_reason === undefined || !("reject_reason" in absentStatus)).toBe(
      true,
    );
    if (absentStatus.reject_reason !== undefined) {
      // If key still present as undefined, it must not be a wrapper with invented data
      expect(isUntrusted(absentStatus.reject_reason)).toBe(false);
    }

    const hostLocalThread = crypto.randomUUID();
    sessionStore.upsert(
      baseSession(hostLocalThread, agentId, peer, "initiator", {
        status: "closed",
        rejectReason: "bond_revoked",
      }),
    );
    const hostLocal = structured(await handleSessionStatus(ctx, { thread: hostLocalThread }));
    expect(hostLocal.ok).toBe(true);
    if (!hostLocal.ok) return;
    // Host-local values still wrapped when present (label imprecision accepted)
    expect(isUntrusted(hostLocal.reject_reason)).toBe(true);
    expect(hostLocal.reject_reason).toEqual({
      untrusted: true,
      source: "peer",
      data: "bond_revoked",
    });
  });

  it("S9: locked_sections is array of wrappers with 256-byte per-item cap", async () => {
    const { ctx, agentId, peer, sessionStore } = await makeCtx();
    const thread = crypto.randomUUID();
    const shortId = "ok";
    const longId = "s".repeat(400);
    expect(utf8Len(longId)).toBe(400);
    expect(LOCKED_SECTION_ID_CAP_BYTES).toBe(256);

    sessionStore.upsert(
      baseSession(thread, agentId, peer, "initiator", {
        lockedSections: [shortId, longId],
      }),
    );

    const status = structured(await handleSessionStatus(ctx, { thread }));
    expect(status.ok).toBe(true);
    if (!status.ok) return;

    expect(Array.isArray(status.locked_sections)).toBe(true);
    expect(status.locked_sections).toHaveLength(2);
    const [w0, w1] = status.locked_sections as Untrusted[];
    expect(w0).toEqual({ untrusted: true, source: "peer", data: shortId });
    expect(w0).not.toHaveProperty("truncated");
    expect(w1.truncated).toBe(true);
    expect(w1.original_length).toBe(400);
    expect(typeof w1.data).toBe("string");
    expect(utf8Len(w1.data as string)).toBeLessThanOrEqual(LOCKED_SECTION_ID_CAP_BYTES);
  });

  it("S10: empty peer_messages and locked_sections stay empty arrays", async () => {
    const { ctx, agentId, peer, sessionStore } = await makeCtx();
    const thread = crypto.randomUUID();
    sessionStore.upsert(
      baseSession(thread, agentId, peer, "initiator", {
        peerMessages: [],
        lockedSections: [],
      }),
    );

    const status = structured(await handleSessionStatus(ctx, { thread }));
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.peer_messages).toEqual([]);
    expect(status.locked_sections).toEqual([]);
  });
});
