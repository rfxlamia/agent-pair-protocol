import { describe, expect, it } from "vitest";
import { detectGlobalThreadGap } from "./thread-seq.js";

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
