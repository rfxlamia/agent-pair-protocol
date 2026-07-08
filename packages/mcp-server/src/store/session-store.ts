import type { SessionRecord } from "../session/state-machine.js";
import type { SessionStore } from "../session/store.js";
import { createJsonPersistentStore, resolveDataDir, storePath } from "./persistent-store.js";

interface SessionsFile {
  v: 1;
  sessions: Record<string, SessionRecord>;
}

const EMPTY_SESSIONS_FILE: SessionsFile = { v: 1, sessions: {} };

function validateSessionsFile(parsed: unknown): SessionsFile | undefined {
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const sessions = (parsed as SessionsFile).sessions;
  if (typeof sessions !== "object" || sessions === null) {
    return undefined;
  }
  return { v: 1, sessions };
}

export function resolveSessionsPath(dataDir?: string): string {
  return storePath(resolveDataDir(dataDir), "sessions.json");
}

export function createFileSessionStore(
  options: { filePath?: string; dataDir?: string } = {},
): SessionStore & { flush(): Promise<void> } {
  const filePath = options.filePath ?? resolveSessionsPath(options.dataDir);
  const backing = createJsonPersistentStore({
    filePath,
    defaultData: structuredClone(EMPTY_SESSIONS_FILE),
    validate: validateSessionsFile,
  });

  return {
    get(thread) {
      return backing.read().sessions[thread];
    },
    upsert(session) {
      backing.mutate((data) => {
        data.sessions[session.thread] = session;
      });
    },
    list() {
      return Object.values(backing.read().sessions);
    },
    flush: () => backing.flush(),
  };
}
