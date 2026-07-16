import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type PreflightError,
  ensurePreflight,
  invalidatePreflightCache,
  resetPreflightCache,
} from "./preflight.js";

const RELAY_U1 = "http://relay-u1.test";
const RELAY_U2 = "http://relay-u2.test";

const compatibleHealth = {
  status: "ok",
  spec_version: "1.0-draft",
  relay_conformance: "agentpair-relay/1",
};

function mockCompatibleRelay(fetchMock: ReturnType<typeof vi.fn>): void {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/health")) {
      return new Response(JSON.stringify(compatibleHealth), { status: 200 });
    }
    if (url.includes("/inbox/") && url.endsWith("/inbox/probe-recipient")) {
      return new Response(JSON.stringify({ error: "auth_required" }), {
        status: 401,
        headers: { "x-agentpair-challenge": "probe-challenge" },
      });
    }
    if (url.includes("/inbox/probe-recipient") && url.includes("challenge=")) {
      return new Response(JSON.stringify({ envelopes: [], rowids: [], cursor: 0 }), {
        status: 200,
      });
    }
    if (url.includes("/inbox/probe-recipient") && url.includes("/inbox/")) {
      return new Response(JSON.stringify({ error: "recipient_not_allowed" }), { status: 403 });
    }
    return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
  });
}

describe("ensurePreflight", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetPreflightCache();
    vi.unstubAllEnvs();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetPreflightCache();
  });

  it("passes on compatible relay without invoking slow/large suite probes", async () => {
    mockCompatibleRelay(fetchMock);

    await expect(ensurePreflight(RELAY_U1)).resolves.toBeUndefined();

    const urls = fetchMock.mock.calls.map(([input]) =>
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    expect(urls.some((u) => u.includes("/pair/"))).toBe(false);
    expect(urls.some((u) => u.includes("/artifact/") && u.includes("large"))).toBe(false);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("cache hit — second call on same URL does not re-fetch /health", async () => {
    mockCompatibleRelay(fetchMock);

    await ensurePreflight(RELAY_U1);
    const healthCallsAfterFirst = fetchMock.mock.calls.filter(([input]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return url.endsWith("/health");
    }).length;

    await ensurePreflight(RELAY_U1);
    const healthCallsAfterSecond = fetchMock.mock.calls.filter(([input]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return url.endsWith("/health");
    }).length;

    expect(healthCallsAfterSecond).toBe(healthCallsAfterFirst);
  });

  it("runs preflight again when URL changes (cache miss)", async () => {
    mockCompatibleRelay(fetchMock);

    await ensurePreflight(RELAY_U1);
    const callsAfterU1 = fetchMock.mock.calls.length;

    await ensurePreflight(RELAY_U2);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterU1);
  });

  it("hard blocks with relay_not_conformant on claim mismatch", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/health")) {
        return new Response(
          JSON.stringify({ status: "ok", spec_version: "99.0", relay_conformance: "other/9" }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 404 });
    });

    await expect(ensurePreflight(RELAY_U1)).rejects.toMatchObject({
      code: "relay_not_conformant",
    } satisfies Partial<PreflightError>);
  });

  it("warn-and-continue for legacy relay without claim (default AGENTPAIR_PREFLIGHT)", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      }
      if (url.includes("/inbox/")) {
        return new Response(JSON.stringify({ error: "recipient_not_allowed" }), { status: 403 });
      }
      return new Response(null, { status: 404 });
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(ensurePreflight(RELAY_U1)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("hard blocks legacy relay when AGENTPAIR_PREFLIGHT=strict", async () => {
    vi.stubEnv("AGENTPAIR_PREFLIGHT", "strict");
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    });

    await expect(ensurePreflight(RELAY_U1)).rejects.toMatchObject({
      code: "relay_not_conformant",
    });
  });

  it("skips preflight entirely when AGENTPAIR_PREFLIGHT=off", async () => {
    vi.stubEnv("AGENTPAIR_PREFLIGHT", "off");
    await expect(ensurePreflight(RELAY_U1)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("invalidates cache on anomaly and re-runs preflight on next op", async () => {
    mockCompatibleRelay(fetchMock);
    await ensurePreflight(RELAY_U1);
    const callsAfterPass = fetchMock.mock.calls.length;

    invalidatePreflightCache(RELAY_U1, { reason: "5xx_streak" });

    await ensurePreflight(RELAY_U1);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterPass);
  });
});
