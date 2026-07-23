import { isTransientInboxPullError } from "../relay/inbox-pull-errors.js";
import { handleInbox } from "./inbox.js";
import type { AgentContext } from "./pair.js";
import { toolTextResult } from "./util.js";

export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
export const MAX_WAIT_TIMEOUT_MS = 55_000;
const MAX_BACKOFF_MS = 10_000;

export type WaitDeps = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const defaultWaitDeps: WaitDeps = {
  now: () => Date.now(),
  sleep: defaultSleep,
};

type InboxWaitInput = {
  timeout_ms?: number;
  since?: number;
  include_history?: boolean;
};

function computeBaseIntervalMs(): number {
  return 1000 + Math.floor(Math.random() * 1000);
}

function nextBackoffIntervalMs(current: number | undefined): number {
  if (current !== undefined) {
    return Math.min(current * 2, MAX_BACKOFF_MS);
  }
  return Math.min(computeBaseIntervalMs() * 2, MAX_BACKOFF_MS);
}

export function hasDeliverableMail(result: Record<string, unknown>): boolean {
  if (result.ok !== true) {
    return false;
  }
  const envelopes = result.envelopes as unknown[] | undefined;
  const rejected = result.rejected as unknown[] | undefined;
  return (envelopes?.length ?? 0) > 0 || (rejected?.length ?? 0) > 0;
}

function buildInboxInput(
  input: InboxWaitInput,
  isFirstIteration: boolean,
): { since?: number; include_history?: boolean } {
  const inboxInput: { since?: number; include_history?: boolean } = {};
  if (input.include_history !== undefined) {
    inboxInput.include_history = input.include_history;
  }
  if (isFirstIteration && input.since !== undefined) {
    inboxInput.since = input.since;
  }
  return inboxInput;
}

// Concurrent inbox_wait/inbox calls are undefined — caller must not overlap.
export async function handleInboxWait(
  ctx: AgentContext,
  input: InboxWaitInput,
  deps: WaitDeps = defaultWaitDeps,
) {
  const startMs = deps.now();
  const timeoutMs = Math.min(input.timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS);
  const deadlineMs = startMs + timeoutMs;

  let successfulPulls = 0;
  let lastSuccessResult: Record<string, unknown> | undefined;
  let lastError = "relay_unavailable";
  let lastRetryAfterMs: number | undefined;
  let backoffIntervalMs: number | undefined;
  let isFirstIteration = true;

  while (deps.now() < deadlineMs) {
    let structured: Record<string, unknown>;
    try {
      const result = await handleInbox(ctx, buildInboxInput(input, isFirstIteration));
      structured = result.structuredContent;
    } catch {
      lastError = "relay_unavailable";
      lastRetryAfterMs = undefined;
      backoffIntervalMs = nextBackoffIntervalMs(backoffIntervalMs);
      isFirstIteration = false;

      const remaining = deadlineMs - deps.now();
      if (remaining <= 0) {
        break;
      }
      await deps.sleep(Math.min(backoffIntervalMs, remaining));
      continue;
    }

    isFirstIteration = false;

    if (structured.ok === true) {
      successfulPulls += 1;
      lastSuccessResult = structured;
      backoffIntervalMs = undefined;
      lastRetryAfterMs = undefined;

      if (hasDeliverableMail(structured)) {
        return toolTextResult({
          ...structured,
          timed_out: false,
          waited_ms: deps.now() - startMs,
        });
      }
    } else {
      const error = structured.error as string;
      if (!isTransientInboxPullError(error)) {
        return toolTextResult({
          ...structured,
          waited_ms: deps.now() - startMs,
        });
      }

      lastError = error;
      const retryAfter = structured.retry_after_ms;
      lastRetryAfterMs =
        typeof retryAfter === "number" && Number.isFinite(retryAfter) ? retryAfter : undefined;
      backoffIntervalMs = nextBackoffIntervalMs(backoffIntervalMs);
    }

    const remaining = deadlineMs - deps.now();
    if (remaining <= 0) {
      break;
    }

    let sleepMs: number;
    if (backoffIntervalMs !== undefined) {
      sleepMs = backoffIntervalMs;
      if (lastRetryAfterMs !== undefined) {
        sleepMs = Math.max(sleepMs, lastRetryAfterMs);
      }
    } else {
      sleepMs = computeBaseIntervalMs();
    }
    await deps.sleep(Math.min(sleepMs, remaining));
  }

  const waitedMs = deps.now() - startMs;

  if (successfulPulls === 0) {
    return toolTextResult({
      ok: false,
      error: lastError,
      waited_ms: waitedMs,
    });
  }

  return toolTextResult({
    ...lastSuccessResult,
    timed_out: true,
    waited_ms: waitedMs,
  });
}
