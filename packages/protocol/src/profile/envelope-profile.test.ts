import { describe, expect, it } from "vitest";
import { ENVELOPE_TYPES } from "../envelope/schema.js";
import { isProfileInBond, profileForEnvelopeType } from "./envelope-profile.js";

describe("profileForEnvelopeType", () => {
  it("maps core types to core/1", () => {
    for (const type of ENVELOPE_TYPES.CORE) {
      expect(profileForEnvelopeType(type)).toBe("core/1");
    }
  });

  it("maps nego types to nego/1", () => {
    for (const type of ENVELOPE_TYPES.NEGO) {
      expect(profileForEnvelopeType(type)).toBe("nego/1");
    }
  });

  it("maps atest types to atest/1", () => {
    for (const type of ENVELOPE_TYPES.ATEST) {
      expect(profileForEnvelopeType(type)).toBe("atest/1");
    }
  });

  it("returns undefined for unknown types", () => {
    expect(profileForEnvelopeType("unknown.type")).toBeUndefined();
    expect(profileForEnvelopeType("revoke.notice")).toBeUndefined();
    expect(profileForEnvelopeType("")).toBeUndefined();
  });
});

describe("isProfileInBond", () => {
  it("returns true when bond includes the envelope profile", () => {
    expect(isProfileInBond("core.msg", ["core/1", "nego/1"])).toBe(true);
    expect(isProfileInBond("nego.turn", ["nego/1"])).toBe(true);
    expect(isProfileInBond("atest.challenge", ["atest/1"])).toBe(true);
  });

  it("returns false when bond excludes the envelope profile", () => {
    expect(isProfileInBond("core.msg", ["nego/1"])).toBe(false);
    expect(isProfileInBond("atest.report", ["core/1", "nego/1"])).toBe(false);
  });

  it("returns false for unknown envelope types", () => {
    expect(isProfileInBond("unknown.type", ["core/1"])).toBe(false);
  });
});
