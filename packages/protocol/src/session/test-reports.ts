import type { SessionRecord, TestReport } from "./types.js";

export const DEFAULT_RUNNER_BUCKET = "default";

export type TestReports = SessionRecord["testReports"];

type RunnerBucket = { initiator?: TestReport; recipient?: TestReport };

type LegacyHashBucket = { initiator?: TestReport; recipient?: TestReport };
type HashBucket = Record<string, RunnerBucket>;

function isTestReportSide(value: unknown): value is TestReport {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const report = value as Record<string, unknown>;
  return typeof report.artifact_hash === "string" && typeof report.passed === "boolean";
}

function isRunnerBucket(value: unknown): value is RunnerBucket {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const bucket = value as Record<string, unknown>;
  for (const [key, side] of Object.entries(bucket)) {
    if (key !== "initiator" && key !== "recipient") {
      return false;
    }
    if (side !== undefined && !isTestReportSide(side)) {
      return false;
    }
  }
  return true;
}

function isLegacyHashBucket(value: unknown): value is LegacyHashBucket {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  for (const key of ["initiator", "recipient"] as const) {
    const side = (value as Record<string, unknown>)[key];
    if (side !== undefined && typeof side === "object" && side !== null && "passed" in side) {
      return true;
    }
  }
  return false;
}

export function createEmptyTestReports(): TestReports {
  return {};
}

export function setRunnerReport(
  reports: TestReports,
  hash: string,
  runner: string,
  role: "initiator" | "recipient",
  report: TestReport,
): TestReports {
  const hashBucket = reports[hash] ?? {};
  const runnerBucket = hashBucket[runner] ?? {};
  return {
    ...reports,
    [hash]: {
      ...hashBucket,
      [runner]: {
        ...runnerBucket,
        [role]: report,
      },
    },
  };
}

export function isValidTestReports(reports: unknown): reports is TestReports {
  if (typeof reports !== "object" || reports === null) {
    return false;
  }
  for (const bucket of Object.values(reports)) {
    if (isLegacyHashBucket(bucket)) {
      for (const role of ["initiator", "recipient"] as const) {
        const side = bucket[role];
        if (side !== undefined && !isTestReportSide(side)) {
          return false;
        }
      }
      continue;
    }
    if (typeof bucket !== "object" || bucket === null) {
      return false;
    }
    for (const runnerBucket of Object.values(bucket)) {
      if (!isRunnerBucket(runnerBucket)) {
        return false;
      }
    }
  }
  return true;
}

export function hasLegacyTestReports(reports: TestReports): boolean {
  return Object.values(reports).some((bucket) => isLegacyHashBucket(bucket));
}

export function normalizeLegacyTestReports(
  reports: TestReports | Record<string, LegacyHashBucket>,
): TestReports {
  const normalized: TestReports = {};

  for (const [hash, bucket] of Object.entries(reports)) {
    if (isLegacyHashBucket(bucket)) {
      const runnerBuckets: HashBucket = {};
      for (const role of ["initiator", "recipient"] as const) {
        const report = bucket[role];
        if (report === undefined) {
          continue;
        }
        const runner = report.runner || DEFAULT_RUNNER_BUCKET;
        runnerBuckets[runner] = {
          ...runnerBuckets[runner],
          [role]: report,
        };
      }
      normalized[hash] = runnerBuckets;
    } else {
      normalized[hash] = bucket as HashBucket;
    }
  }

  return normalized;
}
