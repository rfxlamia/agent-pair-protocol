import { describe, expect, it } from "vitest";
import { REFERENCE_PROFILES } from "../profile/reference.js";
import {
  assertAtestEnvelopeAllowed,
  gateActive,
  runnersRequired,
  signCeremonyComplete,
  testsLegal,
} from "./atest-gate.js";
import { createEmptyTestReports, setRunnerReport } from "./test-reports.js";
import type { SessionRecord } from "./types.js";

const NEGO_ONLY = [...REFERENCE_PROFILES];
const ATEST_CAPABLE = [...REFERENCE_PROFILES, "atest/1"];

const baseSession = (
  acceptance: SessionRecord["acceptance"],
  overrides: Partial<SessionRecord> = {},
): SessionRecord =>
  ({
    acceptance,
    challenges: { initiator: true, recipient: true },
    testReports: createEmptyTestReports(),
    artifactHash: undefined,
    ...overrides,
  }) as SessionRecord;

describe("atest-gate", () => {
  it("gateActive is false when bond lacks atest/1", () => {
    const session = baseSession([
      { id: "A1", test: "executable", desc: "payload <= 4096", runner: "payload-size" },
    ]);
    expect(gateActive(session, NEGO_ONLY)).toBe(false);
  });

  it("gateActive is false when acceptance is all-judgment even with atest/1", () => {
    const session = baseSession([{ id: "J1", test: "judgment", desc: "human review" }]);
    expect(gateActive(session, ATEST_CAPABLE)).toBe(false);
  });

  it("gateActive is true when atest/1 and executable criterion", () => {
    const session = baseSession([
      { id: "A1", test: "executable", desc: "payload <= 4096", runner: "payload-size" },
    ]);
    expect(gateActive(session, ATEST_CAPABLE)).toBe(true);
  });

  it("gateActive is true with mixed judgment + executable when atest/1 present", () => {
    const session = baseSession([
      { id: "J1", test: "judgment", desc: "human review" },
      { id: "A1", test: "executable", desc: "size check", runner: "payload-size" },
    ]);
    expect(gateActive(session, ATEST_CAPABLE)).toBe(true);
  });

  it("runnersRequired dedupes two criteria sharing the same runner", () => {
    const session = baseSession([
      { id: "A1", test: "executable", desc: "first", runner: "payload-size" },
      { id: "A2", test: "executable", desc: "second", runner: "payload-size" },
      { id: "A3", test: "executable", desc: "third", runner: "spectral" },
    ]);
    expect([...runnersRequired(session)].sort()).toEqual(["payload-size", "spectral"]);
  });

  it("runnersRequired ignores judgment criteria", () => {
    const session = baseSession([
      { id: "J1", test: "judgment", desc: "human" },
      { id: "A1", test: "executable", desc: "size", runner: "payload-size" },
    ]);
    expect([...runnersRequired(session)]).toEqual(["payload-size"]);
  });

  it("signCeremonyComplete is true when gate inactive regardless of ceremony state", () => {
    const hash = "sha256:nego-only-hash";
    const session = baseSession(
      [{ id: "A1", test: "executable", desc: "x", runner: "payload-size" }],
      { challenges: {}, testReports: createEmptyTestReports() },
    );
    expect(signCeremonyComplete(session, NEGO_ONLY, hash)).toBe(true);
  });

  it("signCeremonyComplete requires per-runner dual green reports when gate active", () => {
    const hash = "sha256:ceremony-hash";
    let reports = createEmptyTestReports();
    reports = setRunnerReport(reports, hash, "payload-size", "initiator", {
      artifact_hash: hash,
      passed: true,
      runner: "payload-size",
    });
    reports = setRunnerReport(reports, hash, "payload-size", "recipient", {
      artifact_hash: hash,
      passed: true,
      runner: "payload-size",
    });

    const session = baseSession(
      [{ id: "A1", test: "executable", desc: "x", runner: "payload-size" }],
      { testReports: reports, challenges: { initiator: true, recipient: true } },
    );
    expect(signCeremonyComplete(session, ATEST_CAPABLE, hash)).toBe(true);
  });

  it("signCeremonyComplete is false when a required runner lacks dual green reports", () => {
    const hash = "sha256:partial-hash";
    let reports = createEmptyTestReports();
    reports = setRunnerReport(reports, hash, "payload-size", "initiator", {
      artifact_hash: hash,
      passed: true,
      runner: "payload-size",
    });
    reports = setRunnerReport(reports, hash, "spectral", "initiator", {
      artifact_hash: hash,
      passed: true,
      runner: "spectral",
    });
    reports = setRunnerReport(reports, hash, "spectral", "recipient", {
      artifact_hash: hash,
      passed: true,
      runner: "spectral",
    });

    const session = baseSession(
      [
        { id: "A1", test: "executable", desc: "a", runner: "payload-size" },
        { id: "A2", test: "executable", desc: "b", runner: "spectral" },
      ],
      { testReports: reports, challenges: { initiator: true, recipient: true } },
    );
    expect(signCeremonyComplete(session, ATEST_CAPABLE, hash)).toBe(false);
  });

  it("signCeremonyComplete is false when challenges incomplete under active gate", () => {
    const hash = "sha256:no-challenges";
    const session = baseSession(
      [{ id: "A1", test: "executable", desc: "x", runner: "payload-size" }],
      { challenges: { initiator: true }, testReports: createEmptyTestReports() },
    );
    expect(signCeremonyComplete(session, ATEST_CAPABLE, hash)).toBe(false);
  });

  it("testsLegal is true when gate inactive", () => {
    const session = baseSession([
      { id: "A1", test: "executable", desc: "x", runner: "payload-size" },
    ]);
    expect(testsLegal(session, NEGO_ONLY)).toBe(true);
  });

  it("testsLegal is false when gate active and artifactHash undefined", () => {
    const session = baseSession(
      [{ id: "A1", test: "executable", desc: "x", runner: "payload-size" }],
      {
        challenges: { initiator: true, recipient: true },
        artifactHash: undefined,
      },
    );
    expect(testsLegal(session, ATEST_CAPABLE)).toBe(false);
  });

  it("testsLegal is true when gate active, artifactHash set, and ceremony complete", () => {
    const hash = "sha256:legal-hash";
    let reports = createEmptyTestReports();
    reports = setRunnerReport(reports, hash, "payload-size", "initiator", {
      artifact_hash: hash,
      passed: true,
      runner: "payload-size",
    });
    reports = setRunnerReport(reports, hash, "payload-size", "recipient", {
      artifact_hash: hash,
      passed: true,
      runner: "payload-size",
    });
    const session = baseSession(
      [{ id: "A1", test: "executable", desc: "x", runner: "payload-size" }],
      {
        artifactHash: hash,
        challenges: { initiator: true, recipient: true },
        testReports: reports,
      },
    );
    expect(testsLegal(session, ATEST_CAPABLE)).toBe(true);
  });

  it("assertAtestEnvelopeAllowed returns profile_not_supported for nego-only bond", () => {
    expect(assertAtestEnvelopeAllowed("atest.challenge", NEGO_ONLY)).toEqual({
      ok: false,
      error: "profile_not_supported",
    });
    expect(assertAtestEnvelopeAllowed("atest.report", NEGO_ONLY)).toEqual({
      ok: false,
      error: "profile_not_supported",
    });
  });

  it("assertAtestEnvelopeAllowed allows atest envelopes when atest/1 advertised", () => {
    expect(assertAtestEnvelopeAllowed("atest.challenge", ATEST_CAPABLE)).toEqual({ ok: true });
    expect(assertAtestEnvelopeAllowed("atest.report", ATEST_CAPABLE)).toEqual({ ok: true });
  });
});
