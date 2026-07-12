import { randomBytes, utf8ToBytes } from "@noble/ciphers/utils.js";
import { decodeBase64UrlStrict, encodeBase64Url } from "./base64url.js";
import { decryptPayload, encryptPayload } from "./encrypt.js";
import { type KeyPair, agentIdToPublicKey, publicKeyToAgentId } from "./keys.js";
import { sign, verify } from "./sign.js";

export interface OuterEnvelope {
  v: 1;
  from: string;
  to: string;
  blob: string;
  sig: string;
}

export interface EnvelopeBody {
  v: 1;
  id: string;
  from: string;
  to: string;
  type: string;
  thread: string;
  seq: number;
  ttl: number;
  payload: string;
}

export interface CreateOuterEnvelopeInput {
  sender: KeyPair;
  recipientAgentId: string;
  type: string;
  thread: string;
  seq: number;
  ttl: number;
  payload: Uint8Array;
  id?: string;
}

export function serializeBodyBytes(body: EnvelopeBody): Uint8Array {
  const ordered = {
    v: body.v,
    id: body.id,
    from: body.from,
    to: body.to,
    type: body.type,
    thread: body.thread,
    seq: body.seq,
    ttl: body.ttl,
    payload: body.payload,
  };
  return utf8ToBytes(JSON.stringify(ordered));
}

function hasEnvelopeBodyFieldTypes(parsed: unknown): boolean {
  if (typeof parsed !== "object" || parsed === null) {
    return false;
  }
  const body = parsed as Record<string, unknown>;
  return (
    typeof body.v === "number" &&
    typeof body.id === "string" &&
    typeof body.from === "string" &&
    typeof body.to === "string" &&
    typeof body.type === "string" &&
    typeof body.thread === "string" &&
    typeof body.seq === "number" &&
    typeof body.ttl === "number" &&
    typeof body.payload === "string"
  );
}

function validateEnvelopeBody(parsed: unknown): EnvelopeBody {
  if (!hasEnvelopeBodyFieldTypes(parsed)) {
    throw new Error("Invalid envelope body shape");
  }
  const body = parsed as EnvelopeBody;
  if (body.v !== 1) {
    throw new Error("Invalid envelope body shape");
  }
  return body;
}

export function coerceEnvelopeBody(parsed: unknown): EnvelopeBody | null {
  return hasEnvelopeBodyFieldTypes(parsed) ? (parsed as EnvelopeBody) : null;
}

export function createOuterEnvelope(input: CreateOuterEnvelopeInput): OuterEnvelope {
  const recipientPublicKey = agentIdToPublicKey(input.recipientAgentId);
  const encryptedPayload = encryptPayload(
    input.payload,
    input.sender.secretKey,
    recipientPublicKey,
  );

  const from = publicKeyToAgentId(input.sender.publicKey);
  const body: EnvelopeBody = {
    v: 1,
    id: input.id ?? crypto.randomUUID(),
    from,
    to: input.recipientAgentId,
    type: input.type,
    thread: input.thread,
    seq: input.seq,
    ttl: input.ttl,
    payload: encryptedPayload,
  };

  const bodyBytes = serializeBodyBytes(body);
  const signature = sign(bodyBytes, input.sender.secretKey);

  return {
    v: 1,
    from,
    to: input.recipientAgentId,
    blob: encodeBase64Url(bodyBytes),
    sig: encodeBase64Url(signature),
  };
}

export function verifyOuterEnvelope(outer: OuterEnvelope, senderPublicKey: Uint8Array): boolean {
  try {
    const blobBytes = decodeBase64UrlStrict(outer.blob);
    return verify(decodeBase64UrlStrict(outer.sig), blobBytes, senderPublicKey);
  } catch {
    return false;
  }
}

export function parseEnvelopeBody(outer: OuterEnvelope): EnvelopeBody {
  const blobBytes = decodeBase64UrlStrict(outer.blob);
  const parsed = JSON.parse(new TextDecoder().decode(blobBytes)) as unknown;
  return validateEnvelopeBody(parsed);
}

export function serializeOuterEnvelope(outer: OuterEnvelope): string {
  return JSON.stringify({
    v: outer.v,
    from: outer.from,
    to: outer.to,
    blob: outer.blob,
    sig: outer.sig,
  });
}

export function deserializeOuterEnvelope(serialized: string): OuterEnvelope {
  const parsed = JSON.parse(serialized) as Record<string, unknown>;
  if (
    parsed.v !== 1 ||
    typeof parsed.from !== "string" ||
    typeof parsed.to !== "string" ||
    typeof parsed.blob !== "string" ||
    typeof parsed.sig !== "string"
  ) {
    throw new Error("Invalid outer envelope shape");
  }
  return {
    v: 1,
    from: parsed.from,
    to: parsed.to,
    blob: parsed.blob,
    sig: parsed.sig,
  };
}

export function decryptEnvelopePayload(
  body: EnvelopeBody,
  recipient: KeyPair,
  senderPublicKey: Uint8Array,
): Uint8Array {
  return decryptPayload(body.payload, recipient.secretKey, senderPublicKey);
}

export function randomEnvelopeId(): string {
  return crypto.randomUUID();
}

export function randomNonce(bytes = 24): Uint8Array {
  return randomBytes(bytes);
}
