import { utf8ToBytes } from "@noble/ciphers/utils.js";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KeyPair, generateKeyPair, publicKeyToAgentId } from "../crypto/keys.js";
import { sign } from "../crypto/sign.js";
import {
  InMemoryPairingRegistry,
  type LocalAllowlistStore,
  type PairingRelayClient,
  pairInit,
  pairInitComplete,
  pairJoin,
} from "./flow.js";
import { init as initPake } from "./pake-adapter.js";

function canonicalAllowlistBytes(agentId: string, allowed: string[]): Uint8Array {
  const ordered = { agent_id: agentId, allowed: [...allowed].sort() };
  return utf8ToBytes(JSON.stringify(ordered));
}

function signAllowlist(
  agentId: string,
  allowed: string[],
  secretKey: Uint8Array,
): { agent_id: string; allowed: string[]; sig: string } {
  const signature = sign(canonicalAllowlistBytes(agentId, allowed), secretKey);
  return {
    agent_id: agentId,
    allowed: [...allowed].sort(),
    sig: Buffer.from(signature).toString("base64url"),
  };
}

class SlowInitiatorRelay implements PairingRelayClient {
  private pakeMessages = new Map<string, string>();
  private allowlists = new Map<string, string[]>();
  allowlistDelayMs = 2000;
  failAllowlistFor: string | null = null;

  async postPakeMessage(sessionId: string, body: string): Promise<void> {
    this.pakeMessages.set(sessionId, body);
  }

  async pollPakeMessage(sessionId: string): Promise<string | null> {
    return this.pakeMessages.get(sessionId) ?? null;
  }

  async putAllowlist(
    agentId: string,
    allowed: string[],
    secretKey: Uint8Array,
  ): Promise<{ ok: boolean }> {
    await new Promise((resolve) => setTimeout(resolve, this.allowlistDelayMs));
    if (this.failAllowlistFor === agentId) {
      return { ok: false };
    }
    const body = signAllowlist(agentId, allowed, secretKey);
    this.allowlists.set(agentId, body.allowed);
    return { ok: true };
  }
}

class MemoryAllowlistStore implements LocalAllowlistStore {
  private store = new Map<string, string[]>();

  get(agentId: string): string[] {
    return [...(this.store.get(agentId) ?? [])];
  }

  set(agentId: string, allowed: string[]): void {
    this.store.set(agentId, [...allowed]);
  }
}

describe("pairing flow race conditions", () => {
  let initiatorKeys: KeyPair;
  let joinerKeys: KeyPair;
  let initiatorId: string;
  let joinerId: string;
  let relay: SlowInitiatorRelay;
  let registry: InMemoryPairingRegistry;
  let initiatorAllowlist: MemoryAllowlistStore;
  let joinerAllowlist: MemoryAllowlistStore;

  beforeAll(async () => {
    await initPake();
  });

  beforeEach(() => {
    initiatorKeys = generateKeyPair();
    joinerKeys = generateKeyPair();
    initiatorId = publicKeyToAgentId(initiatorKeys.publicKey);
    joinerId = publicKeyToAgentId(joinerKeys.publicKey);
    relay = new SlowInitiatorRelay();
    registry = new InMemoryPairingRegistry();
    initiatorAllowlist = new MemoryAllowlistStore();
    joinerAllowlist = new MemoryAllowlistStore();
  });

  it("joiner and initiator both bond when initiator allowlist push is slow", async () => {
    const pending = await pairInit({
      scope: ["session.negotiate"],
      mode: "ephemeral_until_session_closes",
      keyPair: initiatorKeys,
      relay,
      registry,
    });

    const joinPromise = pairJoin({
      code: pending.code,
      keyPair: joinerKeys,
      relay,
      registry,
      localAllowlist: joinerAllowlist,
      decision: { approve: true },
    });

    const initResult = await pairInitComplete({
      code: pending.code,
      keyPair: initiatorKeys,
      relay,
      registry,
      localAllowlist: initiatorAllowlist,
    });

    const joinResult = await joinPromise;

    expect(initResult.status).toBe("bonded");
    expect(joinResult.status).toBe("bonded");
    expect(initiatorAllowlist.get(initiatorId)).toContain(joinerId);
    expect(joinerAllowlist.get(joinerId)).toContain(initiatorId);
  }, 20000);
});
