import { describe, expect, it } from "vitest";
import { createSessionStore } from "./store.js";
import type { SessionRecord } from "./types.js";

function makeSession(thread: string): SessionRecord {
  return {
    thread,
    initiator: "initiator-id",
    recipient: "recipient-id",
    role: "initiator",
    status: "pending",
    goal: "test goal",
    acceptance: [{ id: "ac-1", test: "executable", desc: "passes tests" }],
    budget: { max_turns: 10, deadline: "2030-01-01T00:00:00.000Z" },
    mandate: { agent_may: ["negotiate"], human_required: ["approve"] },
    createdAt: 1,
    expiresAt: 2,
    turnCount: 0,
    peerMessages: [],
    lockedSections: [],
    testReports: {},
    challenges: {},
    signHashes: {},
    ratifyApproved: {},
  };
}

describe("createSessionStore", () => {
  it("upsert + get returns structured clone", () => {
    const store = createSessionStore();
    const session = makeSession("thread-1");
    store.upsert(session);

    const retrieved = store.get("thread-1");
    expect(retrieved).toEqual(session);
    expect(retrieved).not.toBe(session);

    if (!retrieved) throw new Error("expected session");
    retrieved.goal = "mutated";
    expect(store.get("thread-1")?.goal).toBe("test goal");
  });

  it("list returns all sessions", () => {
    const store = createSessionStore();
    const first = makeSession("thread-a");
    const second = makeSession("thread-b");
    store.upsert(first);
    store.upsert(second);

    const sessions = store.list();
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.thread).sort()).toEqual(["thread-a", "thread-b"]);
    expect(sessions[0]).not.toBe(first);
    expect(sessions[1]).not.toBe(second);
  });
});
