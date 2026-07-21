# Implementasi AgentPair Core dalam satu weekend

[English](./implement-core-weekend.md) · [Indeks docs](./README-ID.md)

Tujuan: implementasi **Core** pihak ketiga yang interoperable dengan stack
referensi — identitas, envelope, perilaku klien relay, pairing/bonding, dan
messaging terenkripsi — dibuktikan dengan **byte-match** terhadap golden vector
yang dipublikasikan.

Negotiation (`nego/1`) dan acceptance testing (`atest/1`) adalah profil terpisah.
Anda bisa membangun aplikasi berguna hanya dengan Core.

## Definisi “selesai”

1. Kode Anda mengonsumsi JSON fixture di `packages/protocol/fixtures/` dan
   menghasilkan output yang diharapkan bit-per-bit (jika fixture mendefinisikannya).
2. Receiver Anda menolak kasus envelope negatif dengan kode error dan urutan
   langkah yang diharapkan.
3. Opsional: bisa pair dan bertukar `core.msg` dengan `agentpair` lewat relay
   bersama (uji publik atau Compose lokal).

Detail normatif: [SPEC.md](../SPEC.md) (bab Core). Pemetaan MUST → test:
[conformance-checklist.md](./conformance-checklist.md).

## Sebelum menulis kode

| Sumber | Kegunaan |
|--------|----------|
| [`packages/protocol/fixtures/README.md`](../packages/protocol/fixtures/README.md) | Kontrak fixture, field harness, perintah regenerate/verify |
| File JSON fixture | Input + output yang diharapkan |
| `@agentpair/protocol` di npm | Implementasi referensi (pelajari perilaku; jangan menyalin buta ke permukaan lisensi Anda) |
| Relay publik | `https://relay.yagura.space` untuk eksperimen hidup |

Status spec **1.0-draft** — wire bisa berubah sampai freeze.

## Rencana weekend (usulan)

### Blok 1 — Primitif

- **base64url** ketat (tolak padding, non-alfabet, non-kanonik) →
  `base64url.json`
- Identitas Ed25519: `agent_id = "ed25519:" + base64url(pk)` → `keys.json`
- Sign / verify atas byte yang ditransmisikan persis

### Blok 2 — Enkripsi payload

- X25519 dari kunci Ed25519, HKDF-SHA-256 dengan info `agentpair-envelope-v1`,
  XChaCha20-Poly1305 → `payload-encryption.json`
- Produksi harus memakai **nonce acak baru** per envelope; fixture boleh
  menyertakan `testOnlyNonceHex` hanya untuk reproduktifitas

### Blok 3 — Outer envelope

- Versi wire `v: 1`, maks **65536** byte UTF-8
- Format outer sign-the-blob → `envelope-core-msg.json`
- Pipeline receive berurutan + error → `envelope-negative.json`
  (cek versi sebelum verifikasi tanda tangan; lihat README fixture untuk kasus
  generatif `envelope_too_large`)

### Blok 4 — Tag / fingerprint pairing

- Vektor fingerprint pairing dan tag `bond_ok`:
  `pair-confirm-fingerprint.json`, `pair-confirm-fingerprint-v2.json`,
  `pair-bond-ok-tag.json`
- Implementasikan SPAKE2 + route pairing relay sesuai SPEC; vektor mengunci byte
  fingerprint/tag yang harus cocok

### Blok 5 — Artifact (jika perlu body besar)

- Enkripsi spillover + ref → `artifact-spillover.json`

### Blok 6 — Smoke hidup (opsional di weekend yang sama)

1. Jalankan atau pakai relay (`docker compose` atau `https://relay.yagura.space`)
2. Pair klien Core Anda dengan `agentpair` referensi (atau dua host Anda)
3. Round-trip `core.msg`; pastikan allowlist default-deny

## Alur fixture di repo ini

```bash
pnpm --filter @agentpair/protocol run verify-fixtures
pnpm --filter @agentpair/protocol run generate-fixtures   # maintainer saja
```

CI gagal jika JSON ter-commit menyimpang dari generator tanpa review.

## Tips harness (`envelope-*.json`)

Saat menggerakkan receiver dari fixture, hormati blok `harness`:

- `nowUnix` — jam yang diinjeksikan
- `isBonded` — default `true`
- `lastAcceptedSeq` — default `0`
- `self` — agen penerima (`alice` / `bob`)
- `dispatchError` — error dispatch paksa (opsional)

## Di luar scope weekend Core

- Session machine penuh `nego/1` (open → turn → sign → ratify)
- Runner `atest/1`
- Binding MCP (tool stdio) — itu satu binding, bukan protokolnya

Setelah Core hijau, tambahkan Negotiation memakai SPEC dan session state machine
referensi di `packages/protocol/src/session/`.

## Referensi

- [SPEC.md](../SPEC.md)
- [Conformance checklist](./conformance-checklist.md)
- [Panduan developer](./developer-guide-ID.md)
- [fixtures/README.md](../packages/protocol/fixtures/README.md)
