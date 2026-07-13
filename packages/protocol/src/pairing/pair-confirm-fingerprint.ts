import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const DOMAIN_V1 = "agentpair-pair-confirm-v1";
const DOMAIN_V2 = "agentpair-pair-confirm-v2";

export function u16Be(len: number): Uint8Array {
  const buf = new Uint8Array(2);
  buf[0] = (len >> 8) & 0xff;
  buf[1] = len & 0xff;
  return buf;
}

export function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function encodeProfileList(profiles: string[]): Uint8Array[] {
  const parts: Uint8Array[] = [u16Be(profiles.length)];
  for (const profile of profiles) {
    const profileBytes = utf8(profile);
    parts.push(u16Be(profileBytes.length), profileBytes);
  }
  return parts;
}

function concatParts(parts: Uint8Array[]): Uint8Array {
  const totalLen = parts.reduce((sum, part) => sum + part.length, 0);
  const message = new Uint8Array(totalLen);
  let offset = 0;
  for (const part of parts) {
    message.set(part, offset);
    offset += part.length;
  }
  return message;
}

function fingerprintFromParts(parts: Uint8Array[]): string {
  return bytesToHex(sha256(concatParts(parts)));
}

export function pairConfirmFingerprint(
  sharedKey: Uint8Array,
  initiatorId: string,
  joinerId: string,
): string {
  const initiatorBytes = utf8(initiatorId);
  const joinerBytes = utf8(joinerId);

  return fingerprintFromParts([
    utf8(DOMAIN_V1),
    u16Be(sharedKey.length),
    sharedKey,
    u16Be(initiatorBytes.length),
    initiatorBytes,
    u16Be(joinerBytes.length),
    joinerBytes,
  ]);
}

export function pairConfirmFingerprintV2(
  sharedKey: Uint8Array,
  initiatorId: string,
  joinerId: string,
  profilesInit: string[],
  profilesJoin: string[],
): string {
  const initiatorBytes = utf8(initiatorId);
  const joinerBytes = utf8(joinerId);

  return fingerprintFromParts([
    utf8(DOMAIN_V2),
    u16Be(sharedKey.length),
    sharedKey,
    u16Be(initiatorBytes.length),
    initiatorBytes,
    u16Be(joinerBytes.length),
    joinerBytes,
    ...encodeProfileList(profilesInit),
    ...encodeProfileList(profilesJoin),
  ]);
}
