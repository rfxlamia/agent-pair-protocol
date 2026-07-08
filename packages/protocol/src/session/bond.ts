import type { Bond } from "../pairing/flow.js";

export function isEphemeralBond(bond: Bond | undefined): boolean {
  return bond?.mode === "ephemeral_until_session_closes";
}
