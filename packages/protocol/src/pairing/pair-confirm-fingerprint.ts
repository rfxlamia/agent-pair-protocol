import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const DOMAIN = "agentpair-pair-confirm-v1";

function u16Be(len: number): Uint8Array {
  const buf = new Uint8Array(2);
  buf[0] = (len >> 8) & 0xff;
  buf[1] = len & 0xff;
  return buf;
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function pairConfirmFingerprint(
  sharedKey: Uint8Array,
  initiatorId: string,
  joinerId: string,
): string {
  const initiatorBytes = utf8(initiatorId);
  const joinerBytes = utf8(joinerId);

  const parts = [
    utf8(DOMAIN),
    u16Be(sharedKey.length),
    sharedKey,
    u16Be(initiatorBytes.length),
    initiatorBytes,
    u16Be(joinerBytes.length),
    joinerBytes,
  ];

  const totalLen = parts.reduce((sum, part) => sum + part.length, 0);
  const message = new Uint8Array(totalLen);
  let offset = 0;
  for (const part of parts) {
    message.set(part, offset);
    offset += part.length;
  }

  return bytesToHex(sha256(message));
}
