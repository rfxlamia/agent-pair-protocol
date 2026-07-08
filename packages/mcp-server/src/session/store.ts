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
      const session = sessions.get(thread);
      return session ? structuredClone(session) : undefined;
    },
    upsert(session) {
      sessions.set(session.thread, structuredClone(session));
    },
    list() {
      return [...sessions.values()].map((session) => structuredClone(session));
    },
  };
}
