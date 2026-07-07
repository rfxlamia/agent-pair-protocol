import { describe, expect, it, beforeAll } from "vitest";
import { bytesToHex } from "@noble/hashes/utils.js";
import { finish, init, respond, start } from "./pake-adapter.js";

describe("pake-spike", () => {
  beforeAll(async () => {
    await init();
  });

  it("derives matching shared keys when both parties use the same pairing code", () => {
    const pairingCode = "7K3M9P";
    const sessionId = "550e8400-e29b-41d4-a716-446655440000";

    const initiator = start("initiator", pairingCode, sessionId);
    const joiner = respond(pairingCode, sessionId, initiator.message);

    const initiatorKey = finish(initiator.session, joiner.message);
    const joinerKey = finish(joiner.session, initiator.message);

    expect(initiatorKey.length).toBeGreaterThan(0);
    expect(bytesToHex(initiatorKey)).toBe(bytesToHex(joinerKey));
  });

  it("produces different keys when pairing codes do not match", () => {
    const sessionId = "550e8400-e29b-41d4-a716-446655440001";

    const initiator = start("initiator", "ABC123", sessionId);
    const joiner = respond("XYZ789", sessionId, initiator.message);

    const initiatorKey = finish(initiator.session, joiner.message);
    const joinerKey = finish(joiner.session, initiator.message);

    expect(bytesToHex(initiatorKey)).not.toBe(bytesToHex(joinerKey));
  });
});
