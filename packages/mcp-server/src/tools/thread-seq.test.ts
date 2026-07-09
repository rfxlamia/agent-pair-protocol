import { describe, expect, it } from "vitest";
import { MemoryAllowlistStore } from "../store/allowlist.js";
import { MemoryBondStore } from "../store/bonds.js";
import { MemoryInboxCursorStore } from "../store/inbox-cursor.js";
import { createKeyStore } from "../store/keys.js";
import { createPendingQueue } from "../store/pending.js";
import { createAgentContext } from "./pair.js";
import { detectClientThreadGaps, detectGlobalThreadGap, recordSentSeq } from "./thread-seq.js";

describe("detectGlobalThreadGap", () => {
  it("returns null for strict alternation peer 1,3 with local seq 2", () => {
    expect(detectGlobalThreadGap("t", [1, 3], [2])).toBeNull();
  });

  it("returns null for burst peer 1,4 with local seq 2,3", () => {
    expect(detectGlobalThreadGap("t", [1, 4], [2, 3])).toBeNull();
  });

  it("detects true global gap when seq 3 is missing everywhere", () => {
    expect(detectGlobalThreadGap("t", [1, 5], [])).toEqual({
      thread: "t",
      last_good_seq: 1,
      expected_seq: 2,
    });
  });
});

describe("detectClientThreadGaps outbound-only (M1.2)", () => {
  function minimalCtx() {
    return createAgentContext({
      keyStore: createKeyStore(),
      allowlist: new MemoryAllowlistStore(),
      bonds: new MemoryBondStore(),
      pending: createPendingQueue(),
      inboxCursor: new MemoryInboxCursorStore(),
    });
  }

  it("detects gap from outbound recordSentSeq only", () => {
    const ctx = minimalCtx();
    recordSentSeq(ctx, "thread-a", 1);
    recordSentSeq(ctx, "thread-a", 3);
    expect(detectClientThreadGaps(ctx)).toEqual([
      { thread: "thread-a", last_good_seq: 1, expected_seq: 2 },
    ]);
  });

  it("returns empty when no outbound sends recorded (inbound no longer tracked)", () => {
    const ctx = minimalCtx();
    expect(detectClientThreadGaps(ctx)).toEqual([]);
  });
});
