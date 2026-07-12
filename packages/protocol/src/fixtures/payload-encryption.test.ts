import { utf8ToBytes } from "@noble/ciphers/utils.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { decryptPayload, encryptPayload } from "../crypto/encrypt.js";
import { keyPairFromEntry, loadFixture, loadKeys } from "./load-fixture.js";

interface PayloadEncryptionFixture {
  sender: "alice" | "bob";
  recipient: "alice" | "bob";
  testOnlyNonceHex: string;
  plaintextUtf8: string;
  expectedPayloadBase64url: string;
}

describe("payload-encryption.json golden vectors", () => {
  const fixture = loadFixture<PayloadEncryptionFixture>("payload-encryption.json");
  const keys = loadKeys();
  const sender = keyPairFromEntry(keys[fixture.sender]);
  const recipient = keyPairFromEntry(keys[fixture.recipient]);
  const nonce = hexToBytes(fixture.testOnlyNonceHex);
  const plaintext = utf8ToBytes(fixture.plaintextUtf8);

  it("encrypt matches expectedPayloadBase64url", () => {
    const payload = encryptPayload(plaintext, sender.secretKey, recipient.publicKey, nonce);
    expect(payload).toBe(fixture.expectedPayloadBase64url);
  });

  it("decrypt round-trips to plaintextUtf8", () => {
    const decrypted = decryptPayload(
      fixture.expectedPayloadBase64url,
      recipient.secretKey,
      sender.publicKey,
    );
    expect(new TextDecoder().decode(decrypted)).toBe(fixture.plaintextUtf8);
  });
});
