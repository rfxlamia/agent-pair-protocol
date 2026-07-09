// ---------------------------------------------------------------------------
// TD-1 — Proof-of-Concept: pairing identity is NOT bound to the SPAKE2 key.
//
// Threat model (from SPEC §11.2): the relay is UNTRUSTED. The spec claims a
// compromised relay "can never forge content". This PoC shows that claim does
// not hold for *pairing*, because §6.2 / flow.ts compute the confirmation as:
//
//     fingerprint = SHA-256(shared_key)          // flow.ts -> keyFingerprint()
//
// and send the long-term identity (`agent_id`) ALONGSIDE that fingerprint,
// unauthenticated. SPAKE2 authenticates the *code*, but nothing binds the
// *identity key* to the shared secret.
//
// Attack: a relay/network attacker forwards the real SPAKE2 `pake` messages
// unchanged (so BOTH honest hosts derive the SAME shared_key, and fingerprints
// match), then swaps ONLY the `agent_id` inside the joiner's `confirm` message.
// The initiator's fingerprint check still passes (fingerprint untouched), so the
// initiator bonds its allowlist to the ATTACKER's identity instead of the real
// joiner. From then on the attacker is an authenticated "peer" to the initiator.
//
// This file contains two tests:
//   1. A PoC that PASSES today, demonstrating the exploit is real in code.
//   2. A security requirement marked `it.fails` — it is green now (the secure
//      assertion currently does not hold) and will turn RED once the fix lands
//      (bind agent_id into the confirmation), forcing `.fails` to be removed.
//
// The fix does NOT change any honest-path test in flow.test.ts.
// ---------------------------------------------------------------------------

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

/**
 * A relay that behaves honestly for every message EXCEPT the joiner's `confirm`,
 * where it rewrites the advertised `agent_id` to the attacker's identity while
 * leaving the SHA-256(shared_key) fingerprint intact. `pake` messages pass
 * through untouched, so both honest hosts still derive the same shared key.
 */
class IdentitySwappingRelay implements PairingRelayClient {
  private pakeMessages = new Map<string, string>();
  private allowlists = new Map<string, string[]>();
  tampered = false;

  constructor(
    /** Identity the initiator EXPECTS to bond with (the real joiner). */
    private readonly victimPeerId: string,
    /** Identity the attacker injects in its place. */
    private readonly attackerId: string,
  ) {}

  async postPakeMessage(sessionId: string, body: string): Promise<void> {
    let outBody = body;
    try {
      const msg = JSON.parse(body) as { phase?: string; agentId?: string };
      // Only touch the joiner's key-confirmation; forward everything else as-is.
      if (msg.phase === "confirm" && msg.agentId === this.victimPeerId) {
        msg.agentId = this.attackerId; // swap identity, keep `fingerprint`
        outBody = JSON.stringify(msg);
        this.tampered = true;
      }
    } catch {
      // non-JSON control frame; forward verbatim
    }
    this.pakeMessages.set(sessionId, outBody);
  }

  async pollPakeMessage(sessionId: string, _timeoutMs = 5000): Promise<string | null> {
    return this.pakeMessages.get(sessionId) ?? null;
  }

  async putAllowlist(
    agentId: string,
    allowed: string[],
    secretKey: Uint8Array,
  ): Promise<{ ok: boolean }> {
    const body = signAllowlist(agentId, allowed, secretKey);
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

describe("TD-1 · pairing identity binding (SPAKE2 confirm)", () => {
  let initiatorKeys: KeyPair;
  let joinerKeys: KeyPair;
  let attackerKeys: KeyPair;
  let initiatorId: string;
  let joinerId: string;
  let attackerId: string;
  let relay: IdentitySwappingRelay;
  let registry: InMemoryPairingRegistry;
  let initiatorAllowlist: MemoryAllowlistStore;
  let joinerAllowlist: MemoryAllowlistStore;

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
    // The attacker sits between relay and initiator, swapping the joiner's id.
    relay = new IdentitySwappingRelay(joinerId, attackerId);
    registry = new InMemoryPairingRegistry();
    initiatorAllowlist = new MemoryAllowlistStore();
    joinerAllowlist = new MemoryAllowlistStore();
  });

  async function runTamperedPairing() {
    const pending = await pairInit({
      scope: ["session.negotiate"],
      mode: "ephemeral_until_session_closes",
      keyPair: initiatorKeys,
      relay,
      registry,
    });

    // The real joiner runs an honest join with the correct code.
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

  it("PoC: a tampering relay substitutes the peer identity and the initiator bonds to the ATTACKER (current behavior — documents the vulnerability)", async () => {
    const { initResult } = await runTamperedPairing();

    // The attacker never knew the pairing code, yet:
    expect(relay.tampered).toBe(true);

    // ...the fingerprint check PASSED (SHA-256(shared_key) was untouched)...
    expect(initResult.status).toBe("bonded");

    // ...and the initiator bonded to the attacker's identity, NOT the joiner.
    if (initResult.status !== "bonded") throw new Error("expected bonded");
    expect(initResult.bond.peer).toBe(attackerId);
    expect(initResult.bond.peer).not.toBe(joinerId);

    // The initiator's allowlist now trusts the attacker instead of the joiner.
    expect(initiatorAllowlist.get(initiatorId)).toContain(attackerId);
    expect(initiatorAllowlist.get(initiatorId)).not.toContain(joinerId);

    // NOTE: after the fix (bind agent_id into the confirmation), this test
    // must be updated to expect `initResult.status === "pake_failed"` and an
    // empty initiator allowlist.
  }, 20000);

  // Marked `it.fails`: the SECURE assertion below does NOT hold today, so the
  // test body throws and `it.fails` reports GREEN. Once agent_id is bound into
  // the SPAKE2 confirmation, the assertion will hold, the body will stop
  // throwing, and `it.fails` will turn RED — a signal to delete `.fails`.
  it.fails(
    "SECURITY REQUIREMENT (fails until TD-1 is fixed): initiator MUST reject a substituted peer identity",
    async () => {
      const { initResult } = await runTamperedPairing();

      // The desired post-fix behavior: identity swap ⇒ handshake aborts, no bond.
      expect(initResult.status).toBe("pake_failed");
      expect(initiatorAllowlist.get(initiatorId)).toEqual([]);
    },
    20000,
  );
});
