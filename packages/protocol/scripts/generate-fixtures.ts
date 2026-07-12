/**
 * Regenerates packages/protocol/fixtures/*.json from fixed seeds.
 *
 * Run: pnpm --filter @agentpair/protocol run generate-fixtures
 *
 * Uses tsx (not node --experimental-strip-types) because production src modules
 * import .js paths that strip-types cannot resolve transitively.
 *
 * Vector origins:
 * - keys.json: well-known 32-byte Ed25519 seeds (0x01… / 0x02…)
 * - base64url.json: static accept/reject cases per SPEC §3
 * - payload-encryption.json: encryptPayloadWithFixedNonce with fixed nonce
 * - envelope-core-msg.json: createOuterEnvelopeWithFixedNonce with fixed id + nonce
 * - envelope-negative.json: hand-assembled wires (version_mismatch, tampered_sig, …)
 * - pair-bond-ok-tag.json: pairBondOkTag for initiator/joiner agent IDs
 * - pair-confirm-fingerprint.json: SPEC §6.2 golden vector (unchanged values)
 * - artifact-spillover.json: encryptArtifact with fixed key/nonce (§5 spillover)
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { utf8ToBytes } from "@noble/ciphers/utils.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { decodeBase64UrlStrict, encodeBase64Url } from "../src/crypto/base64url.ts";
import {
  serializeBodyBytes,
  serializeOuterEnvelope,
  type EnvelopeBody,
} from "../src/crypto/envelope.ts";
import { getPublicKey, publicKeyToAgentId } from "../src/crypto/keys.ts";
import {
  createOuterEnvelopeWithFixedNonce,
  encryptPayloadWithFixedNonce,
} from "../src/fixtures/crypto-fixtures.ts";
import { encryptArtifact } from "../src/artifact/encrypt.ts";
import { deriveContentType, deriveSummary } from "../src/artifact/fields.ts";
import { pairBondOkTag } from "../src/pairing/pair-bond-ok-tag.ts";
import { pairConfirmFingerprint } from "../src/pairing/pair-confirm-fingerprint.ts";
import { sign } from "../src/crypto/sign.ts";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");

// Well-known test seeds — documented in fixtures/README.md
const ALICE_SECRET_HEX =
  "0101010101010101010101010101010101010101010101010101010101010101";
const BOB_SECRET_HEX =
  "0202020202020202020202020202020202020202020202020202020202020202";

const FIXTURE_ENVELOPE_ID = "00000000-0000-4000-8000-000000000000";
const FIXTURE_THREAD = "550e8400-e29b-41d4-a716-446655440000";
const FIXTURE_NOW_UNIX = 1_767_200_000;
const FIXTURE_TTL = FIXTURE_NOW_UNIX + 3600;
const FIXTURE_SEQ = 1;
const FIXTURE_NONCE_HEX = "000102030405060708090a0b0c0d0e0f1011121314151617";
const FIXTURE_PLAINTEXT = '{"body":"hello"}';
const ARTIFACT_KEY_HEX =
  "0303030303030303030303030303030303030303030303030303030303030303";
const ARTIFACT_NONCE_HEX = "000102030405060708090a0b0c0d0e0f1011121314151617";

// SPEC §6.2 golden vector
const PAIR_SHARED_KEY_HEX =
  "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
const PAIR_INITIATOR_ID = "ed25519:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqo";
const PAIR_JOINER_ID = "ed25519:u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7s";

function writeJson(name: string, data: unknown): void {
  writeFileSync(join(fixturesDir, name), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  console.log(`wrote ${name}`);
}

function makeKeys() {
  const aliceSecret = hexToBytes(ALICE_SECRET_HEX);
  const bobSecret = hexToBytes(BOB_SECRET_HEX);
  const alicePublic = getPublicKey(aliceSecret);
  const bobPublic = getPublicKey(bobSecret);
  return {
    alice: {
      secretKeyHex: ALICE_SECRET_HEX,
      publicKeyHex: Buffer.from(alicePublic).toString("hex"),
      agentId: publicKeyToAgentId(alicePublic),
    },
    bob: {
      secretKeyHex: BOB_SECRET_HEX,
      publicKeyHex: Buffer.from(bobPublic).toString("hex"),
      agentId: publicKeyToAgentId(bobPublic),
    },
    aliceSecret,
    bobSecret,
    alicePublic,
    bobPublic,
  };
}

function buildBase64UrlFixture() {
  const sample = new Uint8Array([0, 1, 2, 255, 254, 32, 64, 128]);
  return {
    accept: [
      { input: encodeBase64Url(sample), decodedHex: Buffer.from(sample).toString("hex") },
      { input: "YQ", decodedHex: "61" },
    ],
    reject: [
      { input: "", reason: "empty" },
      { input: "YQ==", reason: "padding" },
      { input: "Y+B/", reason: "standard_alphabet" },
      { input: "ab!cd", reason: "non_alphabet" },
      { input: "_8", reason: "non_canonical" },
    ],
  };
}

function buildPayloadEncryptionFixture(keys: ReturnType<typeof makeKeys>) {
  const nonce = hexToBytes(FIXTURE_NONCE_HEX);
  const plaintext = utf8ToBytes(FIXTURE_PLAINTEXT);
  const expectedPayloadBase64url = encryptPayloadWithFixedNonce(
    plaintext,
    keys.aliceSecret,
    keys.bobPublic,
    nonce,
  );
  return {
    sender: "alice",
    recipient: "bob",
    testOnlyNonceHex: FIXTURE_NONCE_HEX,
    plaintextUtf8: FIXTURE_PLAINTEXT,
    expectedPayloadBase64url,
  };
}

function buildEnvelopeCoreMsg(keys: ReturnType<typeof makeKeys>) {
  const nonce = hexToBytes(FIXTURE_NONCE_HEX);
  const outer = createOuterEnvelopeWithFixedNonce({
    sender: { secretKey: keys.aliceSecret, publicKey: keys.alicePublic },
    recipientAgentId: keys.bob.agentId,
    type: "core.msg",
    thread: FIXTURE_THREAD,
    seq: FIXTURE_SEQ,
    ttl: FIXTURE_TTL,
    payload: utf8ToBytes(FIXTURE_PLAINTEXT),
    id: FIXTURE_ENVELOPE_ID,
    fixedNonce: nonce,
  });
  const wire = serializeOuterEnvelope(outer);
  const bodyBytes = decodeBase64UrlStrict(outer.blob);
  const bodyJson = new TextDecoder().decode(bodyBytes);
  return {
    sender: "alice",
    recipient: "bob",
    id: FIXTURE_ENVELOPE_ID,
    type: "core.msg",
    thread: FIXTURE_THREAD,
    seq: FIXTURE_SEQ,
    ttl: FIXTURE_TTL,
    plaintextUtf8: FIXTURE_PLAINTEXT,
    testOnlyNonceHex: FIXTURE_NONCE_HEX,
    harness: {
      self: "bob",
      nowUnix: FIXTURE_NOW_UNIX,
      isBonded: true,
      lastAcceptedSeq: 0,
    },
    expected: {
      bodyJson,
      blob: outer.blob,
      sig: outer.sig,
      wire,
    },
  };
}

function resignBody(
  outer: { v: 1; from: string; to: string; blob: string; sig: string },
  senderSecret: Uint8Array,
  patch: (body: EnvelopeBody) => void,
): string {
  const blobBytes = decodeBase64UrlStrict(outer.blob);
  const body = JSON.parse(new TextDecoder().decode(blobBytes)) as EnvelopeBody;
  patch(body);
  const bodyBytes = serializeBodyBytes(body);
  const signature = sign(bodyBytes, senderSecret);
  return serializeOuterEnvelope({
    v: 1,
    from: body.from,
    to: body.to,
    blob: encodeBase64Url(bodyBytes),
    sig: encodeBase64Url(signature),
  });
}

function buildEnvelopeNegative(keys: ReturnType<typeof makeKeys>, coreWire: string) {
  const coreOuter = JSON.parse(coreWire) as {
    v: 1;
    from: string;
    to: string;
    blob: string;
    sig: string;
  };
  const baseHarness = {
    self: "bob" as const,
    nowUnix: FIXTURE_NOW_UNIX,
    isBonded: true,
    lastAcceptedSeq: 0,
  };

  const tamperedSigWire = (() => {
    const outer = { ...coreOuter };
    outer.sig = `${outer.sig.slice(0, -2)}XX`;
    return serializeOuterEnvelope(outer);
  })();

  const routingMismatchWire = serializeOuterEnvelope({
    ...coreOuter,
    to: "ed25519:wrongwrongwrongwrongwrongwrongwrongwrongwrongwron",
  });

  const versionMismatchWire = resignBody(coreOuter, keys.aliceSecret, (body) => {
    body.v = 2 as unknown as 1;
  });

  const expiredWire = resignBody(coreOuter, keys.aliceSecret, (body) => {
    body.ttl = FIXTURE_NOW_UNIX;
  });

  const staleSeqWire = coreWire;

  const unsupportedVersionWire = (() => {
    const outer = JSON.parse(coreWire) as typeof coreOuter;
    return JSON.stringify({ ...outer, v: 2 });
  })();

  const invalidJsonWire = '{"v":1,"from":"incomplete"';

  const invalidPayloadWire = resignBody(coreOuter, keys.aliceSecret, (body) => {
    body.payload = "YQ";
  });

  return {
    cases: [
      {
        name: "unsupported_version",
        wire: unsupportedVersionWire,
        expect: "unsupported_version",
        harness: baseHarness,
      },
      {
        name: "invalid_json",
        wire: invalidJsonWire,
        expect: "invalid_json",
        harness: baseHarness,
      },
      {
        name: "tampered_sig",
        wire: tamperedSigWire,
        expect: "invalid_signature",
        harness: baseHarness,
      },
      {
        name: "routing_mismatch",
        wire: routingMismatchWire,
        expect: "routing_mismatch",
        harness: baseHarness,
      },
      {
        name: "version_mismatch",
        wire: versionMismatchWire,
        expect: "version_mismatch",
        harness: baseHarness,
      },
      {
        name: "envelope_expired",
        wire: expiredWire,
        expect: "envelope_expired",
        harness: baseHarness,
      },
      {
        name: "stale_seq",
        wire: staleSeqWire,
        expect: "stale_seq",
        harness: { ...baseHarness, lastAcceptedSeq: FIXTURE_SEQ },
      },
      {
        name: "recipient_not_allowed",
        wire: staleSeqWire,
        expect: "recipient_not_allowed",
        harness: { ...baseHarness, isBonded: false },
      },
      {
        name: "invalid_payload",
        wire: invalidPayloadWire,
        expect: "invalid_payload",
        harness: baseHarness,
      },
      {
        name: "unsupported_envelope_type",
        wire: staleSeqWire,
        expect: "unsupported_envelope_type",
        harness: { ...baseHarness, dispatchError: "unsupported_envelope_type" },
      },
      {
        name: "envelope_too_large",
        bodySize: 65537,
        expect: "envelope_too_large",
        harness: baseHarness,
      },
    ],
  };
}

function buildPairBondOkTag() {
  const sharedKey = hexToBytes(PAIR_SHARED_KEY_HEX);
  return {
    sharedKeyHex: PAIR_SHARED_KEY_HEX,
    cases: [
      {
        role: "joiner",
        agentId: PAIR_JOINER_ID,
        expectedTag: pairBondOkTag(sharedKey, PAIR_JOINER_ID),
      },
      {
        role: "initiator",
        agentId: PAIR_INITIATOR_ID,
        expectedTag: pairBondOkTag(sharedKey, PAIR_INITIATOR_ID),
      },
    ],
  };
}

function buildArtifactSpilloverFixture() {
  const plaintext = utf8ToBytes(FIXTURE_PLAINTEXT);
  const key = hexToBytes(ARTIFACT_KEY_HEX);
  const nonce = hexToBytes(ARTIFACT_NONCE_HEX);
  const { blob, hash } = encryptArtifact(plaintext, key, { nonce });
  const spill_ref = {
    spill: 1,
    artifact_hash: hash,
    size: plaintext.length,
    content_type: deriveContentType(plaintext),
    summary: deriveSummary(plaintext),
    artifact_key: encodeBase64Url(key),
  };
  return {
    plaintext_hex: Buffer.from(plaintext).toString("hex"),
    key_hex: ARTIFACT_KEY_HEX,
    nonce_hex: ARTIFACT_NONCE_HEX,
    blob_hex: Buffer.from(blob).toString("hex"),
    hash,
    spill_ref,
  };
}

function buildPairConfirmFingerprint() {
  const sharedKey = hexToBytes(PAIR_SHARED_KEY_HEX);
  return {
    golden: {
      sharedKeyHex: PAIR_SHARED_KEY_HEX,
      initiatorId: PAIR_INITIATOR_ID,
      joinerId: PAIR_JOINER_ID,
      fingerprint: pairConfirmFingerprint(sharedKey, PAIR_INITIATOR_ID, PAIR_JOINER_ID),
      reversedFingerprint: pairConfirmFingerprint(sharedKey, PAIR_JOINER_ID, PAIR_INITIATOR_ID),
    },
  };
}

const keys = makeKeys();
writeJson("keys.json", { alice: keys.alice, bob: keys.bob });
writeJson("base64url.json", buildBase64UrlFixture());
writeJson("payload-encryption.json", buildPayloadEncryptionFixture(keys));
const core = buildEnvelopeCoreMsg(keys);
writeJson("envelope-core-msg.json", core);
writeJson("envelope-negative.json", buildEnvelopeNegative(keys, core.expected.wire));
writeJson("pair-bond-ok-tag.json", buildPairBondOkTag());
writeJson("pair-confirm-fingerprint.json", buildPairConfirmFingerprint());
writeJson("artifact-spillover.json", buildArtifactSpilloverFixture());
