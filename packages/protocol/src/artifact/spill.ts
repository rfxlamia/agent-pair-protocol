import { randomBytes, utf8ToBytes } from "@noble/ciphers/utils.js";
import { encodeBase64Url } from "../crypto/base64url.js";
import {
  type CreateOuterEnvelopeInput,
  type OuterEnvelope,
  createOuterEnvelope,
  parseEnvelopeBody,
  serializeOuterEnvelope,
} from "../crypto/envelope.js";
import { MAX_ENVELOPE_WIRE_BYTES } from "../crypto/receive-envelope.js";
import { wireUtf8Length } from "../fixtures/wire-padding.js";
import { MAX_SPILLOVER_PLAINTEXT_BYTES, encryptArtifact } from "./encrypt.js";
import { deriveContentType, deriveSummary } from "./fields.js";

export type WrapOrSpillInput = CreateOuterEnvelopeInput;

export type WrapOrSpillDeps = {
  putArtifact: (blob: Uint8Array, hash: string) => Promise<void>;
};

export type WrapOrSpillResult =
  | { ok: true; outer: OuterEnvelope; spilled: boolean }
  | { ok: false; error: string };

function envelopeWireLength(outer: OuterEnvelope): number {
  return wireUtf8Length(serializeOuterEnvelope(outer));
}

function putErrorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

export async function wrapOrSpill(
  input: WrapOrSpillInput,
  deps: WrapOrSpillDeps,
): Promise<WrapOrSpillResult> {
  const tryBuild = createOuterEnvelope(input);
  if (envelopeWireLength(tryBuild) <= MAX_ENVELOPE_WIRE_BYTES) {
    return { ok: true, outer: tryBuild, spilled: false };
  }

  if (input.payload.length > MAX_SPILLOVER_PLAINTEXT_BYTES) {
    return { ok: false, error: "artifact_too_large" };
  }

  const tryBody = parseEnvelopeBody(tryBuild);
  const artifactKey = randomBytes(32);
  const { blob, hash } = encryptArtifact(input.payload, artifactKey);

  const spillRef = {
    spill: 1 as const,
    artifact_hash: hash,
    size: input.payload.length,
    content_type: deriveContentType(input.payload),
    summary: deriveSummary(input.payload),
    artifact_key: encodeBase64Url(artifactKey),
  };

  try {
    await deps.putArtifact(blob, hash);
  } catch (err) {
    const code = putErrorCode(err);
    if (code === "hash_mismatch") {
      throw err;
    }
    if (code) {
      return { ok: false, error: code };
    }
    return { ok: false, error: "artifact_upload_failed" };
  }

  const rebuilt = createOuterEnvelope({
    ...input,
    id: tryBody.id,
    payload: utf8ToBytes(JSON.stringify(spillRef)),
  });

  if (envelopeWireLength(rebuilt) > MAX_ENVELOPE_WIRE_BYTES) {
    throw new Error("Spill envelope still exceeds wire cap");
  }

  return { ok: true, outer: rebuilt, spilled: true };
}
