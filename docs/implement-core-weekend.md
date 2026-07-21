# Implement AgentPair Core in a weekend

[Bahasa Indonesia](./implement-core-weekend-ID.md) · [Docs index](./README.md)

Goal: a third-party **Core** implementation that interoperates with the reference
stack — identity, envelopes, relay client behavior, pairing/bonding, and
encrypted messaging — proven by **byte-matching** the published golden vectors.

Negotiation (`nego/1`) and acceptance testing (`atest/1`) are separate profiles.
You can ship useful apps on Core alone.

## What “done” looks like

1. Your code consumes the JSON fixtures under `packages/protocol/fixtures/` and
   produces the expected outputs bit-for-bit (where the fixture defines them).
2. Your receiver rejects the negative envelope cases with the expected error
   codes and step order.
3. Optionally: you can pair and exchange `core.msg` with `agentpair` over a
   shared relay (public test or local Compose).

Normative detail: [SPEC.md](../SPEC.md) (Core chapters). Checklist mapping MUST →
tests: [conformance-checklist.md](./conformance-checklist.md).

## Before you write code

| Resource | Use |
|----------|-----|
| [`packages/protocol/fixtures/README.md`](../packages/protocol/fixtures/README.md) | Fixture contract, harness fields, regenerate/verify commands |
| Fixture JSON files | Inputs + expected outputs |
| `@agentpair/protocol` on npm | Reference implementation (read behavior; do not copy blindly into your license surface) |
| Public relay | `https://relay.yagura.space` for live experiments |

Spec status is **1.0-draft** — expect wire changes until freeze.

## Suggested weekend plan

### Block 1 — Primitives

- Strict **base64url** (reject padding, non-alphabet, non-canonical) →
  `base64url.json`
- Ed25519 identity: `agent_id = "ed25519:" + base64url(pk)` → `keys.json`
- Sign / verify over exact transmitted bytes

### Block 2 — Payload encryption

- X25519 from Ed25519 keys, HKDF-SHA-256 with info `agentpair-envelope-v1`,
  XChaCha20-Poly1305 → `payload-encryption.json`
- Production must use a **fresh random nonce** per envelope; fixtures may ship
  `testOnlyNonceHex` only for reproducibility

### Block 3 — Outer envelopes

- Wire version `v: 1`, max **65536** UTF-8 bytes
- Sign-the-blob outer format → `envelope-core-msg.json`
- Ordered receive pipeline + errors → `envelope-negative.json`
  (version checks before signature verify; see fixture README for
  `envelope_too_large` generative case)

### Block 4 — Pairing tags / fingerprints

- Pairing fingerprint and `bond_ok` tag vectors:
  `pair-confirm-fingerprint.json`, `pair-confirm-fingerprint-v2.json`,
  `pair-bond-ok-tag.json`
- Implement SPAKE2 + relay pairing routes against SPEC; vectors lock the
  fingerprint/tag bytes your stack must match

### Block 5 — Artifacts (if you need large bodies)

- Spillover encrypt + ref → `artifact-spillover.json`

### Block 6 — Live smoke (optional same weekend)

1. Run or use a relay (`docker compose` or `https://relay.yagura.space`)
2. Pair your Core client with reference `agentpair` (or two of your hosts)
3. `core.msg` round-trip; confirm allowlist default-deny

## Fixture workflow in this repo

```bash
pnpm --filter @agentpair/protocol run verify-fixtures
pnpm --filter @agentpair/protocol run generate-fixtures   # maintainers only
```

CI fails when committed JSON drifts from the generator without review.

## Harness tips (`envelope-*.json`)

When driving a receiver from fixtures, honor the `harness` block:

- `nowUnix` — injected clock
- `isBonded` — default `true`
- `lastAcceptedSeq` — default `0`
- `self` — receiving agent (`alice` / `bob`)
- `dispatchError` — optional forced dispatch error

## Out of scope for Core weekend

- Full `nego/1` session machine (open → turn → sign → ratify)
- `atest/1` runners
- MCP binding (stdio tools) — that is one binding, not the protocol

When Core is green, add Negotiation using SPEC and the reference session state
machine in `packages/protocol/src/session/`.

## References

- [SPEC.md](../SPEC.md)
- [Conformance checklist](./conformance-checklist.md)
- [Developer guide](./developer-guide.md)
- [fixtures/README.md](../packages/protocol/fixtures/README.md)
