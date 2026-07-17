import type { BondMode } from "@agentpair/protocol";

export function toolTextResult(data: unknown): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
} {
  const safe = stripSecrets(data);
  return {
    content: [{ type: "text", text: JSON.stringify(safe, null, 2) }],
    structuredContent:
      typeof safe === "object" && safe !== null
        ? (safe as Record<string, unknown>)
        : { value: safe },
  };
}

const SECRET_PATTERNS = [
  /secretKey/i,
  /privateKey/i,
  /secret_key/i,
  /private_key/i,
  /approvalCodeVerifier/i,
  /approval_code_verifier/i,
];

export function stripSecrets<T>(value: T): T {
  return scrub(value, new WeakSet()) as T;
}

function scrub(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (seen.has(value as object)) {
    return value;
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => scrub(item, seen));
  }

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_PATTERNS.some((pattern) => pattern.test(key))) {
      continue;
    }
    output[key] = scrub(child, seen);
  }
  return output;
}

export function assertNoSecrets(value: unknown): void {
  walkForSecretKeys(value, new WeakSet());
}

function walkForSecretKeys(value: unknown, seen: WeakSet<object>): void {
  if (value === null || typeof value !== "object") {
    return;
  }
  if (seen.has(value as object)) {
    return;
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    for (const item of value) {
      walkForSecretKeys(item, seen);
    }
    return;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_PATTERNS.some((pattern) => pattern.test(key))) {
      throw new Error("tool response leaked private key material");
    }
    walkForSecretKeys(child, seen);
  }
}

export function parseBondMode(
  mode: string,
): { ok: true; mode: BondMode } | { ok: false; error: string } {
  if (mode === "ephemeral_until_session_closes" || mode === "bonded_contact") {
    return { ok: true, mode };
  }
  return { ok: false, error: "invalid_mode" };
}
