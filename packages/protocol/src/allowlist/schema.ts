import { agentIdToPublicKey } from "../crypto/keys.js";

export const ALLOWLIST_MAX_ALLOWED = 1024;

export interface AllowlistBlob {
  agent_id: string;
  allowed: string[];
}

export type ValidateAllowlistSchemaResult = { ok: true } | { ok: false; error: string };

function isValidAgentId(agentId: string): boolean {
  try {
    agentIdToPublicKey(agentId);
    return true;
  } catch {
    return false;
  }
}

export function validateAllowlistSchema(
  blob: AllowlistBlob,
  pathAgentId: string,
): ValidateAllowlistSchemaResult {
  if (blob.agent_id !== pathAgentId) {
    return { ok: false, error: "agent_id_mismatch" };
  }

  if (!Array.isArray(blob.allowed)) {
    return { ok: false, error: "invalid_allowlist" };
  }

  if (blob.allowed.length > ALLOWLIST_MAX_ALLOWED) {
    return { ok: false, error: "allowlist_too_large" };
  }

  const seen = new Set<string>();
  for (const id of blob.allowed) {
    if (!isValidAgentId(id)) {
      return { ok: false, error: "invalid_agent_id" };
    }
    if (seen.has(id)) {
      return { ok: false, error: "duplicate_allowed" };
    }
    seen.add(id);
  }

  return { ok: true };
}
