import { utf8ToBytes } from "@noble/ciphers/utils.js";
import { describe, expect, it, vi } from "vitest";
import {
  type EnvelopeBody,
  type OuterEnvelope,
  createOuterEnvelope,
  serializeBodyBytes,
  serializeOuterEnvelope,
} from "./crypto/envelope.js";
import { generateKeyPair, publicKeyToAgentId } from "./crypto/keys.js";
import {
  MAX_ENVELOPE_WIRE_BYTES,
  type ReceiveEnvelopeDeps,
  defaultEnvelopeTtl,
  receiveEnvelope,
} from "./crypto/receive-envelope.js";

const thread = "550e8400-e29b-41d4-a716-446655440000";

function makeDeps(overrides: Partial<ReceiveEnvelopeDeps> = {}): ReceiveEnvelopeDeps {
  return {
    isBonded: () => true,
    seqStore: {
      getLastAccepted: () => 0,
      commitAccepted: vi.fn(),
    },
    dispatch: vi.fn(async () => ({ ok: true as const })),
    ...overrides,
  };
}

function makeValidWire(): { wire: string; aliceId: string; bobId: string } {
  const alice = generateKeyPair();
  const bob = generateKeyPair();
  const aliceId = publicKeyToAgentId(alice.publicKey);
  const bobId = publicKeyToAgentId(bob.publicKey);

  const outer = createOuterEnvelope({
    sender: alice,
    recipientAgentId: bobId,
    type: "chat.message",
    thread,
    seq: 1,
    ttl: 9_999_999_999,
    payload: utf8ToBytes('{"hello":"world"}'),
  });

  return { wire: serializeOuterEnvelope(outer), aliceId, bobId };
}

function tamperOuter(wire: string, patch: (outer: Record<string, unknown>) => void): string {
  const outer = JSON.parse(wire) as Record<string, unknown>;
  patch(outer);
  return JSON.stringify(outer);
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
  const deficit = targetBytes - wireUtf8Length(wire);
  if (deficit === 0) {
    return wire;
  }
  if (deficit < 0) {
    throw new Error(`wire already exceeds ${targetBytes} bytes`);
  }
  const outer = JSON.parse(wire) as OuterEnvelope;
  outer.blob = `${outer.blob}${"A".repeat(deficit)}`;
  return JSON.stringify(outer);
}

describe("receiveEnvelope steps 0–6 (§4.3)", () => {
  it("step 0: unknown wire version → unsupported_version, dispatch not called", async () => {
    const deps = makeDeps();
    const wire = tamperOuter(makeValidWire().wire, (outer) => {
      outer.v = 2;
    });

    const result = await receiveEnvelope(wire, makeValidWire().bobId, deps);

    expect(result).toEqual({ ok: false, error: "unsupported_version" });
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.seqStore.commitAccepted).not.toHaveBeenCalled();
  });

  it("step 1: wire > 65536 UTF-8 bytes → envelope_too_large, dispatch not called", async () => {
    const deps = makeDeps();
    const wire = "a".repeat(MAX_ENVELOPE_WIRE_BYTES + 1);

    const result = await receiveEnvelope(wire, "self", deps);

    expect(result).toEqual({ ok: false, error: "envelope_too_large" });
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.seqStore.commitAccepted).not.toHaveBeenCalled();
  });

  it("step 1: wire === 65536 bytes passes size check", async () => {
    const { wire, bobId } = makeValidWire();
    const deps = makeDeps();
    const paddedWire = padWireToSize(wire, MAX_ENVELOPE_WIRE_BYTES);

    expect(wireUtf8Length(paddedWire)).toBe(MAX_ENVELOPE_WIRE_BYTES);

    const result = await receiveEnvelope(paddedWire, bobId, deps);

    expect(result.error).not.toBe("envelope_too_large");
  });

  it("step 2: malformed body JSON → invalid_json, dispatch not called", async () => {
    const { wire, bobId } = makeValidWire();
    const deps = makeDeps();
    const outer = JSON.parse(wire) as OuterEnvelope;
    const badBlob = Buffer.from("{not-json", "utf8").toString("base64url");
    const badWire = serializeOuterEnvelope({ ...outer, blob: badBlob });

    const result = await receiveEnvelope(badWire, bobId, deps);

    expect(result).toEqual({ ok: false, error: "invalid_json" });
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.seqStore.commitAccepted).not.toHaveBeenCalled();
  });

  it("step 3: body.v !== outer.v → version_mismatch, dispatch not called", async () => {
    const { wire, bobId } = makeValidWire();
    const deps = makeDeps();
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
    const { wire, aliceId, bobId } = makeValidWire();
    const deps = makeDeps({
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
    const { wire, bobId } = makeValidWire();
    const deps = makeDeps();
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
    const { wire, bobId } = makeValidWire();
    const deps = makeDeps();
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
    const { wire, bobId } = makeValidWire();
    const deps = makeDeps();
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
    const { wire, bobId } = makeValidWire();
    const deps = makeDeps();

    const result = await receiveEnvelope(wire, "not-bob", deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("routing_mismatch");
      expect(result.body).toBeDefined();
    }
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.seqStore.commitAccepted).not.toHaveBeenCalled();
  });

  it("valid wire passing steps 0–6 → envelope_incomplete, dispatch not called", async () => {
    const { wire, bobId } = makeValidWire();
    const deps = makeDeps();

    const result = await receiveEnvelope(wire, bobId, deps);

    expect(result).toEqual({ ok: false, error: "envelope_incomplete" });
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.seqStore.commitAccepted).not.toHaveBeenCalled();
  });
});

describe("defaultEnvelopeTtl", () => {
  it("returns now + seconds as absolute unix timestamp", () => {
    const now = 1_700_000_000;
    expect(defaultEnvelopeTtl(3600, now)).toBe(1_700_003_600);
  });
});

describe("receiveEnvelope steps 7+ (T2)", () => {
  it.todo("step 7: stale seq → stale_seq");
  it.todo("step 7: expired ttl → envelope_expired");
  it.todo("step 8: dispatch success → ok true");
});
