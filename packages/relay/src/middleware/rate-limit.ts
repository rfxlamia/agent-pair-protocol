import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler, Next } from "hono";

export interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
  trustProxy?: boolean;
}

interface Bucket {
  count: number;
  windowStart: number;
}

export function socketRemoteAddress(c: Context): string | undefined {
  try {
    const bindings = c.env.server ? c.env.server : c.env;
    if (!bindings?.incoming?.socket?.remoteAddress) {
      return undefined;
    }
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}

/** Loopback and RFC1918 — immediate peer must match before proxy headers are trusted. */
export function isTrustedProxyAddress(address: string): boolean {
  const normalized = address.startsWith("::ffff:") ? address.slice(7) : address;

  if (normalized === "127.0.0.1" || normalized === "::1") {
    return true;
  }

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  if (ipv4) {
    const octets = ipv4.slice(1, 5).map((part) => Number(part));
    if (octets.some((n) => n > 255)) {
      return false;
    }
    const [a, b] = octets;
    if (a === 10) {
      return true;
    }
    if (a === 172 && b >= 16 && b <= 31) {
      return true;
    }
    if (a === 192 && b === 168) {
      return true;
    }
    if (a === 127) {
      return true;
    }
    return false;
  }

  const lower = normalized.toLowerCase();
  if (lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:")) {
    return true;
  }

  return false;
}

function proxyForwardedClientIp(c: Context): string | undefined {
  const realIp = c.req.header("x-real-ip")?.trim();
  if (realIp) {
    return realIp;
  }

  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    const firstHop = forwarded.split(",")[0]?.trim();
    if (firstHop) {
      return firstHop;
    }
  }

  return undefined;
}

export function clientKey(c: Context, trustProxy: boolean): string {
  const socket = socketRemoteAddress(c);

  if (trustProxy && socket && isTrustedProxyAddress(socket)) {
    return proxyForwardedClientIp(c) ?? socket;
  }

  return socket ?? "unknown";
}

export function evictStaleBuckets(
  buckets: Map<string, Bucket>,
  now: number,
  windowMs: number,
): void {
  const evictionAgeMs = 2 * windowMs;
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart >= evictionAgeMs) {
      buckets.delete(key);
    }
  }
}

export function createRateLimiter(options: RateLimitOptions): MiddlewareHandler {
  const buckets = new Map<string, Bucket>();
  const trustProxy = options.trustProxy ?? false;

  return async (c: Context, next: Next) => {
    const now = Date.now();
    evictStaleBuckets(buckets, now, options.windowMs);

    const routeKey = c.req.routePath || c.req.path;
    const key = `${clientKey(c, trustProxy)}:${routeKey}`;
    const bucket = buckets.get(key);

    if (!bucket || now - bucket.windowStart >= options.windowMs) {
      buckets.set(key, { count: 1, windowStart: now });
      await next();
      return;
    }

    if (bucket.count >= options.maxRequests) {
      return c.json({ error: "rate_limit_exceeded" }, 429);
    }

    bucket.count += 1;
    await next();
  };
}
