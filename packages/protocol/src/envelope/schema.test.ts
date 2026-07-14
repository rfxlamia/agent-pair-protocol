import { describe, expect, it } from "vitest";
import {
  ENVELOPE_TYPES,
  isKnownEnvelopeType,
  isSessionDispatchType,
  parseEnvelopePayload,
} from "./schema.js";

describe("isKnownEnvelopeType", () => {
  it("accepts all 12 whitelist types", () => {
    const all = [...ENVELOPE_TYPES.CORE, ...ENVELOPE_TYPES.NEGO, ...ENVELOPE_TYPES.ATEST];
    expect(all).toHaveLength(12);
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

  it("accepts all 12 whitelist types with minimal valid payloads", () => {
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
