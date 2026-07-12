import { describe, expect, it } from "vitest";
import { assertKeyEntryMatchesDerived, loadKeys } from "./load-fixture.js";

describe("fixture keys.json", () => {
  it("derived keys match committed agentId and publicKeyHex", () => {
    const keys = loadKeys();
    assertKeyEntryMatchesDerived(keys.alice);
    assertKeyEntryMatchesDerived(keys.bob);
    expect(keys.alice.agentId).not.toBe(keys.bob.agentId);
  });
});
