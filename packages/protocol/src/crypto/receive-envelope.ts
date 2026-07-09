import { utf8ToBytes } from "@noble/ciphers/utils.js";
import {
  type EnvelopeBody,
  type OuterEnvelope,
  deserializeOuterEnvelope,
  verifyOuterEnvelope,
} from "./envelope.js";
import { agentIdToPublicKey } from "./keys.js";

export const MAX_ENVELOPE_WIRE_BYTES = 65536;

export function defaultEnvelopeTtl(secondsFromNow = 3600, nowUnix?: number): number {
  const now = nowUnix ?? Math.floor(Date.now() / 1000);
  return now + secondsFromNow;
}

export interface SeqStore {
  getLastAccepted(thread: string, from: string): number;
  commitAccepted(thread: string, from: string, seq: number): void;
}

export interface ReceiveEnvelopeDeps {
  isBonded(from: string): boolean;
  seqStore: SeqStore;
  dispatch(
    type: string,
    plaintext: Uint8Array,
  ): Promise<{ ok: true } | { ok: false; error: "unsupported_envelope_type" | "invalid_payload" }>;
  nowUnix?: () => number;
}

export type ReceiveEnvelopeResult =
  | { ok: false; error: string; body?: EnvelopeBody }
  | { ok: true; body: EnvelopeBody; outer: OuterEnvelope; plaintext: Uint8Array };

function parseOuterVersion(wire: string): number | null {
  try {
    const parsed = JSON.parse(wire) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    return typeof record.v === "number" ? record.v : null;
  } catch {
    return null;
  }
}

function tryParseEnvelopeBody(outer: OuterEnvelope): EnvelopeBody | null {
  try {
    const blobBytes = Buffer.from(outer.blob, "base64url");
    const parsed = JSON.parse(new TextDecoder().decode(blobBytes)) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const body = parsed as Record<string, unknown>;
    if (
      typeof body.v !== "number" ||
      typeof body.id !== "string" ||
      typeof body.from !== "string" ||
      typeof body.to !== "string" ||
      typeof body.type !== "string" ||
      typeof body.thread !== "string" ||
      typeof body.seq !== "number" ||
      typeof body.ttl !== "number" ||
      typeof body.payload !== "string"
    ) {
      return null;
    }
    return body as unknown as EnvelopeBody;
  } catch {
    return null;
  }
}

export async function receiveEnvelope(
  wire: string,
  selfId: string,
  _deps: ReceiveEnvelopeDeps,
): Promise<ReceiveEnvelopeResult> {
  // Step 0: known wire version
  const outerVersion = parseOuterVersion(wire);
  if (outerVersion !== null && outerVersion !== 1) {
    return { ok: false, error: "unsupported_version" };
  }

  // Step 1: pre-decode wire size cap
  if (utf8ToBytes(wire).length > MAX_ENVELOPE_WIRE_BYTES) {
    return { ok: false, error: "envelope_too_large" };
  }

  // Step 2: strict-decode outer + parse body JSON
  let outer: OuterEnvelope;
  try {
    outer = deserializeOuterEnvelope(wire);
  } catch {
    return { ok: false, error: "invalid_json" };
  }

  let body: EnvelopeBody;
  const parsedBody = tryParseEnvelopeBody(outer);
  if (parsedBody === null) {
    return { ok: false, error: "invalid_json" };
  }
  body = parsedBody;

  // Step 3: inner/outer version match
  if (body.v !== outer.v) {
    return { ok: false, error: "version_mismatch", body };
  }

  // Step 4: sender bonded
  if (!_deps.isBonded(body.from)) {
    return { ok: false, error: "recipient_not_allowed", body };
  }

  // Step 5: verify signature over blob bytes
  const senderPublicKey = agentIdToPublicKey(body.from);
  if (!verifyOuterEnvelope(outer, senderPublicKey)) {
    return { ok: false, error: "invalid_signature", body };
  }

  // Step 6: routing cross-check
  if (outer.to !== body.to || outer.from !== body.from || body.to !== selfId) {
    return { ok: false, error: "routing_mismatch", body };
  }

  // T1: steps 7–8 deferred
  return { ok: false, error: "envelope_incomplete" };
}
