import { z } from "zod";
import { optionalProfilesField } from "./profiles-schema.js";

export const pairInitInputSchema = z.object({
  scope: z.array(z.string()).describe("Capability scope for the bond"),
  mode: z.enum(["ephemeral_until_session_closes", "bonded_contact"]).describe("Bond lifetime mode"),
  profiles: optionalProfilesField,
});

export const pairInitCompleteInputSchema = z.object({
  code: z.string().describe("Pairing code from pair_init"),
  profiles: optionalProfilesField,
});
