import type { BondMode } from "@agentpair/protocol";

export const DEFAULT_PEER_CONTENT_CAP_BYTES = 8192;
export const MAX_PEER_CONTENT_CAP_BYTES = 65536;
export const LOCKED_SECTION_ID_CAP_BYTES = 256;

export function resolvePeerContentCapBytes(
  raw?: string | undefined,
  warn?: (msg: string) => void,
): number {
  if (raw === undefined) {
    return DEFAULT_PEER_CONTENT_CAP_BYTES;
  }

  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    warn?.(`Invalid AGENTPAIR_PEER_CONTENT_CAP_BYTES: ${raw}`);
    return DEFAULT_PEER_CONTENT_CAP_BYTES;
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (parsed === 0) {
    warn?.(`Invalid AGENTPAIR_PEER_CONTENT_CAP_BYTES: ${raw}`);
    return DEFAULT_PEER_CONTENT_CAP_BYTES;
  }

  return Math.min(parsed, MAX_PEER_CONTENT_CAP_BYTES);
}

export type UntrustedPeerContent = {
  untrusted: true;
  source: "peer";
  data: unknown;
  truncated?: true;
  original_length?: number;
};

function measurePeerContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

function truncateUtf8ToBytes(s: string, capBytes: number): string {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length <= capBytes) {
    return s;
  }

  let end = capBytes;
  while (end > 0) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
    } catch {
      end--;
    }
  }
  return "";
}

export function wrapUntrustedPeerContent(value: unknown, capBytes: number): UntrustedPeerContent {
  const measured = measurePeerContent(value);
  const originalLength = new TextEncoder().encode(measured).length;

  if (originalLength <= capBytes) {
    return { untrusted: true, source: "peer", data: value };
  }

  return {
    untrusted: true,
    source: "peer",
    data: truncateUtf8ToBytes(measured, capBytes),
    truncated: true,
    original_length: originalLength,
  };
}

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
