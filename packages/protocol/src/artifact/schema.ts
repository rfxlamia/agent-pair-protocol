import { z } from "zod";
import { decodeBase64UrlStrict } from "../crypto/base64url.js";

const artifactKeySchema = z.string().refine(
  (value) => {
    try {
      return decodeBase64UrlStrict(value).length === 32;
    } catch {
      return false;
    }
  },
  { message: "artifact_key must decode to 32 bytes" },
);

export const spillRefSchema = z
  .object({
    spill: z.literal(1),
    artifact_hash: z.string().regex(/^[0-9a-f]{64}$/),
    size: z.number().int().nonnegative(),
    content_type: z.string(),
    summary: z.string().refine((s) => [...s].length <= 240, {
      message: "summary exceeds 240 code points",
    }),
    artifact_key: artifactKeySchema,
  })
  .strict();

export type SpillRef = z.infer<typeof spillRefSchema>;

export function hasSpillMarker(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "spill" in value;
}

export type ParseSpillRefResult =
  | { ok: true; data: SpillRef }
  | { ok: false; error: "invalid_payload" };

export function parseSpillRef(value: unknown): ParseSpillRefResult {
  const result = spillRefSchema.safeParse(value);
  if (!result.success) {
    return { ok: false, error: "invalid_payload" };
  }
  return { ok: true, data: result.data };
}
