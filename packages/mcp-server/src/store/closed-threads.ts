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

function validateFile(parsed: unknown): ClosedThreadsFile | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as ClosedThreadsFile;
  if (record.v !== 1 || typeof record.threads !== "object" || record.threads === null) {
    return undefined;
  }
  return { v: 1, threads: { ...record.threads } };
}

export function resolveClosedThreadsPath(dataDir?: string): string {
  return storePath(resolveDataDir(dataDir), "closed-threads.json");
}

export class MemoryClosedThreadStore implements ClosedThreadStore {
  private threads: Record<string, ClosedThreadEntry> = {};

  async init(_forAgentId: string): Promise<void> {}

  isClosed(thread: string): boolean {
    return thread in this.threads;
  }

  get(thread: string): ClosedThreadEntry | undefined {
    return this.threads[thread];
  }

  markClosed(thread: string, entry: ClosedThreadEntry): void {
    if (!this.threads[thread]) {
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
      return thread in backing.read().threads;
    },
    get(thread: string) {
      return backing.read().threads[thread];
    },
    markClosed(thread: string, entry: ClosedThreadEntry) {
      backing.mutate((data) => {
        if (!data.threads[thread]) {
          data.threads[thread] = entry;
        }
      });
    },
    flush: () => backing.flush(),
  };
}
