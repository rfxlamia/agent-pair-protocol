import { ENVELOPE_TYPES } from "../envelope/schema.js";

const CORE_PROFILE = "core/1";
const NEGO_PROFILE = "nego/1";
const ATEST_PROFILE = "atest/1";

function entriesForTypes(types: readonly string[], profile: string): [string, string][] {
  return types.map((type) => [type, profile]);
}

const ENVELOPE_TYPE_TO_PROFILE = new Map<string, string>([
  ...entriesForTypes(ENVELOPE_TYPES.CORE, CORE_PROFILE),
  ...entriesForTypes(ENVELOPE_TYPES.NEGO, NEGO_PROFILE),
  ...entriesForTypes(ENVELOPE_TYPES.ATEST, ATEST_PROFILE),
]);

export function profileForEnvelopeType(type: string): string | undefined {
  return ENVELOPE_TYPE_TO_PROFILE.get(type);
}

export function isProfileInBond(type: string, bondProfiles: readonly string[]): boolean {
  const profile = profileForEnvelopeType(type);
  if (profile === undefined) {
    return false;
  }
  return bondProfiles.includes(profile);
}
