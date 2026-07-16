import { allowlistBlobProbe } from "./suite/fast/allowlist-blob.js";
import { challengeRoundtripProbe } from "./suite/fast/challenge-roundtrip.js";
import { defaultDenyProbe } from "./suite/fast/default-deny.js";
import { hashVerifyProbe } from "./suite/fast/hash-verify.js";
import { inboxIdempotencyProbe } from "./suite/fast/inbox-idempotency.js";
import { inboxPullShapeProbe } from "./suite/fast/inbox-pull-shape.js";
import { purgeDyadProbe } from "./suite/fast/purge-dyad.js";
import { pullInbox } from "./suite/helpers/pull-inbox.js";
import { getGapSeedContext } from "./suite/helpers/seed-inbox-gap.js";
import { artifact10mbProbe } from "./suite/large/artifact-10mb.js";
import { pairTtlProbe } from "./suite/slow/pair-ttl.js";
import type { Probe, SuiteOptions, SuiteResult } from "./suite/types.js";

export type { SuiteOptions, SuiteResult } from "./suite/types.js";

const fastProbes: Probe[] = [
  defaultDenyProbe,
  challengeRoundtripProbe,
  allowlistBlobProbe,
  inboxIdempotencyProbe,
  hashVerifyProbe,
  purgeDyadProbe,
  inboxPullShapeProbe,
];

const slowProbes: Probe[] = [pairTtlProbe];
const largeProbes: Probe[] = [artifact10mbProbe];

async function runProbe(probe: Probe, baseUrl: string, result: SuiteResult): Promise<void> {
  try {
    await probe.run(baseUrl);
    result.passed.push({ id: probe.id });
  } catch (error) {
    result.failed.push({
      id: probe.id,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

async function checkGapsStrippedAdvisory(baseUrl: string): Promise<string | null> {
  const ctx = getGapSeedContext();
  if (!ctx) {
    return null;
  }

  const pullRes = await pullInbox(baseUrl, ctx.recipientId, ctx.recipient, 0);
  if (pullRes.status !== 200) {
    return null;
  }

  const body = (await pullRes.json()) as Record<string, unknown>;
  if (body.gaps === undefined) {
    return "inbox pull omitted gaps field despite known sequence gap (reference implementation includes gaps)";
  }
  return null;
}

export async function runConformanceSuite(
  baseUrl: string,
  options: SuiteOptions = {},
): Promise<SuiteResult> {
  if (options.advisoryProbe === "gaps-stripped") {
    const result: SuiteResult = {
      exitCode: 0,
      passed: [],
      failed: [],
      skipped: [],
      advisories: [],
    };
    const message = await checkGapsStrippedAdvisory(baseUrl);
    if (message) {
      result.advisories.push({ code: "reference-divergent", message });
    }
    return result;
  }

  const slow = options.slow ?? false;
  const large = options.large ?? false;

  const result: SuiteResult = {
    exitCode: 0,
    passed: [],
    failed: [],
    skipped: [],
    advisories: [],
  };

  for (const probe of fastProbes) {
    await runProbe(probe, baseUrl, result);
  }

  for (const probe of slowProbes) {
    if (!slow) {
      result.skipped.push({ id: probe.id });
      continue;
    }
    await runProbe(probe, baseUrl, result);
  }

  for (const probe of largeProbes) {
    if (!large) {
      result.skipped.push({ id: probe.id });
      continue;
    }
    await runProbe(probe, baseUrl, result);
  }

  result.exitCode = result.failed.length > 0 ? 1 : 0;
  return result;
}
