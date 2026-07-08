import { readFileSync } from "node:fs";
import { chmod, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const DEFAULT_DEBOUNCE_MS = 0;

export function resolveDataDir(override?: string): string {
  if (override) {
    return override;
  }
  const fromEnv = process.env.AGENTPAIR_DATA_DIR;
  if (fromEnv) {
    return fromEnv;
  }
  return join(homedir(), ".agentpair");
}

export function storePath(dataDir: string, filename: string): string {
  return join(dataDir, filename);
}

export interface JsonPersistentStore<T> {
  read(): T;
  mutate(updater: (data: T) => void): void;
  replace(data: T): void;
  flush(): Promise<void>;
  lastFlushError(): Error | undefined;
}

export function createJsonPersistentStore<T>(options: {
  filePath: string;
  defaultData: T;
  validate?: (parsed: unknown) => T | undefined;
  debounceMs?: number;
}): JsonPersistentStore<T> {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  let data = structuredClone(options.defaultData);
  let loaded = false;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let flushPromise: Promise<void> | undefined;
  let lastFlushError: Error | undefined;

  function logFlushFailure(error: unknown): void {
    lastFlushError = error instanceof Error ? error : new Error(String(error));
    console.error(`[agentpair] store flush failed for ${options.filePath}`, lastFlushError.message);
  }

  function scheduleFlush(): void {
    void flush()
      .then(() => {
        lastFlushError = undefined;
      })
      .catch((error) => {
        logFlushFailure(error);
      });
  }

  function loadSync(): void {
    if (loaded) {
      return;
    }
    loaded = true;
    try {
      const raw = readFileSync(options.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (options.validate) {
        const validated = options.validate(parsed);
        if (validated !== undefined) {
          data = validated;
        } else {
          console.error(`[agentpair] invalid store shape ${options.filePath}, starting empty`);
        }
      } else if (parsed !== null && typeof parsed === "object") {
        data = parsed as T;
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return;
      }
      console.error(
        `[agentpair] corrupt store ${options.filePath}, starting empty`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  function scheduleSave(): void {
    if (debounceMs <= 0) {
      scheduleFlush();
      return;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      scheduleFlush();
    }, debounceMs);
  }

  async function flush(): Promise<void> {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
    if (flushPromise) {
      await flushPromise;
    }
    flushPromise = writeAtomicWithRetry(options.filePath, data);
    try {
      await flushPromise;
      lastFlushError = undefined;
    } catch (error) {
      logFlushFailure(error);
      throw lastFlushError;
    } finally {
      flushPromise = undefined;
    }
  }

  return {
    read() {
      loadSync();
      return structuredClone(data);
    },
    mutate(updater) {
      loadSync();
      updater(data);
      scheduleSave();
    },
    replace(next) {
      loadSync();
      data = structuredClone(next);
      scheduleSave();
    },
    flush,
    lastFlushError() {
      return lastFlushError;
    },
  };
}

async function writeAtomicWithRetry<T>(filePath: string, data: T): Promise<void> {
  try {
    await writeAtomic(filePath, data);
  } catch {
    await writeAtomic(filePath, data);
    console.error(`[agentpair] store flush retry succeeded for ${filePath}`);
  }
}

async function writeAtomic<T>(filePath: string, data: T): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: DIR_MODE });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2), {
    encoding: "utf8",
    mode: FILE_MODE,
  });
  await rename(tmpPath, filePath);
  await chmod(filePath, FILE_MODE);
}

export async function readStoreFileMode(filePath: string): Promise<number> {
  const fileStat = await stat(filePath);
  return fileStat.mode & 0o777;
}
