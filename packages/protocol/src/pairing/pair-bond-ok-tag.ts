import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const DOMAIN = "agentpair-pair-bondok-v1";

function u16Be(len: number): Uint8Array {
  const buf = new Uint8Array(2);
  buf[0] = (len >> 8) & 0xff;
  buf[1] = len & 0xff;
  return buf;
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** Identity-bound tag for bond_ok (sender agent_id + SPAKE2 shared key). */
export function pairBondOkTag(sharedKey: Uint8Array, senderAgentId: string): string {
  const agentBytes = utf8(senderAgentId);

  const parts = [
    utf8(DOMAIN),
    u16Be(sharedKey.length),
    sharedKey,
    u16Be(agentBytes.length),
    agentBytes,
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
