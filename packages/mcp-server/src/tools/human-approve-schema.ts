import { z } from "zod";
import { optionalProfilesField } from "./profiles-schema.js";

export const humanApproveInputSchema = z.object({
  pending_id: z.string(),
  decision: z.string().describe('Use "approve" or "reject:<reason>"'),
  approval_code: z
    .string()
    .optional()
    .describe("Out-of-band approval code from the human operator"),
  profiles: optionalProfilesField,
});

export type HumanApproveInput = z.infer<typeof humanApproveInputSchema>;
