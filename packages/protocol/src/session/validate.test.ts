import { describe, expect, it } from "vitest";
import {
  parseOpenEnvelopePayload,
  parsePeerSignedEnvelopePayload,
  parsePeerTestReportEnvelopePayload,
  parsePeerTurnEnvelopePayload,
  parseSignalEnvelopePayload,
} from "./validate.js";

const validOpenPayload = {
  goal: "Agree telemetry API contract v1",
  acceptance: [
    {
      id: "A1",
      test: "executable" as const,
      desc: "payload <= 4096 bytes",
      runner: "payload-size",
    },
  ],
  budget: { max_turns: 30 },
  mandate: {
    agent_may: ["propose", "counter", "accept_section", "challenge"],
    human_required: ["sign_final", "budget_extend", "constraint_change"],
  },
};

describe("parseOpenEnvelopePayload", () => {
  it("accepts valid session.open payloads", () => {
    const result = parseOpenEnvelopePayload(validOpenPayload);
    expect(result).toEqual({ ok: true, data: validOpenPayload });
  });

  it("rejects payloads missing required fields", () => {
    const result = parseOpenEnvelopePayload({ goal: "only goal, no budget" });
    expect(result).toEqual({ ok: false, error: "invalid_payload" });
  });

  it("strips unknown keys from valid payloads", () => {
    const result = parseOpenEnvelopePayload({
      ...validOpenPayload,
      relay_meta: { hop: 1 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data).toEqual(validOpenPayload);
    expect("relay_meta" in result.data).toBe(false);
  });
});

describe("parsePeerTestReportEnvelopePayload", () => {
  it("rejects non-boolean passed values", () => {
    const result = parsePeerTestReportEnvelopePayload({
      artifact_hash: "sha256:malformed-test-report",
      passed: "yes",
      runner: "payload-size",
    });
    expect(result).toEqual({ ok: false, error: "invalid_payload" });
  });
});

describe("parsePeerTurnEnvelopePayload", () => {
  it("rejects non-numeric turn_count values", () => {
    const result = parsePeerTurnEnvelopePayload({
      turn_count: "1",
      msg_type: "propose",
      body: JSON.stringify({ diff: "bad" }),
    });
    expect(result).toEqual({ ok: false, error: "invalid_payload" });
  });
});

describe("parsePeerSignedEnvelopePayload", () => {
  it("rejects payloads missing artifact_hash", () => {
    const result = parsePeerSignedEnvelopePayload({});
    expect(result).toEqual({ ok: false, error: "invalid_payload" });
  });
});

describe("parseSignalEnvelopePayload", () => {
  it("accepts empty object payloads", () => {
    const result = parseSignalEnvelopePayload({});
    expect(result).toEqual({ ok: true, data: {} });
  });

  it("strips unknown keys from signal payloads", () => {
    const result = parseSignalEnvelopePayload({ extra: 1 });
    expect(result).toEqual({ ok: true, data: {} });
  });
});
