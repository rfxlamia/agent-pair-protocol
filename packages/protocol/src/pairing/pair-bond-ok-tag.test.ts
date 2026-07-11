import { describe, expect, it } from "vitest";
import { decodeBase64UrlStrict } from "../crypto/base64url.js";
import { pairBondOkTag } from "./pair-bond-ok-tag.js";

describe("pairBondOkTag", () => {
  it("is deterministic for shared key and sender agent id", () => {
    const sharedKey = decodeBase64UrlStrict(
      "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8",
    );
    const agentId = "ed25519:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqo";
    const tag = pairBondOkTag(sharedKey, agentId);
    expect(tag).toMatch(/^[0-9a-f]{64}$/);
    expect(pairBondOkTag(sharedKey, agentId)).toBe(tag);
    expect(pairBondOkTag(sharedKey, "ed25519:other")).not.toBe(tag);
  });
});
