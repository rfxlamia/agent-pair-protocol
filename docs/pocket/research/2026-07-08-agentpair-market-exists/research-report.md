# Research Report — Apakah pasar untuk AgentPair benar-benar ada?

- **Date:** 2026-07-08
- **Verdict:** Inconclusive
- **Confidence:** medium

## Assumption tested

**Ada pasar yang cukup nyata (demand + adopsi) untuk protokol personal agent-to-agent seperti AgentPair** — bukan sekadar kebutuhan enterprise yang sudah ditangani A2A.

**Disconfirming observation:** Tidak ada bukti permintaan pengguna personal, tidak ada adopsi terukur, dan use case AgentPair bisa diselesaikan dengan alat yang sudah ada (chat manusia, shared doc, email, MCP tools saja) tanpa protokol agent-to-agent khusus.

## Methods used

- **Operationalization** (analytical) — memecah "pasar ada" menjadi: (a) problem space terbukti, (b) willingness to adopt protokol, (c) pasar khusus wedge AgentPair (artifact negotiation + executable acceptance)
- **Source Triangulation** (triangulation) — ≥5 sumber independen: industri (A2A/MCP), kompetitor langsung, proyek open-source sejenis, use case personal
- **Counterexample Hunt** (adversarial) — mencari kasus di mana pasar tidak perlu / sudah terpenuhi alternatif
- **Recency Weighting** (triangulation) — bobot bukti 2025–2026; AgentPair sendiri baru publish npm 2026-07-07

## Evidence

| Finding | Source | Supports / Refutes |
|---------|--------|--------------------|
| Demand enterprise agent-to-agent kuat (150+ org A2A, cloud embed) — tapi bukan personal layer | [PR Newswire A2A Apr 2026](https://www.prnewswire.com/news-releases/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year-302737641.html) | Refutes (pasar besar ≠ pasar AgentPair) |
| MCP 97M+ downloads/bulan — mayoritas untuk tool access, bukan agent-agent | [AgentMarketCap Apr 2026](https://agentmarketcap.ai/blog/2026/04/07/google-a2a-vs-anthropic-mcp-multi-agent-interoperability) | Refutes (audiens MCP ≠ otomatis butuh AgentPair) |
| **Mingle MCP**: networking personal via MCP, Ed25519, human approve, 120+ live cards | [npm mingle-mcp](https://registry.npmjs.org/mingle-mcp), [Agent Wars Mar 2026](https://agent-wars.com/news/2026-03-13-mingle-mcp-agent-to-agent-networking-tool-for-human-connection) | Supports (problem space personal ada) |
| **c2c.im**: IM antar coding agents, relay publik, pairing alias — tanpa server | [c2c.im](https://c2c.im/) | Supports |
| **agent-comms**: 6-word LAN pairing + human accept — sangat mirip filosofi pairing AgentPair | [GitHub GGCryptoh/agent-comms](https://github.com/GGCryptoh/agent-comms) | Supports (problem + solusi paralel) |
| **OpenFused, AgentFiles, agent-mesh**: file/handoff/email antar agent personal | [openfused](https://github.com/wearethecompute/openfused), [agentfiles](https://github.com/agentfiles-io/agentfiles), [agent-mesh](https://github.com/Ggrryta/agent-mesh) | Supports (kategori sedang lahir) |
| Use case personal nyata: calendar sync antar dua agent (home/work) | [htek.dev](https://htek.dev/articles/work-life-calendar-sync-agent-mesh) | Supports (pain point konkret) |
| Personal agent task delegation / "single-player mode" frustration | [DEV Community garasegae](https://dev.to/garasegae/why-your-ai-agent-shouldnt-work-alone-the-case-for-agent-to-agent-collaboration-55pb) | Supports |
| AgentPair sendiri: status RFC/prototype, non-goal A2A enterprise | `docs/pocket/agentpair-v0-requirement.md:14-16` | Neutral |
| AgentPair npm: 11 versi sejak 2026-07-07, belum ada metrik adopsi publik | `npm view agentpair`, registry API | Refutes (belum terbukti traction) |
| Banyak solusi fragment — belum ada winner / paying market terukur | Konvergensi temuan kompetitor | Refutes (pasar belum matang) |
| Wedge unik AgentPair: session + executable acceptance + co-signed artifact hash | `docs/pocket/agentpair-v0-requirement.md:137-168` | Supports (diferensiasi) — demand untuk wedge ini **belum terbukti** |

## Curation notes

**Strongest support:** Beberapa proyek independen (Mingle, c2c, agent-comms, OpenFused, agent-mesh) membuktikan *problem space* "agent personal perlu bicara ke agent lain" sedang dieksplorasi — bukan halusinasi satu tim.

**Strongest counter-evidence:** (1) Semua bukti adopsi personal masih mikroskopis (120 cards, repo hobby, zero npm download data untuk agentpair); (2) enterprise demand mendominasi narasi industri; (3) workarounds human-in-the-loop (WhatsApp, Google Docs, email) masih cukup untuk mayoritas kasus hari ini; (4) kompetitor sudah menutup subset use case AgentPair (pairing/networking/chat) tanpa protocol session artifact.

**Gap:** Tidak ada survei pengguna, tidak ada revenue/paying customers di kategori ini, tidak ada search-volume data. Verdict tidak bisa "Confirmed" tanpa metrik adopsi AgentPair atau permintaan eksplisit untuk *executable acceptance negotiation*.

*Curation gate: inline fallback (advisor unavailable).*

## Verdict & reasoning

**Inconclusive (confidence: medium).**

Pasar untuk *kategori* "personal agent-to-agent" **ada sebagai niche yang sedang terbentuk** — dibuktikan oleh banyak implementasi paralel dan use case nyata (calendar sync, networking, handoff). Namun pasar untuk **AgentPair secara spesifik** (default-deny inbox + SPAKE2 OOB + session artifact dengan executable tests + human ratify) **belum terbukti cukup besar atau siap bayar**. AgentPair berada di sub-niche yang lebih sempit dari kompetitor yang sudah live (Mingle = discovery/networking; c2c = chat; agent-comms = context push).

## Recommendation (non-binding)

1. **Jangan asumsikan pasar besar** — posisikan v0 sebagai RFC + reference implementation, bukan produk dengan PMF terkonfirmasi.
2. **Validasi wedge spesifik** — buat demo/video skenario §8 (dua laptop, negotiate API contract → co-signed hash) seperti yang sudah direncanakan di requirement doc; ukur apakah orang *mengerti dan mau coba*.
3. **Bedakan dari Mingle/c2c** — messaging jelas: AgentPair bukan LinkedIn-for-agents atau chat; ini *negotiation dengan deliverable terverifikasi*.
4. **Pantau kompetitor** — terutama agent-comms (pairing mirip) dan Concordia (negotiation layer).
5. **Carry-forward ke grinding** hanya input: "problem space confirmed nascent; product-market fit unproven."

## What would change this verdict

| Arah | Evidence yang dibutuhkan |
|------|--------------------------|
| → **Confirmed** | 1.000+ active bonded pairs di relay publik, atau npm downloads konsisten >1k/minggu, atau 3+ tim independen implement compatible client tanpa dorongan author |
| → **Refuted** | Kompetitor dominan menyerap use case + tidak ada adopsi AgentPair setelah 6 bulan + use case demo tidak resonate di user testing |
| Tetap Inconclusive | Adopsi organik kecil tapi use case demo viral tanpa retention terukur |
