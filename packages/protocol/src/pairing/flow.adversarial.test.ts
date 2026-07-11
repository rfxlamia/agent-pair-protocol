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
 * rolled_back — identity/fingerprint failures should surface as pake_failed instead.
 */

describe("pairing flow adversarial (RED on current flow.ts)", () => {
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

  it("case 1: swap joiner agentId — initiator bonds to attacker peer (RED)", async () => {
    relay.swapJoinerAgentId = attackerId;

    const { initResult, joinResult } = await runPairing();

    expect(initResult.status).toBe("bonded");
    if (initResult.status === "bonded") {
      expect(initResult.bond.peer).toBe(attackerId);
      expect(initResult.bond.peer).not.toBe(joinerId);
    }

    // Joiner may still bond using registry peer; vulnerability is on initiator side.
    expect(joinResult.status).not.toBe("pake_failed");
  }, 20000);

  it("case 2: swap initiator agentId — initiator mis-binds via swapped self-echo (RED)", async () => {
    relay.swapInitiatorAgentId = attackerId;

    const { initResult, joinResult } = await runPairing();

    // RED: inbound swap on initiator's own confirm lets initiator accept it as joiner confirm.
    expect(initResult.status).toBe("bonded");
    if (initResult.status === "bonded") {
      expect(initResult.bond.peer).toBe(attackerId);
      expect(initResult.bond.peer).not.toBe(joinerId);
    }
    expect(joinResult.status).toBe("pake_failed");
  }, 35000);

  it("case 3: tampered registry proposal — joiner bonds to attacker from registry (RED)", async () => {
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

    expect(joinResult.status).toBe("bonded");
    if (joinResult.status === "bonded") {
      expect(joinResult.bond.peer).toBe(attackerId);
      expect(joinResult.bond.peer).not.toBe(initiatorId);
    }
    expect(initResult.status).toBe("bonded");
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
  }, 20000);

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
  }, 20000);

  it("case 9: malformed confirm — may throw or pake_failed inconsistently", async () => {
    relay.malformConfirm = "omit_fingerprint";

    const { initResult, joinResult } = await runPairing();

    const statuses = [initResult.status, joinResult.status];
    expect(statuses.some((s) => s === "pake_failed" || s === "rolled_back")).toBe(true);
    expect(statuses.every((s) => s === "bonded")).toBe(false);
  }, 20000);

  it("case 10: drop initiator bond_ok — initiator bonded, joiner rolled_back (two-generals)", async () => {
    relay.dropInitiatorBondOkReply = true;

    const { initResult, joinResult } = await runPairing();

    expect(initResult.status).toBe("bonded");
    expect(joinResult.status).toBe("rolled_back");
    expect(initiatorAllowlist.get(initiatorId)).toContain(joinerId);
    expect(joinerAllowlist.get(joinerId)).toEqual([]);
  }, 35000);
});
