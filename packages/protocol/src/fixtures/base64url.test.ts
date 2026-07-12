import { describe, expect, it } from "vitest";
import { decodeBase64UrlStrict } from "../crypto/base64url.js";
import { loadFixture } from "./load-fixture.js";

interface Base64UrlFixture {
  accept: Array<{ input: string; decodedHex: string }>;
  reject: Array<{ input: string; reason: string }>;
}

describe("base64url.json golden vectors", () => {
  const fixture = loadFixture<Base64UrlFixture>("base64url.json");

  it.each(fixture.accept)("accepts $input", ({ input, decodedHex }) => {
    const bytes = decodeBase64UrlStrict(input);
    expect(Buffer.from(bytes).toString("hex")).toBe(decodedHex);
  });

  it.each(fixture.reject)("rejects $reason ($input)", ({ input }) => {
    expect(() => decodeBase64UrlStrict(input)).toThrow();
  });
});
