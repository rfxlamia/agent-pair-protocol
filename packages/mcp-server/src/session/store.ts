import type { SessionRecord } from "./state-machine.js";

export interface SessionStore {
  get(thread: string): SessionRecord | undefined;
  upsert(session: SessionRecord): void;
  list(): SessionRecord[];
}

export function createSessionStore(): SessionStore {
  const sessions = new Map<string, SessionRecord>();
  return {
    get(thread) {
      return sessions.get(thread);
    },
    upsert(session) {
      sessions.set(session.thread, session);
    },
    list() {
      return [...sessions.values()];
    },
  };
}
