import { Hono } from "hono";
import type { Context } from "hono";
import { describe, expect, it } from "vitest";
import {
  clientKey,
  createRateLimiter,
  evictStaleBuckets,
  isTrustedProxyAddress,
} from "./rate-limit.js";

function nodeEnv(remoteAddress: string) {
  return {
    incoming: {
      socket: {
        remoteAddress,
        remotePort: 42_000,
        remoteFamily: "IPv4" as const,
      },
    },
  };
}

function rateLimitApp(options: {
  maxRequests: number;
  windowMs?: number;
  trustProxy?: boolean;
}) {
  const app = new Hono();
  app.post(
    "/limited",
    createRateLimiter({
      windowMs: options.windowMs ?? 60_000,
      maxRequests: options.maxRequests,
      trustProxy: options.trustProxy,
    }),
    (c) => c.json({ ok: true }),
  );
  return app;
}

async function postLimited(
  app: Hono,
  init: { headers?: Record<string, string>; env?: ReturnType<typeof nodeEnv> },
) {
  return app.request(
    "/limited",
    {
      method: "POST",
      headers: init.headers,
    },
    init.env,
  );
}

describe("isTrustedProxyAddress", () => {
  it("accepts loopback and private ranges", () => {
    expect(isTrustedProxyAddress("127.0.0.1")).toBe(true);
    expect(isTrustedProxyAddress("10.0.0.1")).toBe(true);
    expect(isTrustedProxyAddress("172.17.0.2")).toBe(true);
    expect(isTrustedProxyAddress("192.168.1.5")).toBe(true);
    expect(isTrustedProxyAddress("::ffff:172.17.0.2")).toBe(true);
  });

  it("rejects public addresses", () => {
    expect(isTrustedProxyAddress("203.0.113.10")).toBe(false);
    expect(isTrustedProxyAddress("8.8.8.8")).toBe(false);
  });
});

describe("evictStaleBuckets", () => {
  it("removes expired buckets and keeps active ones", () => {
    const buckets = new Map<string, { count: number; windowStart: number }>();
    const windowMs = 60_000;
    const now = 200_000;

    for (let i = 0; i < 1_000; i++) {
      buckets.set(`10.0.0.${i % 250}:/limited`, { count: 1, windowStart: 1_000 });
    }
    buckets.set("10.0.0.99:/limited", { count: 2, windowStart: now - 1_000 });

    evictStaleBuckets(buckets, now, windowMs);

    expect(buckets.size).toBe(1);
    expect(buckets.has("10.0.0.99:/limited")).toBe(true);
  });
});

describe("createRateLimiter", () => {
  it("ignores x-forwarded-for and x-real-ip when trustProxy is off", async () => {
    const app = rateLimitApp({ maxRequests: 2 });
    const env = nodeEnv("10.0.0.5");

    const first = await postLimited(app, {
      env,
      headers: { "x-forwarded-for": "1.1.1.1" },
    });
    const second = await postLimited(app, {
      env,
      headers: { "x-real-ip": "2.2.2.2" },
    });
    const third = await postLimited(app, {
      env,
      headers: { "x-forwarded-for": "3.3.3.3" },
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
    expect(await third.json()).toEqual({ error: "rate_limit_exceeded" });
  });

  it("limits distinct socket addresses independently", async () => {
    const app = rateLimitApp({ maxRequests: 2 });

    await postLimited(app, { env: nodeEnv("10.0.0.5") });
    await postLimited(app, { env: nodeEnv("10.0.0.5") });
    const blockedA = await postLimited(app, { env: nodeEnv("10.0.0.5") });

    const allowedB = await postLimited(app, { env: nodeEnv("10.0.0.6") });

    expect(blockedA.status).toBe(429);
    expect(allowedB.status).toBe(200);
  });

  it("uses x-forwarded-for when trustProxy is on and peer is a trusted proxy", async () => {
    const app = rateLimitApp({ maxRequests: 1, trustProxy: true });
    const env = nodeEnv("172.17.0.1");

    const first = await postLimited(app, {
      env,
      headers: { "x-forwarded-for": "203.0.113.10, 10.0.0.1" },
    });
    const second = await postLimited(app, {
      env,
      headers: { "x-forwarded-for": "203.0.113.10" },
    });
    const differentClient = await postLimited(app, {
      env,
      headers: { "x-forwarded-for": "203.0.113.11" },
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(differentClient.status).toBe(200);
  });

  it("prefers x-real-ip over x-forwarded-for behind a trusted proxy", async () => {
    const app = rateLimitApp({ maxRequests: 1, trustProxy: true });
    const env = nodeEnv("127.0.0.1");

    const first = await postLimited(app, {
      env,
      headers: {
        "x-real-ip": "203.0.113.20",
        "x-forwarded-for": "198.51.100.1",
      },
    });
    const second = await postLimited(app, {
      env,
      headers: {
        "x-real-ip": "203.0.113.20",
        "x-forwarded-for": "198.51.100.2",
      },
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
  });

  it("ignores spoofed proxy headers when trustProxy is on but peer is public", async () => {
    const app = rateLimitApp({ maxRequests: 2, trustProxy: true });
    const env = nodeEnv("203.0.113.99");

    const first = await postLimited(app, {
      env,
      headers: { "x-forwarded-for": "1.1.1.1" },
    });
    const second = await postLimited(app, {
      env,
      headers: { "x-real-ip": "2.2.2.2" },
    });
    const third = await postLimited(app, {
      env,
      headers: { "x-forwarded-for": "3.3.3.3" },
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
  });

  it("falls back to socket address when trustProxy is on, peer is trusted, and headers are absent", async () => {
    const app = rateLimitApp({ maxRequests: 1, trustProxy: true });
    const env = nodeEnv("172.17.0.5");

    const first = await postLimited(app, { env });
    const second = await postLimited(app, { env });

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
  });

  it("shares one bucket across dynamic path segments on the same route", async () => {
    const app = new Hono();
    app.post("/items/:id", createRateLimiter({ windowMs: 60_000, maxRequests: 2 }), (c) =>
      c.json({ ok: true }),
    );
    const env = nodeEnv("10.0.0.8");

    const first = await app.request("/items/a", { method: "POST" }, env);
    const second = await app.request("/items/b", { method: "POST" }, env);
    const third = await app.request("/items/c", { method: "POST" }, env);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
  });

  it("uses unknown bucket without throwing when node bindings are missing", async () => {
    const app = rateLimitApp({ maxRequests: 2 });

    const first = await postLimited(app, {});
    const second = await postLimited(app, {});
    const third = await postLimited(app, {});

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
  });
});

describe("clientKey", () => {
  it("returns unknown when socket bindings are missing", () => {
    const c = {
      req: { header: () => undefined },
      env: {},
    } as unknown as Context;

    expect(clientKey(c, false)).toBe("unknown");
  });
});
