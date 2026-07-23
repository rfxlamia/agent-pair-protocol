import { z } from "zod";

/** Shared optional profiles field for pairing MCP tools (initiator + joiner approve). */
export const optionalProfilesField = z
  .array(z.string())
  .optional()
  .describe(
    "Protocol profiles to advertise during pairing (e.g. core/1, nego/1, atest/1); defaults to core/1 + nego/1 if omitted",
  );
