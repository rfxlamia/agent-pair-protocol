import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { pairBondOkTag } from "../pairing/pair-bond-ok-tag.js";
import { loadFixture } from "./load-fixture.js";

interface PairBondOkTagFixture {
  sharedKeyHex: string;
  cases: Array<{ role: string; agentId: string; expectedTag: string }>;
}

describe("pair-bond-ok-tag.json golden vectors", () => {
  const fixture = loadFixture<PairBondOkTagFixture>("pair-bond-ok-tag.json");
  const sharedKey = hexToBytes(fixture.sharedKeyHex);

  it.each(fixture.cases)("$role tag matches", ({ agentId, expectedTag }) => {
    const tag = pairBondOkTag(sharedKey, agentId);
    expect(tag).toMatch(/^[0-9a-f]{64}$/);
    expect(tag).toBe(expectedTag);
  });
});
