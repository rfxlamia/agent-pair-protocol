import type { OpenApiDocument } from "./openapi-schemas.js";
import { DEFAULT_MAX_PAYLOAD_BYTES, type RunnerResult, runPayloadSize } from "./payload-size.js";
import { runSpectral } from "./spectral.js";

export type { RunnerResult };

export type RunnerFn = (input: Record<string, unknown>) => Promise<RunnerResult> | RunnerResult;

const RUNNERS = new Map<string, RunnerFn>([
  [
    "payload-size",
    (input) => {
      const schema = input.schema;
      if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
        return { ok: false, error: "payload-size: missing or invalid schema field" };
      }
      return runPayloadSize(schema as Record<string, unknown>, {
        maxBytes: typeof input.maxBytes === "number" ? input.maxBytes : DEFAULT_MAX_PAYLOAD_BYTES,
        seed: typeof input.seed === "number" ? input.seed : undefined,
      });
    },
  ],
  [
    "spectral",
    async (input) => {
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        return { ok: false, error: "spectral: missing or invalid OpenAPI document" };
      }
      if (typeof input.openapi !== "string") {
        return { ok: false, error: "spectral: missing or invalid OpenAPI document" };
      }
      return runSpectral(input as OpenApiDocument);
    },
  ],
]);

export function lookupRunner(name: string): RunnerFn | undefined {
  return RUNNERS.get(name);
}

export async function runRegisteredRunner(
  name: string,
  input: Record<string, unknown>,
): Promise<RunnerResult> {
  const runner = lookupRunner(name);
  if (!runner) {
    return { ok: false, error: `runner not registered: ${name}` };
  }
  return await runner(input);
}
