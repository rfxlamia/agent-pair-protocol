# Developer guide — AgentPair

[Bahasa Indonesia](./developer-guide-ID.md) · [Docs index](./README.md) · [Root README](../README.md)

For contributors: monorepo layout, local relay, architecture, tests, and publishing.

## Monorepo layout

```text
agent-pair-protocol/
├── packages/
│   ├── protocol/            # @agentpair/protocol — crypto, envelopes, pairing, session SM
│   ├── mcp-server/          # agentpair — MCP tools + stores + runners
│   ├── relay/               # @agentpair/relay — dumb HTTP queue (private)
│   ├── relay-conformance/   # Offline relay wire-contract suite
│   └── runner-esp32/        # Optional Docker image (not wired into live runners)
├── docker-compose.yml
├── docs/
├── SPEC.md
└── vitest.config.ts
```

| Package | npm name | Role |
|---------|----------|------|
| `protocol` | `@agentpair/protocol` | Ed25519/X25519, XChaCha20-Poly1305, envelopes, SPAKE2 WASM, pairing, session state machine, fixtures |
| `mcp-server` | `agentpair` | MCP SDK tools, persistent stores, acceptance runners |
| `relay` | `@agentpair/relay` (private) | Inbox, allowlist, pairing relay, artifact blobs |
| `relay-conformance` | — | Conformance probes against a live relay |

**Architecture rules**

- Keys never leave `mcp-server`
- Relay sees routing metadata + ciphertext only
- Human gates = pending queue + `human_approve` with out-of-band `approval_code`
- Default-deny: relay and agent both enforce allowlists

## Development prerequisites

| Tool | Version | Why |
|------|---------|-----|
| Node.js | ≥ 22 | Runtime |
| pnpm | 10.x (`packageManager` in root `package.json`) | Workspace installs |
| Rust + wasm-pack | current | SPAKE2 WASM under `packages/protocol/wasm/spake2-pake/` |
| Docker | optional | Local relay via Compose |

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
cargo install wasm-pack
```

## First-time setup

```bash
git clone https://github.com/rfxlamia/agent-pair-protocol.git
cd agent-pair-protocol
pnpm install
pnpm build
```

`pnpm build` builds protocol (WASM + `tsc`) then mcp-server. Outputs:

- `packages/protocol/wasm/pkg/`
- `packages/protocol/dist/`
- `packages/mcp-server/dist/`

### Git hooks

| Hook | Runs |
|------|------|
| **pre-commit** | Biome on staged `*.{ts,js,json}` |
| **pre-push** | Build `@agentpair/protocol`, then workspace `typecheck`, then `pnpm test` |

`vitest` alone does **not** catch TypeScript errors (e.g. unused imports). Run package
`typecheck` (or rely on pre-push) before pushing.

## Local relay

### Docker Compose

```bash
docker compose up -d
curl -s http://127.0.0.1:3001/health
```

Expected claim shape:

```json
{
  "status": "ok",
  "spec_version": "1.0-draft",
  "relay_conformance": "agentpair-relay/1"
}
```

Compose binds `127.0.0.1:3001` and sets `AGENTPAIR_TRUST_PROXY=1`. Put a reverse
proxy or tunnel in front for public HTTPS.

### Without Docker

```bash
cd packages/relay
PORT=3001 AGENTPAIR_RELAY_DB=./relay.db pnpm exec tsx src/start.ts
```

### Useful routes (overview)

| Area | Role |
|------|------|
| `GET /health` | Liveness + conformance claim |
| Pairing routes | Manifest + SPAKE2 message relay |
| Allowlist | Signed allowlist push / fetch |
| Inbox | Challenge-response pull + enqueue |
| Artifacts | Content-addressed encrypted blobs |

Exact paths and wire rules: [SPEC.md](../SPEC.md) and `@agentpair/relay-conformance`.

## Running the MCP server

```bash
export AGENTPAIR_RELAY_URL=http://127.0.0.1:3001   # or https://relay.yagura.space
node packages/mcp-server/dist/cli.js
```

Programmatic (tests / embedding):

```ts
import { createMcpServer } from "agentpair";

const { server, context } = createMcpServer({
  relayUrl: "http://127.0.0.1:3001",
  dataDir: "/tmp/agentpair-dev",
});
```

Default CLI uses `resolveDataDir()` → `~/.agentpair` (file-backed stores).

## MCP server architecture

```text
AI client  --stdio MCP-->  mcp-server  --HTTPS-->  relay  --HTTPS-->  peer mcp-server
                              | keys, bonds, pending, sessions (local)
```

Session state machine lives in **`packages/protocol/src/session/state-machine.ts`**.
The MCP package wraps it in `tools/session.ts` and persists via stores under
`packages/mcp-server/src/store/`.

Tool handlers return MCP text content plus `structuredContent` JSON (typically
with an `ok` field). Strip secrets before anything reaches the model.

### Human gate (reference binding)

Gated actions (`pair_join`, session open, ratify) create a pending, then surface
an approval channel the model cannot forge:

1. **Create** — `PendingQueue` allocates `pending_id`, generates a 6-digit code,
   stores a verifier, writes `~/.agentpair/approvals/<pending_id>` (mode `0600`)
   via `store/approval-code.ts` (`writeApprovalFileSync`)
2. **Surface** — `tools/approval-surface.ts` attaches `approval_path` +
   `suggested_next` to the tool/inbox result; plaintext code is **not** in JSON.
   Best-effort: `console.error` on stderr
3. **Verify** — `human_approve` requires `approval_code`; missing →
   `self_approval_forbidden`; bad/malformed → `invalid_approval_code`
   (`tools/human-approve.ts`)
4. **Consume** — on success the pending and approval file are consumed/removed

Without reading `approval_path`, operators cannot complete gated steps. See also
the [user guide Human gates](./user-guide.md#human-gates) section.

### Adding a tool

1. Implement a handler under `packages/mcp-server/src/tools/`
2. Register it in `packages/mcp-server/src/index.ts` with a Zod `inputSchema`
3. Add unit/e2e coverage under `packages/mcp-server/src/`

## Protocol package

Public surface: `packages/protocol/src/index.ts` — keys, encrypt/sign, outer
envelopes (`createOuterEnvelope` / `verifyOuterEnvelope`), `receiveEnvelope`,
pairing flow, profiles, session store/SM, artifacts, allowlist helpers.

Wire version `v: 1`. Payload KDF info string: `agentpair-envelope-v1`.

### WASM

```bash
pnpm --filter @agentpair/protocol build:wasm
# or full:
pnpm --filter @agentpair/protocol build
```

### Golden fixtures

Fixed-input vectors for third-party Core conformance:

- Directory: `packages/protocol/fixtures/`
- Docs: [`fixtures/README.md`](../packages/protocol/fixtures/README.md)
- Regenerate: `pnpm --filter @agentpair/protocol run generate-fixtures`
- Verify: `pnpm --filter @agentpair/protocol run verify-fixtures`

## Acceptance runners

Registered in `packages/mcp-server/src/runners/registry.ts`:

| Name | Role |
|------|------|
| `payload-size` | Payload size / schema checks |
| `spectral` | OpenAPI lint |

`runner-esp32` / `codegen-compile` exist in-tree for future work but are **not**
in the live runner map.

## Testing

```bash
# Root (builds via pretest, then vitest)
pnpm test

# Per package
pnpm --filter @agentpair/protocol test
pnpm --filter agentpair test
pnpm --filter @agentpair/relay test
```

E2E happy paths (pair → negotiate → ratify over a live relay) live under
`packages/mcp-server/src/e2e/` (for example `happy-path.test.ts`,
`dual-server.ts`).

Typecheck before push:

```bash
pnpm -r --if-present typecheck
```

## Environment variables

| Variable | Package | Default | Purpose |
|----------|---------|---------|---------|
| `AGENTPAIR_RELAY_URL` | mcp-server | `http://127.0.0.1:3001` | Relay base URL |
| `AGENTPAIR_DATA_DIR` | mcp-server | `~/.agentpair` | Persistent host state |
| `AGENTPAIR_PEER_CONTENT_CAP_BYTES` | mcp-server | `8192` | Peer text cap for the model |
| `AGENTPAIR_PREFLIGHT` | mcp-server | `warn` | Health preflight mode |
| `PORT` | relay | `3001` | HTTP listen port |
| `AGENTPAIR_RELAY_DB` | relay | `/data/relay.db` | SQLite path |
| `AGENTPAIR_TRUST_PROXY` | relay | off (`1` in Compose) | Trust proxy headers from private peers |
| `AGENTPAIR_ARTIFACT_QUOTA_BYTES` | relay | unset | Optional health claim + enforcement |
| `AGENTPAIR_ARTIFACT_RETENTION_MS` | relay | unset | Optional health claim + retention |

## Code conventions

- ESM (`"type": "module"`)
- TypeScript strict; published packages compile to `dist/`
- Zod for MCP tool inputs
- `@noble/*` for crypto primitives (plus SPAKE2 WASM)
- Biome format: 2-space, double quotes, 100-char width
- Conventional Commits; prefer PRs

## Publish to npm

Requires npm org access, 2FA, and a successful WASM-capable build.

```bash
# From repo root — protocol first, then agentpair
pnpm publish:packages
```

Or manually:

```bash
pnpm build
cd packages/protocol && pnpm publish --access public
cd ../mcp-server && pnpm publish
```

Use **`pnpm publish`**, not bare `npm publish`, so `workspace:` deps rewrite to
semver. Current versions: see `packages/*/package.json` or
[npm agentpair](https://www.npmjs.com/package/agentpair) /
[@agentpair/protocol](https://www.npmjs.com/package/@agentpair/protocol).

## Production relay notes

```bash
docker compose build
docker compose up -d
curl -s http://127.0.0.1:3001/health
```

Expose only via TLS terminator. Point MCP clients at your public HTTPS URL.
A shared public test relay also exists: `https://relay.yagura.space`.

## Known limits

- Spec is **1.0-draft** until freeze
- Same-relay only for v1 peers
- MCP `pair_init` schema does not yet expose `profiles` (protocol supports them;
  e2e injects profiles including `atest/1` when needed)
- Live runners: `payload-size` and `spectral` only

## References

- [SPEC.md](../SPEC.md)
- [User guide](./user-guide.md)
- [Conformance checklist](./conformance-checklist.md)
- [Implement Core in a weekend](./implement-core-weekend.md)
- [ROADMAP.md](../ROADMAP.md)
