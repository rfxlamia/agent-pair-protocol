import { z } from "zod";

const PROFILE_ID_REGEX = /^[a-z_]+\/[0-9]+$/;

const profileIdSchema = z.string().max(64).regex(PROFILE_ID_REGEX, "invalid profile id grammar");

const profilesArraySchema = z
  .array(profileIdSchema)
  .max(32)
  .refine((arr) => new Set(arr).size === arr.length, { message: "duplicate profiles" });

export type ParseProfilesWireResult =
  | { ok: true; profiles: string[] }
  | { ok: false; error: string };

export function isValidProfilesArray(value: unknown): value is string[] {
  return profilesArraySchema.safeParse(value).success;
}

export function parseProfilesWire(value: unknown): ParseProfilesWireResult {
  const result = profilesArraySchema.safeParse(value);
  if (result.success) {
    return { ok: true, profiles: result.data };
  }
  return { ok: false, error: result.error.message };
}
