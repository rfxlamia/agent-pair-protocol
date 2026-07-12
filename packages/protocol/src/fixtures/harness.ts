import { vi } from "vitest";
import type { KeyPair } from "../crypto/keys.js";
import type { ReceiveEnvelopeDeps } from "../crypto/receive-envelope.js";
import type { ReceiveDispatchError } from "../crypto/receive-envelope.js";
import { type FixtureKeys, keyPairFromEntry } from "./load-fixture.js";

export interface FixtureHarness {
  self: "alice" | "bob";
  nowUnix: number;
  isBonded: boolean;
  lastAcceptedSeq: number;
  /** When set, harness dispatch returns this §4.3 step-8 error instead of ok. */
  dispatchError?: ReceiveDispatchError;
}

export function resolveSelfKeyPair(
  keys: FixtureKeys,
  harness: FixtureHarness,
): { selfId: string; selfKeyPair: KeyPair } {
  const entry = keys[harness.self];
  return { selfId: entry.agentId, selfKeyPair: keyPairFromEntry(entry) };
}

export function makeReceiveDeps(
  selfKeyPair: KeyPair,
  harness: FixtureHarness,
): ReceiveEnvelopeDeps {
  // lastAcceptedSeq is global per harness — sufficient for single-thread fixtures.
  // Multi-thread vectors would need per-(thread, from) fields in harness JSON.
  return {
    isBonded: () => harness.isBonded,
    selfKeyPair,
    seqStore: {
      getLastAccepted: () => harness.lastAcceptedSeq,
      commitAccepted: vi.fn(),
    },
    dispatch: vi.fn(async () => {
      if (harness.dispatchError) {
        return { ok: false as const, error: harness.dispatchError };
      }
      return { ok: true as const };
    }),
    nowUnix: () => harness.nowUnix,
  };
}
