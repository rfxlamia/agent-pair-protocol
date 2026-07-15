import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRelayApp } from "../server.js";

describe("pair relay routes — fixed TTL and §10 error codes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not extend expires_at on POST activity — still expires at T0+5min", async () => {
    const { app } = createRelayApp();
    const sessionId = "session-fixed-ttl";
    const first = JSON.stringify({ phase: "pake", step: 1 });
    const second = JSON.stringify({ phase: "pake", step: 2 });

    await app.request(`/pair/${sessionId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: first,
    });

    vi.setSystemTime(new Date("2026-01-01T00:04:00.000Z"));

    await app.request(`/pair/${sessionId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: second,
    });

    vi.setSystemTime(new Date("2026-01-01T00:05:30.000Z"));

    const expiredRes = await app.request(`/pair/${sessionId}`);
    expect(expiredRes.status).toBe(410);
    const body = (await expiredRes.json()) as { error: string };
    expect(body.error).toBe("pair_session_lost");
  });

  it("returns 404 pair_not_found for unknown session", async () => {
    const { app } = createRelayApp();
    const res = await app.request("/pair/missing-session");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("pair_not_found");
  });

  it("returns 410 pair_session_lost after TTL and deletes row", async () => {
    const { app, db } = createRelayApp();
    const sessionId = "session-expired-codes";
    const message = JSON.stringify({ phase: "pake" });

    await app.request(`/pair/${sessionId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: message,
    });

    vi.setSystemTime(new Date("2026-01-01T00:06:00.000Z"));

    const expiredRes = await app.request(`/pair/${sessionId}`);
    expect(expiredRes.status).toBe(410);
    const body = (await expiredRes.json()) as { error: string };
    expect(body.error).toBe("pair_session_lost");

    const row = db
      .prepare("SELECT session_id FROM pair_sessions WHERE session_id = ?")
      .get(sessionId);
    expect(row).toBeUndefined();

    const missingRes = await app.request(`/pair/${sessionId}`);
    expect(missingRes.status).toBe(404);
    const missingBody = (await missingRes.json()) as { error: string };
    expect(missingBody.error).toBe("pair_not_found");
  });

  it("returns 410 pair_session_lost at exact T0+5min boundary", async () => {
    const { app } = createRelayApp();
    const sessionId = "session-exact-ttl";
    const message = JSON.stringify({ phase: "pake" });

    await app.request(`/pair/${sessionId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: message,
    });

    // expires_at is T0+5min; inclusive check must treat exact boundary as lost
    vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));

    const res = await app.request(`/pair/${sessionId}`);
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("pair_session_lost");
  });
});
