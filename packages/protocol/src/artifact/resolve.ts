import { decodeBase64UrlStrict } from "../crypto/base64url.js";
import { MAX_SPILLOVER_PLAINTEXT_BYTES, decryptArtifact, hashArtifactBlob } from "./encrypt.js";
import { hasSpillMarker, parseSpillRef } from "./schema.js";

export interface ResolveSpilloverDeps {
  getArtifact: (hash: string, size: number) => Promise<Uint8Array>;
}

export type ResolveSpilloverResult = Uint8Array | { error: string };

export async function resolveSpillover(
  plaintext: Uint8Array,
  deps: ResolveSpilloverDeps,
): Promise<ResolveSpilloverResult> {
  let obj: unknown;
  try {
    const decoded = new TextDecoder().decode(plaintext);
    obj = JSON.parse(decoded);
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
      return plaintext;
    }
  } catch {
    return plaintext;
  }

  if (!hasSpillMarker(obj)) {
    return plaintext;
  }

  const parsed = parseSpillRef(obj);
  if (!parsed.ok) {
    return { error: "invalid_payload" };
  }
  const ref = parsed.data;

  if (ref.size > MAX_SPILLOVER_PLAINTEXT_BYTES) {
    return { error: "artifact_too_large" };
  }

  let blob: Uint8Array;
  try {
    blob = await deps.getArtifact(ref.artifact_hash, ref.size);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code) {
      return { error: code };
    }
    throw err;
  }

  if (blob.byteLength !== ref.size + 40) {
    return { error: "artifact_decrypt_failed" };
  }

  if (hashArtifactBlob(blob) !== ref.artifact_hash) {
    return { error: "artifact_decrypt_failed" };
  }

  const key = decodeBase64UrlStrict(ref.artifact_key);
  try {
    return decryptArtifact(blob, key);
  } catch {
    return { error: "artifact_decrypt_failed" };
  }
}
