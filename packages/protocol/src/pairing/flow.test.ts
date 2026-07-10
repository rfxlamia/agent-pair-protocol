import { utf8ToBytes } from "@noble/ciphers/utils.js";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type KeyPair, generateKeyPair, publicKeyToAgentId } from "../crypto/keys.js";
import { sign } from "../crypto/sign.js";
import {
  type Bond,
  InMemoryPairingRegistry,
  type LocalAllowlistStore,
  type PairingRelayClient,
  pairInit,
  pairInitComplete,
  pairJoin,
  pairRetry,
} from "./flow.js";
import { CODE_WORDS, generatePairingCode } from "./pairing-words.js";
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

class MockRelayClient implements PairingRelayClient {
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
    const publicKey = allowed.length > 0 ? agentId : agentId;
    void publicKey;
    this.allowlists.set(agentId, body.allowed);
    return { ok: true };
  }

  getAllowlist(agentId: string): string[] {
    return this.allowlists.get(agentId) ?? [];
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

describe("generatePairingCode", () => {
  it("uses a 256-word list with unique lowercase entries", () => {
    expect(CODE_WORDS).toHaveLength(256);
    expect(new Set(CODE_WORDS).size).toBe(256);
    for (const word of CODE_WORDS) {
      expect(word).toMatch(/^[a-z]+$/);
      expect(word.length).toBeLessThanOrEqual(8);
    }
  });

  it("matches NN-word-word-word format with words from CODE_WORDS", () => {
    const code = generatePairingCode();
    expect(code).toMatch(/^\d{2}-[a-z]+-[a-z]+-[a-z]+$/);
    const match = code.match(/^(\d{2})-([a-z]+)-([a-z]+)-([a-z]+)$/);
    expect(match).not.toBeNull();
    const [, num, w1, w2, w3] = match as RegExpMatchArray;
    expect(Number(num)).toBeGreaterThanOrEqual(10);
    expect(Number(num)).toBeLessThanOrEqual(99);
    expect(CODE_WORDS).toContain(w1);
    expect(CODE_WORDS).toContain(w2);
    expect(CODE_WORDS).toContain(w3);
  });

  it("does not call Math.random during generation", () => {
    const mathRandom = vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("Math.random must not be used for pairing codes");
    });
    expect(() => generatePairingCode()).not.toThrow();
    mathRandom.mockRestore();
  });

  it("produces highly unique codes in 10,000 generations", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      seen.add(generatePairingCode());
    }
    // ~2^30 space → birthday bound gives ~3% chance of any collision in 10k draws.
    // Require strong uniqueness without a flaky zero-collision assertion.
    expect(seen.size).toBeGreaterThanOrEqual(9_990);
  });
});

describe("pairing flow", () => {
  let initiatorKeys: KeyPair;
  let joinerKeys: KeyPair;
  let initiatorId: string;
  let joinerId: string;
  let relay: MockRelayClient;
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
    relay = new MockRelayClient();
    registry = new InMemoryPairingRegistry();
    initiatorAllowlist = new MemoryAllowlistStore();
    joinerAllowlist = new MemoryAllowlistStore();
  });

  it("fails pairing when relay delivers non-canonical PAKE payload", async () => {
    const pending = await pairInit({
      scope: ["session.negotiate"],
      mode: "ephemeral_until_session_closes",
      keyPair: initiatorKeys,
      relay,
      registry,
    });

    const raw = await relay.pollPakeMessage(pending.sessionId);
    expect(raw).not.toBeNull();
    if (raw === null) {
      return;
    }
    const wire = JSON.parse(raw) as { phase: string; payload: string; role: string };
    wire.payload = "_8"; // non-canonical; loose decode accepts, strict rejects
    await relay.postPakeMessage(pending.sessionId, JSON.stringify(wire));

    const joinResult = await pairJoin({
      code: pending.code,
      keyPair: joinerKeys,
      relay,
      registry,
      localAllowlist: joinerAllowlist,
      decision: { approve: true },
    });

    expect(joinResult.status).toBe("pake_failed");
  }, 15000);

  function assertNoPlaintextCodeOnRelay(code: string): void {
    for (const body of relay.postedPakeBodies) {
      expect(body).not.toContain(code);
    }
  }

  async function runSuccessfulPairing(): Promise<{
    initiatorBond: Bond;
    joinerBond: Bond;
    code: string;
  }> {
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

    expect(joinResult.status).toBe("bonded");
    expect(initResult.status).toBe("bonded");

    if (joinResult.status !== "bonded" || initResult.status !== "bonded") {
      throw new Error("expected bonded");
    }

    return {
      initiatorBond: initResult.bond,
      joinerBond: joinResult.bond,
      code: pending.code,
    };
  }

  it("completes successful pairing with matching code and bonded allowlists", async () => {
    const { initiatorBond, joinerBond, code } = await runSuccessfulPairing();

    expect(initiatorBond.peer).toBe(joinerId);
    expect(initiatorBond.scope).toEqual(["session.negotiate"]);
    expect(initiatorBond.mode).toBe("ephemeral_until_session_closes");

    expect(joinerBond.peer).toBe(initiatorId);
    expect(joinerBond.scope).toEqual(["session.negotiate"]);
    expect(joinerBond.mode).toBe("ephemeral_until_session_closes");

    expect(initiatorAllowlist.get(initiatorId)).toContain(joinerId);
    expect(joinerAllowlist.get(joinerId)).toContain(initiatorId);
    expect(relay.getAllowlist(initiatorId)).toContain(joinerId);
    expect(relay.getAllowlist(joinerId)).toContain(initiatorId);

    assertNoPlaintextCodeOnRelay(code);
  }, 15000);

  it("completes pairing when initiator waits several seconds for human approval", async () => {
    const pending = await pairInit({
      scope: ["session.negotiate"],
      mode: "ephemeral_until_session_closes",
      keyPair: initiatorKeys,
      relay,
      registry,
    });

    const completeInitPromise = pairInitComplete({
      code: pending.code,
      keyPair: initiatorKeys,
      relay,
      registry,
      localAllowlist: initiatorAllowlist,
    });

    // Simulate human reading the pairing proposal before approving.
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const joinResult = await pairJoin({
      code: pending.code,
      keyPair: joinerKeys,
      relay,
      registry,
      localAllowlist: joinerAllowlist,
      decision: { approve: true },
    });

    const initResult = await completeInitPromise;

    expect(joinResult.status).toBe("bonded");
    expect(initResult.status).toBe("bonded");
  }, 30000);

  it("aborts SPAKE2 with wrong code and creates no allowlist entries", async () => {
    const pending = await pairInit({
      scope: ["session.negotiate"],
      mode: "ephemeral_until_session_closes",
      keyPair: initiatorKeys,
      relay,
      registry,
    });

    const joinPromise = pairJoin({
      code: pending.code,
      pakeCode: "wrong-code-xyz",
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

    expect(joinResult.status).toBe("pake_failed");
    expect(initResult.status).toBe("pake_failed");
    expect(initiatorAllowlist.get(initiatorId)).toEqual([]);
    expect(joinerAllowlist.get(joinerId)).toEqual([]);
    expect(relay.getAllowlist(initiatorId)).toEqual([]);
    expect(relay.getAllowlist(joinerId)).toEqual([]);

    assertNoPlaintextCodeOnRelay(pending.code);
    assertNoPlaintextCodeOnRelay("wrong-code-xyz");
  }, 15000);

  it("returns rejection explanation to initiator with no bond", async () => {
    const pending = await pairInit({
      scope: ["session.negotiate"],
      mode: "bonded_contact",
      keyPair: initiatorKeys,
      relay,
      registry,
    });

    const joinResult = await pairJoin({
      code: pending.code,
      keyPair: joinerKeys,
      relay,
      registry,
      localAllowlist: joinerAllowlist,
      decision: { reject: "scope too broad" },
    });

    const initResult = await pairInitComplete({
      code: pending.code,
      keyPair: initiatorKeys,
      relay,
      registry,
      localAllowlist: initiatorAllowlist,
    });

    expect(joinResult.status).toBe("rejected");
    expect(initResult.status).toBe("rejected");
    if (initResult.status === "rejected") {
      expect(initResult.reason).toBe("scope too broad");
    }

    expect(initiatorAllowlist.get(initiatorId)).toEqual([]);
    expect(joinerAllowlist.get(joinerId)).toEqual([]);
    assertNoPlaintextCodeOnRelay(pending.code);
  });

  it("rolls back allowlists on partial failure and allows retry with new session_id", async () => {
    const pending = await pairInit({
      scope: ["session.negotiate"],
      mode: "ephemeral_until_session_closes",
      keyPair: initiatorKeys,
      relay,
      registry,
    });

    relay.failAllowlistFor = joinerId;

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

    expect(joinResult.status).toBe("rolled_back");
    expect(initResult.status).toBe("rolled_back");
    expect(initiatorAllowlist.get(initiatorId)).toEqual([]);
    expect(joinerAllowlist.get(joinerId)).toEqual([]);
    expect(relay.getAllowlist(initiatorId)).toEqual([]);
    expect(relay.getAllowlist(joinerId)).toEqual([]);

    const originalSessionId = pending.sessionId;
    relay.failAllowlistFor = null;

    const retry = await pairRetry({
      code: pending.code,
      keyPair: initiatorKeys,
      relay,
      registry,
    });

    expect(retry.code).toBe(pending.code);
    expect(retry.sessionId).not.toBe(originalSessionId);

    const entry = registry.lookup(pending.code);
    expect(entry?.sessionId).toBe(retry.sessionId);
    expect(entry?.expiresAt).toBe(pending.expiresAt);

    const joinRetryPromise = pairJoin({
      code: pending.code,
      keyPair: joinerKeys,
      relay,
      registry,
      localAllowlist: joinerAllowlist,
      decision: { approve: true },
    });

    const initRetry = await pairInitComplete({
      code: pending.code,
      keyPair: initiatorKeys,
      relay,
      registry,
      localAllowlist: initiatorAllowlist,
    });

    const joinRetry = await joinRetryPromise;

    expect(joinRetry.status).toBe("bonded");
    expect(initRetry.status).toBe("bonded");
    expect(initiatorAllowlist.get(initiatorId)).toContain(joinerId);
    expect(joinerAllowlist.get(joinerId)).toContain(initiatorId);
  }, 20000);
});
