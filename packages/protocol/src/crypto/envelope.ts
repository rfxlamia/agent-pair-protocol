import { randomBytes, utf8ToBytes } from "@noble/ciphers/utils.js";
import {
  agentIdToPublicKey,
  type KeyPair,
  publicKeyToAgentId,
} from "./keys.js";
import { decryptPayload, encryptPayload } from "./encrypt.js";
import { sign, verify } from "./sign.js";

export interface Envelope {
  id: string;
  from: string;
  to: string;
  type: string;
  thread: string;
  seq: number;
  ttl: number;
  payload: string;
  sig: string;
}

export type SignableEnvelopeFields = Omit<Envelope, "sig">;

export interface CreateEnvelopeInput {
  sender: KeyPair;
  recipientAgentId: string;
  type: string;
  thread: string;
  seq: number;
  ttl: number;
  payload: Uint8Array;
  id?: string;
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64Url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function canonicalSignBytes(fields: SignableEnvelopeFields): Uint8Array {
  const ordered = {
    from: fields.from,
    id: fields.id,
    payload: fields.payload,
    seq: fields.seq,
    thread: fields.thread,
    to: fields.to,
    ttl: fields.ttl,
    type: fields.type,
  };
  return utf8ToBytes(JSON.stringify(ordered));
}

export function createEnvelope(input: CreateEnvelopeInput): Envelope {
  const recipientPublicKey = agentIdToPublicKey(input.recipientAgentId);
  const encryptedPayload = encryptPayload(
    input.payload,
    input.sender.secretKey,
    recipientPublicKey,
  );

  const unsigned: SignableEnvelopeFields = {
    id: input.id ?? crypto.randomUUID(),
    from: publicKeyToAgentId(input.sender.publicKey),
    to: input.recipientAgentId,
    type: input.type,
    thread: input.thread,
    seq: input.seq,
    ttl: input.ttl,
    payload: encryptedPayload,
  };

  const signature = sign(
    canonicalSignBytes(unsigned),
    input.sender.secretKey,
  );

  return {
    ...unsigned,
    sig: toBase64Url(signature),
  };
}

export function verifyEnvelope(
  envelope: Envelope,
  senderPublicKey: Uint8Array,
): boolean {
  const { sig, ...unsigned } = envelope;
  return verify(
    fromBase64Url(sig),
    canonicalSignBytes(unsigned),
    senderPublicKey,
  );
}

export function decryptEnvelopePayload(
  envelope: Envelope,
  recipient: KeyPair,
  senderPublicKey: Uint8Array,
): Uint8Array {
  if (!verifyEnvelope(envelope, senderPublicKey)) {
    throw new Error("Envelope signature verification failed");
  }
  return decryptPayload(envelope.payload, recipient.secretKey, senderPublicKey);
}

export function serializeEnvelope(envelope: Envelope): string {
  return JSON.stringify(envelope);
}

export function deserializeEnvelope(serialized: string): Envelope {
  const parsed = JSON.parse(serialized) as Envelope;
  if (
    typeof parsed.id !== "string" ||
    typeof parsed.from !== "string" ||
    typeof parsed.to !== "string" ||
    typeof parsed.type !== "string" ||
    typeof parsed.thread !== "string" ||
    typeof parsed.seq !== "number" ||
    typeof parsed.ttl !== "number" ||
    typeof parsed.payload !== "string" ||
    typeof parsed.sig !== "string"
  ) {
    throw new Error("Invalid envelope shape");
  }
  return parsed;
}

export function randomEnvelopeId(): string {
  return crypto.randomUUID();
}

export function randomNonce(bytes = 32): Uint8Array {
  return randomBytes(bytes);
}
