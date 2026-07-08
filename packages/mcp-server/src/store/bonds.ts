import type { Bond } from "@agentpair/protocol";
import {
  type JsonPersistentStore,
  createJsonPersistentStore,
  resolveDataDir,
  storePath,
} from "./persistent-store.js";

interface BondsFile {
  v: 1;
  agents: Record<string, Bond[]>;
}

const EMPTY_BONDS_FILE: BondsFile = { v: 1, agents: {} };

function validateBondsFile(parsed: unknown): BondsFile | undefined {
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const agents = (parsed as BondsFile).agents;
  if (typeof agents !== "object" || agents === null) {
    return undefined;
  }
  return { v: 1, agents };
}

export interface BondStore {
  get(agentId: string): Bond[];
  add(agentId: string, bond: Bond): void;
  remove(agentId: string, peer: string): void;
  find(agentId: string, peer: string): Bond | undefined;
}

export class MemoryBondStore implements BondStore {
  private store = new Map<string, Bond[]>();

  get(agentId: string): Bond[] {
    return [...(this.store.get(agentId) ?? [])];
  }

  add(agentId: string, bond: Bond): void {
    const existing = this.get(agentId).filter((entry) => entry.peer !== bond.peer);
    this.store.set(agentId, [...existing, bond]);
  }

  remove(agentId: string, peer: string): void {
    const next = this.get(agentId).filter((entry) => entry.peer !== peer);
    this.store.set(agentId, next);
  }

  find(agentId: string, peer: string): Bond | undefined {
    return this.get(agentId).find((entry) => entry.peer === peer);
  }
}

export function isEphemeralBond(bond: Bond | undefined): boolean {
  return bond?.mode === "ephemeral_until_session_closes";
}

export function resolveBondsPath(dataDir?: string): string {
  return storePath(resolveDataDir(dataDir), "bonds.json");
}

export class FileBondStore implements BondStore {
  private readonly backing: JsonPersistentStore<BondsFile>;

  constructor(options: { filePath?: string; dataDir?: string } = {}) {
    const filePath = options.filePath ?? resolveBondsPath(options.dataDir);
    this.backing = createJsonPersistentStore({
      filePath,
      defaultData: structuredClone(EMPTY_BONDS_FILE),
      validate: validateBondsFile,
    });
  }

  flush(): Promise<void> {
    return this.backing.flush();
  }

  get(agentId: string): Bond[] {
    const agents = this.backing.read().agents;
    return [...(agents[agentId] ?? [])];
  }

  add(agentId: string, bond: Bond): void {
    this.backing.mutate((data) => {
      const existing = (data.agents[agentId] ?? []).filter((entry) => entry.peer !== bond.peer);
      data.agents[agentId] = [...existing, bond];
    });
  }

  remove(agentId: string, peer: string): void {
    this.backing.mutate((data) => {
      const next = (data.agents[agentId] ?? []).filter((entry) => entry.peer !== peer);
      data.agents[agentId] = next;
    });
  }

  find(agentId: string, peer: string): Bond | undefined {
    return this.get(agentId).find((entry) => entry.peer === peer);
  }
}
