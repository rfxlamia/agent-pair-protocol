import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type KeyPair, generateKeyPair, publicKeyToAgentId } from "../crypto/keys.js";
import { REFERENCE_PROFILES } from "../profile/reference.js";
import {
  type Bond,
  InMemoryPairingRegistry,
  pairInit,
  pairInitComplete,
  pairJoin,
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
    // Dual registry: production is per-process; joiner consume must not erase initiator pending.
    const initiatorRegistry = new InMemoryPairingRegistry();
    const joinerRegistry = new InMemoryPairingRegistry();

    const pending = await pairInit({
      scope: ["session.negotiate"],
      mode: "bonded_contact",
      keyPair: initiatorKeys,
      relay,
      registry: initiatorRegistry,
    });

    joinerRegistry.register({
      code: pending.code,
      sessionId: pending.sessionId,
      proposal: pending.proposal,
      createdAt: Date.now(),
      expiresAt: pending.expiresAt,
    });

    const joinResult = await pairJoin({
      code: pending.code,
      keyPair: joinerKeys,
      relay,
      registry: joinerRegistry,
      localAllowlist: joinerAllowlist,
      decision: { reject: "scope_too_broad" },
    });

    const initResult = await pairInitComplete({
      code: pending.code,
      keyPair: initiatorKeys,
      relay,
      registry: initiatorRegistry,
      localAllowlist: initiatorAllowlist,
    });

    expect(joinResult.status).toBe("rejected");
    expect(initResult.status).toBe("rejected");
    if (initResult.status === "rejected") {
      expect(initResult.reason).toBe("scope_too_broad");
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

  it("rolls back allowlists on partial failure and burns code (recovery needs new pairInit)", async () => {
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

    // Same code is burned — recovery requires a new pairInit (no pairRetry).
    expect(registry.lookup(pending.code)).toBeUndefined();
    expect(registry.isConsumed(pending.code)).toBe(true);

    relay.failAllowlistFor = null;
    const fresh = await pairInit({
      scope: ["session.negotiate"],
      mode: "ephemeral_until_session_closes",
      keyPair: initiatorKeys,
      relay,
      registry,
    });
    expect(fresh.code).not.toBe(pending.code);
    expect(fresh.sessionId).not.toBe(pending.sessionId);

    const joinRetryPromise = pairJoin({
      code: fresh.code,
      keyPair: joinerKeys,
      relay,
      registry,
      localAllowlist: joinerAllowlist,
      decision: { approve: true },
    });

    const initRetry = await pairInitComplete({
      code: fresh.code,
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

  it("pairInit includes profiles on initiator pake wire", async () => {
    await pairInit({
      scope: ["session.negotiate"],
      mode: "ephemeral_until_session_closes",
      keyPair: initiatorKeys,
      relay,
      registry,
      profiles: ["core/1", "nego/1"],
    });

    const initPake = relay.postedPakeBodies.find((body) => {
      const wire = JSON.parse(body) as { phase: string; role: string; profiles?: string[] };
      return wire.phase === "pake" && wire.role === "initiator";
    });
    expect(initPake).toBeDefined();
    if (initPake) {
      const wire = JSON.parse(initPake) as { profiles: string[] };
      expect(wire.profiles).toEqual(["core/1", "nego/1"]);
    }
  });

  describe("single-use burn + reject poll (T2)", () => {
    // Shares parent beforeAll/beforeEach fixtures. Dual-registry tests construct local registries.

    it("burns code on both sides after bonded", async () => {
      const { code } = await runSuccessfulPairing();
      expect(registry.lookup(code)).toBeUndefined();
      expect(registry.isConsumed(code)).toBe(true);

      const again = await pairJoin({
        code,
        keyPair: joinerKeys,
        relay,
        registry,
        localAllowlist: joinerAllowlist,
        decision: { approve: true },
      });
      expect(again.status).toBe("not_found");
    }, 15000);

    it("burns joiner code on reject decision (dual registry; initiator still live until poll)", async () => {
      const initiatorRegistry = new InMemoryPairingRegistry();
      const joinerRegistry = new InMemoryPairingRegistry();

      const pending = await pairInit({
        scope: ["session.negotiate"],
        mode: "bonded_contact",
        keyPair: initiatorKeys,
        relay,
        registry: initiatorRegistry,
      });

      // Joiner gets its own live copy (as MCP ensureJoinerRegistry would).
      joinerRegistry.register({
        code: pending.code,
        sessionId: pending.sessionId,
        proposal: pending.proposal,
        createdAt: Date.now(),
        expiresAt: pending.expiresAt,
      });

      const joinResult = await pairJoin({
        code: pending.code,
        keyPair: joinerKeys,
        relay,
        registry: joinerRegistry,
        localAllowlist: joinerAllowlist,
        decision: { reject: "scope_too_broad" },
      });

      expect(joinResult.status).toBe("rejected");
      if (joinResult.status === "rejected") {
        expect(joinResult.reason).toBe("scope_too_broad");
      }
      expect(joinerRegistry.lookup(pending.code)).toBeUndefined();
      expect(joinerRegistry.isConsumed(pending.code)).toBe(true);
      // Initiator registry still has the pending so pairInitComplete can poll wire reject.
      expect(initiatorRegistry.lookup(pending.code)).toBeDefined();
    });

    it("initiator polls wire reject, returns rejected, and burns (not TTL wait)", async () => {
      // Dual registry: model production (joiner consume does not touch initiator map).
      const initiatorRegistry = new InMemoryPairingRegistry();
      const joinerRegistry = new InMemoryPairingRegistry();

      const pending = await pairInit({
        scope: ["session.negotiate"],
        mode: "bonded_contact",
        keyPair: initiatorKeys,
        relay,
        registry: initiatorRegistry,
      });

      joinerRegistry.register({
        code: pending.code,
        sessionId: pending.sessionId,
        proposal: pending.proposal,
        createdAt: Date.now(),
        expiresAt: pending.expiresAt,
      });

      const joinResult = await pairJoin({
        code: pending.code,
        keyPair: joinerKeys,
        relay,
        registry: joinerRegistry,
        localAllowlist: joinerAllowlist,
        decision: { reject: "scope_too_broad" },
      });
      expect(joinResult.status).toBe("rejected");

      const started = Date.now();
      const initResult = await pairInitComplete({
        code: pending.code,
        keyPair: initiatorKeys,
        relay,
        registry: initiatorRegistry,
        localAllowlist: initiatorAllowlist,
      });
      const elapsed = Date.now() - started;

      expect(initResult.status).toBe("rejected");
      if (initResult.status === "rejected") {
        expect(initResult.reason).toBe("scope_too_broad");
      }
      expect(initiatorRegistry.lookup(pending.code)).toBeUndefined();
      expect(initiatorRegistry.isConsumed(pending.code)).toBe(true);
      expect(elapsed).toBeLessThan(5_000);
    });

    it("truncates reject reason to exactly 256 UTF-8 bytes at protocol parse", async () => {
      const pending = await pairInit({
        scope: ["session.negotiate"],
        mode: "bonded_contact",
        keyPair: initiatorKeys,
        relay,
        registry,
      });

      const longReason = "r".repeat(300); // ASCII → 300 bytes; cap must yield exactly 256
      await relay.postPakeMessage(
        pending.sessionId,
        JSON.stringify({ phase: "reject", reason: longReason }),
      );

      const initResult = await pairInitComplete({
        code: pending.code,
        keyPair: initiatorKeys,
        relay,
        registry,
        localAllowlist: initiatorAllowlist,
      });

      expect(initResult.status).toBe("rejected");
      if (initResult.status === "rejected") {
        expect(new TextEncoder().encode(initResult.reason).byteLength).toBe(256);
        expect(initResult.reason.length).toBeLessThan(longReason.length);
      }
      expect(registry.lookup(pending.code)).toBeUndefined();
    });

    it("truncates multi-byte UTF-8 reject reason without splitting a code point", async () => {
      const pending = await pairInit({
        scope: ["session.negotiate"],
        mode: "bonded_contact",
        keyPair: initiatorKeys,
        relay,
        registry,
      });

      // "é" is 2 UTF-8 bytes; 200 of them = 400 bytes → truncate to ≤256 without orphan lead bytes
      const longReason = "é".repeat(200);
      await relay.postPakeMessage(
        pending.sessionId,
        JSON.stringify({ phase: "reject", reason: longReason }),
      );

      const initResult = await pairInitComplete({
        code: pending.code,
        keyPair: initiatorKeys,
        relay,
        registry,
        localAllowlist: initiatorAllowlist,
      });

      expect(initResult.status).toBe("rejected");
      if (initResult.status === "rejected") {
        const bytes = new TextEncoder().encode(initResult.reason);
        expect(bytes.byteLength).toBeLessThanOrEqual(256);
        expect(bytes.byteLength).toBeGreaterThan(250); // near cap
        // Round-trip decode must succeed (no truncated mid-codepoint)
        expect(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes)).not.toThrow();
      }
    });

    it("burns code on pake_failed (wrong code)", async () => {
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
      expect(registry.lookup(pending.code)).toBeUndefined();
    }, 15000);

    it("burns on rolled_back allowlist_push_failed; recovery requires new pairInit", async () => {
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
      await joinPromise;

      expect(initResult.status).toBe("rolled_back");
      expect(registry.lookup(pending.code)).toBeUndefined();

      // Rewrite former pairRetry recovery: same code must not retry; new pairInit works.
      const mod = await import("./flow.js");
      expect("pairRetry" in mod).toBe(false);

      relay.failAllowlistFor = null;
      const fresh = await pairInit({
        scope: ["session.negotiate"],
        mode: "ephemeral_until_session_closes",
        keyPair: initiatorKeys,
        relay,
        registry,
      });
      expect(fresh.code).not.toBe(pending.code);

      const joinRetryPromise = pairJoin({
        code: fresh.code,
        keyPair: joinerKeys,
        relay,
        registry,
        localAllowlist: joinerAllowlist,
        decision: { approve: true },
      });
      const initRetry = await pairInitComplete({
        code: fresh.code,
        keyPair: initiatorKeys,
        relay,
        registry,
        localAllowlist: initiatorAllowlist,
      });
      const joinRetry = await joinRetryPromise;
      expect(joinRetry.status).toBe("bonded");
      expect(initRetry.status).toBe("bonded");
    }, 20000);

    it("late reject after joiner-pake already consumed does not override to rejected", async () => {
      // MockRelayClient is single-slot: posting reject BEFORE pairInitComplete consumes
      // joiner pake would overwrite the slot and incorrectly yield rejected. Correct scenario:
      // initiator must pass the joiner-pake poll (consume slot) first; only then is a late
      // reject "too late" for the reject branch (confirm/bond phase ignores reject override).
      // Stabilize: inject reject only after initiator bond_ok is posted and joiner has had a
      // chance to consume it — initiator's trailing bond_fail poll ignores phase:reject.
      const pending = await pairInit({
        scope: ["session.negotiate"],
        mode: "ephemeral_until_session_closes",
        keyPair: initiatorKeys,
        relay,
        registry,
      });

      const originalPost = relay.postPakeMessage.bind(relay);
      let lateRejectPosted = false;
      vi.spyOn(relay, "postPakeMessage").mockImplementation(async (sessionId, body) => {
        await originalPost(sessionId, body);
        if (lateRejectPosted) return;
        const wire = JSON.parse(body) as { phase: string; agentId?: string };
        // After initiator posts bond_ok, joiner-pake / confirm phases are done.
        if (wire.phase === "bond_ok" && wire.agentId === initiatorId) {
          lateRejectPosted = true;
          // Yield so joiner can poll+consume initiator bond_ok before we overwrite the slot.
          await new Promise((r) => setTimeout(r, 30));
          await originalPost(sessionId, JSON.stringify({ phase: "reject", reason: "too_late" }));
        }
      });

      const joinPromise = pairJoin({
        code: pending.code,
        keyPair: joinerKeys,
        relay,
        registry,
        localAllowlist: joinerAllowlist,
        decision: { approve: true },
      });

      const initPromise = pairInitComplete({
        code: pending.code,
        keyPair: initiatorKeys,
        relay,
        registry,
        localAllowlist: initiatorAllowlist,
      });

      const initResult = await initPromise;
      await joinPromise;

      expect(lateRejectPosted).toBe(true);
      expect(initResult.status).not.toBe("rejected");
      vi.restoreAllMocks();
    }, 20000);

    it("clock-skew: joiner after initiator burn gets pake_failed and burns locally", async () => {
      // pairJoin waits BOND_COORDINATION_TIMEOUT_MS (30s) for initiator confirm when
      // initiator already burned and is not running pairInitComplete. Prefer stub that
      // returns bond_fail on confirm-phase polls so we fail fast without 30s wall clock.
      const initiatorRegistry = new InMemoryPairingRegistry();
      const joinerRegistry = new InMemoryPairingRegistry();

      const pending = await pairInit({
        scope: ["session.negotiate"],
        mode: "ephemeral_until_session_closes",
        keyPair: initiatorKeys,
        relay,
        registry: initiatorRegistry,
      });

      joinerRegistry.register({
        code: pending.code,
        sessionId: pending.sessionId,
        proposal: pending.proposal,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      });

      initiatorRegistry.consume(pending.code);

      // After joiner consumes initiator pake and posts joiner pake, confirm never arrives.
      // Returning bond_fail after the initiator pake is consumed ends confirm wait immediately.
      const originalPoll = relay.pollPakeMessage.bind(relay);
      let sawInitiatorPake = false;
      vi.spyOn(relay, "pollPakeMessage").mockImplementation(async (sessionId, timeoutMs) => {
        const msg = await originalPoll(sessionId, timeoutMs);
        if (msg) {
          try {
            const wire = JSON.parse(msg) as { phase?: string; role?: string };
            if (wire.phase === "pake" && wire.role === "initiator") {
              sawInitiatorPake = true;
              return msg;
            }
          } catch {
            // fall through
          }
        }
        // Confirm phase (or empty slot after initiator pake): fail fast via bond_fail.
        if (sawInitiatorPake) {
          return JSON.stringify({ phase: "bond_fail" });
        }
        return msg;
      });

      const joinResult = await pairJoin({
        code: pending.code,
        keyPair: joinerKeys,
        relay,
        registry: joinerRegistry,
        localAllowlist: joinerAllowlist,
        decision: { approve: true },
      });

      expect(joinResult.status).toBe("pake_failed");
      expect(joinerRegistry.lookup(pending.code)).toBeUndefined();
      expect(joinerRegistry.isConsumed(pending.code)).toBe(true);
      expect(initiatorAllowlist.get(initiatorId)).toEqual([]);
      expect(joinerAllowlist.get(joinerId)).toEqual([]);
      vi.restoreAllMocks();
    }, 20000);

    it("pairRetry is not exported from @agentpair/protocol pairing flow", async () => {
      const flowMod = await import("./flow.js");
      expect("pairRetry" in flowMod).toBe(false);
      const pkg = await import("../index.js");
      expect("pairRetry" in pkg).toBe(false);
    });
  });
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
