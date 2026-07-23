import { describe, expect, it } from "vitest";
import { pairInitCompleteInputSchema, pairInitInputSchema } from "./pair-input-schema.js";

describe("pair MCP input schemas", () => {
  it("pairInitInputSchema exposes optional profiles for MCP binding", () => {
    const shape = pairInitInputSchema.shape;
    expect(shape.scope).toBeDefined();
    expect(shape.mode).toBeDefined();
    expect(shape.profiles).toBeDefined();
    expect(shape.profiles.isOptional()).toBe(true);
  });

  it("pairInitCompleteInputSchema exposes optional profiles for MCP binding", () => {
    const shape = pairInitCompleteInputSchema.shape;
    expect(shape.code).toBeDefined();
    expect(shape.profiles).toBeDefined();
    expect(shape.profiles.isOptional()).toBe(true);
  });
});
