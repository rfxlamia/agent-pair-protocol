# Research Report — Apakah ada masalah struktural: agent milik 2+ orang perlu terhubung?

- **Date:** 2026-07-08
- **Verdict:** Confirmed
- **Confidence:** high

## Assumption tested

**Ada masalah berulang dan struktural** di mana agent yang dijalankan oleh 2+ orang berbeda perlu saling terhubung dan menyelesaikan sesuatu bersama — dan solusi yang ada hari ini (tool call, human relay manual, A2A enterprise) **tidak menutup gap ini** dengan bersih di layer personal/cross-principal.

Analogi yang diajukan pemilik riset: sebelum MCP tidak ada "pasar MCP", tapi ada masalah M×N integrasi tool; tool call sudah ada di mana-mana, yang kurang adalah **unified protocol**.

**Disconfirming observation:** Tool call + MCP + A2A sudah cukup; atau human copy-paste antar chat sudah menyelesaikan semua kasus; atau tidak ada bukti orang/agent benar-benar mengalami friction ini.

## Methods used

- **Operationalization** (analytical) — memisahkan "pasar ada" dari "masalah ada"; mengukur gap protokol cross-principal
- **First-Principles Decomposition** (analytical) — MCP menyelesaikan agent→tool; apa yang tersisa untuk agent(A)→agent(B) lintas pemilik berbeda?
- **Source Triangulation** (triangulation) — paper akademik, post industri, proyek open-source independen, pernyataan resmi Anthropic tentang origin MCP
- **Counterexample Hunt** (adversarial) — apakah workaround human/manual sudah memadai sehingga masalah tidak perlu protokol?

## Evidence

| Finding | Source | Supports / Refutes |
|---------|--------|--------------------|
| Pre-MCP: M×N integrasi — setiap AI app butuh custom connector per tool; tool call sudah ada tapi fragmented | [Anthropic MCP launch](https://www.anthropic.com/news/model-context-protocol), [GenAI Unplugged](https://genaiunplugged.substack.com/p/why-mcp-was-created-full-course-lesson) | Supports (analogi valid) |
| MCP dirancang agent→tool; "tool tidak punya goals sendiri, tidak push work back" | [alexcloudstar A2A vs MCP](https://www.alexcloudstar.com/blog/a2a-vs-mcp-agent-communication-2026/) | Supports (gap tersisa) |
| IBM: MCP tidak cocok untuk agent-to-agent (no delta streaming, no multi-server shared memory) — by design | [Neosalpha ACP vs MCP vs A2A](https://neosalpha.com/blogs/ai-agent-protocols-acp-vs-mcp-vs-a2a/) | Supports |
| A2A solves peer coordination tapi target enterprise multi-agent, vendor/org boundaries | [Oracle Agent Communication Matrix](https://blogs.oracle.com/developers/the-agent-communication-matrix-when-mcp-a2a-and-plain-rest-each-win) | Supports (partial — tidak personal) |
| **MPAC paper**: MCP dan A2A assume **single principal**; ketika agent dari **independent principals** harus koordinasi → "coordination collapses to ad-hoc chat, manual merging, or silent overwrites" | [MPAC arxiv 2604.09744](https://arxiv.org/pdf/2604.09744) | Supports (strong) |
| **CHAP paper**: MCP + A2A tidak define "shared workspace where humans and agents jointly carry work"; handoffs hilang di chat threads | [CHAP arxiv 2606.09751](https://arxiv.org/html/2606.09751v1) | Supports |
| Multi-agent systems "fail at handoffs more often than at reasoning" — lost context, ambiguous formats | [Geodocs Agent Handoff Protocol](https://geodocs.dev/ai-agents/agent-handoff-protocol-spec) | Supports |
| AHP: agents handed "long conversation histories, stale state, mixed instructions" — job gets lost | [junkyard22/AHP](https://github.com/junkyard22/AHP) | Supports |
| Use case nyata: dua agent (home/work) tidak bisa bicara — human jadi relay calendar | [htek.dev agent mesh](https://htek.dev/articles/work-life-calendar-sync-agent-mesh) | Supports |
| Personal agent "single-player mode" — no way to connect when task outside expertise | [DEV garasegae](https://dev.to/garasegae/why-your-ai-agent-shouldnt-work-alone-the-case-for-agent-to-agent-collaboration-55pb) | Supports |
| Fragmentasi solusi personal: Mingle, c2c, agent-comms, OpenFused, agent-mesh — masing-masing custom | npm/GitHub (lihat riset pasar 2026-07-08) | Supports (M×N lagi di layer personal) |
| AgentPair requirement: "without either human relaying messages by hand" — explicitly names the pain | `docs/pocket/agentpair-v0-requirement.md:11` | Supports |
| Workaround: human copy-paste antar chat/email masih works untuk banyak kasus | Praktik umum | Refutes (partial — masalah ada tapi tidak selalu urgent) |
| A2A + MCP stack mungkin eventually stretch ke personal use | [Oracle](https://blogs.oracle.com/developers/the-agent-communication-matrix-when-mcp-a2a-and-plain-rest-each-win) | Refutes (partial — belum di personal/cross-principal) |

## Curation notes

**Strongest support:** MPAC secara eksplisit menamai gap yang persis relevan: **multi-principal** (bukan multi-agent dalam satu org). CHAP dan AHP mengonfirmasi dari sudut berbeda — handoff/collaboration grammar belum distandarkan. Banyak proyek independen membangun solusi ad-hoc = bukti masalah, bukan bukti pasar.

**Strongest counter-evidence:** Workaround human relay (WhatsApp, copy-paste) masih cukup untuk mayoritas kasus *hari ini* — sama seperti pre-MCP Anda bisa manual copy-paste API docs. Itu tidak menghilangkan masalah struktural; hanya menunda urgency.

**Gap:** Frekuensi masalah di populasi umum belum terukur. Problem confirmed ≠ everyone feels it yet. Sama seperti pre-MCP: devs yang connect 3 tools ke 3 apps merasakan pain duluan.

*Curation gate: inline fallback.*

## Verdict & reasoning

**Confirmed (confidence: high).**

Masalah struktural **ada**: ketika agent milik orang A perlu berkolaborasi dengan agent milik orang B untuk menyelesaikan satu deliverable, stack saat ini tidak punya layer unified. MCP menutup agent→tool. A2A menutup agent↔agent di enterprise orchestration. **Cross-principal personal coordination** — engineer+firmware dev, dua kolega, dua teman — jatuh ke ad-hoc chat, human relay, atau N proyek open-source yang tidak interoperable.

Analogi pre-MCP **valid secara struktural**: tool call ada di mana-mana, tapi fragmented; yang kurang unified protocol. Di layer personal agent-agent, pola yang sama terlihat (Mingle ≠ c2c ≠ agent-comms ≠ AgentPair).

**Penting:** Ini **bukan** konfirmasi pasar. Ini konfirmasi **akar masalah** — tepat seperti Anthropic melihat M×N sebelum ada pasar MCP.

## Recommendation (non-binding)

1. **Reframe positioning AgentPair** dari "apakah pasarnya ada" ke "kami unify layer yang MCP dan A2A sengaja tidak cover — cross-principal personal coordination."
2. **Gunakan narasi M×N → M+N** — seperti MCP untuk personal agent mesh.
3. **Spesifikkan wedge** — bukan semua cross-agent (A2A/MPAC/CHAP juga claim space); AgentPair = bonded pair + default-deny + artifact negotiation + human ratify.
4. **Validasi urgency** terpisah — masalah ada, tapi apakah cukup menyakitkan untuk adopt protokol baru? Itu pertanyaan timing, bukan existence.

## What would change this verdict

| Arah | Evidence |
|------|----------|
| → Refuted | A2A v2 atau MCP extension resmi menambahkan multi-principal personal semantics dan mengabsorpsi semua use case |
| Tetap Confirmed tapi urgency rendah | Masalah ada tapi 95% user puas dengan human relay selama 5+ tahun |
| Problem → Market | Setelah unified protocol tersedia, adopsi organik cepat (mirip kurva MCP) — itu riset terpisah |
