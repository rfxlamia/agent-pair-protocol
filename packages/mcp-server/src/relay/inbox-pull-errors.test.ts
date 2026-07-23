import { generateKeyPair } from "@agentpair/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpRelayClient } from "./client.js";
import {
  isTransientInboxPullError,
  mapInboxPullHttpStatus,
  parseRetryAfterMs,
} from "./inbox-pull-errors.js";
import * as preflight from "./preflight.js";

const BASE_URL = "http://relay-inbox-pull.test";

describe("inbox-pull-errors unit", () => {
  describe("mapInboxPullHttpStatus", () => {
    it("maps 429 to transient inbox_pull_failed_429", () => {
      expect(mapInboxPullHttpStatus(429)).toEqual({
        error: "inbox_pull_failed_429",
        retryable: true,
      });
    });

    it("maps 503 to transient inbox_pull_failed_503", () => {
      expect(mapInboxPullHttpStatus(503)).toEqual({
        error: "inbox_pull_failed_503",
        retryable: true,
      });
    });

    it("maps 403 to non-transient unexpected_challenge_status", () => {
      expect(mapInboxPullHttpStatus(403)).toEqual({
        error: "unexpected_challenge_status",
        retryable: false,
      });
    });

    it("maps 404 to non-transient unexpected_challenge_status", () => {
      expect(mapInboxPullHttpStatus(404)).toEqual({
        error: "unexpected_challenge_status",
        retryable: false,
      });
    });
  });

  describe("isTransientInboxPullError", () => {
    it.each([
      ["inbox_pull_failed_429", true],
      ["inbox_pull_failed_503", true],
      ["inbox_pull_failed_500", true],
      ["inbox_pull_failed_502", true],
      ["relay_unavailable", true],
      ["unexpected_challenge_status", false],
      ["inbox_pull_failed_parse", false],
      ["inbox_pull_failed_403", false],
    ] as const)("isTransientInboxPullError(%s) → %s", (error, expected) => {
      expect(isTransientInboxPullError(error)).toBe(expected);
    });
  });

  describe("parseRetryAfterMs", () => {
    it("parses seconds string to milliseconds", () => {
      expect(parseRetryAfterMs("30")).toBe(30_000);
    });

    it("returns undefined for null/missing/non-numeric header", () => {
      expect(parseRetryAfterMs(null)).toBeUndefined();
      expect(parseRetryAfterMs(undefined)).toBeUndefined();
      expect(parseRetryAfterMs("not-a-number")).toBeUndefined();
    });
  });
});

describe("pullInbox 429 integration (mocked fetch)", () => {
  const keyPair = generateKeyPair();
  let ensureSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    ensureSpy = vi.spyOn(preflight, "ensurePreflight").mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    ensureSpy.mockRestore();
  });

  it("returns inbox_pull_failed_429 when challenge issue responds 429", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("rate limited", { status: 429, headers: { "Retry-After": "2" } }),
      ),
    );

    const client = new HttpRelayClient(BASE_URL);
    const result = await client.pullInbox(keyPair);

    expect(result).toEqual({
      ok: false,
      error: "inbox_pull_failed_429",
      retry_after_ms: 2000,
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("returns inbox_pull_failed_429 + retry_after_ms when authenticated GET responds 429 (regression)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const href =
          typeof url === "string" ? url : url instanceof Request ? url.url : url.toString();
        if (!href.includes("challenge=")) {
          return new Response(JSON.stringify({ challenge: "test-challenge" }), { status: 401 });
        }
        return new Response("rate limited", {
          status: 429,
          headers: { "Retry-After": "30" },
        });
      }),
    );

    const client = new HttpRelayClient(BASE_URL);
    const result = await client.pullInbox(keyPair);

    expect(result).toEqual({
      ok: false,
      error: "inbox_pull_failed_429",
      retry_after_ms: 30_000,
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("returns unexpected_challenge_status for non-429 challenge statuses (403 fail-fast)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("forbidden", { status: 403 })),
    );

    const client = new HttpRelayClient(BASE_URL);
    const result = await client.pullInbox(keyPair);

    expect(result).toEqual({ ok: false, error: "unexpected_challenge_status" });
  });
});
