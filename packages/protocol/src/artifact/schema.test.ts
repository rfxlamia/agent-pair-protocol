import { utf8ToBytes } from "@noble/ciphers/utils.js";
import { describe, expect, it } from "vitest";
import { deriveContentType, deriveSummary } from "./fields.js";
import { hasSpillMarker, parseSpillRef, spillRefSchema } from "./schema.js";

describe("spill fields", () => {
  it("deriveContentType returns application/json for valid JSON object", () => {
    expect(deriveContentType(utf8ToBytes('{"a":1}'))).toBe("application/json");
  });
  it("deriveContentType returns application/octet-stream for non-JSON", () => {
    expect(deriveContentType(utf8ToBytes("not json"))).toBe("application/octet-stream");
  });
  it("deriveSummary truncates to 240 code points without splitting", () => {
    const input = utf8ToBytes("é".repeat(300));
    expect([...deriveSummary(input)].length).toBe(240);
  });
  it("deriveSummary returns empty for invalid UTF-8", () => {
    expect(deriveSummary(new Uint8Array([0xff, 0xfe, 0x00]))).toBe("");
  });
});

describe("spillRefSchema", () => {
  it("accepts valid 6-key ref with spill:1", () => {
    const ref = {
      spill: 1,
      artifact_hash: "a".repeat(64),
      size: 100,
      content_type: "application/json",
      summary: "hi",
      artifact_key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    };
    expect(spillRefSchema.safeParse(ref).success).toBe(true);
  });
  it("rejects extra keys (.strict)", () => {
    const ref = {
      spill: 1,
      artifact_hash: "a".repeat(64),
      size: 0,
      content_type: "x",
      summary: "",
      artifact_key: "A".repeat(43),
      extra: true,
    };
    expect(spillRefSchema.safeParse(ref).success).toBe(false);
  });
  it("hasSpillMarker true when spill key present", () => {
    expect(hasSpillMarker({ spill: 2, foo: 1 })).toBe(true);
  });
  it("parseSpillRef rejects spill !== 1", () => {
    const ref = {
      spill: 2,
      artifact_hash: "a".repeat(64),
      size: 0,
      content_type: "application/json",
      summary: "",
      artifact_key: "A".repeat(43),
    };
    expect(parseSpillRef(ref).ok).toBe(false);
  });
  it("accepts summary of 240 emoji code points (not UTF-16 unit count)", () => {
    const ref = {
      spill: 1,
      artifact_hash: "a".repeat(64),
      size: 0,
      content_type: "application/json",
      summary: "😀".repeat(240),
      artifact_key: "A".repeat(43),
    };
    expect(spillRefSchema.safeParse(ref).success).toBe(true);
  });
  it("rejects summary of 241 emoji code points", () => {
    const ref = {
      spill: 1,
      artifact_hash: "a".repeat(64),
      size: 0,
      content_type: "application/json",
      summary: "😀".repeat(241),
      artifact_key: "A".repeat(43),
    };
    expect(spillRefSchema.safeParse(ref).success).toBe(false);
  });
});
