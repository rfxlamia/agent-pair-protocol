import { utf8ToBytes } from "@noble/ciphers/utils.js";
import { encodeBase64Url } from "../crypto/base64url.js";
import { sign } from "../crypto/sign.js";
import type { LocalAllowlistStore, PairingRelayClient } from "./flow.js";

export function canonicalAllowlistBytes(agentId: string, allowed: string[]): Uint8Array {
  const ordered = { agent_id: agentId, allowed: [...allowed].sort() };
  return utf8ToBytes(JSON.stringify(ordered));
}

export function signAllowlist(
  agentId: string,
  allowed: string[],
  secretKey: Uint8Array,
): { agent_id: string; allowed: string[]; sig: string } {
  const signature = sign(canonicalAllowlistBytes(agentId, allowed), secretKey);
  return {
    agent_id: agentId,
    allowed: [...allowed].sort(),
    sig: encodeBase64Url(signature),
  };
}

export class MockRelayClient implements PairingRelayClient {
  private pakeMessages = new Map<string, string>();
  private allowlists = new Map<string, string[]>();
  failAllowlistFor: string | null = null;
  postedPakeBodies: string[] = [];

  async postPakeMessage(sessionId: string, body: string): Promise<void> {
    this.postedPakeBodies.push(body);
    this.pakeMessages.set(sessionId, body);
  }

  async pollPakeMessage(sessionId: string, _timeoutMs = 5000): Promise<string | null> {
    return this.pakeMessages.get(sessionId) ?? null;
  }

  async putAllowlist(
    agentId: string,
    allowed: string[],
    secretKey: Uint8Array,
  ): Promise<{ ok: boolean }> {
    if (this.failAllowlistFor === agentId) {
      return { ok: false };
    }
    const body = signAllowlist(agentId, allowed, secretKey);
    this.allowlists.set(agentId, body.allowed);
    return { ok: true };
  }

  getAllowlist(agentId: string): string[] {
    return this.allowlists.get(agentId) ?? [];
  }
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
