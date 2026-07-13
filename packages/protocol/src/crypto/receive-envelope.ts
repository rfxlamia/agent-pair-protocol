import { utf8ToBytes } from "@noble/ciphers/utils.js";
import { decodeBase64UrlStrict } from "./base64url.js";
import {
  type EnvelopeBody,
  type OuterEnvelope,
  coerceEnvelopeBody,
  decryptEnvelopePayload,
  deserializeOuterEnvelope,
  verifyOuterEnvelope,
} from "./envelope.js";
import { type KeyPair, agentIdToPublicKey } from "./keys.js";

export const MAX_ENVELOPE_WIRE_BYTES = 65536;

export function defaultEnvelopeTtl(secondsFromNow = 3600, nowUnix?: number): number {
  const now = nowUnix ?? Math.floor(Date.now() / 1000);
  return now + secondsFromNow;
}

export interface SeqStore {
  getLastAccepted(thread: string, from: string): number;
  commitAccepted(thread: string, from: string, seq: number): void;
}

export type ReceiveDispatchError =
  | "unsupported_envelope_type"
  | "profile_not_supported"
  | "invalid_payload"
  | "not_a_participant";

export interface ReceiveEnvelopeDeps {
  isBonded(from: string): boolean;
  selfKeyPair: KeyPair;
  seqStore: SeqStore;
  dispatch(
    body: EnvelopeBody,
    plaintext: Uint8Array,
  ): Promise<{ ok: true } | { ok: false; error: ReceiveDispatchError }>;
  resolvePayload?: (
    plaintext: Uint8Array,
    body: EnvelopeBody,
  ) => Promise<Uint8Array | { error: string }>;
  nowUnix?: () => number;
}

export type ReceiveEnvelopeResult =
  | { ok: false; error: string; body?: EnvelopeBody }
  | { ok: true; body: EnvelopeBody; outer: OuterEnvelope; plaintext: Uint8Array };

export function parseOuterVersion(wire: string): number | null {
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

export function tryParseEnvelopeBody(outer: OuterEnvelope): EnvelopeBody | null {
  try {
    const blobBytes = decodeBase64UrlStrict(outer.blob);
    const parsed = JSON.parse(new TextDecoder().decode(blobBytes)) as unknown;
    return coerceEnvelopeBody(parsed);
  } catch {
    return null;
  }
}

export async function receiveEnvelope(
  wire: string,
  selfId: string,
  deps: ReceiveEnvelopeDeps,
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

  const parsedBody = tryParseEnvelopeBody(outer);
  if (parsedBody === null) {
    return { ok: false, error: "invalid_json" };
  }
  const body = parsedBody;

  // Step 3: inner/outer version match
  if (body.v !== outer.v) {
    return { ok: false, error: "version_mismatch", body };
  }

  // Step 4: sender bonded
  if (!deps.isBonded(body.from)) {
    return { ok: false, error: "recipient_not_allowed", body };
  }

  // Step 5: verify signature over blob bytes
  let senderPublicKey: Uint8Array;
  try {
    senderPublicKey = agentIdToPublicKey(body.from);
  } catch {
    return { ok: false, error: "invalid_signature", body };
  }
  if (!verifyOuterEnvelope(outer, senderPublicKey)) {
    return { ok: false, error: "invalid_signature", body };
  }

  // Step 6: routing cross-check
  if (outer.to !== body.to || outer.from !== body.from || body.to !== selfId) {
    return { ok: false, error: "routing_mismatch", body };
  }

  // Step 7: replay/ordering — seq before ttl
  const lastAccepted = deps.seqStore.getLastAccepted(body.thread, body.from);
  if (body.seq <= lastAccepted) {
    return { ok: false, error: "stale_seq", body };
  }

  const now = (deps.nowUnix ?? (() => Math.floor(Date.now() / 1000)))();
  if (body.ttl <= now) {
    return { ok: false, error: "envelope_expired", body };
  }

  // Step 8: decrypt, dispatch, commit on success only
  let plaintext: Uint8Array;
  try {
    plaintext = decryptEnvelopePayload(body, deps.selfKeyPair, senderPublicKey);
  } catch {
    return { ok: false, error: "invalid_payload", body };
  }

  if (deps.resolvePayload) {
    const resolved = await deps.resolvePayload(plaintext, body);
    if (typeof resolved === "object" && "error" in resolved) {
      return { ok: false, error: resolved.error, body };
    }
    plaintext = resolved;
  }

  const dispatchResult = await deps.dispatch(body, plaintext);
  if (!dispatchResult.ok) {
    return { ok: false, error: dispatchResult.error, body };
  }

  deps.seqStore.commitAccepted(body.thread, body.from, body.seq);
  return { ok: true, body, outer, plaintext };
}
