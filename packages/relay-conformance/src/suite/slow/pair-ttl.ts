import type { Probe } from "../types.js";

const PAIR_TTL_MS = 5 * 60 * 1000;
const EXPIRY_BUFFER_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const pairTtlProbe: Probe = {
  id: "pair-ttl",
  tier: "slow",
  async run(baseUrl) {
    const sessionId = `conformance-pair-ttl-${crypto.randomUUID()}`;
    const message = JSON.stringify({ phase: "pake" });

    const createRes = await fetch(`${baseUrl}/pair/${sessionId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: message,
    });
    if (createRes.status !== 204) {
      throw new Error(`pair POST failed: ${createRes.status}`);
    }

    await sleep(PAIR_TTL_MS + EXPIRY_BUFFER_MS);

    const expiredRes = await fetch(`${baseUrl}/pair/${sessionId}`);
    if (expiredRes.status !== 410) {
      throw new Error(`expected 410 pair_session_lost, got ${expiredRes.status}`);
    }
    const body = (await expiredRes.json()) as { error: string };
    if (body.error !== "pair_session_lost") {
      throw new Error(`expected pair_session_lost, got ${body.error}`);
    }
  },
};
