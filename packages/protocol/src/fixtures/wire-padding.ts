import { utf8ToBytes } from "@noble/ciphers/utils.js";

export function wireUtf8Length(wire: string): number {
  return utf8ToBytes(wire).length;
}

/** Pad a v:1 outer JSON wire to an exact UTF-8 byte length (for envelope_too_large tests). */
export function padWireToSize(wire: string, targetBytes: number): string {
  const current = wireUtf8Length(wire);
  if (current === targetBytes) {
    return wire;
  }
  if (current > targetBytes) {
    throw new Error(`wire already exceeds ${targetBytes} bytes`);
  }
  const outer = JSON.parse(wire) as Record<string, unknown>;
  let low = 0;
  let high = targetBytes;
  let best = "";
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = JSON.stringify({ ...outer, _pad: "x".repeat(mid) });
    const len = wireUtf8Length(candidate);
    if (len <= targetBytes) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (!best || wireUtf8Length(best) !== targetBytes) {
    throw new Error(`could not pad wire to exactly ${targetBytes} bytes`);
  }
  return best;
}
