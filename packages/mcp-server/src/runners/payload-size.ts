import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function loadJsonSchemaFaker(): typeof import("json-schema-faker") | null {
  try {
    return require("json-schema-faker") as typeof import("json-schema-faker");
  } catch {
    return null;
  }
}

export type RunnerResult = {
  ok: boolean;
  error?: string;
  details?: Record<string, unknown>;
};

export const DEFAULT_MAX_PAYLOAD_BYTES = 4096;

export type PayloadSizeOptions = {
  maxBytes?: number;
  seed?: number;
};

export function runPayloadSize(
  schema: Record<string, unknown>,
  options: PayloadSizeOptions = {},
): RunnerResult {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const faker = loadJsonSchemaFaker();
  if (!faker) {
    return {
      ok: false,
      error:
        "payload-size runner unavailable: reinstall or upgrade agentpair (json-schema-faker should ship with the package)",
    };
  }

  try {
    if (options.seed !== undefined) {
      // json-schema-faker supports randomSeed at runtime; typings are incomplete.
      (faker.JSONSchemaFaker.option as (opts: { randomSeed: number }) => void)({
        randomSeed: options.seed,
      });
    }

    const payload = faker.JSONSchemaFaker.generate(schema);
    const json = JSON.stringify(payload);
    const byteLength = Buffer.byteLength(json, "utf8");

    if (byteLength > maxBytes) {
      return {
        ok: false,
        error: `Payload size ${byteLength} bytes exceeds limit of ${maxBytes} bytes`,
        details: { byteLength, maxBytes },
      };
    }

    return {
      ok: true,
      details: { byteLength, maxBytes },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `payload-size failed: ${message}`,
    };
  }
}
