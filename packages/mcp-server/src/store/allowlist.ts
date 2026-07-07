import type { LocalAllowlistStore } from "@agentpair/protocol";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

interface AllowlistFile {
  allowed: string[];
}

export function resolveAllowlistPath(baseDir?: string): string {
  const root = baseDir ?? join(homedir(), ".agentpair");
  return join(root, "allowlist.json");
}

export function createFileAllowlistStore(options: {
  filePath?: string;
  agentId?: string;
} = {}): LocalAllowlistStore & { filePath: string } {
  const filePath = options.filePath ?? resolveAllowlistPath();
  let agentId = options.agentId;
  let cache: string[] | undefined;

  async function persist(allowed: string[]): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    const payload: AllowlistFile = { allowed: [...allowed].sort() };
    await writeFile(filePath, JSON.stringify(payload, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  async function load(): Promise<string[]> {
    if (cache) {
      return [...cache];
    }
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as AllowlistFile;
      cache = Array.isArray(parsed.allowed) ? [...parsed.allowed] : [];
      return [...cache];
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        cache = [];
        return [];
      }
      throw error;
    }
  }

  return {
    filePath,
    get(agent: string) {
      if (agentId && agent !== agentId) {
        return [];
      }
      void load();
      return [...(cache ?? [])];
    },
    set(agent: string, allowed: string[]) {
      if (agentId && agent !== agentId) {
        return;
      }
      cache = [...allowed];
      void persist(cache);
    },
    async init(forAgentId: string): Promise<void> {
      agentId = forAgentId;
      cache = await load();
    },
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
