import type { LocalAllowlistStore } from "@agentpair/protocol";
import { createJsonPersistentStore, resolveDataDir, storePath } from "./persistent-store.js";

interface AllowlistFile {
  v: 1;
  allowed: string[];
}

const EMPTY_ALLOWLIST_FILE: AllowlistFile = { v: 1, allowed: [] };

function validateAllowlistFile(parsed: unknown): AllowlistFile | undefined {
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const allowed = (parsed as AllowlistFile).allowed;
  if (!Array.isArray(allowed)) {
    return undefined;
  }
  return { v: 1, allowed: [...allowed] };
}

export function resolveAllowlistPath(dataDir?: string): string {
  return storePath(resolveDataDir(dataDir), "allowlist.json");
}

export function createFileAllowlistStore(
  options: {
    filePath?: string;
    dataDir?: string;
    agentId?: string;
  } = {},
): LocalAllowlistStore & {
  filePath: string;
  init(forAgentId: string): Promise<void>;
  flush(): Promise<void>;
} {
  const filePath = options.filePath ?? resolveAllowlistPath(options.dataDir);
  let agentId = options.agentId;
  const backing = createJsonPersistentStore({
    filePath,
    defaultData: structuredClone(EMPTY_ALLOWLIST_FILE),
    validate: validateAllowlistFile,
  });

  return {
    filePath,
    get(agent: string) {
      if (agentId && agent !== agentId) {
        return [];
      }
      return [...backing.read().allowed];
    },
    set(agent: string, allowed: string[]) {
      if (agentId && agent !== agentId) {
        return;
      }
      backing.replace({ v: 1, allowed: [...allowed].sort() });
    },
    async init(forAgentId: string): Promise<void> {
      agentId = forAgentId;
      backing.read();
    },
    flush: () => backing.flush(),
  };
}

export class MemoryAllowlistStore implements LocalAllowlistStore {
  private store = new Map<string, string[]>();

  get(agentId: string): string[] {
    return [...(this.store.get(agentId) ?? [])];
  }

  set(agentId: string, allowed: string[]): void {
    this.store.set(agentId, [...allowed]);
  }
}
