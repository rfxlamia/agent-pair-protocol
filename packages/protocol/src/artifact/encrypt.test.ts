import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_AAD,
  MAX_SPILLOVER_PLAINTEXT_BYTES,
  decryptArtifact,
  encryptArtifact,
  hashArtifactBlob,
} from "./encrypt.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures");

describe("artifact encrypt", () => {
  it("exports MAX_SPILLOVER_PLAINTEXT_BYTES as 10 MiB", () => {
    expect(MAX_SPILLOVER_PLAINTEXT_BYTES).toBe(10 * 1024 * 1024);
  });

  it("matches artifact-spillover.json golden vector (encrypt + spill ref)", () => {
    const fixture = JSON.parse(
      readFileSync(join(fixtureDir, "artifact-spillover.json"), "utf8"),
    ) as {
      plaintext_hex: string;
      key_hex: string;
      nonce_hex: string;
      blob_hex: string;
      hash: string;
      spill_ref: Record<string, unknown>;
    };
    const plaintext = Buffer.from(fixture.plaintext_hex, "hex");
    const key = Buffer.from(fixture.key_hex, "hex");
    const nonce = Buffer.from(fixture.nonce_hex, "hex");
    const { blob, hash } = encryptArtifact(plaintext, key, { nonce });
    expect(Buffer.from(blob).toString("hex")).toBe(fixture.blob_hex);
    expect(hash).toBe(fixture.hash);
    expect(Buffer.from(decryptArtifact(blob, key)).toString("hex")).toBe(fixture.plaintext_hex);
    expect(fixture.spill_ref).toMatchObject({
      spill: 1,
      artifact_hash: fixture.hash,
      size: plaintext.length,
    });
  });

  it("uses ARTIFACT_AAD domain separation", () => {
    expect(ARTIFACT_AAD).toBe("agentpair-artifact-v1");
  });

  it("binds AAD so decrypt with wrong AAD fails", async () => {
    const { xchacha20poly1305 } = await import("@noble/ciphers/chacha.js");
    const { utf8ToBytes } = await import("@noble/ciphers/utils.js");
    const plaintext = utf8ToBytes('{"body":"aad"}');
    const key = new Uint8Array(32).fill(7);
    const nonce = new Uint8Array(24).fill(3);
    const { blob } = encryptArtifact(plaintext, key, { nonce });
    const ct = blob.subarray(24);
    expect(() => xchacha20poly1305(key, nonce, utf8ToBytes("wrong-aad")).decrypt(ct)).toThrow();
    expect(decryptArtifact(blob, key)).toEqual(plaintext);
  });
});
