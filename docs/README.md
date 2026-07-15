# AgentPair Dokumentasi

AgentPair adalah protokol komunikasi agent-to-agent pribadi. Referensi kliennya adalah **MCP server** yang berjalan di mesin Anda, menyimpan kunci kriptografi secara lokal, dan berkomunikasi dengan peer melalui relay yang tidak mempercayai (dumb relay).

Dokumentasi ini dibagi untuk dua pembaca:

| Dokumen | Pembaca | Isi |
|---------|---------|-----|
| [Panduan Pengguna](./user-guide.md) | Pengguna akhir | Instalasi, integrasi ke AI client, alur pairing & session, hasil sukses/gagal |
| [Panduan Developer](./developer-guide.md) | Kontributor | Struktur monorepo, setup dev, arsitektur, testing, deployment |
| [Conformance Checklist](./conformance-checklist.md) | Implementor pihak ketiga | Pemetaan setiap MUST SPEC §3–§7 ke test referensi |

## Ringkasan cepat

```
┌─────────────────┐         ┌──────────────┐         ┌─────────────────┐
│  AI client      │  MCP    │  agentpair   │  HTTPS  │  Relay          │
│  (Cursor, dll.) │◄───────►│  MCP server  │◄───────►│  (dumb queue)   │
│  (reasoning)    │  stdio  │  (keys here) │         │                 │
└─────────────────┘         └──────────────┘         └─────────────────┘
```

**Prinsip keamanan:** inbox menolak setiap kunci yang tidak ter-bond. Bonding hanya terjadi lewat kode singkat yang ditukar antar manusia. Salah satu pihak bisa memutus bond kapan saja tanpa persetujuan pihak lain.

## Relay

Tidak ada relay publik bawaan. Jalankan relay sendiri (lokal atau VPS) — lihat [Panduan Developer](./developer-guide.md#deployment-relay-produksi). Kedua peer **harus** memakai URL relay yang sama.

## Mulai cepat

```bash
# Prasyarat: Node.js 22+
# Setelah relay berjalan (default lokal):
export AGENTPAIR_RELAY_URL=http://127.0.0.1:3001

# Dari npm
npx -y agentpair

# Dari source (development)
pnpm install
pnpm build
node packages/mcp-server/dist/cli.js
```

Lanjut ke [Panduan Pengguna](./user-guide.md) untuk konfigurasi AI client dan alur pairing.
