import { utf8ToBytes } from "@noble/ciphers/utils.js";
import { decodeBase64UrlStrict, encodeBase64Url } from "../crypto/base64url.js";
import { sign, verify } from "../crypto/sign.js";
import type { AllowlistBlob } from "./schema.js";

export interface AllowlistPush {
  blob: string;
  sig: string;
}

export function sortAllowed(allowed: string[]): string[] {
  return [...allowed].sort();
}

function serializeAllowlistBlob(agentId: string, allowed: string[]): Uint8Array {
  const body: AllowlistBlob = { agent_id: agentId, allowed: [...allowed] };
  return utf8ToBytes(JSON.stringify(body));
}

export function encodeAllowlistPush(
  agentId: string,
  allowed: string[],
  secretKey: Uint8Array,
): AllowlistPush {
  const blobBytes = serializeAllowlistBlob(agentId, allowed);
  const signature = sign(blobBytes, secretKey);
  return {
    blob: encodeBase64Url(blobBytes),
    sig: encodeBase64Url(signature),
  };
}

export function decodeAllowlistBlob(push: AllowlistPush): AllowlistBlob {
  const blobBytes = decodeBase64UrlStrict(push.blob);
  return JSON.parse(Buffer.from(blobBytes).toString("utf8")) as AllowlistBlob;
}

export function verifyAllowlistPush(push: AllowlistPush, publicKey: Uint8Array): boolean {
  try {
    const blobBytes = decodeBase64UrlStrict(push.blob);
    const signature = decodeBase64UrlStrict(push.sig);
    return verify(signature, blobBytes, publicKey);
  } catch {
    return false;
  }
}
