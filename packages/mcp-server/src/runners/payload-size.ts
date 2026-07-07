import { JSONSchemaFaker } from "json-schema-faker";

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

  try {
    if (options.seed !== undefined) {
      JSONSchemaFaker.option({ randomSeed: options.seed });
    }

    const payload = JSONSchemaFaker.generate(schema);
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
