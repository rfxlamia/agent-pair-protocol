# @agentpair/relay-conformance

Offline HTTP contract suite for AgentPair relay implementations. Probes exercise the external relay API via `fetch`; unit tests in `@agentpair/relay` own behavioral edge cases.

This package is **not** preflight (live deployment checks — see T9). It runs locally or in CI against any reachable relay base URL.

## Probe classes

| Class | CLI gate | Exit on failure |
|-------|----------|-----------------|
| **REQUIRED (fast)** | default | yes (`exit 1`) |
| **slow** | `--slow` | yes when enabled |
| **large** | `--large` | yes when enabled |
| **ADVISORY** | internal (`advisoryProbe` option) | no (`exit 0`, warning only) |

## Probes

| Probe id | Class | Purpose |
|----------|-------|---------|
| `default-deny` | REQUIRED | Inbox POST denied without allowlist (`recipient_not_allowed`) |
| `challenge-roundtrip` | REQUIRED | Inbox GET challenge → signed pull |
| `allowlist-blob` | REQUIRED | Sign-the-blob allowlist PUT |
| `inbox-idempotency` | REQUIRED | Byte-identical inbox POST retry → `204` |
| `hash-verify` | REQUIRED | Artifact PUT `hash_mismatch` |
| `purge-dyad` | REQUIRED | Inbox purge with challenge auth |
| `inbox-pull-shape` | REQUIRED | Inbox GET JSON shape (`envelopes`, `cursor`, `gaps`) |
| `pair-ttl` | slow | Pair session expires after fixed TTL |
| `artifact-10mb` | large | 10 MiB authenticated artifact upload |
| `reference-divergent` | ADVISORY | Pull omits `gaps` when sequence gap exists |

## Mapping to relay unit tests

| Probe | Primary relay unit test file |
|-------|------------------------------|
| `default-deny` | `packages/relay/src/routes/inbox.test.ts` |
| `challenge-roundtrip` | `packages/relay/src/routes/inbox.test.ts` |
| `allowlist-blob` | `packages/relay/src/routes/allowlist.test.ts` |
| `inbox-idempotency` | `packages/relay/src/routes/inbox.test.ts` |
| `hash-verify` | `packages/relay/src/routes/artifact.test.ts` |
| `purge-dyad` | `packages/relay/src/routes/inbox.test.ts` |
| `inbox-pull-shape` | `packages/relay/src/routes/inbox.test.ts` |
| `pair-ttl` | `packages/relay/src/routes/pair.test.ts` |
| `artifact-10mb` | `packages/relay/src/routes/artifact.test.ts` |

## Usage

```bash
# Fast REQUIRED probes only (default CI)
pnpm --filter @agentpair/relay-conformance conformance -- http://127.0.0.1:8787

# Include slow and large gates
pnpm --filter @agentpair/relay-conformance conformance -- --slow --large http://127.0.0.1:8787

# Package tests (in-process relay via fetch bridge)
pnpm --filter @agentpair/relay-conformance test
```

## Suite vs preflight

- **Suite (this package):** offline contract probes; deterministic; no deployment assumptions.
- **Preflight (T9):** live deployment checks; not implemented here.

## In-process testing

`fetch-bridge.ts` patches `globalThis.fetch` to route requests to a Hono `app.request` adapter. Tests use `transformResponse` to simulate divergent implementations (e.g. stripping `gaps`) without relay-specific flags.
