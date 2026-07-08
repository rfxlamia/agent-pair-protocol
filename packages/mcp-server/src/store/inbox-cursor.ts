import { readFileSync } from "node:fs";
import { createJsonPersistentStore, resolveDataDir, storePath } from "./persistent-store.js";

interface InboxCursorFile {
  v: 1;
  cursor: number;
}

const EMPTY_CURSOR_FILE: InboxCursorFile = { v: 1, cursor: 0 };

export interface InboxCursorLoadResult {
  cursor: number;
  wasReset: boolean;
}

export interface InboxCursorStore {
  init(forAgentId: string): Promise<void>;
  load(): InboxCursorLoadResult;
  set(cursor: number): void;
  flush(): Promise<void>;
  filePath?: string;
}

function validateInboxCursorFile(parsed: unknown): InboxCursorFile | undefined {
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const cursor = (parsed as InboxCursorFile).cursor;
  if (typeof cursor !== "number" || !Number.isFinite(cursor) || cursor < 0) {
    return undefined;
  }
  return { v: 1, cursor };
}

export function resolveInboxCursorPath(dataDir?: string): string {
  return storePath(resolveDataDir(dataDir), "inbox-cursor.json");
}

export class MemoryInboxCursorStore implements InboxCursorStore {
  private agentId: string | undefined;
  private cursor = 0;

  async init(forAgentId: string): Promise<void> {
    this.agentId = forAgentId;
  }

  load(): InboxCursorLoadResult {
    return { cursor: this.cursor, wasReset: false };
  }

  set(cursor: number): void {
    if (!this.agentId) {
      return;
    }
    this.cursor = cursor;
  }

  async flush(): Promise<void> {
    // no-op
  }
}

export function createFileInboxCursorStore(
  options: { filePath?: string; dataDir?: string; agentId?: string } = {},
): InboxCursorStore & { filePath: string } {
  const filePath = options.filePath ?? resolveInboxCursorPath(options.dataDir);
  let agentId = options.agentId;
  const backing = createJsonPersistentStore({
    filePath,
    defaultData: structuredClone(EMPTY_CURSOR_FILE),
    validate: validateInboxCursorFile,
  });

  return {
    filePath,
    async init(forAgentId: string): Promise<void> {
      agentId = forAgentId;
      backing.read();
    },
    load(): InboxCursorLoadResult {
      if (!agentId) {
        return { cursor: 0, wasReset: false };
      }
      try {
        const raw = readFileSync(filePath, "utf8");
        const parsed = JSON.parse(raw) as unknown;
        const validated = validateInboxCursorFile(parsed);
        if (validated !== undefined) {
          return { cursor: validated.cursor, wasReset: false };
        }
        return { cursor: 0, wasReset: true };
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === "ENOENT") {
          return { cursor: 0, wasReset: false };
        }
        return { cursor: 0, wasReset: true };
      }
    },
    set(cursor: number): void {
      if (!agentId) {
        return;
      }
      if (!Number.isFinite(cursor) || cursor < 0) {
        return;
      }
      backing.replace({ v: 1, cursor });
    },
    flush: () => backing.flush(),
  };
}
