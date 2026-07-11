import { createJsonPersistentStore, resolveDataDir, storePath } from "./persistent-store.js";

export interface ClosedThreadEntry {
  closed_at: number;
  reason?: string;
  by: string;
}

interface ClosedThreadsFile {
  v: 1;
  threads: Record<string, ClosedThreadEntry>;
}

const EMPTY: ClosedThreadsFile = { v: 1, threads: {} };

export interface ClosedThreadStore {
  init(forAgentId: string): Promise<void>;
  isClosed(thread: string): boolean;
  get(thread: string): ClosedThreadEntry | undefined;
  markClosed(thread: string, entry: ClosedThreadEntry): void;
  flush(): Promise<void>;
  filePath?: string;
}

function isValidClosedThreadEntry(value: unknown): value is ClosedThreadEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.by !== "string" || typeof entry.closed_at !== "number") {
    return false;
  }
  if (entry.reason !== undefined && typeof entry.reason !== "string") {
    return false;
  }
  return true;
}

function validateFile(parsed: unknown): ClosedThreadsFile | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as ClosedThreadsFile;
  if (record.v !== 1 || typeof record.threads !== "object" || record.threads === null) {
    return undefined;
  }
  const threads: Record<string, ClosedThreadEntry> = {};
  for (const [threadId, entry] of Object.entries(record.threads)) {
    if (!isValidClosedThreadEntry(entry)) {
      return undefined;
    }
    threads[threadId] = {
      closed_at: entry.closed_at,
      by: entry.by,
      ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
    };
  }
  return { v: 1, threads };
}

export function resolveClosedThreadsPath(dataDir?: string): string {
  return storePath(resolveDataDir(dataDir), "closed-threads.json");
}

export class MemoryClosedThreadStore implements ClosedThreadStore {
  private threads: Record<string, ClosedThreadEntry> = {};

  async init(_forAgentId: string): Promise<void> {}

  isClosed(thread: string): boolean {
    return Object.hasOwn(this.threads, thread);
  }

  get(thread: string): ClosedThreadEntry | undefined {
    return Object.hasOwn(this.threads, thread) ? this.threads[thread] : undefined;
  }

  markClosed(thread: string, entry: ClosedThreadEntry): void {
    if (!Object.hasOwn(this.threads, thread)) {
      this.threads[thread] = entry;
    }
  }

  async flush(): Promise<void> {}
}

export function createFileClosedThreadStore(
  options: { filePath?: string; dataDir?: string } = {},
): ClosedThreadStore & { filePath: string } {
  const filePath = options.filePath ?? resolveClosedThreadsPath(options.dataDir);
  const backing = createJsonPersistentStore({
    filePath,
    defaultData: structuredClone(EMPTY),
    validate: validateFile,
  });

  return {
    filePath,
    async init(_forAgentId: string): Promise<void> {},
    isClosed(thread: string) {
      return Object.hasOwn(backing.read().threads, thread);
    },
    get(thread: string) {
      const threads = backing.read().threads;
      return Object.hasOwn(threads, thread) ? threads[thread] : undefined;
    },
    markClosed(thread: string, entry: ClosedThreadEntry) {
      backing.mutate((data) => {
        if (!Object.hasOwn(data.threads, thread)) {
          data.threads[thread] = entry;
        }
      });
    },
    flush: () => backing.flush(),
  };
}
