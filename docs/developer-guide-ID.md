# Panduan developer — AgentPair

[English](./developer-guide.md) · [Indeks docs](./README-ID.md) · [Root README](../README-ID.md)

Untuk kontributor: layout monorepo, relay lokal, arsitektur, test, dan publish.

## Layout monorepo

```text
agent-pair-protocol/
├── packages/
│   ├── protocol/            # @agentpair/protocol — crypto, envelope, pairing, session SM
│   ├── mcp-server/          # agentpair — tool MCP + store + runner
│   ├── relay/               # @agentpair/relay — antrian HTTP bodoh (private)
│   ├── relay-conformance/   # Suite kontrak wire relay offline
│   └── runner-esp32/        # Image Docker opsional (belum di runner live)
├── docker-compose.yml
├── docs/
├── SPEC.md
└── vitest.config.ts
```

| Paket | Nama npm | Peran |
|-------|----------|-------|
| `protocol` | `@agentpair/protocol` | Ed25519/X25519, XChaCha20-Poly1305, envelope, SPAKE2 WASM, pairing, session state machine, fixture |
| `mcp-server` | `agentpair` | Tool MCP SDK, store persisten, runner acceptance |
| `relay` | `@agentpair/relay` (private) | Inbox, allowlist, pairing relay, artifact blob |
| `relay-conformance` | — | Probe conformance terhadap relay hidup |

**Aturan arsitektur**

- Kunci tidak pernah meninggalkan `mcp-server`
- Relay hanya melihat metadata routing + ciphertext
- Human gate = antrian pending + `human_approve` dengan `approval_code` luar band
- Default-deny: relay dan agen sama-sama menegakkan allowlist

## Prasyarat development

| Tool | Versi | Untuk |
|------|-------|-------|
| Node.js | ≥ 22 | Runtime |
| pnpm | 10.x (`packageManager` di root `package.json`) | Install workspace |
| Rust + wasm-pack | terkini | SPAKE2 WASM di `packages/protocol/wasm/spake2-pake/` |
| Docker | opsional | Relay lokal via Compose |

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
cargo install wasm-pack
```

## Setup awal

```bash
git clone https://github.com/rfxlamia/agent-pair-protocol.git
cd agent-pair-protocol
pnpm install
pnpm build
```

`pnpm build` membangun protocol (WASM + `tsc`) lalu mcp-server. Output:

- `packages/protocol/wasm/pkg/`
- `packages/protocol/dist/`
- `packages/mcp-server/dist/`

### Git hooks

| Hook | Menjalankan |
|------|-------------|
| **pre-commit** | Biome pada `*.{ts,js,json}` yang di-stage |
| **pre-push** | Build `@agentpair/protocol`, lalu `typecheck` workspace, lalu `pnpm test` |

`vitest` **tidak** menangkap error TypeScript. Jalankan `typecheck` paket (atau
andalkan pre-push) sebelum push.

## Relay lokal

### Docker Compose

```bash
docker compose up -d
curl -s http://127.0.0.1:3001/health
```

Bentuk claim yang diharapkan:

```json
{
  "status": "ok",
  "spec_version": "1.0-draft",
  "relay_conformance": "agentpair-relay/1"
}
```

Compose bind `127.0.0.1:3001` dan set `AGENTPAIR_TRUST_PROXY=1`. Taruh reverse
proxy atau tunnel di depan untuk HTTPS publik.

### Tanpa Docker

```bash
cd packages/relay
PORT=3001 AGENTPAIR_RELAY_DB=./relay.db pnpm exec tsx src/start.ts
```

### Ringkasan route

| Area | Peran |
|------|-------|
| `GET /health` | Liveness + claim conformance |
| Pairing | Manifest + relay pesan SPAKE2 |
| Allowlist | Push / fetch allowlist bertanda tangan |
| Inbox | Pull challenge-response + enqueue |
| Artifacts | Blob terenkripsi content-addressed |

Path dan aturan wire lengkap: [SPEC.md](../SPEC.md) dan `@agentpair/relay-conformance`.

## Menjalankan MCP server

```bash
export AGENTPAIR_RELAY_URL=http://127.0.0.1:3001   # atau https://relay.yagura.space
node packages/mcp-server/dist/cli.js
```

Programatik (test / embedding):

```ts
import { createMcpServer } from "agentpair";

const { server, context } = createMcpServer({
  relayUrl: "http://127.0.0.1:3001",
  dataDir: "/tmp/agentpair-dev",
});
```

CLI default memakai `resolveDataDir()` → `~/.agentpair` (store berbasis file).

## Arsitektur MCP server

```text
AI client  --stdio MCP-->  mcp-server  --HTTPS-->  relay  --HTTPS-->  peer mcp-server
                              | kunci, bond, pending, session (lokal)
```

Session state machine ada di **`packages/protocol/src/session/state-machine.ts`**.
Paket MCP membungkusnya di `tools/session.ts` dan menyimpan state di
`packages/mcp-server/src/store/`.

Handler tool mengembalikan konten teks MCP plus `structuredContent` JSON
(biasanya ada field `ok`). Strip secret sebelum apa pun sampai ke model.

### Menambah tool

1. Implementasikan handler di `packages/mcp-server/src/tools/`
2. Daftarkan di `packages/mcp-server/src/index.ts` dengan Zod `inputSchema`
3. Tambah coverage unit/e2e di `packages/mcp-server/src/`

## Paket protocol

Surface publik: `packages/protocol/src/index.ts` — kunci, encrypt/sign, outer
envelope (`createOuterEnvelope` / `verifyOuterEnvelope`), `receiveEnvelope`,
pairing flow, profil, session store/SM, artifact, helper allowlist.

Versi wire `v: 1`. Info string KDF payload: `agentpair-envelope-v1`.

### WASM

```bash
pnpm --filter @agentpair/protocol build:wasm
# atau penuh:
pnpm --filter @agentpair/protocol build
```

### Golden fixture

Vektor input tetap untuk conformance Core pihak ketiga:

- Direktori: `packages/protocol/fixtures/`
- Docs: [`fixtures/README.md`](../packages/protocol/fixtures/README.md)
- Regenerate: `pnpm --filter @agentpair/protocol run generate-fixtures`
- Verify: `pnpm --filter @agentpair/protocol run verify-fixtures`

## Runner acceptance

Terdaftar di `packages/mcp-server/src/runners/registry.ts`:

| Nama | Peran |
|------|-------|
| `payload-size` | Cek ukuran / schema payload |
| `spectral` | Lint OpenAPI |

`runner-esp32` / `codegen-compile` ada di tree untuk kerja nanti tetapi **tidak**
ada di map runner live.

## Testing

```bash
# Root (build via pretest, lalu vitest)
pnpm test

# Per paket
pnpm --filter @agentpair/protocol test
pnpm --filter agentpair test
pnpm --filter @agentpair/relay test
```

Happy path e2e (pair → negotiate → ratify lewat relay hidup) di
`packages/mcp-server/src/e2e/` (mis. `happy-path.test.ts`, `dual-server.ts`).

Typecheck sebelum push:

```bash
pnpm -r --if-present typecheck
```

## Variabel lingkungan

| Variabel | Paket | Default | Tujuan |
|----------|-------|---------|--------|
| `AGENTPAIR_RELAY_URL` | mcp-server | `http://127.0.0.1:3001` | Base URL relay |
| `AGENTPAIR_DATA_DIR` | mcp-server | `~/.agentpair` | State host persisten |
| `AGENTPAIR_PEER_CONTENT_CAP_BYTES` | mcp-server | `8192` | Cap teks peer untuk model |
| `AGENTPAIR_PREFLIGHT` | mcp-server | `warn` | Mode preflight health |
| `PORT` | relay | `3001` | Port listen HTTP |
| `AGENTPAIR_RELAY_DB` | relay | `/data/relay.db` | Path SQLite |
| `AGENTPAIR_TRUST_PROXY` | relay | off (`1` di Compose) | Percayai header proxy dari peer privat |
| `AGENTPAIR_ARTIFACT_QUOTA_BYTES` | relay | unset | Claim health opsional + enforcement |
| `AGENTPAIR_ARTIFACT_RETENTION_MS` | relay | unset | Claim health opsional + retention |

## Konvensi kode

- ESM (`"type": "module"`)
- TypeScript strict; paket publish compile ke `dist/`
- Zod untuk input tool MCP
- `@noble/*` untuk primitif crypto (plus SPAKE2 WASM)
- Format Biome: indent 2 spasi, double quotes, lebar 100
- Conventional Commits; lebih suka PR

## Publish ke npm

Butuh akses org npm, 2FA, dan build yang mendukung WASM.

```bash
# Dari root repo — protocol dulu, lalu agentpair
pnpm publish:packages
```

Atau manual:

```bash
pnpm build
cd packages/protocol && pnpm publish --access public
cd ../mcp-server && pnpm publish
```

Pakai **`pnpm publish`**, bukan `npm publish` mentah, agar dependency `workspace:`
tertulis ulang ke semver. Versi terkini: lihat `packages/*/package.json` atau
[npm agentpair](https://www.npmjs.com/package/agentpair) /
[@agentpair/protocol](https://www.npmjs.com/package/@agentpair/protocol).

## Catatan relay produksi

```bash
docker compose build
docker compose up -d
curl -s http://127.0.0.1:3001/health
```

Expose hanya lewat TLS terminator. Arahkan klien MCP ke URL HTTPS publik Anda.
Relay uji publik bersama juga tersedia: `https://relay.yagura.space`.

## Batasan yang diketahui

- Spec **1.0-draft** sampai freeze
- Peer v1 hanya same-relay
- Schema MCP `pair_init` belum mengekspos `profiles` (protocol mendukungnya;
  e2e menyuntikkan profil termasuk `atest/1` bila perlu)
- Runner live: hanya `payload-size` dan `spectral`

## Referensi

- [SPEC.md](../SPEC.md)
- [Panduan pengguna](./user-guide-ID.md)
- [Conformance checklist](./conformance-checklist.md)
- [Implementasi Core dalam weekend](./implement-core-weekend-ID.md)
- [ROADMAP.md](../ROADMAP.md)
