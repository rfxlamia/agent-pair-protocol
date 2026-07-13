import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOuterEnvelope,
  defaultEnvelopeTtl,
  publicKeyToAgentId,
  serializeOuterEnvelope,
} from "@agentpair/protocol";
import { describe, expect, it, vi } from "vitest";
import type { HttpRelayClient } from "../relay/client.js";
import { MemoryAllowlistStore } from "../store/allowlist.js";
import { MemoryBondStore } from "../store/bonds.js";
import { MemoryInboxCursorStore } from "../store/inbox-cursor.js";
import { createKeyStore } from "../store/keys.js";
import { createPendingQueue } from "../store/pending.js";
import { sendEnvelopeWithSpill } from "./inbox-spill.js";
import { handleInbox } from "./inbox.js";
import { createAgentContext } from "./pair.js";

function structured<T>(result: { structuredContent: T }): T {
  return result.structuredContent;
}

async function makeCoreOnlyBond() {
  const [aliceDir, bobDir] = await Promise.all([
    mkdtemp(join(tmpdir(), "agentpair-profile-alice-")),
    mkdtemp(join(tmpdir(), "agentpair-profile-bob-")),
  ]);
  const allowlistAlice = new MemoryAllowlistStore();
  const allowlistBob = new MemoryAllowlistStore();
  const bondsAlice = new MemoryBondStore();
  const bondsBob = new MemoryBondStore();
  const relay = {
    sendEnvelope: vi.fn(async () => undefined),
    pullInbox: vi.fn(),
    putArtifact: vi.fn(async () => undefined),
    getArtifact: vi.fn(),
  };

  const aliceCtx = createAgentContext({
    keyStore: createKeyStore({ keyPath: join(aliceDir, "keys.json") }),
    relay: relay as unknown as HttpRelayClient,
    allowlist: allowlistAlice,
    bonds: bondsAlice,
    pending: createPendingQueue(),
    inboxCursor: new MemoryInboxCursorStore(),
  });
  const bobCtx = createAgentContext({
    keyStore: createKeyStore({ keyPath: join(bobDir, "keys.json") }),
    relay: relay as unknown as HttpRelayClient,
    allowlist: allowlistBob,
    bonds: bondsBob,
    pending: createPendingQueue(),
    inboxCursor: new MemoryInboxCursorStore(),
  });

  const aliceKeys = await aliceCtx.keyStore.loadOrCreate();
  const bobKeys = await bobCtx.keyStore.loadOrCreate();
  const aliceId = publicKeyToAgentId(aliceKeys.publicKey);
  const bobId = publicKeyToAgentId(bobKeys.publicKey);

  allowlistAlice.set(aliceId, [bobId]);
  allowlistBob.set(bobId, [aliceId]);
  bondsAlice.add(aliceId, {
    peer: bobId,
    scope: ["msg"],
    mode: "bonded_contact",
    profiles: ["core/1"],
  });
  bondsBob.add(bobId, {
    peer: aliceId,
    scope: ["msg"],
    mode: "bonded_contact",
    profiles: ["core/1"],
  });

  await aliceCtx.envelopeSeq.init(aliceId);
  await bobCtx.envelopeSeq.init(bobId);

  return { aliceCtx, bobCtx, aliceKeys, bobKeys, aliceId, bobId, relay, aliceDir, bobDir };
}

describe("inbox profile enforcement", () => {
  it("send nego.open rejected with profile_not_supported before relay", async () => {
    const { aliceCtx, aliceKeys, bobId, relay, aliceDir, bobDir } = await makeCoreOnlyBond();
    try {
      const result = await sendEnvelopeWithSpill(aliceCtx, {
        sender: aliceKeys,
        to: bobId,
        type: "nego.open",
        thread: crypto.randomUUID(),
        seq: 1,
        ttl: defaultEnvelopeTtl(),
        payload: new TextEncoder().encode(JSON.stringify({ goal: "x" })),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("profile_not_supported");
      }
      expect(relay.sendEnvelope).not.toHaveBeenCalled();
    } finally {
      await Promise.all([
        rm(aliceDir, { recursive: true, force: true }),
        rm(bobDir, { recursive: true, force: true }),
      ]);
    }
  });

  it("receive nego.turn returns profile_not_supported with no side effects", async () => {
    const { aliceCtx, bobKeys, bobId, aliceId, relay, aliceDir, bobDir } = await makeCoreOnlyBond();
    try {
      const thread = "550e8400-e29b-41d4-a716-446655440001";
      const negoWire = serializeOuterEnvelope(
        createOuterEnvelope({
          sender: bobKeys,
          recipientAgentId: aliceId,
          type: "nego.turn",
          thread,
          seq: 1,
          ttl: Math.floor(Date.now() / 1000) + 3600,
          payload: new TextEncoder().encode(JSON.stringify({ body: "probe" })),
        }),
      );
      relay.pullInbox.mockResolvedValue({
        ok: true,
        wires: [negoWire],
        cursor: 1,
        rowids: [1],
      });
      const seqBefore = aliceCtx.envelopeSeq.getLastAccepted(thread, bobId);

      const result = structured(await handleInbox(aliceCtx, {}));

      expect(result.ok).toBe(true);
      expect(result.rejected).toEqual(
        expect.arrayContaining([expect.objectContaining({ error: "profile_not_supported" })]),
      );
      expect(result.envelopes).toHaveLength(0);
      expect(aliceCtx.envelopeSeq.getLastAccepted(thread, bobId)).toBe(seqBefore);
    } finally {
      await Promise.all([
        rm(aliceDir, { recursive: true, force: true }),
        rm(bobDir, { recursive: true, force: true }),
      ]);
    }
  });

  it("unknown.foo returns unsupported_envelope_type not profile_not_supported", async () => {
    const { aliceCtx, bobKeys, aliceId, relay, aliceDir, bobDir } = await makeCoreOnlyBond();
    try {
      const badWire = serializeOuterEnvelope(
        createOuterEnvelope({
          sender: bobKeys,
          recipientAgentId: aliceId,
          type: "unknown.foo",
          thread: crypto.randomUUID(),
          seq: 1,
          ttl: Math.floor(Date.now() / 1000) + 3600,
          payload: new TextEncoder().encode("{}"),
        }),
      );
      relay.pullInbox.mockResolvedValue({
        ok: true,
        wires: [badWire],
        cursor: 1,
        rowids: [1],
      });
      const result = structured(await handleInbox(aliceCtx, {}));
      expect(result.rejected).toEqual(
        expect.arrayContaining([expect.objectContaining({ error: "unsupported_envelope_type" })]),
      );
      expect(result.rejected?.every((r) => r.error !== "profile_not_supported")).toBe(true);
    } finally {
      await Promise.all([
        rm(aliceDir, { recursive: true, force: true }),
        rm(bobDir, { recursive: true, force: true }),
      ]);
    }
  });

  it("spill send rejects nego before relay when bond lacks nego/1", async () => {
    const { aliceCtx, aliceKeys, bobId, relay, aliceDir, bobDir } = await makeCoreOnlyBond();
    try {
      const largeBody = "x".repeat(70_000);
      const result = await sendEnvelopeWithSpill(aliceCtx, {
        sender: aliceKeys,
        to: bobId,
        type: "nego.open",
        thread: crypto.randomUUID(),
        seq: 1,
        ttl: defaultEnvelopeTtl(),
        payload: new TextEncoder().encode(JSON.stringify({ goal: largeBody })),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("profile_not_supported");
      }
      expect(relay.sendEnvelope).not.toHaveBeenCalled();
      expect(relay.putArtifact).not.toHaveBeenCalled();
    } finally {
      await Promise.all([
        rm(aliceDir, { recursive: true, force: true }),
        rm(bobDir, { recursive: true, force: true }),
      ]);
    }
  });
});
