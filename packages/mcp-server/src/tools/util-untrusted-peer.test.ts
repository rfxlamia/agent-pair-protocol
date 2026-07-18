import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpRelayClient } from "../relay/client.js";
import { createKeyStore } from "../store/keys.js";
import { createAgentContext } from "./pair.js";
import {
  DEFAULT_PEER_CONTENT_CAP_BYTES,
  LOCKED_SECTION_ID_CAP_BYTES,
  MAX_PEER_CONTENT_CAP_BYTES,
  resolvePeerContentCapBytes,
  wrapUntrustedPeerContent,
} from "./util.js";

const utf8Len = (s: string) => new TextEncoder().encode(s).length;

describe("wrapUntrustedPeerContent", () => {
  it("preserves under-cap types and omits truncated/original_length", () => {
    const cases: unknown[] = [{ body: "hi" }, "plain", null, 42, true, false, [1, "a"]];
    for (const value of cases) {
      const wrapped = wrapUntrustedPeerContent(value, 8192);
      expect(wrapped).toEqual({ untrusted: true, source: "peer", data: value });
      expect(wrapped).not.toHaveProperty("truncated");
      expect(wrapped).not.toHaveProperty("original_length");
    }
  });

  it("exact-cap path keeps original type (no truncate)", () => {
    const value = "abcdefgh"; // 8 UTF-8 bytes
    const cap = utf8Len(value);
    const wrapped = wrapUntrustedPeerContent(value, cap);
    expect(wrapped).toEqual({ untrusted: true, source: "peer", data: value });
    expect(wrapped).not.toHaveProperty("truncated");
    expect(wrapped).not.toHaveProperty("original_length");
  });

  it("over-cap non-string serializes then truncates to string data", () => {
    const value = { body: "x".repeat(40) };
    const full = JSON.stringify(value);
    const original = utf8Len(full);
    const cap = 16;
    expect(original).toBeGreaterThan(cap);

    const wrapped = wrapUntrustedPeerContent(value, cap);
    expect(wrapped.untrusted).toBe(true);
    expect(wrapped.source).toBe("peer");
    expect(wrapped.truncated).toBe(true);
    expect(wrapped.original_length).toBe(original);
    expect(typeof wrapped.data).toBe("string");
    const dataLen = utf8Len(wrapped.data as string);
    expect(dataLen).toBeLessThanOrEqual(cap);
    expect(dataLen).toBeGreaterThanOrEqual(cap - 3);
  });

  it("over-cap plain string measures UTF-8 as-is (not JSON-quoted)", () => {
    const value = "y".repeat(40);
    const cap = 10;
    const asIs = utf8Len(value);
    const jsonQuoted = utf8Len(JSON.stringify(value));
    expect(jsonQuoted).toBeGreaterThan(asIs);

    const wrapped = wrapUntrustedPeerContent(value, cap);
    expect(wrapped.truncated).toBe(true);
    expect(wrapped.original_length).toBe(asIs);
    expect(wrapped.original_length).not.toBe(jsonQuoted);
    expect(typeof wrapped.data).toBe("string");
    expect(utf8Len(wrapped.data as string)).toBeLessThanOrEqual(cap);
  });

  it("multi-byte boundary: does not leave orphan continuation bytes", () => {
    // "é" is 2 UTF-8 bytes (C3 A9). Cap mid-code-point must walk back.
    const value = "aaébb"; // bytes: 61 61 C3 A9 62 62
    const cap = 3; // would cut after C3 without walk-back
    const wrapped = wrapUntrustedPeerContent(value, cap);
    expect(wrapped.truncated).toBe(true);
    expect(typeof wrapped.data).toBe("string");
    const data = wrapped.data as string;
    expect(() =>
      new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(data)),
    ).not.toThrow();
    expect(utf8Len(data)).toBeLessThanOrEqual(cap);
    expect(data).toBe("aa");
  });

  it("cap=1 + emoji first code point → data empty string", () => {
    const value = "😀hello"; // emoji is 4 UTF-8 bytes
    const wrapped = wrapUntrustedPeerContent(value, 1);
    expect(wrapped).toMatchObject({
      untrusted: true,
      source: "peer",
      data: "",
      truncated: true,
    });
    expect(wrapped.original_length).toBe(utf8Len(value));
  });
});

describe("resolvePeerContentCapBytes", () => {
  it("undefined → DEFAULT and no warn", () => {
    const warn = vi.fn();
    expect(resolvePeerContentCapBytes(undefined, warn)).toBe(DEFAULT_PEER_CONTENT_CAP_BYTES);
    expect(DEFAULT_PEER_CONTENT_CAP_BYTES).toBe(8192);
    expect(warn).not.toHaveBeenCalled();
  });

  it("invalid → 8192 + warn", () => {
    for (const raw of ["", "abc", "8.5", "1e3", "0x20", "-1", "8192.0"]) {
      const warn = vi.fn();
      expect(resolvePeerContentCapBytes(raw, warn)).toBe(8192);
      expect(warn).toHaveBeenCalledTimes(1);
    }
  });

  it("0 → 8192 + warn (S4b fallback)", () => {
    const warn = vi.fn();
    expect(resolvePeerContentCapBytes("0", warn)).toBe(8192);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("65537 → MAX clamp", () => {
    expect(resolvePeerContentCapBytes("65537")).toBe(MAX_PEER_CONTENT_CAP_BYTES);
    expect(MAX_PEER_CONTENT_CAP_BYTES).toBe(65536);
  });

  it("trim whitespace; no silent min floor", () => {
    expect(resolvePeerContentCapBytes(" 16 ")).toBe(16);
  });
});

describe("constants + AgentContext cap inject", () => {
  const tempDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it("exports LOCKED_SECTION_ID_CAP_BYTES = 256", () => {
    expect(LOCKED_SECTION_ID_CAP_BYTES).toBe(256);
  });

  it("createAgentContext({ peerContentCapBytes: 16 }) injects cap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentpair-cap-inject-"));
    tempDirs.push(dir);
    const ctx = createAgentContext({
      keyStore: createKeyStore({ keyPath: join(dir, "keys.json") }),
      relay: new HttpRelayClient("http://127.0.0.1:9"),
      peerContentCapBytes: 16,
    });
    expect(ctx.peerContentCapBytes).toBe(16);
  });
});
