import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hexToBytes } from "@noble/hashes/utils.js";
import type { KeyPair } from "../crypto/keys.js";
import { getPublicKey, publicKeyToAgentId } from "../crypto/keys.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures");

export function fixturesPath(name: string): string {
  return join(fixturesDir, name);
}

export function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(fixturesPath(name), "utf8")) as T;
}

export interface FixtureKeyEntry {
  secretKeyHex: string;
  publicKeyHex: string;
  agentId: string;
}

export interface FixtureKeys {
  alice: FixtureKeyEntry;
  bob: FixtureKeyEntry;
}

export function loadKeys(): FixtureKeys {
  return loadFixture<FixtureKeys>("keys.json");
}

export function keyPairFromEntry(entry: FixtureKeyEntry): KeyPair {
  const secretKey = hexToBytes(entry.secretKeyHex);
  const publicKey = getPublicKey(secretKey);
  return { secretKey, publicKey };
}

export function assertKeyEntryMatchesDerived(entry: FixtureKeyEntry): void {
  const derived = keyPairFromEntry(entry);
  if (publicKeyToAgentId(derived.publicKey) !== entry.agentId) {
    throw new Error(`agentId mismatch for fixture key ${entry.agentId}`);
  }
  const pubHex = Buffer.from(derived.publicKey).toString("hex");
  if (pubHex !== entry.publicKeyHex) {
    throw new Error(`publicKeyHex mismatch for ${entry.agentId}`);
  }
}
