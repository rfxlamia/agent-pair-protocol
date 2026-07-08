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
const signalEnvelopePayloadSchema = z.object({});

const openEnvelopePayloadSchema = z.object({
  goal: z.string(),
  acceptance: z.array(acceptanceCriterionSchema),
  budget: sessionBudgetSchema,
  mandate: sessionMandateSchema,
  expires_at: z.number().optional(),
});

const openRejectEnvelopePayloadSchema = z.object({
  reason: z.string().optional(),
});

const peerTestReportEnvelopePayloadSchema = z.object({
  artifact_hash: z.string(),
  passed: z.boolean(),
  runner: z.string(),
  details: z.string().optional(),
});

const peerSignedEnvelopePayloadSchema = z.object({
  artifact_hash: z.string(),
});

const peerTurnEnvelopePayloadSchema = z.object({
  turn_count: z.number().optional(),
  msg_type: z.string().optional(),
  body: z.string().optional(),
});

type ParseResult<T> = { ok: true; data: T } | { ok: false; error: "invalid_payload" };

function parseEnvelopePayload<T extends z.ZodTypeAny>(
  schema: T,
  parsed: Record<string, unknown>,
): ParseResult<z.infer<T>> {
  const result = schema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: "invalid_payload" };
  }
  return { ok: true, data: result.data };
}

export function parseSignalEnvelopePayload(
  parsed: Record<string, unknown>,
): ParseResult<z.infer<typeof signalEnvelopePayloadSchema>> {
  return parseEnvelopePayload(signalEnvelopePayloadSchema, parsed);
}

export function parseOpenEnvelopePayload(
  parsed: Record<string, unknown>,
): ParseResult<z.infer<typeof openEnvelopePayloadSchema>> {
  return parseEnvelopePayload(openEnvelopePayloadSchema, parsed);
}

export function parseOpenRejectEnvelopePayload(
  parsed: Record<string, unknown>,
): ParseResult<z.infer<typeof openRejectEnvelopePayloadSchema>> {
  return parseEnvelopePayload(openRejectEnvelopePayloadSchema, parsed);
}

export function parsePeerTestReportEnvelopePayload(
  parsed: Record<string, unknown>,
): ParseResult<z.infer<typeof peerTestReportEnvelopePayloadSchema>> {
  return parseEnvelopePayload(peerTestReportEnvelopePayloadSchema, parsed);
}

export function parsePeerSignedEnvelopePayload(
  parsed: Record<string, unknown>,
): ParseResult<z.infer<typeof peerSignedEnvelopePayloadSchema>> {
  return parseEnvelopePayload(peerSignedEnvelopePayloadSchema, parsed);
}

export function parsePeerTurnEnvelopePayload(
  parsed: Record<string, unknown>,
): ParseResult<z.infer<typeof peerTurnEnvelopePayloadSchema>> {
  return parseEnvelopePayload(peerTurnEnvelopePayloadSchema, parsed);
}
