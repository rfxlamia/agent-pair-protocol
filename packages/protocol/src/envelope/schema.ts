import { z } from "zod";

const acceptanceCriterionSchema = z.object({
  id: z.string(),
  test: z.enum(["executable", "judgment"]),
  desc: z.string(),
  runner: z.string().optional(),
});

const negoBudgetSchema = z.object({
  max_turns: z.number(),
  deadline: z.string().optional(),
});

const negoMandateSchema = z.object({
  agent_may: z.array(z.string()),
  human_required: z.array(z.string()),
  escalate_on: z.array(z.string()).optional(),
});

const signalSchema = z.object({});

export const ENVELOPE_TYPES = {
  CORE: ["core.msg", "core.close", "core.ack"] as const,
  NEGO: [
    "nego.open",
    "nego.open_approved",
    "nego.open_reject",
    "nego.open_expired",
    "nego.turn",
    "nego.signed",
    "nego.ratified",
  ] as const,
  ATEST: ["atest.challenge", "atest.report"] as const,
} as const;

const KNOWN_TYPES = new Set<string>([
  ...ENVELOPE_TYPES.CORE,
  ...ENVELOPE_TYPES.NEGO,
  ...ENVELOPE_TYPES.ATEST,
]);

const PAYLOAD_SCHEMAS: Record<string, z.ZodTypeAny> = {
  "core.msg": z.object({
    body: z.string(),
    kind: z.string().optional(),
  }),
  "core.close": z.object({
    reason: z.string().optional(),
  }),
  "core.ack": z.object({
    ack_seq: z.number(),
  }),
  "nego.open": z.object({
    goal: z.string(),
    acceptance: z.array(acceptanceCriterionSchema),
    budget: negoBudgetSchema,
    mandate: negoMandateSchema,
    expires_at: z.number().optional(),
  }),
  "nego.open_approved": signalSchema,
  "nego.open_reject": z.object({ reason: z.string().optional() }),
  "nego.open_expired": signalSchema,
  "nego.turn": z.object({
    turn_count: z.number().optional(),
    msg_type: z.string().optional(),
    body: z.string().optional(),
  }),
  "nego.signed": z.object({ artifact_hash: z.string() }),
  "nego.ratified": signalSchema,
  "atest.challenge": signalSchema,
  "atest.report": z.object({
    artifact_hash: z.string(),
    passed: z.boolean(),
    runner: z.string(),
    details: z.string().optional(),
  }),
};

export type ParseEnvelopePayloadResult =
  | { ok: true; data: unknown }
  | { ok: false; error: "unsupported_envelope_type" | "invalid_payload" };

export function isKnownEnvelopeType(type: string): boolean {
  return KNOWN_TYPES.has(type);
}

export function isSessionDispatchType(type: string): boolean {
  return type.startsWith("nego.") || type === "atest.challenge" || type === "atest.report";
}

export function parseEnvelopePayload(type: string, parsed: unknown): ParseEnvelopePayloadResult {
  const schema = PAYLOAD_SCHEMAS[type];
  if (!schema) {
    return { ok: false, error: "unsupported_envelope_type" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "invalid_payload" };
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: "invalid_payload" };
  }
  return { ok: true, data: result.data };
}

// Named parsers for state-machine (typed convenience)
export function parseNegoOpenPayload(parsed: Record<string, unknown>) {
  return parseEnvelopePayload("nego.open", parsed) as
    | { ok: true; data: z.infer<(typeof PAYLOAD_SCHEMAS)["nego.open"]> }
    | { ok: false; error: "invalid_payload" };
}

export function parseNegoOpenRejectPayload(parsed: Record<string, unknown>) {
  return parseEnvelopePayload("nego.open_reject", parsed);
}

export function parseNegoTurnPayload(parsed: Record<string, unknown>) {
  return parseEnvelopePayload("nego.turn", parsed);
}

export function parseNegoSignedPayload(parsed: Record<string, unknown>) {
  return parseEnvelopePayload("nego.signed", parsed);
}

export function parseAtestReportPayload(parsed: Record<string, unknown>) {
  return parseEnvelopePayload("atest.report", parsed);
}
