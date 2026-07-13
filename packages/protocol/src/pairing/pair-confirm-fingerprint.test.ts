import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { pairConfirmFingerprint, pairConfirmFingerprintV2 } from "./pair-confirm-fingerprint.js";

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/pair-confirm-fingerprint.json",
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  golden: {
    sharedKeyHex: string;
    initiatorId: string;
    joinerId: string;
    fingerprint: string;
    reversedFingerprint: string;
  };
};

describe("pairConfirmFingerprint", () => {
  const { sharedKeyHex, initiatorId, joinerId, fingerprint, reversedFingerprint } = fixture.golden;
  const sharedKey = hexToBytes(sharedKeyHex);

  it("matches golden vector", () => {
    expect(pairConfirmFingerprint(sharedKey, initiatorId, joinerId)).toBe(fingerprint);
  });

  it("is order-sensitive (reversed initiator/joiner)", () => {
    expect(pairConfirmFingerprint(sharedKey, joinerId, initiatorId)).toBe(reversedFingerprint);
  });
});

const v2Fixture = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../fixtures/pair-confirm-fingerprint-v2.json",
    ),
    "utf8",
  ),
) as {
  golden: {
    sharedKeyHex: string;
    initiatorId: string;
    joinerId: string;
    profilesInit: string[];
    profilesJoin: string[];
    fingerprint: string;
  };
};

describe("pairConfirmFingerprintV2", () => {
  it("matches golden vector with profiles in wire order", () => {
    const g = v2Fixture.golden;
    const sk = hexToBytes(g.sharedKeyHex);
    expect(
      pairConfirmFingerprintV2(sk, g.initiatorId, g.joinerId, g.profilesInit, g.profilesJoin),
    ).toBe(g.fingerprint);
  });
});
