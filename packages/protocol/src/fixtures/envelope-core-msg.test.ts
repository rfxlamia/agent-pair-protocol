import { utf8ToBytes } from "@noble/ciphers/utils.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import {
  createOuterEnvelope,
  serializeOuterEnvelope,
  verifyOuterEnvelope,
} from "../crypto/envelope.js";
import { receiveEnvelope } from "../crypto/receive-envelope.js";
import { type FixtureHarness, makeReceiveDeps, resolveSelfKeyPair } from "./harness.js";
import { keyPairFromEntry, loadFixture, loadKeys } from "./load-fixture.js";

interface EnvelopeCoreMsgFixture {
  sender: "alice";
  recipient: "bob";
  id: string;
  type: string;
  thread: string;
  seq: number;
  ttl: number;
  plaintextUtf8: string;
  testOnlyNonceHex: string;
  harness: FixtureHarness;
  expected: {
    bodyJson: string;
    blob: string;
    sig: string;
    wire: string;
  };
}

describe("envelope-core-msg.json golden vectors", () => {
  const fixture = loadFixture<EnvelopeCoreMsgFixture>("envelope-core-msg.json");
  const keys = loadKeys();
  const alice = keyPairFromEntry(keys.alice);
  const bob = keyPairFromEntry(keys.bob);

  it("createOuterEnvelope reproduces committed blob and sig", () => {
    const outer = createOuterEnvelope({
      sender: alice,
      recipientAgentId: keys.bob.agentId,
      type: fixture.type,
      thread: fixture.thread,
      seq: fixture.seq,
      ttl: fixture.ttl,
      payload: utf8ToBytes(fixture.plaintextUtf8),
      id: fixture.id,
      testOnlyNonce: hexToBytes(fixture.testOnlyNonceHex),
    });
    expect(serializeOuterEnvelope(outer)).toBe(fixture.expected.wire);
    expect(outer.blob).toBe(fixture.expected.blob);
    expect(outer.sig).toBe(fixture.expected.sig);
    expect(verifyOuterEnvelope(outer, alice.publicKey)).toBe(true);
  });

  it("receiveEnvelope accepts committed wire with harness clock", async () => {
    const { selfId, selfKeyPair } = resolveSelfKeyPair(keys, fixture.harness);
    const deps = makeReceiveDeps(selfKeyPair, fixture.harness);
    const result = await receiveEnvelope(fixture.expected.wire, selfId, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(new TextDecoder().decode(result.plaintext)).toBe(fixture.plaintextUtf8);
    }
  });

  it("ttl is strictly greater than harness nowUnix", () => {
    expect(fixture.ttl).toBeGreaterThan(fixture.harness.nowUnix);
  });
});
