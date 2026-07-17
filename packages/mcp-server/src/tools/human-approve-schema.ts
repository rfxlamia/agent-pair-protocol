import { z } from "zod";

export const humanApproveInputSchema = z.object({
  pending_id: z.string(),
  decision: z.string().describe('Use "approve" or "reject:<reason>"'),
  approval_code: z
    .string()
    .optional()
    .describe("Out-of-band approval code from the human operator"),
  profiles: z.array(z.string()).optional(),
});

export type HumanApproveInput = z.infer<typeof humanApproveInputSchema>;
