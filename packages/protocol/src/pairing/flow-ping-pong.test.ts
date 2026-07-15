import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KeyPair, generateKeyPair, publicKeyToAgentId } from "../crypto/keys.js";
import {
  InMemoryPairingRegistry,
  type PairFlowResult,
  type PairInitOutput,
  pairInit,
  pairInitComplete,
  pairJoin,
} from "./flow.js";
import { init as initPake } from "./pake-adapter.js";
import {
  violateInitiatorDoublePosts,
  violateJoinerPostsWithoutConsume,
} from "./ping-pong-violation.js";
import { MemoryAllowlistStore, MockRelayClient } from "./test-helpers.js";

describe("§6.2 ping-pong violation", () => {
  let initiatorKeys: KeyPair;
  let joinerKeys: KeyPair;
  let initiatorId: string;
  let joinerId: string;
  let registry: InMemoryPairingRegistry;
  let initiatorAllowlist: MemoryAllowlistStore;
  let joinerAllowlist: MemoryAllowlistStore;
  let relay: MockRelayClient;

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

  function expectZeroAllowlist(): void {
    expect(initiatorAllowlist.get(initiatorId)).toEqual([]);
    expect(joinerAllowlist.get(joinerId)).toEqual([]);
    expect(relay.getAllowlist(initiatorId)).toEqual([]);
    expect(relay.getAllowlist(joinerId)).toEqual([]);
  }

  async function expectSlotOverwroteInitiatorPake(
    initiatorPakeFromPairInit: string,
    sessionId: string,
  ): Promise<void> {
    expect(relay.postedPakeBodies.length).toBeGreaterThan(1);
    const current = await relay.pollPakeMessage(sessionId);
    expect(current).not.toBeNull();
    expect(current).not.toBe(initiatorPakeFromPairInit);
  }

  async function runAfterViolation(
    pending: PairInitOutput,
  ): Promise<{ initResult: PairFlowResult; joinResult: PairFlowResult }> {
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
    return { initResult, joinResult };
  }

  it("joiner posts pake without consuming initiator — pake_failed, slot overwrite, zero allowlist", async () => {
    const pending = await pairInit({
      scope: ["session.negotiate"],
      mode: "ephemeral_until_session_closes",
      keyPair: initiatorKeys,
      relay,
      registry,
    });

    const initiatorPake = relay.postedPakeBodies.at(-1);
    expect(initiatorPake).toBeDefined();

    const { overwrittenInitiatorPake } = await violateJoinerPostsWithoutConsume(
      {
        relay,
        sessionId: pending.sessionId,
        code: pending.code,
      },
      joinerKeys,
    );

    expect(overwrittenInitiatorPake).toBe(initiatorPake);
    await expectSlotOverwroteInitiatorPake(initiatorPake as string, pending.sessionId);

    const { initResult, joinResult } = await runAfterViolation(pending);

    expect(joinResult.status).toBe("pake_failed");
    expect(initResult.status).toBe("pake_failed");
    // Class 1: confirm-phase failures surface as pake_failed, not premature rolled_back
    expect(initResult.status).not.toBe("rolled_back");
    expect(joinResult.status).not.toBe("rolled_back");
    expectZeroAllowlist();
  }, 20_000);

  it("initiator double-posts pake before joiner consumes — pake_failed, slot overwrite, zero allowlist", async () => {
    const pending = await pairInit({
      scope: ["session.negotiate"],
      mode: "ephemeral_until_session_closes",
      keyPair: initiatorKeys,
      relay,
      registry,
    });

    const { firstInitiatorPake, secondInitiatorPake } = await violateInitiatorDoublePosts({
      relay,
      sessionId: pending.sessionId,
      code: pending.code,
    });

    expect(firstInitiatorPake).not.toBe(secondInitiatorPake);
    await expectSlotOverwroteInitiatorPake(firstInitiatorPake, pending.sessionId);
    const currentSlot = await relay.pollPakeMessage(pending.sessionId);
    expect(currentSlot).toBe(secondInitiatorPake);

    const { initResult, joinResult } = await runAfterViolation(pending);

    expect(joinResult.status).toBe("pake_failed");
    expect(initResult.status).toBe("pake_failed");
    expect(initResult.status).not.toBe("rolled_back");
    expect(joinResult.status).not.toBe("rolled_back");
    expectZeroAllowlist();
  }, 35_000);
});
