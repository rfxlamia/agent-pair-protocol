# AgentPair Protocol Golden Test Vectors

Fixed-input JSON fixtures for third-party Core conformance testing. Each file
documents inputs and expected outputs; your implementation must byte-match the
expected values when given the same inputs.

## Regenerate

```bash
pnpm --filter @agentpair/protocol run generate-fixtures
```

CI runs `pnpm --filter @agentpair/protocol run verify-fixtures` to fail when
committed JSON drifts from the generator without an intentional review.

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
| `artifact-spillover.json` | §5 artifact blob encrypt + spill ref golden vector |

## Harness contract (`envelope-*.json`)

When verifying via a receiver implementation, use the fixture `harness` block:

- `nowUnix` — inject as clock (never wall clock)
- `isBonded` — default `true` (`recipient_not_allowed` uses `false`)
- `lastAcceptedSeq` — default `0` (global per harness; single-thread fixtures only)
- `self` — receiving agent (`alice` or `bob`)
- `dispatchError` — optional; when set, step 8 dispatch returns that error (e.g.
  `unsupported_envelope_type`)

Negative cases assume SPEC §4.3 step order (version check before signature verify).
Each wire is a single-fault case unless noted below.

### `envelope_too_large` (generative)

This case has `bodySize` (65537) but no committed `wire`. Synthesize any UTF-8
outer JSON wire whose byte length equals `bodySize` and whose outer `v` is `1`.
The reference tests pad a valid `v:1` core wire by adding a `_pad` field until
the UTF-8 length is exact. Your receiver must return `envelope_too_large` when
the wire exceeds 65536 UTF-8 bytes — check size before `JSON.parse` per §4.3 step 1.

## Unit tests vs fixture tests

`src/crypto/base64url.test.ts` and `fixtures/base64url.json` cover the same cases
intentionally: unit tests guard the implementation; fixture JSON is the published
contract third parties byte-match against.

## Fixed nonce (`testOnlyNonceHex`)

Fixtures that encrypt payloads include `testOnlyNonceHex` (24 bytes). Production
code MUST use a fresh random nonce per envelope (§3). The fixed nonce exists only
so ciphertext is reproducible in tests. Deterministic encryption helpers live in
`src/fixtures/crypto-fixtures.ts` and are not exported from the package entry.

## Ed25519 determinism

Given fixed message bytes and a fixed secret key, Ed25519 signatures are
exactly reproducible across implementations.

## HKDF domain string

Payload encryption uses HKDF-SHA-256 with info = `"agentpair-envelope-v1"`.
`@agentpair/protocol@0.4.0` and later use this string; `0.3.0` used
`agentpair-envelope-v0` — ciphertext is not interoperable across that boundary.
