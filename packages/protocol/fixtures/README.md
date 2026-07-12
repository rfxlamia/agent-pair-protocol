# AgentPair Protocol Golden Test Vectors

Fixed-input JSON fixtures for third-party Core conformance testing. Each file
documents inputs and expected outputs; your implementation must byte-match the
expected values when given the same inputs.

## Regenerate

```bash
pnpm --filter @agentpair/protocol run generate-fixtures
```

## Files

| File | Verifies |
|------|----------|
| `keys.json` | Well-known Ed25519 test keypairs (includes secret keys) |
| `base64url.json` | Strict base64url decode (§3) |
| `payload-encryption.json` | HKDF + XChaCha20-Poly1305 with `agentpair-envelope-v1` |
| `envelope-core-msg.json` | Outer envelope v1 sign-the-blob happy path |
| `envelope-negative.json` | §10 error codes via `receiveEnvelope` harness |
| `pair-confirm-fingerprint.json` | §6.2 pairing fingerprint |
| `pair-bond-ok-tag.json` | §6.2 bond_ok tag |

## Harness contract (`envelope-*.json`)

When verifying via a receiver implementation, use the fixture `harness` block:

- `nowUnix` — inject as clock (never wall clock)
- `isBonded` — default `true`
- `lastAcceptedSeq` — default `0` (global per harness; single-thread fixtures only)
- `self` — receiving agent (`alice` or `bob`)

## Unit tests vs fixture tests

`src/crypto/base64url.test.ts` and `fixtures/base64url.json` cover the same cases
intentionally: unit tests guard the implementation; fixture JSON is the published
contract third parties byte-match against.

## `testOnlyNonce`

Fixtures that encrypt payloads include `testOnlyNonceHex` (24 bytes). Production
code MUST use a fresh random nonce per envelope (§3). The fixed nonce exists
only so ciphertext is reproducible in tests.

## Ed25519 determinism

Given fixed message bytes and a fixed secret key, Ed25519 signatures are
exactly reproducible across implementations.
