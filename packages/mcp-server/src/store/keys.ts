import { generateKeyPair, publicKeyToAgentId, type KeyPair } from "@agentpair/protocol";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const KEY_FILE_MODE = 0o600;
const KEY_DIR_MODE = 0o700;

interface StoredKeys {
  secretKey: string;
  publicKey: string;
}

export interface KeyStore {
  loadOrCreate(): Promise<KeyPair>;
  getAgentId(): Promise<string>;
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64Url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

export function resolveKeyPath(baseDir?: string): string {
  const root = baseDir ?? join(homedir(), ".agentpair");
  return join(root, "keys.json");
}

export function createKeyStore(options: { keyPath?: string } = {}): KeyStore {
  const keyPath = options.keyPath ?? resolveKeyPath();
  let cached: KeyPair | undefined;

  async function loadOrCreate(): Promise<KeyPair> {
    if (cached) {
      return cached;
    }

    try {
      const raw = await readFile(keyPath, "utf8");
      const stored = JSON.parse(raw) as StoredKeys;
      cached = {
        secretKey: fromBase64Url(stored.secretKey),
        publicKey: fromBase64Url(stored.publicKey),
      };
      return cached;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        throw error;
      }
    }

    const keyPair = generateKeyPair();
    const stored: StoredKeys = {
      secretKey: toBase64Url(keyPair.secretKey),
      publicKey: toBase64Url(keyPair.publicKey),
    };

    await mkdir(dirname(keyPath), { recursive: true, mode: KEY_DIR_MODE });
    await writeFile(keyPath, JSON.stringify(stored, null, 2), {
      encoding: "utf8",
      mode: KEY_FILE_MODE,
    });
    await chmod(keyPath, KEY_FILE_MODE);

    cached = keyPair;
    return keyPair;
  }

  return {
    loadOrCreate,
    async getAgentId(): Promise<string> {
      const keyPair = await loadOrCreate();
      return publicKeyToAgentId(keyPair.publicKey);
    },
  };
}
