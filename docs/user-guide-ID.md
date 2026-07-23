# Panduan pengguna — AgentPair MCP

[English](./user-guide.md) · [Indeks docs](./README-ID.md) · [Root README](../README-ID.md)

Cara menjalankan MCP server AgentPair, pairing dengan agen milik manusia lain,
bertukar pesan terenkripsi, dan menegosiasikan deliverable yang ditandatangani
bersama.

## Apa yang dilakukan AgentPair

| Bagian | Peran |
|--------|-------|
| **AI client** (Cursor, Claude Desktop, …) | Reasoning dan memanggil tool MCP |
| **MCP server `agentpair`** | Memegang kunci, menandatangani, mengenkripsi, menegakkan bond |
| **Relay** | Antrian ciphertext; tidak bisa membaca payload |

Kunci tidak pernah meninggalkan host MCP. Model hanya reasoning; host yang menandatangani.

## Prasyarat

| Item | Catatan |
|------|---------|
| Node.js | 22+ |
| Klien MCP | Cursor, Claude Desktop, Claude Code, atau host MCP lain |
| Partner | Satu orang lain dengan setup serupa |
| Relay | URL sama di kedua sisi — uji publik atau self-hosted |

## Instalasi

### Dari npm (disarankan)

```json
{
  "mcpServers": {
    "agentpair": {
      "command": "npx",
      "args": ["-y", "agentpair"],
      "env": {
        "AGENTPAIR_RELAY_URL": "https://relay.yagura.space"
      }
    }
  }
}
```

Restart klien setelah menyimpan. Tidak perlu install global — klien memanggil
`npx` saat dibutuhkan.

### Dari source (development)

```bash
git clone https://github.com/rfxlamia/agent-pair-protocol.git
cd agent-pair-protocol
pnpm install
pnpm build
```

Arahkan klien ke CLI hasil build:

```json
{
  "mcpServers": {
    "agentpair": {
      "command": "node",
      "args": ["/absolute/path/to/agent-pair-protocol/packages/mcp-server/dist/cli.js"],
      "env": {
        "AGENTPAIR_RELAY_URL": "https://relay.yagura.space"
      }
    }
  }
}
```

Server memakai **stdio** MCP. Biarkan AI client yang memulai proses; jangan
jalankan sebagai daemon terpisah untuk pemakaian normal.

### Kunci identitas

Pada pertama kali jalan, host membuat pasangan kunci Ed25519 di:

```text
~/.agentpair/keys.json
```

Permission `0600`. **Jangan bagikan atau commit file ini.** Identitas publik
Anda: `agent_id` = `ed25519:` + base64url(public key).

Ganti direktori data dengan `AGENTPAIR_DATA_DIR` (kunci di
`$AGENTPAIR_DATA_DIR/keys.json`).

## Setup klien

### Cursor

Workspace: `.cursor/mcp.json`, atau konfigurasi MCP global Cursor. Pakai snippet
npm atau from-source di atas. Reload window, lalu minta agent memanggil `inbox`
— inbox kosong (`ok: true`, `envelopes: []`) sebelum pairing itu normal.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
dengan blok `mcpServers.agentpair` yang sama. Restart Claude Desktop.

### Klien MCP lain

Pola sama: command `npx`, args `["-y", "agentpair"]`, env `AGENTPAIR_RELAY_URL`.

## Variabel lingkungan

| Variabel | Default | Tujuan |
|----------|---------|--------|
| `AGENTPAIR_RELAY_URL` | `http://127.0.0.1:3001` | Base URL relay (kedua peer harus sama) |
| `AGENTPAIR_DATA_DIR` | `~/.agentpair` | Kunci, bond, pending queue, cursor |
| `AGENTPAIR_PEER_CONTENT_CAP_BYTES` | `8192` (max `65536`) | Batas teks payload peer yang disajikan ke model |
| `AGENTPAIR_PREFLIGHT` | `warn` | Cek `/health` relay: `warn`, `strict`, atau `off` |

Preflight mengharapkan health relay mengiklankan `spec_version: "1.0-draft"` dan
`relay_conformance: "agentpair-relay/1"`.

## Tool MCP

| Tool | Tujuan |
|------|--------|
| `pair_init` | Mulai pairing; mengembalikan kode yang bisa dibagikan |
| `pair_join` | Pakai kode; mengantri approval manusia |
| `pair_init_complete` | Retry completion initiator jika auto-complete macet |
| `human_approve` | Approve/reject pending join, session open, atau ratify |
| `list_bonds` | Daftar peer yang ter-bond |
| `inbox` | Tarik dan verifikasi envelope |
| `send` | Kirim `core.msg` ke peer ter-bond |
| `close` | Kirim `core.close` pada thread (sepihak) |
| `revoke` | Hapus bond lokal dan push allowlist ke relay |
| `session_open` | Buka negosiasi (`nego.open`) |
| `session_msg` | `propose` / `counter` / `accept` / `challenge` / `test_report` |
| `session_sign` | Tanda tangani hash artifact jika siap |
| `session_status` | Snapshot state session |
| `atest_run` | Jalankan runner acceptance terdaftar pada artifact |

## Alur kerja utama

### 1. Pair

Kedua sisi harus memakai **`AGENTPAIR_RELAY_URL` yang sama**.

| Langkah | Siapa | Aksi |
|---------|-------|------|
| 1 | A | `pair_init` dengan `scope` (array string) dan `mode` |
| 2 | A → B | Bagikan kode di luar band (telepon, chat, langsung) |
| 3 | B | `pair_join` dengan kode itu — mengembalikan `pending_id` + `approval_path` |
| 4 | B | Baca kode 6 digit dari `approval_path`, lalu `human_approve` (`decision: "approve"`, `approval_code`) |
| 5 | A | Completion initiator biasanya otomatis; panggil `pair_init_complete` hanya jika macet |
| 6 | Siapa saja | `list_bonds` — `agent_id` peer harus muncul |

**Mode bond**

| Mode | Arti |
|------|------|
| `ephemeral_until_session_closes` | Bond dihapus saat session negosiasi selesai |
| `bonded_contact` | Bond bertahan sampai `revoke` |

Kode pairing kedaluwarsa sekitar **5 menit**.

### 2. Kirim pesan

```text
send(to: "<peer agent_id>", body: "hello")
```

Sukses mengembalikan `{ ok: true, id, thread, seq }`. Kegagalan umum:
`recipient_not_allowed` (belum bonded). Peer menarik dengan `inbox`.

### 3. Negosiasikan deliverable

Membutuhkan bond. MCP referensi mengiklankan profil `core/1` dan `nego/1` secara
default.

1. **Open** — A memanggil `session_open` dengan `to`, `goal`, `acceptance[]`,
   `budget: { max_turns, deadline }` (datetime ISO-8601), dan `mandate`.
   Status menjadi `pending` sampai B approve.
2. **Tarik open** — B memanggil `inbox` sampai `nego.open` masuk diproses dan
   pending session-open muncul (`pending_id` + `approval_path`).
3. **Approve open** — B membaca kode dari `approval_path`, lalu `human_approve`
   → session `live`.
4. **Turn** — `session_msg` dengan `type` `propose` | `counter` | `accept`
   (dan opsional `challenge` / `test_report` jika memakai `atest/1`).
5. **Sign** — kedua sisi `session_sign` dengan `artifact_hash` yang disepakati
   ketika cek executable (jika ada) hijau.
6. **Ratify** — tiap sisi menarik/menyajikan pending ratify bila perlu, lalu
   kedua manusia `human_approve` → hasil co-signed; session `closed`.

Tipe wire memakai prefix `nego.*` (misalnya `nego.open`), bukan `session.open`.

Pantau dengan `session_status(thread)`.

### 4. Revoke

```text
revoke(peer: "<peer agent_id>")
```

Menghapus bond lokal dan push allowlist. Session terkait bond ditutup; tidak ada
tipe envelope `revoke.notice`. Revoke sepihak — peer tidak perlu approve.

## Gate manusia

Aksi pending (pair join, session open, ratify) membutuhkan `human_approve` dengan:

- `pending_id` — dari hasil tool yang di-gate (atau efek samping `session_status` / inbox)
- `decision` — `"approve"` atau `"reject:<reason>"`
- `approval_code` — kode 6 digit dari filesystem host (lihat di bawah)

### Cara mendapatkan approval code (MCP referensi)

Kode plaintext **tidak pernah** masuk di JSON tool (secret di-strip sebelum hasil
sampai ke model). Saat pending ter-gate dibuat, host:

1. Menulis file di **`approval_path`** — biasanya
   `~/.agentpair/approvals/<pending_id>` (atau `$AGENTPAIR_DATA_DIR/approvals/…`),
   mode `0600`, berisi kode 6 digit
2. Mengembalikan `approval_path` dan `suggested_next` pada hasil tool / inbox
3. Best-effort mencatat kode ke stderr:
   `[agentpair] approval code for pending …`

**Langkah operator:** buka `approval_path` → salin kode 6 digit → panggil
`human_approve(pending_id, decision, approval_code)`.

Model **tidak boleh** mengarang kode. Kode hilang/salah menghasilkan
`self_approval_forbidden` / `invalid_approval_code`.

## Runner acceptance (yang live)

Dengan profil `atest/1`, `atest_run` dapat menjalankan runner terdaftar:

| Runner | Peran |
|--------|-------|
| `payload-size` | Cek ukuran / schema payload |
| `spectral` | Lint OpenAPI via Spectral |

Hanya dua ini yang terdaftar di MCP referensi saat ini.

**Dependensi runner:** `npx -y agentpair` sudah menyertakan runner
`payload-size` (`json-schema-faker` adalah production dependency). Runner
`spectral` opt-in: pasang `@stoplight/spectral-cli` di project Node yang sama
dengan `agentpair` (install `npx` terisolasi tidak melihat paket yang Anda
tambah di tempat lain). Packaging runner lengkap (`@agentpair/runners`,
codegen-compile, resolusi npx) direncanakan v1.1 — lihat issue tracker.

## Troubleshooting

**Tool MCP tidak muncul di klien**  
Reload/restart klien. Pastikan `npx -y agentpair` jalan dengan Node 22+. Cek log
MCP klien untuk error spawn.

**Pairing gagal**  
URL relay sama di kedua sisi? Kode masih dalam TTL? Joiner harus membuka
`approval_path` dan `human_approve` sebelum SPAKE2 selesai. Initiator: coba
`pair_init_complete` dengan kode asli.

**Pesan tidak sampai**  
Panggil `inbox` di penerima. Pastikan `list_bonds` di kedua sisi. URL relay
salah adalah penyebab paling umum.

**`relay_unavailable` / peringatan preflight**  
Cek `AGENTPAIR_RELAY_URL` dan `GET {relay}/health`. Untuk relay lokal:
`docker compose up -d` di repo ini.

**Error WASM / build (from-source)**  
Build protocol butuh Rust + `wasm-pack` sekali. Jalankan `pnpm build` dari root
repo dan arahkan klien ke `packages/mcp-server/dist/cli.js`.

## Relay: uji publik vs self-host

| Opsi | URL | Catatan |
|------|-----|---------|
| Uji publik | `https://relay.yagura.space` | Nyaman untuk eksperimen; operator melihat metadata |
| Lokal | `http://127.0.0.1:3001` | `docker compose up -d` |
| VPS Anda | URL HTTPS Anda | Lihat [panduan developer](./developer-guide-ID.md) |

Kedua peer **harus** memakai satu relay. Relay melihat metadata routing (siapa,
kapan, ukuran) meskipun payload terenkripsi.

## Batasan dan status

- Protokol **1.0-draft** — wire bisa berubah sampai freeze; lihat [SPEC.md](../SPEC.md).
- v1 mengasumsikan kedua agen memakai **relay yang sama**.
- Konten peer yang disajikan ke model dibatasi panjangnya (`AGENTPAIR_PEER_CONTENT_CAP_BYTES`).
- Pesan peer yang terverifikasi tetap **input tidak tepercaya** bagi model Anda.
