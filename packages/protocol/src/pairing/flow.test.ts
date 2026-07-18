import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type KeyPair, generateKeyPair, publicKeyToAgentId } from "../crypto/keys.js";
import { REFERENCE_PROFILES } from "../profile/reference.js";
import {
  type Bond,
  InMemoryPairingRegistry,
  pairInit,
  pairInitComplete,
  pairJoin,
  pairRetry,
} from "./flow.js";
import { CODE_WORDS, generatePairingCode } from "./pairing-words.js";
import { init as initPake } from "./pake-adapter.js";
import { MemoryAllowlistStore, MockRelayClient } from "./test-helpers.js";

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
    relay.consumePakeMessage(pending.sessionId);
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
    expect(initiatorBond.profiles).toEqual([...REFERENCE_PROFILES]);

    expect(joinerBond.peer).toBe(initiatorId);
    expect(joinerBond.scope).toEqual(["session.negotiate"]);
    expect(joinerBond.mode).toBe("ephemeral_until_session_closes");
    expect(joinerBond.profiles).toEqual([...REFERENCE_PROFILES]);

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

  it("does not push initiator allowlist before joiner bond_ok", async () => {
    const pending = await pairInit({
      scope: ["session.negotiate"],
      mode: "ephemeral_until_session_closes",
      keyPair: initiatorKeys,
      relay,
      registry,
    });

    let initiatorPutBeforeJoinerBondOk = false;
    const putAllowlistSpy = vi.spyOn(relay, "putAllowlist");
    let joinerBondOkSeen = false;

    putAllowlistSpy.mockImplementation(async (agentId, allowed, secretKey) => {
      if (agentId === initiatorId && !joinerBondOkSeen) {
        initiatorPutBeforeJoinerBondOk = true;
      }
      putAllowlistSpy.mockRestore();
      return relay.putAllowlist(agentId, allowed, secretKey);
    });

    const originalPost = relay.postPakeMessage.bind(relay);
    vi.spyOn(relay, "postPakeMessage").mockImplementation(async (sessionId, body) => {
      const wire = JSON.parse(body) as { phase: string };
      if (wire.phase === "bond_ok") {
        joinerBondOkSeen = true;
      }
      return originalPost(sessionId, body);
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
    expect(initiatorPutBeforeJoinerBondOk).toBe(false);
  }, 15000);

  it("rolls back allowlists on partial failure and allows retry with new session_id", async () => {
    const pending = await pairInit({
      scope: ["session.negotiate"],
      mode: "ephemeral_until_session_closes",
      keyPair: initiatorKeys,
      relay,
      registry,
    });

    relay.failAllowlistFor = initiatorId;

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
    if (joinResult.status === "rolled_back") {
      expect(joinResult.reason).toBe("bond_aborted");
    }
    if (initResult.status === "rolled_back") {
      expect(initResult.reason).toBe("allowlist_push_failed");
    }
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

  it("stores full profile contract when both sides advertise the reference set", async () => {
    const { initiatorBond, joinerBond } = await runSuccessfulPairing();
    expect(initiatorBond.profiles).toEqual(["core/1", "nego/1"]);
    expect(joinerBond.profiles).toEqual(["core/1", "nego/1"]);
  }, 15000);

  it("returns profile_not_supported when profiles are disjoint", async () => {
    const pending = await pairInit({
      scope: ["session.negotiate"],
      mode: "ephemeral_until_session_closes",
      keyPair: initiatorKeys,
      relay,
      registry,
      profiles: ["core/1"],
    });

    const joinPromise = pairJoin({
      code: pending.code,
      keyPair: joinerKeys,
      relay,
      registry,
      localAllowlist: joinerAllowlist,
      decision: { approve: true },
      profiles: ["nego/1"],
    });

    const initResult = await pairInitComplete({
      code: pending.code,
      keyPair: initiatorKeys,
      relay,
      registry,
      localAllowlist: initiatorAllowlist,
      profiles: ["core/1"],
    });

    const joinResult = await joinPromise;

    expect(initResult.status).toBe("rolled_back");
    expect(joinResult.status).toBe("rolled_back");
    if (initResult.status === "rolled_back") {
      expect(initResult.reason).toBe("profile_not_supported");
    }
    if (joinResult.status === "rolled_back") {
      expect(joinResult.reason).toBe("profile_not_supported");
    }
    expect(initiatorAllowlist.get(initiatorId)).toEqual([]);
    expect(joinerAllowlist.get(joinerId)).toEqual([]);
  }, 15000);

  it("returns profile_not_supported when intersection lacks core/1", async () => {
    const pending = await pairInit({
      scope: ["session.negotiate"],
      mode: "ephemeral_until_session_closes",
      keyPair: initiatorKeys,
      relay,
      registry,
      profiles: ["nego/1"],
    });

    const joinPromise = pairJoin({
      code: pending.code,
      keyPair: joinerKeys,
      relay,
      registry,
      localAllowlist: joinerAllowlist,
      decision: { approve: true },
      profiles: ["nego/1"],
    });

    const initResult = await pairInitComplete({
      code: pending.code,
      keyPair: initiatorKeys,
      relay,
      registry,
      localAllowlist: initiatorAllowlist,
      profiles: ["nego/1"],
    });

    const joinResult = await joinPromise;

    expect(initResult.status).toBe("rolled_back");
    expect(joinResult.status).toBe("rolled_back");
    if (initResult.status === "rolled_back") {
      expect(initResult.reason).toBe("profile_not_supported");
    }
    if (joinResult.status === "rolled_back") {
      expect(joinResult.reason).toBe("profile_not_supported");
    }
    expect(initiatorAllowlist.get(initiatorId)).toEqual([]);
    expect(joinerAllowlist.get(joinerId)).toEqual([]);
  }, 15000);

  it("stores partial intersection as bond contract", async () => {
    const pending = await pairInit({
      scope: ["session.negotiate"],
      mode: "ephemeral_until_session_closes",
      keyPair: initiatorKeys,
      relay,
      registry,
      profiles: ["core/1", "nego/1"],
    });

    const joinPromise = pairJoin({
      code: pending.code,
      keyPair: joinerKeys,
      relay,
      registry,
      localAllowlist: joinerAllowlist,
      decision: { approve: true },
      profiles: ["core/1"],
    });

    const initResult = await pairInitComplete({
      code: pending.code,
      keyPair: initiatorKeys,
      relay,
      registry,
      localAllowlist: initiatorAllowlist,
      profiles: ["core/1", "nego/1"],
    });

    const joinResult = await joinPromise;

    expect(initResult.status).toBe("bonded");
    expect(joinResult.status).toBe("bonded");
    if (initResult.status === "bonded" && joinResult.status === "bonded") {
      expect(initResult.bond.profiles).toEqual(["core/1"]);
      expect(joinResult.bond.profiles).toEqual(["core/1"]);
    }
  }, 15000);

  it("initiator sends confirm even when intersection gate fails", async () => {
    const pending = await pairInit({
      scope: ["session.negotiate"],
      mode: "ephemeral_until_session_closes",
      keyPair: initiatorKeys,
      relay,
      registry,
      profiles: ["core/1"],
    });

    const joinPromise = pairJoin({
      code: pending.code,
      keyPair: joinerKeys,
      relay,
      registry,
      localAllowlist: joinerAllowlist,
      decision: { approve: true },
      profiles: ["nego/1"],
    });

    const initResult = await pairInitComplete({
      code: pending.code,
      keyPair: initiatorKeys,
      relay,
      registry,
      localAllowlist: initiatorAllowlist,
      profiles: ["core/1"],
    });

    await joinPromise;

    const confirmPosted = relay.postedPakeBodies.some((body) => {
      const wire = JSON.parse(body) as { phase: string };
      return wire.phase === "confirm";
    });
    expect(confirmPosted).toBe(true);
    expect(initResult.status).toBe("rolled_back");
    if (initResult.status === "rolled_back") {
      expect(initResult.reason).toBe("profile_not_supported");
    }
  }, 15000);

  it("pairRetry includes profiles on initiator pake wire", async () => {
    const pending = await pairInit({
      scope: ["session.negotiate"],
      mode: "ephemeral_until_session_closes",
      keyPair: initiatorKeys,
      relay,
      registry,
      profiles: ["core/1", "nego/1"],
    });

    relay.failAllowlistFor = initiatorId;

    const joinPromise = pairJoin({
      code: pending.code,
      keyPair: joinerKeys,
      relay,
      registry,
      localAllowlist: joinerAllowlist,
      decision: { approve: true },
    });

    await pairInitComplete({
      code: pending.code,
      keyPair: initiatorKeys,
      relay,
      registry,
      localAllowlist: initiatorAllowlist,
    });
    await joinPromise;

    relay.failAllowlistFor = null;
    relay.postedPakeBodies = [];

    await pairRetry({
      code: pending.code,
      keyPair: initiatorKeys,
      relay,
      registry,
      profiles: ["core/1", "nego/1"],
    });

    const retryPake = relay.postedPakeBodies.find((body) => {
      const wire = JSON.parse(body) as { phase: string; role: string; profiles?: string[] };
      return wire.phase === "pake" && wire.role === "initiator";
    });
    expect(retryPake).toBeDefined();
    if (retryPake) {
      const wire = JSON.parse(retryPake) as { profiles: string[] };
      expect(wire.profiles).toEqual(["core/1", "nego/1"]);
    }
  }, 20000);
});

describe("InMemoryPairingRegistry consume/tombstone", () => {
  let registry: InMemoryPairingRegistry;
  let relay: MockRelayClient;
  let initiatorKeys: KeyPair;
  let joinerKeys: KeyPair;
  let joinerAllowlist: MemoryAllowlistStore;

  beforeAll(async () => {
    await initPake();
  });

  beforeEach(() => {
    registry = new InMemoryPairingRegistry();
    relay = new MockRelayClient();
    initiatorKeys = generateKeyPair();
    joinerKeys = generateKeyPair();
    joinerAllowlist = new MemoryAllowlistStore();
  });

  it("consume hides entry from lookup, sets isConsumed, and is idempotent", () => {
    const code = "42-otter-maple-crane";
    registry.register({
      code,
      sessionId: crypto.randomUUID(),
      proposal: {
        scope: ["session.negotiate"],
        mode: "ephemeral_until_session_closes",
        initiatorAgentId: "ed25519:alice",
      },
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });

    expect(registry.lookup(code)).toBeDefined();
    expect(registry.isConsumed(code)).toBe(false);
    registry.consume(code);
    expect(registry.lookup(code)).toBeUndefined();
    expect(registry.isConsumed(code)).toBe(true);
    expect(() => registry.consume(code)).not.toThrow();
    expect(registry.isConsumed(code)).toBe(true);
    expect(registry.lookup(code)).toBeUndefined();
  });

  it("isConsumed is false for never-registered codes", () => {
    expect(registry.isConsumed("99-never-seen-code-zzzz")).toBe(false);
  });

  it("pairJoin returns not_found for a consumed code while TTL is still live", async () => {
    const pending = await pairInit({
      scope: ["session.negotiate"],
      mode: "ephemeral_until_session_closes",
      keyPair: initiatorKeys,
      relay,
      registry,
    });

    registry.consume(pending.code);
    expect(registry.isConsumed(pending.code)).toBe(true);

    const joinResult = await pairJoin({
      code: pending.code,
      keyPair: joinerKeys,
      relay,
      registry,
      localAllowlist: joinerAllowlist,
      decision: { approve: true },
    });

    expect(joinResult.status).toBe("not_found");
    expect(registry.lookup(pending.code)).toBeUndefined();
    expect(registry.isConsumed(pending.code)).toBe(true);
  });

  it("expired lookupPending returns expired; past-TTL entry does not linger as isConsumed", async () => {
    const code = "11-alpha-bravo-charlie";
    registry.register({
      code,
      sessionId: crypto.randomUUID(),
      proposal: {
        scope: ["session.negotiate"],
        mode: "ephemeral_until_session_closes",
        initiatorAgentId: "ed25519:alice",
      },
      createdAt: Date.now() - 120_000,
      expiresAt: Date.now() - 1_000,
    });

    const joinResult = await pairJoin({
      code,
      keyPair: joinerKeys,
      relay,
      registry,
      localAllowlist: joinerAllowlist,
      decision: { approve: true },
    });

    expect(joinResult.status).toBe("expired");
    expect(registry.lookup(code)).toBeUndefined();
    expect(registry.isConsumed(code)).toBe(false);
  });

  it("live-TTL consume keeps isConsumed true; past-TTL tombstone purges on lookup/isConsumed", () => {
    const liveCode = "22-delta-echo-foxtrot";
    registry.register({
      code: liveCode,
      sessionId: crypto.randomUUID(),
      proposal: {
        scope: ["session.negotiate"],
        mode: "ephemeral_until_session_closes",
        initiatorAgentId: "ed25519:alice",
      },
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    registry.consume(liveCode);
    expect(registry.lookup(liveCode)).toBeUndefined();
    expect(registry.isConsumed(liveCode)).toBe(true);

    const pastCode = "33-golf-hotel-india";
    registry.register({
      code: pastCode,
      sessionId: crypto.randomUUID(),
      proposal: {
        scope: ["session.negotiate"],
        mode: "ephemeral_until_session_closes",
        initiatorAgentId: "ed25519:alice",
      },
      createdAt: Date.now() - 120_000,
      expiresAt: Date.now() - 1_000,
    });
    registry.consume(pastCode);
    expect(registry.lookup(pastCode)).toBeUndefined();
    expect(registry.isConsumed(pastCode)).toBe(false);
    expect(() => registry.consume(pastCode)).not.toThrow();
    expect(registry.isConsumed(pastCode)).toBe(false);
  });
});
