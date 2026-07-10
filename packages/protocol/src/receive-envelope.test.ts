import { utf8ToBytes } from "@noble/ciphers/utils.js";
import { describe, expect, it, vi } from "vitest";
import {
  type EnvelopeBody,
  type OuterEnvelope,
  createOuterEnvelope,
  serializeBodyBytes,
  serializeOuterEnvelope,
} from "./crypto/envelope.js";
import { type KeyPair, generateKeyPair, publicKeyToAgentId } from "./crypto/keys.js";
import {
  MAX_ENVELOPE_WIRE_BYTES,
  type ReceiveEnvelopeDeps,
  type SeqStore,
  defaultEnvelopeTtl,
  receiveEnvelope,
} from "./crypto/receive-envelope.js";
import { sign } from "./crypto/sign.js";

const thread = "550e8400-e29b-41d4-a716-446655440000";
const fixedNow = 1_700_000_000;

function makeMutableSeqStore(): SeqStore & { commitAccepted: ReturnType<typeof vi.fn> } {
  const store = new Map<string, number>();
  const key = (t: string, from: string) => `${t}:${from}`;
  return {
    getLastAccepted: (t: string, from: string) => store.get(key(t, from)) ?? 0,
    commitAccepted: vi.fn((t: string, from: string, seq: number) => {
      store.set(key(t, from), seq);
    }),
  };
}

function makeDeps(
  selfKeyPair: KeyPair,
  overrides: Partial<ReceiveEnvelopeDeps> = {},
): ReceiveEnvelopeDeps {
  return {
    isBonded: () => true,
    selfKeyPair,
    seqStore: {
      getLastAccepted: () => 0,
      commitAccepted: vi.fn(),
    },
    dispatch: vi.fn(async () => ({ ok: true as const })),
    nowUnix: () => fixedNow,
    ...overrides,
  };
}

function makeValidWire(options?: {
  seq?: number;
  ttl?: number;
  thread?: string;
}): {
  wire: string;
  alice: KeyPair;
  bob: KeyPair;
  aliceId: string;
  bobId: string;
} {
  const alice = generateKeyPair();
  const bob = generateKeyPair();
  const aliceId = publicKeyToAgentId(alice.publicKey);
  const bobId = publicKeyToAgentId(bob.publicKey);

  const outer = createOuterEnvelope({
    sender: alice,
    recipientAgentId: bobId,
    type: "chat.message",
    thread: options?.thread ?? thread,
    seq: options?.seq ?? 1,
    ttl: options?.ttl ?? 9_999_999_999,
    payload: utf8ToBytes('{"hello":"world"}'),
  });

  return { wire: serializeOuterEnvelope(outer), alice, bob, aliceId, bobId };
}

function tamperOuter(wire: string, patch: (outer: Record<string, unknown>) => void): string {
  const outer = JSON.parse(wire) as Record<string, unknown>;
  patch(outer);
  return JSON.stringify(outer);
}

function resignBody(wire: string, sender: KeyPair, patch: (body: EnvelopeBody) => void): string {
  const outer = JSON.parse(wire) as OuterEnvelope;
  const blobBytes = Buffer.from(outer.blob, "base64url");
  const body = JSON.parse(blobBytes.toString("utf8")) as EnvelopeBody;
  patch(body);
  const bodyBytes = serializeBodyBytes(body);
  const signature = sign(bodyBytes, sender.secretKey);
  return serializeOuterEnvelope({
    v: 1,
    from: body.from,
    to: body.to,
    blob: Buffer.from(bodyBytes).toString("base64url"),
    sig: Buffer.from(signature).toString("base64url"),
  });
}

function tamperBody(wire: string, patch: (body: EnvelopeBody) => void): string {
  const outer = JSON.parse(wire) as OuterEnvelope;
  const blobBytes = Buffer.from(outer.blob, "base64url");
  const body = JSON.parse(blobBytes.toString("utf8")) as EnvelopeBody;
  patch(body);
  const tampered = { ...outer, blob: Buffer.from(serializeBodyBytes(body)).toString("base64url") };
  return serializeOuterEnvelope(tampered);
}

function wireUtf8Length(wire: string): number {
  return utf8ToBytes(wire).length;
}

function padWireToSize(wire: string, targetBytes: number): string {
  const current = wireUtf8Length(wire);
  if (current === targetBytes) {
    return wire;
  }
  if (current > targetBytes) {
    throw new Error(`wire already exceeds ${targetBytes} bytes`);
  }
  const outer = JSON.parse(wire) as Record<string, unknown>;
  let low = 0;
  let high = targetBytes;
  let best = "";
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = JSON.stringify({ ...outer, _pad: "x".repeat(mid) });
    const len = wireUtf8Length(candidate);
    if (len <= targetBytes) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (!best || wireUtf8Length(best) !== targetBytes) {
    throw new Error(`could not pad wire to exactly ${targetBytes} bytes`);
  }
  return best;
}

describe("receiveEnvelope steps 0–6 (§4.3)", () => {
  it("step 0: unknown wire version → unsupported_version, dispatch not called", async () => {
    const { wire, bob, bobId } = makeValidWire();
    const deps = makeDeps(bob);
    const badWire = tamperOuter(wire, (outer) => {
      outer.v = 2;
    });

    const result = await receiveEnvelope(badWire, bobId, deps);

    expect(result).toEqual({ ok: false, error: "unsupported_version" });
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.seqStore.commitAccepted).not.toHaveBeenCalled();
  });

  it("step 1: wire > 65536 UTF-8 bytes → envelope_too_large, dispatch not called", async () => {
    const { bob } = makeValidWire();
    const deps = makeDeps(bob);
    const wire = "a".repeat(MAX_ENVELOPE_WIRE_BYTES + 1);

    const result = await receiveEnvelope(wire, "self", deps);

    expect(result).toEqual({ ok: false, error: "envelope_too_large" });
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.seqStore.commitAccepted).not.toHaveBeenCalled();
  });

  it("step 1: wire === 65536 bytes passes size check", async () => {
    const { wire, bob, bobId } = makeValidWire();
    const deps = makeDeps(bob);
    const paddedWire = padWireToSize(wire, MAX_ENVELOPE_WIRE_BYTES);

    expect(wireUtf8Length(paddedWire)).toBe(MAX_ENVELOPE_WIRE_BYTES);

    const result = await receiveEnvelope(paddedWire, bobId, deps);

    expect(result.error).not.toBe("envelope_too_large");
  });

  it("step 2: malformed body JSON → invalid_json, dispatch not called", async () => {
    const { wire, bob, bobId } = makeValidWire();
    const deps = makeDeps(bob);
    const outer = JSON.parse(wire) as OuterEnvelope;
    const badBlob = Buffer.from("{not-json", "utf8").toString("base64url");
    const badWire = serializeOuterEnvelope({ ...outer, blob: badBlob });

    const result = await receiveEnvelope(badWire, bobId, deps);

    expect(result).toEqual({ ok: false, error: "invalid_json" });
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.seqStore.commitAccepted).not.toHaveBeenCalled();
  });

  it.each([
    ["padded blob", "YQ=="],
    ["non-alphabet blob", "ab!cd"],
    ["non-canonical blob", (outer: OuterEnvelope) => `${outer.blob}A`],
    ["empty blob", ""],
  ])("step 2: strict-decode rejects %s → invalid_json", async (_label, blobOrFn) => {
    const { wire, bob, bobId } = makeValidWire();
    const deps = makeDeps(bob);
    const outer = JSON.parse(wire) as OuterEnvelope;
    const blob = typeof blobOrFn === "function" ? blobOrFn(outer) : blobOrFn;
    const badWire = serializeOuterEnvelope({ ...outer, blob });

    const result = await receiveEnvelope(badWire, bobId, deps);

    expect(result).toEqual({ ok: false, error: "invalid_json" });
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.seqStore.commitAccepted).not.toHaveBeenCalled();
  });

  it("step 3: body.v !== outer.v → version_mismatch, dispatch not called", async () => {
    const { wire, bob, bobId } = makeValidWire();
    const deps = makeDeps(bob);
    const mismatched = tamperBody(wire, (body) => {
      body.v = 2 as unknown as 1;
    });

    const result = await receiveEnvelope(mismatched, bobId, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("version_mismatch");
      expect(result.body).toBeDefined();
    }
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.seqStore.commitAccepted).not.toHaveBeenCalled();
  });

  it("step 4: unbonded sender → recipient_not_allowed, dispatch not called", async () => {
    const { wire, aliceId, bob, bobId } = makeValidWire();
    const deps = makeDeps(bob, {
      isBonded: (from) => from !== aliceId,
    });

    const result = await receiveEnvelope(wire, bobId, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("recipient_not_allowed");
      expect(result.body).toBeDefined();
    }
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.seqStore.commitAccepted).not.toHaveBeenCalled();
  });

  it("step 5: bad signature → invalid_signature, dispatch not called", async () => {
    const { wire, bob, bobId } = makeValidWire();
    const deps = makeDeps(bob);
    const badSig = tamperOuter(wire, (outer) => {
      outer.sig = `${String(outer.sig).slice(0, -2)}XX`;
    });

    const result = await receiveEnvelope(badSig, bobId, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("invalid_signature");
      expect(result.body).toBeDefined();
    }
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.seqStore.commitAccepted).not.toHaveBeenCalled();
  });

  it("step 6: outer.to !== body.to → routing_mismatch, dispatch not called", async () => {
    const { wire, bob, bobId } = makeValidWire();
    const deps = makeDeps(bob);
    const mismatched = tamperOuter(wire, (outer) => {
      outer.to = "wrong-recipient";
    });

    const result = await receiveEnvelope(mismatched, bobId, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("routing_mismatch");
      expect(result.body).toBeDefined();
    }
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.seqStore.commitAccepted).not.toHaveBeenCalled();
  });

  it("step 6: outer.from !== body.from → routing_mismatch, dispatch not called", async () => {
    const { wire, bob, bobId } = makeValidWire();
    const deps = makeDeps(bob);
    const mismatched = tamperOuter(wire, (outer) => {
      outer.from = "wrong-sender";
    });

    const result = await receiveEnvelope(mismatched, bobId, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("routing_mismatch");
      expect(result.body).toBeDefined();
    }
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.seqStore.commitAccepted).not.toHaveBeenCalled();
  });

  it("step 6: body.to !== selfId → routing_mismatch, dispatch not called", async () => {
    const { wire, bob, bobId } = makeValidWire();
    const deps = makeDeps(bob);

    const result = await receiveEnvelope(wire, "not-bob", deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("routing_mismatch");
      expect(result.body).toBeDefined();
    }
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.seqStore.commitAccepted).not.toHaveBeenCalled();
  });

  it("valid wire passing steps 0–6 continues to step 7+ (not rejected early)", async () => {
    const { wire, bob, bobId } = makeValidWire();
    const deps = makeDeps(bob);

    const result = await receiveEnvelope(wire, bobId, deps);

    expect(result.ok).toBe(true);
    expect(deps.dispatch).toHaveBeenCalled();
    expect(deps.seqStore.commitAccepted).toHaveBeenCalled();
  });
});

describe("defaultEnvelopeTtl", () => {
  it("returns now + seconds as absolute unix timestamp", () => {
    const now = 1_700_000_000;
    expect(defaultEnvelopeTtl(3600, now)).toBe(1_700_003_600);
  });
});

describe("receiveEnvelope steps 7–8 (§4.3)", () => {
  it("step 7: seq <= lastAccepted(thread, from) → stale_seq, commitAccepted not called", async () => {
    const { wire, bob, bobId } = makeValidWire({ seq: 1 });
    const deps = makeDeps(bob, {
      seqStore: { getLastAccepted: () => 1, commitAccepted: vi.fn() },
    });

    const result = await receiveEnvelope(wire, bobId, deps);

    expect(result).toEqual({ ok: false, error: "stale_seq", body: expect.any(Object) });
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.seqStore.commitAccepted).not.toHaveBeenCalled();
  });

  it("step 7: duplicate seq after accept → stale_seq", async () => {
    const { wire, bob, bobId } = makeValidWire({ seq: 1 });
    const seqStore = makeMutableSeqStore();
    const deps = makeDeps(bob, { seqStore });

    const first = await receiveEnvelope(wire, bobId, deps);
    expect(first.ok).toBe(true);
    expect(seqStore.commitAccepted).toHaveBeenCalledWith(thread, expect.any(String), 1);

    const second = await receiveEnvelope(wire, bobId, deps);
    expect(second).toEqual({ ok: false, error: "stale_seq", body: expect.any(Object) });
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
    expect(seqStore.commitAccepted).toHaveBeenCalledTimes(1);
  });

  it("step 7: first seq=1 with baseline 0 → pass", async () => {
    const { wire, bob, bobId } = makeValidWire({ seq: 1 });
    const deps = makeDeps(bob);

    const result = await receiveEnvelope(wire, bobId, deps);

    expect(result.ok).toBe(true);
    expect(deps.seqStore.commitAccepted).toHaveBeenCalledWith(thread, expect.any(String), 1);
  });

  it("step 7: independent seq per (thread, from) on same thread", async () => {
    const alice1 = generateKeyPair();
    const alice2 = generateKeyPair();
    const bob = generateKeyPair();
    const bobId = publicKeyToAgentId(bob.publicKey);
    const alice1Id = publicKeyToAgentId(alice1.publicKey);
    const alice2Id = publicKeyToAgentId(alice2.publicKey);

    const wire1 = serializeOuterEnvelope(
      createOuterEnvelope({
        sender: alice1,
        recipientAgentId: bobId,
        type: "chat.message",
        thread,
        seq: 1,
        ttl: 9_999_999_999,
        payload: utf8ToBytes("a"),
      }),
    );
    const wire2 = serializeOuterEnvelope(
      createOuterEnvelope({
        sender: alice2,
        recipientAgentId: bobId,
        type: "chat.message",
        thread,
        seq: 1,
        ttl: 9_999_999_999,
        payload: utf8ToBytes("b"),
      }),
    );

    const seqStore = makeMutableSeqStore();
    const deps = makeDeps(bob, { seqStore });

    const r1 = await receiveEnvelope(wire1, bobId, deps);
    const r2 = await receiveEnvelope(wire2, bobId, deps);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(seqStore.commitAccepted).toHaveBeenCalledWith(thread, alice1Id, 1);
    expect(seqStore.commitAccepted).toHaveBeenCalledWith(thread, alice2Id, 1);
  });

  it("step 7: body.ttl <= nowUnix() → envelope_expired", async () => {
    const { wire, bob, bobId } = makeValidWire({ ttl: fixedNow });
    const deps = makeDeps(bob);

    const result = await receiveEnvelope(wire, bobId, deps);

    expect(result).toEqual({ ok: false, error: "envelope_expired", body: expect.any(Object) });
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.seqStore.commitAccepted).not.toHaveBeenCalled();
  });

  it("step 7: both stale seq and expired ttl → stale_seq (seq checked first)", async () => {
    const { wire, bob, bobId } = makeValidWire({ seq: 1, ttl: fixedNow });
    const deps = makeDeps(bob, {
      seqStore: { getLastAccepted: () => 1, commitAccepted: vi.fn() },
    });

    const result = await receiveEnvelope(wire, bobId, deps);

    expect(result).toEqual({ ok: false, error: "stale_seq", body: expect.any(Object) });
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it("step 8: dispatch ok → commitAccepted called with (thread, from, seq)", async () => {
    const { wire, bob, bobId, aliceId } = makeValidWire({ seq: 3 });
    const commitAccepted = vi.fn();
    const deps = makeDeps(bob, {
      seqStore: { getLastAccepted: () => 2, commitAccepted },
    });

    const result = await receiveEnvelope(wire, bobId, deps);

    expect(result.ok).toBe(true);
    expect(commitAccepted).toHaveBeenCalledWith(thread, aliceId, 3);
    expect(deps.dispatch).toHaveBeenCalledWith("chat.message", expect.any(Uint8Array));
  });

  it("step 8: decrypt failure → invalid_payload", async () => {
    const { wire, alice, bob, bobId } = makeValidWire();
    const badWire = resignBody(wire, alice, (body) => {
      body.payload = Buffer.from(new Uint8Array(40).fill(0xab)).toString("base64url");
    });
    const deps = makeDeps(bob);

    const result = await receiveEnvelope(badWire, bobId, deps);

    expect(result).toEqual({ ok: false, error: "invalid_payload", body: expect.any(Object) });
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.seqStore.commitAccepted).not.toHaveBeenCalled();
  });

  it("step 8: dispatch returns unsupported_envelope_type → no commit", async () => {
    const { wire, bob, bobId } = makeValidWire();
    const deps = makeDeps(bob, {
      dispatch: vi.fn(async () => ({ ok: false as const, error: "unsupported_envelope_type" })),
    });

    const result = await receiveEnvelope(wire, bobId, deps);

    expect(result).toEqual({
      ok: false,
      error: "unsupported_envelope_type",
      body: expect.any(Object),
    });
    expect(deps.seqStore.commitAccepted).not.toHaveBeenCalled();
  });

  it("step 8: dispatch returns invalid_payload → no commit", async () => {
    const { wire, bob, bobId } = makeValidWire();
    const deps = makeDeps(bob, {
      dispatch: vi.fn(async () => ({ ok: false as const, error: "invalid_payload" })),
    });

    const result = await receiveEnvelope(wire, bobId, deps);

    expect(result).toEqual({ ok: false, error: "invalid_payload", body: expect.any(Object) });
    expect(deps.seqStore.commitAccepted).not.toHaveBeenCalled();
  });

  it("order: dispatch must not run when step 7 fails (stale seq)", async () => {
    const { wire, bob, bobId } = makeValidWire({ seq: 1 });
    const dispatch = vi.fn(async () => {
      throw new Error("dispatch must not run when seq is stale");
    });
    const deps = makeDeps(bob, {
      seqStore: { getLastAccepted: () => 5, commitAccepted: vi.fn() },
      dispatch,
    });

    const result = await receiveEnvelope(wire, bobId, deps);

    expect(result).toEqual({ ok: false, error: "stale_seq", body: expect.any(Object) });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
