import { describe, expect, it } from "vitest";
import {
  ENVELOPE_TYPES,
  isKnownEnvelopeType,
  isSessionDispatchType,
  parseEnvelopePayload,
} from "./schema.js";

describe("isKnownEnvelopeType", () => {
  it("accepts all 15 whitelist types", () => {
    const all = [...ENVELOPE_TYPES.CORE, ...ENVELOPE_TYPES.NEGO, ...ENVELOPE_TYPES.ATEST];
    expect(all).toHaveLength(15);
    for (const type of all) {
      expect(isKnownEnvelopeType(type)).toBe(true);
    }
  });

  it("rejects v0 and unknown types", () => {
    expect(isKnownEnvelopeType("chat.message")).toBe(false);
    expect(isKnownEnvelopeType("session.open")).toBe(false);
    expect(isKnownEnvelopeType("nego.unknown")).toBe(false);
    expect(isKnownEnvelopeType("")).toBe(false);
  });
});

describe("isSessionDispatchType", () => {
  it("matches nego.* and atest challenge/report", () => {
    expect(isSessionDispatchType("nego.turn")).toBe(true);
    expect(isSessionDispatchType("atest.challenge")).toBe(true);
    expect(isSessionDispatchType("atest.report")).toBe(true);
    expect(isSessionDispatchType("core.msg")).toBe(false);
  });
});

describe("parseEnvelopePayload", () => {
  it("validates core.msg", () => {
    const ok = parseEnvelopePayload("core.msg", { body: "hi", kind: "text" });
    expect(ok).toEqual({ ok: true, data: { body: "hi", kind: "text" } });
  });

  it("rejects core.msg missing body", () => {
    expect(parseEnvelopePayload("core.msg", {})).toEqual({
      ok: false,
      error: "invalid_payload",
    });
  });

  it("validates core.close and core.ack", () => {
    expect(parseEnvelopePayload("core.close", { reason: "done" })).toEqual({
      ok: true,
      data: { reason: "done" },
    });
    expect(parseEnvelopePayload("core.ack", { ack_seq: 3 })).toEqual({
      ok: true,
      data: { ack_seq: 3 },
    });
  });

  it("validates nego.open", () => {
    const payload = {
      goal: "g",
      acceptance: [{ id: "a1", test: "judgment", desc: "d" }],
      budget: { max_turns: 5, deadline: "2030-01-01T00:00:00.000Z" },
      mandate: { agent_may: ["x"], human_required: ["y"] },
    };
    expect(parseEnvelopePayload("nego.open", payload).ok).toBe(true);
  });

  it("rejects nego.open without budget.deadline", () => {
    const payload = {
      goal: "g",
      acceptance: [{ id: "a1", test: "judgment", desc: "d" }],
      budget: { max_turns: 5 },
      mandate: { agent_may: ["x"], human_required: ["y"] },
    };
    expect(parseEnvelopePayload("nego.open", payload)).toEqual({
      ok: false,
      error: "invalid_payload",
    });
  });

  it("rejects nego.open deadline with offset", () => {
    const payload = {
      goal: "g",
      acceptance: [{ id: "a1", test: "judgment", desc: "d" }],
      budget: { max_turns: 5, deadline: "2030-01-01T00:00:00+00:00" },
      mandate: { agent_may: ["x"], human_required: ["y"] },
    };
    expect(parseEnvelopePayload("nego.open", payload)).toEqual({
      ok: false,
      error: "invalid_payload",
    });
  });

  it("rejects nego.open with invalid datetime string", () => {
    const payload = {
      goal: "g",
      acceptance: [{ id: "a1", test: "judgment", desc: "d" }],
      budget: { max_turns: 5, deadline: "not-a-date" },
      mandate: { agent_may: ["x"], human_required: ["y"] },
    };
    expect(parseEnvelopePayload("nego.open", payload)).toEqual({
      ok: false,
      error: "invalid_payload",
    });
  });

  it("rejects nego.open with lowercase z suffix", () => {
    const payload = {
      goal: "g",
      acceptance: [{ id: "a1", test: "judgment", desc: "d" }],
      budget: { max_turns: 5, deadline: "2030-01-01T00:00:00.000z" },
      mandate: { agent_may: ["x"], human_required: ["y"] },
    };
    expect(parseEnvelopePayload("nego.open", payload)).toEqual({
      ok: false,
      error: "invalid_payload",
    });
  });

  it("accepts nego.open with Z-suffix deadline", () => {
    const payload = {
      goal: "g",
      acceptance: [{ id: "a1", test: "judgment", desc: "d" }],
      budget: { max_turns: 5, deadline: "2030-01-01T00:00:00.000Z" },
      mandate: { agent_may: ["x"], human_required: ["y"] },
    };
    expect(parseEnvelopePayload("nego.open", payload)).toEqual({
      ok: true,
      data: payload,
    });
  });

  it("returns unsupported_envelope_type for unknown type", () => {
    expect(parseEnvelopePayload("chat.message", { body: "x" })).toEqual({
      ok: false,
      error: "unsupported_envelope_type",
    });
  });

  it("accepts all 15 whitelist types with minimal valid payloads", () => {
    const budgetBase = {
      thread: "thread-1",
      proposal_id: "550e8400-e29b-41d4-a716-446655440000",
      new_max_turns: 30,
    };
    const minimal: Record<string, unknown> = {
      "core.msg": { body: "hi" },
      "core.close": {},
      "core.ack": { ack_seq: 1 },
      "nego.open": {
        goal: "g",
        acceptance: [{ id: "a1", test: "judgment", desc: "d" }],
        budget: { max_turns: 5, deadline: "2030-01-01T00:00:00.000Z" },
        mandate: { agent_may: ["x"], human_required: ["y"] },
      },
      "nego.open_approved": {},
      "nego.open_reject": {},
      "nego.open_expired": {},
      "nego.turn": {},
      "nego.signed": { artifact_hash: "sha256:abc" },
      "nego.ratified": {},
      "nego.budget_propose": budgetBase,
      "nego.budget_approved": budgetBase,
      "nego.budget_reject": budgetBase,
      "atest.challenge": {},
      "atest.report": {
        artifact_hash: "sha256:abc",
        passed: true,
        runner: "payload-size",
      },
    };
    const all = [...ENVELOPE_TYPES.CORE, ...ENVELOPE_TYPES.NEGO, ...ENVELOPE_TYPES.ATEST];
    for (const type of all) {
      expect(parseEnvelopePayload(type, minimal[type])).toEqual({
        ok: true,
        data: minimal[type],
      });
    }
  });

  it("validates signal envelopes and strips unknown keys", () => {
    for (const type of [
      "nego.open_approved",
      "nego.open_expired",
      "nego.ratified",
      "atest.challenge",
    ] as const) {
      expect(parseEnvelopePayload(type, {})).toEqual({ ok: true, data: {} });
      expect(parseEnvelopePayload(type, { extra: 1 })).toEqual({
        ok: true,
        data: {},
      });
    }
  });
});

describe("N4 budget extend envelope payloads", () => {
  const validBase = {
    thread: "thread-1",
    proposal_id: "550e8400-e29b-41d4-a716-446655440000",
    new_max_turns: 30,
  };

  it("validates nego.budget_propose", () => {
    expect(parseEnvelopePayload("nego.budget_propose", validBase)).toEqual({
      ok: true,
      data: validBase,
    });
  });

  it("validates nego.budget_approved", () => {
    expect(parseEnvelopePayload("nego.budget_approved", validBase)).toEqual({
      ok: true,
      data: validBase,
    });
  });

  it("validates nego.budget_reject with optional reason", () => {
    expect(
      parseEnvelopePayload("nego.budget_reject", { ...validBase, reason: "superseded" }),
    ).toEqual({
      ok: true,
      data: { ...validBase, reason: "superseded" },
    });
    expect(parseEnvelopePayload("nego.budget_reject", validBase)).toEqual({
      ok: true,
      data: validBase,
    });
  });

  it("rejects budget payloads with invalid proposal_id", () => {
    for (const type of [
      "nego.budget_propose",
      "nego.budget_approved",
      "nego.budget_reject",
    ] as const) {
      expect(parseEnvelopePayload(type, { ...validBase, proposal_id: "not-a-uuid" })).toEqual({
        ok: false,
        error: "invalid_payload",
      });
    }
  });

  it("rejects budget payloads with non-integer new_max_turns", () => {
    expect(
      parseEnvelopePayload("nego.budget_propose", { ...validBase, new_max_turns: 30.5 }),
    ).toEqual({
      ok: false,
      error: "invalid_payload",
    });
  });

  it("rejects budget payloads missing thread", () => {
    const { thread: _, ...rest } = validBase;
    expect(parseEnvelopePayload("nego.budget_propose", rest)).toEqual({
      ok: false,
      error: "invalid_payload",
    });
  });
});
