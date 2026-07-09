import type { AgentContext } from "./pair.js";

export interface ThreadGap {
  thread: string;
  last_good_seq: number;
  expected_seq: number;
}

// In-memory per process; outbound sends only (M1.2).
const threadSeqHighWater = new WeakMap<AgentContext, Map<string, number>>();
const threadSentSeqs = new WeakMap<AgentContext, Map<string, Set<number>>>();

function sentMap(ctx: AgentContext): Map<string, Set<number>> {
  const map = threadSentSeqs.get(ctx) ?? new Map<string, Set<number>>();
  threadSentSeqs.set(ctx, map);
  return map;
}

function highWaterMap(ctx: AgentContext): Map<string, number> {
  const map = threadSeqHighWater.get(ctx) ?? new Map<string, number>();
  threadSeqHighWater.set(ctx, map);
  return map;
}

export function getThreadSeqHighWater(ctx: AgentContext, thread: string): number {
  return highWaterMap(ctx).get(thread) ?? 0;
}

export function nextThreadSeq(ctx: AgentContext, thread: string): number {
  return getThreadSeqHighWater(ctx, thread) + 1;
}

export function recordSentSeq(ctx: AgentContext, thread: string, seq: number): void {
  const seqs = sentMap(ctx).get(thread) ?? new Set<number>();
  seqs.add(seq);
  sentMap(ctx).set(thread, seqs);

  const current = highWaterMap(ctx).get(thread) ?? 0;
  if (seq > current) {
    highWaterMap(ctx).set(thread, seq);
  }
}

export function detectGlobalThreadGap(
  thread: string,
  peerSeqs: Iterable<number>,
  ourSeqs: Iterable<number>,
): ThreadGap | null {
  const global = [...new Set([...peerSeqs, ...ourSeqs])].sort((a, b) => a - b);
  if (global.length <= 1) {
    return null;
  }

  const firstSeq = global[0];
  if (firstSeq === undefined) {
    return null;
  }
  let lastGood = firstSeq;
  for (let i = 1; i < global.length; i += 1) {
    const current = global[i];
    if (current === undefined) {
      continue;
    }
    if (current !== lastGood + 1) {
      return {
        thread,
        last_good_seq: lastGood,
        expected_seq: lastGood + 1,
      };
    }
    lastGood = current;
  }

  return null;
}

export function detectClientThreadGaps(ctx: AgentContext): ThreadGap[] {
  const gaps: ThreadGap[] = [];

  for (const thread of sentMap(ctx).keys()) {
    const gap = detectGlobalThreadGap(thread, [], sentMap(ctx).get(thread) ?? []);
    if (gap) {
      gaps.push(gap);
    }
  }

  return gaps;
}
