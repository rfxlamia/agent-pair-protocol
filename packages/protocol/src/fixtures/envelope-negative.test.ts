import { describe, expect, it } from "vitest";
import { receiveEnvelope } from "../crypto/receive-envelope.js";
import { type FixtureHarness, makeReceiveDeps, resolveSelfKeyPair } from "./harness.js";
import { loadFixture, loadKeys } from "./load-fixture.js";
import { padWireToSize } from "./wire-padding.js";

interface NegativeCase {
  name: string;
  wire?: string;
  bodySize?: number;
  expect: string;
  harness: FixtureHarness;
}

interface EnvelopeNegativeFixture {
  cases: NegativeCase[];
}

describe("envelope-negative.json golden vectors", () => {
  const fixture = loadFixture<EnvelopeNegativeFixture>("envelope-negative.json");
  const keys = loadKeys();
  const coreWire = loadFixture<{ expected: { wire: string } }>("envelope-core-msg.json").expected
    .wire;

  it.each(fixture.cases.filter((c): c is NegativeCase & { wire: string } => !!c.wire))(
    "$name → $expect",
    async (testCase) => {
      const { selfId, selfKeyPair } = resolveSelfKeyPair(keys, testCase.harness);
      const deps = makeReceiveDeps(selfKeyPair, testCase.harness);
      const result = await receiveEnvelope(testCase.wire, selfId, deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(testCase.expect);
      }
    },
  );

  it("envelope_too_large → envelope_too_large (v:1 wire)", async () => {
    const testCase = fixture.cases.find((c) => c.name === "envelope_too_large");
    expect(testCase?.bodySize).toBeDefined();
    if (!testCase?.bodySize) {
      return;
    }
    const oversized = padWireToSize(coreWire, testCase.bodySize);
    expect(oversized).toContain('"v":1');
    const { selfId, selfKeyPair } = resolveSelfKeyPair(keys, testCase.harness);
    const deps = makeReceiveDeps(selfKeyPair, testCase.harness);
    const result = await receiveEnvelope(oversized, selfId, deps);
    expect(result).toEqual({ ok: false, error: "envelope_too_large" });
  });
});
