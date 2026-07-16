import { isProfileInBond } from "../profile/envelope-profile.js";
import type { SessionRecord } from "./types.js";

const ATEST_PROFILE = "atest/1";

function bothChallengesFiled(session: SessionRecord): boolean {
  return Boolean(session.challenges.initiator && session.challenges.recipient);
}

export function gateActive(session: SessionRecord, bondProfiles: readonly string[]): boolean {
  return (
    bondProfiles.includes(ATEST_PROFILE) &&
    session.acceptance.some((criterion) => criterion.test === "executable")
  );
}

export function runnersRequired(session: SessionRecord): Set<string> {
  const runners = new Set<string>();
  for (const criterion of session.acceptance) {
    if (criterion.test === "executable" && criterion.runner) {
      runners.add(criterion.runner);
    }
  }
  return runners;
}

export function signCeremonyComplete(
  session: SessionRecord,
  bondProfiles: readonly string[],
  hash: string,
): boolean {
  if (!gateActive(session, bondProfiles)) {
    return true;
  }

  if (!bothChallengesFiled(session)) {
    return false;
  }

  const hashReports = session.testReports[hash];
  for (const runner of runnersRequired(session)) {
    const runnerReports = hashReports?.[runner];
    if (!runnerReports?.initiator?.passed || !runnerReports?.recipient?.passed) {
      return false;
    }
  }

  return true;
}

export function testsLegal(session: SessionRecord, bondProfiles: readonly string[]): boolean {
  if (!gateActive(session, bondProfiles)) {
    return true;
  }

  if (session.artifactHash === undefined) {
    return false;
  }

  return signCeremonyComplete(session, bondProfiles, session.artifactHash);
}

export function assertAtestEnvelopeAllowed(
  type: string,
  bondProfiles: readonly string[],
): { ok: true } | { ok: false; error: "profile_not_supported" } {
  if (isProfileInBond(type, bondProfiles)) {
    return { ok: true };
  }
  return { ok: false, error: "profile_not_supported" };
}

function hasExecutableAcceptance(session: SessionRecord): boolean {
  return session.acceptance.some((criterion) => criterion.test === "executable");
}

export function buildExecutableWarnings(
  session: SessionRecord,
  bondProfiles: readonly string[],
): string[] {
  if (!hasExecutableAcceptance(session) || bondProfiles.includes(ATEST_PROFILE)) {
    return [];
  }
  return [
    "Machine verification unavailable: bond does not advertise atest/1 but session includes executable acceptance criteria.",
  ];
}
