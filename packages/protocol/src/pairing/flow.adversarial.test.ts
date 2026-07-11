import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KeyPair, generateKeyPair, publicKeyToAgentId } from "../crypto/keys.js";
import { TamperingRelay } from "./adversarial-relay.js";
import {
  InMemoryPairingRegistry,
  type PairFlowResult,
  pairInit,
  pairInitComplete,
  pairJoin,
} from "./flow.js";
import { init as initPake } from "./pake-adapter.js";
import { MemoryAllowlistStore } from "./test-helpers.js";

/**
 * Class 1 invariant (post-T3 GREEN): adversarial cases 1–5 and 9 must never return
 * rolled_back before local verification passes — confirm failures surface as pake_failed.
 */

describe("pairing flow adversarial (identity-bound confirm)", () => {
  let initiatorKeys: KeyPair;
  let joinerKeys: KeyPair;
  let attackerKeys: KeyPair;
  let initiatorId: string;
  let joinerId: string;
  let attackerId: string;
  let registry: InMemoryPairingRegistry;
  let initiatorAllowlist: MemoryAllowlistStore;
  let joinerAllowlist: MemoryAllowlistStore;
  let relay: TamperingRelay;

  beforeAll(async () => {
    await initPake();
  });

  beforeEach(() => {
    initiatorKeys = generateKeyPair();
    joinerKeys = generateKeyPair();
    attackerKeys = generateKeyPair();
    initiatorId = publicKeyToAgentId(initiatorKeys.publicKey);
    joinerId = publicKeyToAgentId(joinerKeys.publicKey);
    attackerId = publicKeyToAgentId(attackerKeys.publicKey);
    registry = new InMemoryPairingRegistry();
    initiatorAllowlist = new MemoryAllowlistStore();
    joinerAllowlist = new MemoryAllowlistStore();
    relay = new TamperingRelay(initiatorId, joinerId, registry);
  });

  async function runPairing(): Promise<{
    initResult: PairFlowResult;
    joinResult: PairFlowResult;
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
    return { initResult, joinResult, code: pending.code };
  }

  function expectZeroAllowlist(): void {
    expect(initiatorAllowlist.get(initiatorId)).toEqual([]);
    expect(joinerAllowlist.get(joinerId)).toEqual([]);
    expect(relay.getAllowlist(initiatorId)).toEqual([]);
    expect(relay.getAllowlist(joinerId)).toEqual([]);
  }

  it("case 1: swap joiner agentId — both sides reject with pake_failed", async () => {
    relay.swapJoinerAgentId = attackerId;

    const { initResult, joinResult } = await runPairing();

    expect(initResult.status).toBe("pake_failed");
    expect(joinResult.status).toBe("pake_failed");
    expect(initResult.status).not.toBe("rolled_back");
    expect(joinResult.status).not.toBe("rolled_back");
    expectZeroAllowlist();
  }, 20000);

  it("case 2: swap initiator agentId — joiner pake_failed, initiator rolled_back", async () => {
    relay.swapInitiatorAgentId = attackerId;

    const { initResult, joinResult } = await runPairing();

    expect(joinResult.status).toBe("pake_failed");
    expect(initResult.status).toBe("rolled_back");
    expectZeroAllowlist();
  }, 35000);

  it("case 3: tampered registry proposal — both sides reject with pake_failed", async () => {
    const pending = await pairInit({
      scope: ["session.negotiate"],
      mode: "ephemeral_until_session_closes",
      keyPair: initiatorKeys,
      relay,
      registry,
    });

    relay.tamperProposalInitiatorId(pending.code, attackerId);

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

    expect(initResult.status).toBe("pake_failed");
    expect(joinResult.status).toBe("pake_failed");
    expect(initResult.status).not.toBe("rolled_back");
    expect(joinResult.status).not.toBe("rolled_back");
    expectZeroAllowlist();
  }, 20000);

  it("case 4: drop bond_fail — peer eventually pake_failed, zero allowlist", async () => {
    relay.dropBondFail = true;
    // Force a fingerprint mismatch path by swapping joiner id so initiator bonds to attacker
    // but joiner may post bond_fail on mismatch — with drop, coordination hangs.
    // Use wrong pake code to trigger bond_fail from joiner after confirm mismatch.
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
    expectZeroAllowlist();
  }, 35000);

  it("case 5: inject bond_fail during confirm — pake_failed, zero allowlist", async () => {
    relay.injectBondFailDuringConfirm = true;

    const { initResult, joinResult } = await runPairing();

    expect(initResult.status).toBe("pake_failed");
    expect(joinResult.status).toBe("pake_failed");
    expectZeroAllowlist();
  }, 35000);

  it("case 6: initiator putAllowlist fail — both rolled_back", async () => {
    relay.failAllowlistFor = initiatorId;

    const { initResult, joinResult } = await runPairing();

    expect(initResult.status).toBe("rolled_back");
    expect(joinResult.status).toBe("rolled_back");
    expectZeroAllowlist();
  }, 20000);

  it("case 7: joiner putAllowlist fail — initiator may bonded, joiner rolled_back", async () => {
    relay.failAllowlistFor = joinerId;

    const { initResult, joinResult } = await runPairing();

    expect(joinResult.status).toBe("rolled_back");
    // Initiator may remain bonded briefly, but current flow rolls back on bond_fail.
    expect(["bonded", "rolled_back"]).toContain(initResult.status);
    if (initResult.status === "bonded") {
      expect(initiatorAllowlist.get(initiatorId)).toContain(joinerId);
    }
    expect(joinerAllowlist.get(joinerId)).toEqual([]);
  }, 20000);

  it("case 8: inject bond_fail during bond_ok — rolled_back", async () => {
    relay.injectBondFailDuringBondOk = true;

    const { initResult, joinResult } = await runPairing();

    expect(initResult.status).toBe("rolled_back");
    expect(joinResult.status).toBe("rolled_back");
    expectZeroAllowlist();
  }, 35000);

  it("case 9: malformed confirm — pake_failed, zero allowlist", async () => {
    relay.malformConfirm = "omit_fingerprint";

    const { initResult, joinResult } = await runPairing();

    expect(initResult.status).toBe("pake_failed");
    expect(joinResult.status).toBe("pake_failed");
    expectZeroAllowlist();
  }, 35000);

  it("case 10: drop initiator bond_ok — initiator bonded, joiner rolled_back (two-generals)", async () => {
    relay.dropInitiatorBondOkReply = true;

    const { initResult, joinResult } = await runPairing();

    expect(initResult.status).toBe("bonded");
    expect(joinResult.status).toBe("rolled_back");
    expect(initiatorAllowlist.get(initiatorId)).toContain(joinerId);
    expect(joinerAllowlist.get(joinerId)).toEqual([]);
  }, 35000);
});
