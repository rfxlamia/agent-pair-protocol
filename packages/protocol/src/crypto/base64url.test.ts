import { describe, expect, it } from "vitest";
import { decodeBase64UrlStrict, encodeBase64Url } from "./base64url.js";
import { agentIdToPublicKey, generateKeyPair, publicKeyToAgentId } from "./keys.js";

describe("base64url strict", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 254, 32, 64, 128]);
    expect(decodeBase64UrlStrict(encodeBase64Url(bytes))).toEqual(bytes);
  });

  it("rejects empty string", () => {
    expect(() => decodeBase64UrlStrict("")).toThrow(/Invalid base64url encoding/);
  });

  it("rejects padding", () => {
    expect(() => decodeBase64UrlStrict("YQ==")).toThrow(/Invalid base64url encoding/);
  });

  it("rejects standard base64 alphabet (+ and /)", () => {
    expect(() => decodeBase64UrlStrict("Y+B/")).toThrow(/Invalid base64url encoding/);
  });

  it("rejects non-alphabet characters", () => {
    expect(() => decodeBase64UrlStrict("ab!cd")).toThrow(/Invalid base64url encoding/);
  });

  it("rejects non-canonical encoding", () => {
    // "_8" decodes to 1 byte but canonical form is "_w"
    expect(() => decodeBase64UrlStrict("_8")).toThrow(/Non-canonical base64url encoding/);
  });
});

describe("agentIdToPublicKey strict", () => {
  it("rejects padded agent_id suffix", () => {
    expect(() => agentIdToPublicKey("ed25519:YQ==")).toThrow(/Invalid base64url encoding/);
  });

  it("rejects wrong-length decoded key", () => {
    expect(() => agentIdToPublicKey("ed25519:AAAA")).toThrow(/Invalid Ed25519 public key length/);
  });

  it("round-trips a generated key pair", () => {
    const { publicKey } = generateKeyPair();
    const agentId = publicKeyToAgentId(publicKey);
    expect(agentIdToPublicKey(agentId)).toEqual(publicKey);
  });
});

describe("publicKeyToAgentId strict", () => {
  it("encodes agent_id suffix as canonical unpadded base64url", () => {
    const { publicKey } = generateKeyPair();
    const agentId = publicKeyToAgentId(publicKey);
    const suffix = agentId.slice("ed25519:".length);
    expect(suffix).not.toContain("=");
    expect(decodeBase64UrlStrict(suffix)).toEqual(publicKey);
  });
});
