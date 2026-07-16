import { vi } from "vitest";
import type { Probe } from "../types.js";

export const pairTtlProbe: Probe = {
  id: "pair-ttl",
  tier: "slow",
  async run(baseUrl) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const sessionId = "conformance-pair-ttl";
      const message = JSON.stringify({ phase: "pake" });

      const createRes = await fetch(`${baseUrl}/pair/${sessionId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: message,
      });
      if (createRes.status !== 204) {
        throw new Error(`pair POST failed: ${createRes.status}`);
      }

      vi.setSystemTime(new Date("2026-01-01T00:06:00.000Z"));

      const expiredRes = await fetch(`${baseUrl}/pair/${sessionId}`);
      if (expiredRes.status !== 410) {
        throw new Error(`expected 410 pair_session_lost, got ${expiredRes.status}`);
      }
      const body = (await expiredRes.json()) as { error: string };
      if (body.error !== "pair_session_lost") {
        throw new Error(`expected pair_session_lost, got ${body.error}`);
      }
    } finally {
      vi.useRealTimers();
    }
  },
};
