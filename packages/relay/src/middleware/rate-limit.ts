import type { Context, MiddlewareHandler, Next } from "hono";

export interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
}

interface Bucket {
  count: number;
  windowStart: number;
}

function clientIp(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() ?? "unknown";
  }
  return c.req.header("x-real-ip") ?? "unknown";
}

export function createRateLimiter(
  options: RateLimitOptions,
): MiddlewareHandler {
  const buckets = new Map<string, Bucket>();

  return async (c: Context, next: Next) => {
    const key = `${clientIp(c)}:${c.req.path}`;
    const now = Date.now();
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
