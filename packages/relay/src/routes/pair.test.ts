import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRelayApp } from "../server.js";

describe("pair relay routes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("round-trips a message via POST then GET", async () => {
    const { app } = createRelayApp();
    const sessionId = "session-round-trip";
    const message = JSON.stringify({ phase: "pake", payload: "opaque" });

    const postRes = await app.request(`/pair/${sessionId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: message,
    });
    expect(postRes.status).toBe(204);

    const getRes = await app.request(`/pair/${sessionId}`);
    expect(getRes.status).toBe(200);
    expect(await getRes.text()).toBe(message);
  });

  it("overwrites message_json on POST conflict for the same session_id", async () => {
    const { app } = createRelayApp();
    const sessionId = "session-overwrite";
    const first = JSON.stringify({ step: 1 });
    const second = JSON.stringify({ step: 2 });

    await app.request(`/pair/${sessionId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: first,
    });
    await app.request(`/pair/${sessionId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: second,
    });

    const getRes = await app.request(`/pair/${sessionId}`);
    expect(getRes.status).toBe(200);
    expect(await getRes.text()).toBe(second);
  });

  it("returns 404 for unknown session", async () => {
    const { app } = createRelayApp();
    const res = await app.request("/pair/missing-session");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("session_not_found");
  });

  it("returns 410 session_expired and deletes the row after TTL", async () => {
    const { app, db } = createRelayApp();
    const sessionId = "session-expired";
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
    expect(body.error).toBe("session_expired");

    const row = db
      .prepare("SELECT session_id FROM pair_sessions WHERE session_id = ?")
      .get(sessionId);
    expect(row).toBeUndefined();

    const missingRes = await app.request(`/pair/${sessionId}`);
    expect(missingRes.status).toBe(404);
  });
});
