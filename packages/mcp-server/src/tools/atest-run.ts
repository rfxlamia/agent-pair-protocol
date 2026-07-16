import {
  MAX_SPILLOVER_PLAINTEXT_BYTES,
  REFERENCE_PROFILES,
  type SessionRecord,
  type TestReport,
  assertAtestEnvelopeAllowed,
  publicKeyToAgentId,
} from "@agentpair/protocol";
import { DEFAULT_MAX_PAYLOAD_BYTES } from "../runners/payload-size.js";
import { lookupRunner, runRegisteredRunner } from "../runners/registry.js";
import type { AgentContext } from "./pair.js";
import { recordSessionTestReport } from "./session.js";
import { toolTextResult } from "./util.js";

function bondProfilesFor(ctx: AgentContext, session: SessionRecord, agentId: string): string[] {
  const peer = session.initiator === agentId ? session.recipient : session.initiator;
  return [...(ctx.bonds.find(agentId, peer)?.profiles ?? REFERENCE_PROFILES)];
}

function runnerInputForArtifact(
  runner: string,
  parsed: Record<string, unknown>,
): Record<string, unknown> {
  if (runner === "payload-size") {
    return { schema: parsed, maxBytes: DEFAULT_MAX_PAYLOAD_BYTES };
  }
  return parsed;
}

export async function handleAtestRun(
  ctx: AgentContext,
  input: { thread: string; criterion_id: string; artifact_hash: string },
) {
  const session = ctx.sessionStore.get(input.thread);
  if (!session) {
    return toolTextResult({ ok: false, error: "session_not_found" });
  }

  const keyPair = await ctx.keyStore.loadOrCreate();
  const agentId = publicKeyToAgentId(keyPair.publicKey);

  const criterion = session.acceptance.find((item) => item.id === input.criterion_id);
  if (!criterion) {
    return toolTextResult({ ok: false, error: "criterion_not_found" });
  }
  if (criterion.test !== "executable" || !criterion.runner) {
    return toolTextResult({
      ok: false,
      error: "criterion is not executable or missing runner",
    });
  }

  if (!lookupRunner(criterion.runner)) {
    return toolTextResult({
      ok: false,
      error: `runner not registered: ${criterion.runner}`,
    });
  }

  const profileCheck = assertAtestEnvelopeAllowed(
    "atest.report",
    bondProfilesFor(ctx, session, agentId),
  );
  if (!profileCheck.ok) {
    return toolTextResult({ ok: false, error: profileCheck.error });
  }

  let bytes: Uint8Array;
  try {
    bytes = await ctx.relay.getArtifact(input.artifact_hash, MAX_SPILLOVER_PLAINTEXT_BYTES);
  } catch {
    return toolTextResult({ ok: false, error: "artifact_fetch_failed" });
  }

  let parsed: Record<string, unknown>;
  try {
    const text = new TextDecoder().decode(bytes);
    const value = JSON.parse(text) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return toolTextResult({ ok: false, error: "invalid artifact JSON" });
    }
    parsed = value as Record<string, unknown>;
  } catch {
    return toolTextResult({ ok: false, error: "invalid artifact JSON" });
  }

  const runnerResult = await runRegisteredRunner(
    criterion.runner,
    runnerInputForArtifact(criterion.runner, parsed),
  );
  if (!runnerResult.ok && /unavailable/i.test(runnerResult.error ?? "")) {
    return toolTextResult({ ok: false, error: runnerResult.error });
  }

  const report: TestReport = {
    artifact_hash: input.artifact_hash,
    passed: runnerResult.ok,
    runner: criterion.runner,
    details: runnerResult.details ? JSON.stringify(runnerResult.details) : undefined,
  };

  const recorded = await recordSessionTestReport(ctx, {
    thread: input.thread,
    report,
  });
  const recordedBody = recorded.structuredContent;
  if (recordedBody.ok !== true) {
    return recorded;
  }

  return toolTextResult({
    ok: true,
    thread: input.thread,
    runner: criterion.runner,
    passed: runnerResult.ok,
  });
}
