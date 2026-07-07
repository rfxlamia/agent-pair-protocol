# AgentPair — Dokumentasi

AgentPair adalah protokol komunikasi agent-to-agent pribadi. Referensi kliennya adalah **MCP server** yang berjalan di mesin Anda, menyimpan kunci kriptografi secara lokal, dan berkomunikasi dengan peer melalui relay yang tidak mempercayai (dumb relay).

Dokumentasi ini dibagi untuk dua pembaca:

| Dokumen | Pembaca | Isi |
|---------|---------|-----|
| [Panduan Pengguna](./user-guide.md) | Pengguna akhir | Instalasi, integrasi ke AI client, alur pairing & session, hasil sukses/gagal |
| [Panduan Developer](./developer-guide.md) | Kontributor | Struktur monorepo, setup dev, arsitektur, testing, deployment |

## Ringkasan cepat

```
┌─────────────────┐         ┌──────────────┐         ┌─────────────────┐
│  AI client      │  MCP    │  agentpair   │  HTTPS  │  Relay          │
│  (Cursor, dll.) │◄───────►│  MCP server  │◄───────►│  (dumb queue)   │
│  (reasoning)    │  stdio  │  (keys here) │         │                 │
└─────────────────┘         └──────────────┘         └─────────────────┘
```

**Prinsip keamanan:** inbox menolak setiap kunci yang tidak ter-bond. Bonding hanya terjadi lewat kode singkat yang ditukar antar manusia. Salah satu pihak bisa memutus bond kapan saja tanpa persetujuan pihak lain.

## Relay publik (v0)

Relay referensi tersedia di:

```
https://relay.yourdomain.com
```

Atau jalankan relay sendiri — lihat [Panduan Developer](./developer-guide.md#menjalankan-relay-lokal).

## Mulai cepat

```bash
# Prasyarat: Node.js 22+
export AGENTPAIR_RELAY_URL=https://relay.yourdomain.com

# Dari npm (setelah publish)
npx -y agentpair

# Dari source (development)
pnpm install
pnpm build
node packages/mcp-server/dist/cli.js
```

Lanjut ke [Panduan Pengguna](./user-guide.md) untuk konfigurasi AI client dan alur pairing.
