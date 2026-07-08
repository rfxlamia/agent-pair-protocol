import { z } from "zod";

const acceptanceCriterionSchema = z.object({
  id: z.string(),
  test: z.enum(["executable", "judgment"]),
  desc: z.string(),
  runner: z.string().optional(),
});

const sessionBudgetSchema = z.object({
  max_turns: z.number(),
  deadline: z.string().optional(),
});

const sessionMandateSchema = z.object({
  agent_may: z.array(z.string()),
  human_required: z.array(z.string()),
  escalate_on: z.array(z.string()).optional(),
});

/** Relay may attach metadata; handlers ignore payload fields beyond validation. */
export const signalEnvelopePayloadSchema = z.object({});

export const openEnvelopePayloadSchema = z.object({
  goal: z.string(),
  acceptance: z.array(acceptanceCriterionSchema),
  budget: sessionBudgetSchema,
  mandate: sessionMandateSchema,
  expires_at: z.number().optional(),
});

export const openRejectEnvelopePayloadSchema = z.object({
  reason: z.string().optional(),
});

export const peerTestReportEnvelopePayloadSchema = z.object({
  artifact_hash: z.string(),
  passed: z.boolean(),
  runner: z.string(),
  details: z.string().optional(),
});

export const peerSignedEnvelopePayloadSchema = z.object({
  artifact_hash: z.string(),
});

export const peerTurnEnvelopePayloadSchema = z.object({
  turn_count: z.number().optional(),
  msg_type: z.string().optional(),
  body: z.string().optional(),
});

export function parseEnvelopePayload<T extends z.ZodTypeAny>(
  schema: T,
  parsed: Record<string, unknown>,
): { ok: true; data: z.infer<T> } | { ok: false; error: "invalid_payload" } {
  const result = schema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: "invalid_payload" };
  }
  return { ok: true, data: result.data };
}
