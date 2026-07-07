import { describe, expect, it, beforeAll } from "vitest";
import { init, start } from "./pake-adapter.js";

describe("pake-adapter", () => {
  beforeAll(async () => {
    await init();
  });

  it("exposes free() on session handles for deterministic WASM cleanup", () => {
    const { session } = start(
      "initiator",
      "TEST01",
      "990e8400-e29b-41d4-a716-446655440000",
    );
    expect(session).toHaveProperty("free");
    expect(typeof (session as { free?: () => void }).free).toBe("function");
  });
});
