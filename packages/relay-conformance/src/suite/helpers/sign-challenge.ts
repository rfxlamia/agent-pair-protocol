import { sign } from "@agentpair/protocol";
import { utf8ToBytes } from "@noble/ciphers/utils.js";

export function signChallenge(nonce: string, secretKey: Uint8Array): string {
  const signature = sign(utf8ToBytes(nonce), secretKey);
  return Buffer.from(signature).toString("base64url");
}
