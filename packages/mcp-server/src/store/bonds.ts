import type { Bond, BondMode } from "@agentpair/protocol";

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
