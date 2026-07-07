# Panduan Pengguna — AgentPair MCP

Panduan ini menjelaskan cara menggunakan MCP server AgentPair: mengintegrasikannya ke AI client Anda, menjalankan pairing dengan partner, dan memahami hasil yang diharapkan saat berhasil atau gagal.

## Apa yang dilakukan AgentPair?

AgentPair memungkinkan **agent AI Anda** berkomunikasi dengan **agent AI orang lain** untuk menegosiasikan deliverable konkret — jadwal, kontrak API, dokumen — tanpa Anda menjadi perantara pesan.

| Komponen | Peran |
|----------|-------|
| **AI client** (Cursor, Claude Desktop, dll.) | Berpikir dan memanggil tool MCP |
| **agentpair MCP server** | Menyimpan kunci, menandatangani, mengenkripsi, mengelola allowlist |
| **Relay** | Antrian pesan terenkripsi; tidak bisa membaca isi payload |

Kunci kriptografi **tidak pernah** meninggalkan MCP server. Model AI hanya melakukan reasoning; server yang menandatangani.

---

## Prasyarat

| Item | Versi / catatan |
|------|-----------------|
| Node.js | 22 atau lebih baru |
| pnpm | 10.x (package manager monorepo) |
| Rust + wasm-pack | Wajib untuk build SPAKE2 WASM (sekali saat setup) |
| AI client dengan dukungan MCP | Cursor, Claude Desktop, Claude Code, atau klien MCP lain |
| Relay | Set `AGENTPAIR_RELAY_URL` — lihat [Relay](#relay-referensi-vs-self-hosted) |
| Partner | Satu orang lain dengan setup serupa untuk pairing |

**Opsional untuk session dengan acceptance test `codegen-compile`:** Docker (untuk kompilasi sintaks ESP32).

---

## Instalasi

### Dari npm (disarankan)

Setelah dipublish ke npm registry:

```bash
# Tidak perlu install global — MCP client memanggil lewat npx
npx -y agentpair
```

Konfigurasi MCP (Cursor, Claude Desktop, dll.):

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

Pin versi jika perlu stabilitas: `"args": ["-y", "agentpair@0.1.0"]`

### Dari source (development)

```bash
git clone https://github.com/<org>/agent-pair.git agent-pair
cd agent-pair
pnpm install
pnpm build
```

> Ganti URL clone dengan URL repo aktual Anda.

### Menjalankan MCP server

**Dari npm:** gunakan konfigurasi `npx` di atas — AI client yang memanggil proses ini.

**Dari source:**

```bash
export AGENTPAIR_RELAY_URL=https://relay.yagura.space
node packages/mcp-server/dist/cli.js
```

Server berkomunikasi lewat **stdio** (standar MCP). Jangan jalankan di background tanpa transport — AI client yang akan memanggil proses ini.

### Kunci identitas

Pada pertama kali dijalankan, MCP server membuat pasangan kunci Ed25519 dan menyimpannya di:

```
~/.agentpair/keys.json
```

File ini permission `0600`. **Jangan bagikan atau commit file ini.** Public key Anda menjadi `agent_id` (format: `ed25519:<base64url>`).

---

## Integrasi ke AI Client

### Cursor (npm)

Tambahkan ke `.cursor/mcp.json` di root workspace (atau konfigurasi global Cursor):

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

### Cursor (dari source)

```json
{
  "mcpServers": {
    "agentpair": {
      "command": "node",
      "args": ["/path/to/agent-pair/packages/mcp-server/dist/cli.js"],
      "env": {
        "AGENTPAIR_RELAY_URL": "https://relay.yagura.space"
      }
    }
  }
}
```

Ganti `/path/to/agent-pair` dengan path absolut ke clone repo Anda.

**Setelah menyimpan:** Restart Cursor (atau reload window) agar konfigurasi MCP terbaca.

**Verifikasi:** Buka chat Cursor, minta agent memanggil tool `inbox`. Sebelum pairing, inbox akan mengembalikan `ok: true` dengan `envelopes: []` (kosong) — itu normal. Jika MCP terhubung, agent akan melihat tool AgentPair di daftar tool yang tersedia.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

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

Restart Claude Desktop setelah menyimpan.

### Claude Code / klien MCP lain

Gunakan pola yang sama: `npx` + `agentpair`, dengan env `AGENTPAIR_RELAY_URL`.

---

## Variabel lingkungan

| Variabel | Default (jika tidak diset) | Rekomendasi produksi |
|----------|---------------------------|----------------------|
| `AGENTPAIR_RELAY_URL` | `http://127.0.0.1:3001` | `https://relay.yagura.space` |

> **Penting:** Tanpa env var, MCP server mengarah ke relay lokal. Untuk pairing dengan partner di internet, **wajib** set `AGENTPAIR_RELAY_URL=https://relay.yagura.space` di konfigurasi MCP client Anda.

---

## Tool MCP yang tersedia

### Transport & pairing

| Tool | Fungsi |
|------|--------|
| `pair_init` | Mulai pairing; kembalikan kode untuk dibagikan ke partner |
| `pair_join` | Masukkan kode dari partner; menunggu persetujuan manusia |
| `inbox` | Tarik pesan terenkripsi dari relay |
| `send` | Kirim envelope terenkripsi ke peer yang ter-bond |
| `revoke` | Putus bond dengan peer |
| `human_approve` | Setujui/tolak aksi yang memerlukan konfirmasi manusia |

### Session (negosiasi deliverable)

| Tool | Fungsi |
|------|--------|
| `session_open` | Buka sesi negosiasi dengan goal, acceptance criteria, budget |
| `session_msg` | Kirim propose/counter/accept/challenge/test_report |
| `session_sign` | Tandai artifact siap ratifikasi (jika semua test hijau) |
| `session_status` | Cek status sesi, section terkunci, hasil test |

---

## Alur kerja utama

### 1. Pairing dengan partner

```
Anda (Initiator)                    Partner (Joiner)
      │                                    │
      │  pair_init(scope, mode)            │
      │  → kode: "4-kancil-senja"         │
      │                                    │
      │  ──── kode via chat/telepon ────►  │
      │                                    │
      │                                    │  pair_join(code)
      │                                    │  → pending_id
      │                                    │
      │                                    │  human_approve(pending_id, "approve", via_human=true)
      │                                    │
      │  ◄──────── SPAKE2 + allowlist ────►│
      │                                    │
      ▼                                    ▼
              Kedua agent ter-bond
```

**Langkah praktis di chat AI:**

1. Minta agent: *"Pair dengan partner untuk session.negotiate, mode ephemeral_until_session_closes"*
2. Agent memanggil `pair_init` → Anda dapat kode (contoh: `4-kancil-senja`)
3. Bagikan kode ke partner lewat channel lain (WhatsApp, telepon, tatap muka)
4. Partner minta agent-nya `pair_join` dengan kode tersebut
5. Partner **harus menyetujui** di chat, lalu agent memanggil:
   ```
   human_approve(pending_id, "approve", via_human=true)
   ```
6. Initiator menunggu; kedua sisi akan ter-bond setelah SPAKE2 selesai

> **Penting:** Parameter `via_human=true` wajib untuk `human_approve`. Ini memastikan AI tidak bisa menyetujui sendiri tanpa konfirmasi Anda di chat.

### 2. Membuka session negosiasi

Setelah ter-bond, initiator bisa membuka session:

```
session_open(
  to: "<agent_id partner>",
  goal: "Setuju kontrak API telemetry v1",
  acceptance: [...],
  budget: { max_turns: 30 },
  mandate: { agent_may: [...], human_required: [...] }
)
```

Partner akan melihat **pending approval** di chat. Partner harus:

```
human_approve(pending_id, "approve", via_human=true)
```

atau menolak:

```
human_approve(pending_id, "reject:alasan penolakan", via_human=true)
```

### 3. Negosiasi, verifikasi, ratifikasi

```
AGENT NEGOSIASI  →  MESIN VERIFIKASI  →  MANUSIA RATIFIKASI
(propose/counter)    (acceptance tests)     (human_approve ratify)
```

1. Agent-agent bertukar `session_msg` (propose, counter, accept, challenge)
2. Setiap perubahan draft diuji oleh runner (payload-size, spectral, codegen-compile)
3. Kedua agent mengirim `test_report` yang pass untuk hash yang sama
4. Kedua agent memanggil `session_sign`
5. Kedua manusia memanggil `human_approve` untuk ratifikasi
6. Hasil akhir: **co-signed artifact hash**

### 4. Memeriksa inbox

Panggil `inbox()` secara berkala (atau minta agent melakukannya) untuk menarik pesan baru. Relay menggunakan challenge-response auth — Anda tidak perlu mengatur ini manual; MCP server menanganinya.

---

## Hasil yang diharapkan

Semua tool mengembalikan JSON dengan field `ok: true/false`. Berikut pola sukses dan kegagalan per operasi.

### `pair_init` — Sukses

```json
{
  "ok": true,
  "code": "4-kancil-senja",
  "session_id": "uuid-...",
  "proposal": {
    "scope": ["session.negotiate"],
    "mode": "ephemeral_until_session_closes",
    "initiatorAgentId": "ed25519:..."
  },
  "expires_at": 1720000000000,
  "agent_id": "ed25519:..."
}
```

**Yang harus Anda lakukan:** Bagikan `code` ke partner sebelum `expires_at` (TTL 5 menit).

### `pair_init` — Gagal

| Error | Penyebab | Tindakan |
|-------|----------|----------|
| `invalid_mode` | Mode bond tidak valid | Gunakan `ephemeral_until_session_closes` atau `bonded_contact` |

### `pair_join` — Sukses (menunggu approval)

```json
{
  "ok": true,
  "pending_id": "pending-uuid",
  "proposal": { "scope": [...], "mode": "...", "initiatorAgentId": "ed25519:..." },
  "message": "Human approval required before pairing completes"
}
```

**Yang harus Anda lakukan:** Tinjau proposal scope/mode. Jika setuju, panggil `human_approve` dengan `via_human=true`.

### `pair_join` — Gagal

| Error | Penyebab | Tindakan |
|-------|----------|----------|
| `pair_not_found` | Kode salah atau expired (TTL 5 menit) | Minta kode baru dari initiator |
| `pair_not_found` | Relay tidak terjangkau | Cek `curl $AGENTPAIR_RELAY_URL/health` dan pastikan URL sama dengan initiator |

### `human_approve` (pairing) — Sukses

```json
{
  "ok": true,
  "status": "bonded",
  "bond": {
    "peer": "ed25519:...",
    "scope": ["session.negotiate"],
    "mode": "ephemeral_until_session_closes"
  }
}
```

### `human_approve` (pairing) — Gagal

| Error / status | Penyebab | Tindakan |
|----------------|----------|----------|
| `self_approval_forbidden` | `via_human` tidak `true` | Konfirmasi di chat dulu, lalu set `via_human=true` |
| `pending_not_found` | `pending_id` salah atau sudah diproses | Ulangi `pair_join` jika perlu |
| `status: "rejected"` | Anda menolak pairing | Tidak ada bond; beri tahu initiator alasan |
| `status: "pake_failed"` | Kode salah atau MITM | Ulangi pairing dengan kode baru |
| `status: "allowlist_rollback"` | Push allowlist ke relay gagal | Coba lagi; bond di-rollback otomatis |

### `inbox` — Sukses

```json
{
  "ok": true,
  "since": 0,
  "cursor": 5,
  "envelopes": [
    {
      "id": "uuid",
      "from": "ed25519:...",
      "type": "session.open",
      "verified": true,
      ...
    }
  ]
}
```

### `inbox` — Gagal

| Error | Penyebab | Tindakan |
|-------|----------|----------|
| `unexpected_challenge_status` | Relay tidak merespons challenge dengan benar | Cek kesehatan relay (`GET /health`) |
| `gap_detected` | Ada pesan hilang di thread (seq gap) | 1) Panggil `inbox()` lagi di kedua sisi. 2) Hubungi partner. 3) Jika persisten, revoke + re-pair |
| `inbox_pull_failed_403` | Signature challenge invalid/expired | Coba `inbox` lagi (nonce single-use) |

### `send` — Sukses

```json
{
  "ok": true,
  "envelope_id": "uuid",
  "to": "ed25519:..."
}
```

### `send` — Gagal

| Error | Penyebab | Tindakan |
|-------|----------|----------|
| `peer_not_allowed` | Target belum ter-bond | Lakukan pairing dulu |
| `relay inbox post failed: 403` | Relay menolak (sender tidak di allowlist penerima) | Cek bond masih aktif |

### `revoke` — Sukses

```json
{
  "ok": true,
  "revoked": "ed25519:...",
  "allowed": []
}
```

Partner akan menerima `revoke.notice` di inbox. Session aktif (jika ada) berubah ke state `revoked`.

### `session_open` — Sukses (initiator)

```json
{
  "ok": true,
  "thread": "session-uuid",
  "status": "pending_open",
  "pending_id": "pending-uuid"
}
```

Partner harus `human_approve` sebelum session live.

### `session_status` — Contoh session live

```json
{
  "ok": true,
  "thread": "session-uuid",
  "status": "live",
  "locked_sections": ["timestamp"],
  "test_results": { "sha256:abc...": { "payload-size": "pass", "spectral": "pass" } },
  "budget_remaining": 18
}
```

### `session_sign` — Gagal umum

| Error | Penyebab |
|-------|----------|
| `tests_not_green` | Acceptance test masih merah di salah satu pihak |
| `challenge_not_filed` | Belum semua agent mengirim challenge |
| `human_required` | Aksi memerlukan `human_approve` |

---

## Gate manusia (human-in-the-loop)

AgentPair secara struktural mencegah AI menyetujui hal-hal sensitif tanpa Anda:

| Aksi | Gate |
|------|------|
| Menerima pairing (`pair_join`) | `human_approve` dengan `via_human=true` |
| Membuka session (`session_open` di sisi penerima) | `human_approve` |
| Ratifikasi final | `human_approve` pada pending `ratify` |
| Perpanjang budget | `human_approve` (keduanya) |

**Cara kerja di praktik:** Saat ada pending action, agent akan menampilkan `pending_id` dan detail proposal. Anda membaca, lalu secara eksplisit menyuruh agent menyetujui atau menolak. Agent **tidak boleh** memanggil `human_approve` tanpa konfirmasi Anda.

---

## Mode bond

| Mode | Perilaku |
|------|----------|
| `ephemeral_until_session_closes` | Bond dihapus otomatis saat session ditutup atau revoke |
| `bonded_contact` | Bond persisten sampai Anda memanggil `revoke` |

---

## Troubleshooting

### MCP server tidak muncul di AI client

1. Pastikan Node.js ≥ 22: `node --version`
2. Untuk npm: pastikan `npx -y agentpair` berjalan di terminal
3. Untuk source: pastikan path ke `dist/cli.js` benar (absolut, bukan relatif) dan sudah `pnpm build`
4. Restart AI client setelah mengubah konfigurasi MCP
5. Cek log error MCP di output panel AI client

### Pairing selalu gagal

1. Verifikasi relay: `curl https://relay.yagura.space/health`
2. Pastikan kode dibagikan dalam 5 menit
3. Pastikan kedua pihak memakai relay yang sama (`AGENTPAIR_RELAY_URL`)
4. Kode case-sensitive — ketik persis

### Pesan tidak sampai

1. Panggil `inbox()` di kedua sisi
2. Cek bond masih ada (belum di-revoke)
3. Seq gap? Lihat error `gap_detected` — relay mungkin drop pesan

### WASM / build error

Jika MCP gagal start dengan error modul WASM:

```bash
pnpm build
```

Prasyarat build WASM: Rust toolchain + `wasm-pack` (hanya untuk build dari source).

### Acceptance test `codegen-compile` gagal

Runner ini memerlukan Docker dengan image `agentpair/runner-esp32`. Tanpa Docker, test ini akan fail — gunakan hanya jika Anda memang membutuhkan verifikasi kompilasi ESP32.

---

## Relay referensi vs self-hosted

| | Relay publik | Self-hosted |
|--|--------------|-------------|
| URL | `https://relay.yagura.space` | `http://127.0.0.1:3001` atau domain Anda |
| Setup | Tidak perlu | Docker Compose — lihat [Panduan Developer](./developer-guide.md) |
| Privasi metadata | Operator relay melihat routing metadata | Anda kontrol infrastruktur |

Payload dan artifact tetap terenkripsi end-to-end di kedua kasus.

---

## Batasan v0

- Satu relay per deployment (tidak ada failover multi-relay di klien v0)
- Metadata routing (`from`, `to`, `thread`) terlihat oleh operator relay
- Tier 0 (GitHub Issues sebagai transport) belum diimplementasi

Untuk detail protokol lengkap, lihat [`agentpair-v0-requirement.md`](../pocket/agentpair-v0-requirement.md).
