import { describe, expect, it } from "vitest";
import type { Bond } from "../pairing/flow.js";
import { isEphemeralBond } from "./bond.js";

describe("isEphemeralBond", () => {
  it("returns true for ephemeral_until_session_closes", () => {
    const bond: Bond = {
      peer: "peer-id",
      scope: ["session.negotiate"],
      mode: "ephemeral_until_session_closes",
    };
    expect(isEphemeralBond(bond)).toBe(true);
  });

  it("returns false for bonded_contact", () => {
    const bond: Bond = {
      peer: "peer-id",
      scope: ["session.negotiate"],
      mode: "bonded_contact",
    };
    expect(isEphemeralBond(bond)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isEphemeralBond(undefined)).toBe(false);
  });
});
