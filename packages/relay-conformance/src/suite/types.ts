export type ProbeTier = "fast" | "slow" | "large";

export interface Probe {
  id: string;
  tier: ProbeTier;
  run: (baseUrl: string) => Promise<void>;
}

export interface SuiteResult {
  exitCode: number;
  passed: Array<{ id: string }>;
  failed: Array<{ id: string; reason: string }>;
  skipped: Array<{ id: string }>;
  advisories: Array<{ code: string; message: string }>;
}

export interface SuiteOptions {
  slow?: boolean;
  large?: boolean;
  advisoryProbe?: string;
}
