import {
  type SessionRecord,
  type SessionStore,
  hasLegacyTestReports,
  normalizeLegacyTestReports,
} from "@agentpair/protocol";
import { parseSessionRecords } from "./persistence-validate.js";
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
  const sessions = parseSessionRecords((parsed as SessionsFile).sessions);
  if (!sessions) {
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

  function ensureTestReportsMigrated(): void {
    const sessions = backing.read().sessions;
    const hasLegacy = Object.values(sessions).some((session) =>
      hasLegacyTestReports(session.testReports),
    );
    if (!hasLegacy) {
      return;
    }
    backing.mutate((data) => {
      for (const session of Object.values(data.sessions)) {
        session.testReports = normalizeLegacyTestReports(session.testReports);
      }
    });
  }

  return {
    get(thread) {
      ensureTestReportsMigrated();
      const session = backing.read().sessions[thread];
      return session ? structuredClone(session) : undefined;
    },
    upsert(session) {
      backing.mutate((data) => {
        data.sessions[session.thread] = structuredClone(session);
      });
    },
    list() {
      ensureTestReportsMigrated();
      return Object.values(backing.read().sessions).map((session) => structuredClone(session));
    },
    flush: () => backing.flush(),
  };
}
