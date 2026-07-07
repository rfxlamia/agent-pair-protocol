# AgentPair v0 — Reference Implementation

**Date:** 2026-07-07
**Status:** approved
**Author:** pocket-grinding session
**Spec path:** docs/pocket/spec/2026-07-07-agentpair-v0/agentpair-v0.md

---

## Summary

AgentPair v0 is a greenfield reference implementation of a personal agent-to-agent protocol: two humans, two MCP servers, one self-hosted relay. Agents pair via human-exchanged codes and SPAKE2, negotiate session artifacts under executable acceptance criteria, and produce co-signed hashes after human ratification. This spec covers the full happy path (firmware/API demo §8) with relay at `https://relay.yagura.space` via Cloudflare Tunnel on VPS `school`.

---

## Context

### Current State

- Greenfield repo: requirement doc only (`docs/pocket/agentpair-v0-requirement.md`), no application code.
- Cloudflare Tunnel `agentpair` deployed on VPS `school`; `relay.yagura.space` returns 502 until relay Docker listens on `:3001`.
- VPS also runs kareema stack at `/opt/kareema/` (`pembayaran.intankarimah.web.id`) — **must not be touched**.

### Problem / Motivation

No implementation exists for pairing, transport, session negotiation, executable verification, or human-in-the-loop gates. A reference client (`npx agentpair`) and relay are needed to demonstrate the §8 firmware/API scenario with a real partner on two machines.

### Related Areas

- `docs/pocket/agentpair-v0-requirement.md` — protocol RFC
- VPS `school`: `/opt/agentpair/` (new), `/etc/cloudflared/config.yml` (existing tunnel)
- Packages: `packages/protocol`, `packages/relay`, `packages/mcp-server`, `packages/runner-esp32`

---

## Scope

### In-Scope

- TypeScript monorepo: `protocol`, `relay`, `mcp-server`, `runner-esp32`
- MCP server `npx agentpair` with local Ed25519 keys (OS keychain recommended)
- Self-hosted relay: SQLite, Docker on `school`, `localhost:3001` behind Cloudflare Tunnel
- Relay API: card, allowlist push, pairing endpoint, inbox, artifact blobs, challenge-response pull auth
- Pairing: `pair_init` / `pair_join`, SPAKE2 via `POST /pair/{session_id}`, initiator proposes scope/mode, joiner HITL approve in chat, reject with explanation, all-or-nothing allowlist commit
- Transport: signed encrypted envelopes, sequence numbers per thread, gap detection
- Session full happy path §8: open → constraints → propose/counter/accept → challenges → sign → ratify → co-sign
- Human gates via pending queue + `human_approve(pending_id, decision)` in AI client
- Executable runners: payload-size, spectral lint, Docker `agentpair/runner-esp32` (xtensa syntax-only); both parties must pass; `test_report` attestation
- Unilateral revoke + `revoke.notice`; ephemeral `until_session_closes` bond removed on session close or revoke
- Demo: user + real partner, two machines, Docker required for ESP32 runner

### Out-of-Scope

- Tier 0 GitHub Issues transport
- Cloudflare Worker + KV as relay backend
- `intankarimah.com`, `pembayaran.intankarimah.com`, `pembayaran.intankarimah.web.id`, `/opt/kareema/`, Caddy kareema stack (**HARD CONSTRAINT**)
- A2A / enterprise orchestration interoperability
- Discovery network, marketplace, cold contact
- Real-time / presence layer
- Metadata privacy (padding, mixing, onion relays) — W11 accepted
- Multi-relay failover mesh (single relay v0; seq/gap detection included)
- Rich judgment-rubric language for acceptance criteria
- Central identity registry / accounts

---

## Architecture Constraints

- **May touch:** MCP server (Node/TS), relay Docker (`/opt/agentpair/`), shared protocol types, cloudflared config (tunnel only — already deployed), `runner-esp32` Docker image
- **Must NOT touch:** `/opt/kareema/`, kareema Docker network, Caddy kareema config, intankarimah.* domains
- **Patterns:** default-deny inbox; defense-in-depth allowlist (relay + agent); keys never leave MCP; human-in-the-loop structural; deliverable = co-signed artifact hash; relay dumb (opaque blobs, no content parse)
- **Architecture validation:** PASS

---

## Dependencies

### Existing (to leverage)

- Cloudflare Tunnel on VPS `school` — HTTPS ingress to `localhost:3001`
- Docker on VPS and demo laptops — ESP32 runner image

### New (proposed)

- `@modelcontextprotocol/sdk` — MCP server tools
- `@noble/curves` — Ed25519, X25519
- `@noble/ciphers` — XChaCha20-Poly1305
- `@noble/hashes` — hashing utilities
- **PAKE:** RustCrypto `spake2` crate via **wasm-pack** (WASM in Node); **reject** npm `spake2@1.0.2` (unmaintained, elliptic/bn.js) and npm `cpace` (unrelated nodemon tool)
- `hono` — relay HTTP server
- `better-sqlite3` — relay persistence (debian-slim base image, not alpine)
- **PAKE:** RustCrypto `spake2` via wasm-pack (see `packages/protocol/wasm/spake2-pake/`)
- `quicktype` — OpenAPI `components.schemas` → C (cJSON target) for codegen-compile runner
- `@stoplight/spectral-cli` — OpenAPI lint runner
- `json-schema-faker` — payload-size runner (generate example payloads from schema)
- Node 22+ — runtime

---

## Relay API (v0)

```
GET  /card/{agent_id}
PUT  /allowlist/{agent_id}           # signed by agent; rollback bond on fail
POST /pair/{session_id}              # SPAKE2 PAKE messages only; 5 min TTL
POST /inbox/{agent_id}               # bonded senders only
GET  /inbox/{agent_id}               # challenge-response auth (see below)
PUT  /artifact/{hash}                # opaque draft blob
GET  /artifact/{hash}
GET  /health
```

### Inbox challenge-response (v0)

1. `GET /inbox/{agent_id}?since=T` without sig → `401` + `{ challenge: nonce, expires_at }` (nonce TTL 60s, single-use)
2. Client `GET /inbox/{agent_id}?since=T&challenge={nonce}&sig={sign(nonce)}` → envelopes or `403` on bad/expired/reused nonce

### Relay metadata visibility (W11)

Relay sees envelope routing fields (`from`, `to`, `thread`, `seq`, `type`) in cleartext for allowlist/seq enforcement. **Payload and artifact blobs remain opaque.**

### Codegen-compile pipeline (T7)

1. Extract `components.schemas` from OpenAPI draft → JSON Schema bundle
2. `quicktype --lang cjson` → `.c` + `.h` (cJSON)
3. Docker runner: `xtensa-esp-elf-gcc -fsyntax-only` with vendored `cJSON.h` (not full ESP-IDF — ~200MB toolchain, multi-arch)

---

## MCP Tool Surface (v0)

```
pair_init(scope, mode)               → code for human OOB share
pair_join(code)                      → show proposal → HITL → SPAKE2
inbox()
send(to, type, payload)
revoke(key)
human_approve(pending_id, decision)
session_open(goal, acceptance, budget, mandate)
session_msg(thread, type, body)
session_sign(thread, artifact_hash)
session_status(thread)
```

---

## Stories + Scenarios

### Story: Pairing with HITL

> As a user, I want to bond with a trusted partner's agent via an out-of-band code, so only intended peers reach my inbox.

**Rule 1: Initiator proposes scope/mode**
- Example A: A runs `pair_init(["session.negotiate"], ephemeral_until_session_closes)` → code `4-kancil-senja`
- Example B: B rejects with explanation → A receives reject reason, no bond

```gherkin
Scenario: Successful pairing
  Given User A requests pair with scope session.negotiate
  When A shares code OOB to User B and B approves proposal in chat
  Then SPAKE2 completes and both allowlists push succeeds
  And both agents are bonded with agreed scope

Scenario: Joiner rejects pairing
  Given A generated pair code with scope session.negotiate
  When B's human rejects with explanation "scope too broad"
  Then no bond is created and A receives the explanation

Scenario: Allowlist push failure rolls back
  Given SPAKE2 succeeded
  When either agent's PUT /allowlist fails
  Then bond is rolled back on both sides and code remains retryable

Scenario: Wrong pairing code
  Given A generated code 4-kancil-senja
  When B runs pair_join with wrong code
  Then SPAKE2 aborts and no allowlist entries are created
```

### Story: Transport

> As an agent, I want encrypted signed envelopes via a dumb relay, so messages are private and authenticated.

```gherkin
Scenario: Inbox challenge-response
  Given Agent B requests GET /inbox without sig
  When relay returns challenge nonce and B signs it
  Then B receives envelopes since cursor T

Scenario: Sequence gap detection
  Given messages seq 1,2,4 exist for thread X
  When B pulls inbox
  Then gap_detected error is returned with last_good_seq 2

Scenario: Non-bonded send dropped
  Given X is not on Y's allowlist
  When X POST /inbox/Y
  Then relay drops envelope
```

### Story: Session full happy path

> As firmware and backend users, I want agents to negotiate an API contract to a co-signed hash with minimal human involvement.

```gherkin
Scenario: Session open with human gate
  Given V and R are bonded
  When V session_open with acceptance criteria and budget
  Then R sees pending approval in chat
  And session becomes live only after R human_approve

Scenario: Session open rejected
  Given V opened session pending R approval
  When R rejects with reason
  Then V receives session.open_reject envelope and session_status shows open_rejected

Scenario: Session open expires
  Given R ignores pending open for 1 hour
  Then session becomes open_expired and V notified via envelope + poll

Scenario: Negotiation with test evidence
  Given live session with constraint exchange complete
  When R proposes ISO timestamp and V counters with epoch uint32
  Then payload-size test attached shows ISO variant red
  And R accepts epoch variant and section locks

Scenario: Both runners must pass
  Given draft hash H with all sections locked
  When V and R each send test_report pass for H
  Then session_sign becomes legal
  When V pass and R fail on same H
  Then escalate_to_humans and sign remains illegal

Scenario: Challenges and sign
  Given all executable tests green
  When both agents file challenge and both test_reports pass
  Then agents may session_sign
  When any executable test is red
  Then session_sign is rejected

Scenario: Ratification and co-sign
  Given both agents signed
  When V and R each human_approve ratification in chat
  Then agents co-sign artifact hash and session closes
  And ephemeral bond is removed

Scenario: Budget exhausted
  Given max_turns reached with unlocked sections
  When agent attempts propose
  Then session escalates to input-required
  And budget_extend requires both humans to human_approve
```

### Story: Revoke

```gherkin
Scenario: Mid-session revoke
  Given active session between V and R
  When V revoke(R_pubkey)
  Then V drops R from allowlist and relay is updated
  And revoke.notice sent to R
  And session state becomes revoked on both sides
  And R's allowlist toward V is unchanged until R revokes
```

---

## Acceptance Criteria

```
Rule: Pairing HITL and all-or-nothing bond
  ✓ Given initiator pair_init with scope/mode, When joiner approves in chat and both allowlist pushes succeed, Then bonded
  ✓ Given joiner rejects with explanation, When pair_join completes, Then no bond and initiator receives reason
  ✓ Given SPAKE2 ok but one allowlist push fails, When pair completes, Then rollback both sides and code retryable
  ✗ Given wrong code, When pair_join, Then SPAKE2 abort

Rule: Transport security
  ✓ Given bonded agents, When send/inbox with challenge-response, Then decryptable verified messages
  ✓ Given seq gap in thread, When inbox pull, Then gap_detected error
  ✗ Given non-bonded sender, When POST inbox, Then relay drops

Rule: Session open gates
  ✓ Given V session_open, When R human_approve, Then session live
  ✓ Given R rejects, When within 1h, Then open_rejected via envelope + session_status
  ✓ Given R ignores 1h, When timeout, Then open_expired
  ✗ Given agent attempts ratify without human_approve, Then human_required rejection

Rule: Negotiation and verification
  ✓ Given draft change, When test_report from both parties pass for hash, Then sign legal
  ✓ Given both challenges filed and tests green, When session_sign, Then accepted
  ✗ Given codegen-compile red on either side, When session_sign, Then rejected

Rule: Ratification and bond lifecycle
  ✓ Given both agents signed and both humans ratify, When finalize, Then co-signed hash and session closed
  ✓ Given ephemeral until_session_closes bond, When session closed or revoked, Then bond removed from allowlist

Rule: Revoke
  ✓ Given active session, When V revokes R, Then session revoked and revoke.notice to R
  ✗ Given revoked sender, When send to V, Then relay drops

Rule: Infrastructure constraint
  ✓ Given deploy to school VPS, When relay starts, Then kareema stack unaffected at /opt/kareema/
```

---

## Design Decision

**Chosen option:** Option A — Integrated TypeScript Monorepo

**Summary:** Single repo with `protocol`, `relay` (Hono + SQLite), `mcp-server` (MCP SDK), and `runner-esp32` Docker image. Keys and human gates live in MCP; relay remains a dumb queue with opaque artifact blobs.

**Rejected options:**
- Option B (relay-first, session on relay): violates keys-never-leave-MCP and human gate ownership
- Option C (mock relay first): insufficient for §8 demo with real partner

**Key tradeoffs accepted:**
- Single relay at `relay.yagura.space` (no multi-relay failover in v0)
- Metadata visibility at relay (W11)
- Docker required on both demo machines for honest ESP32 compile test

---

## Open Questions / Assumptions

| Question | Resolution | Risk if Wrong |
|----------|------------|---------------|
| Judgment-type acceptance (A4 ergonomic) | assumed: surfaced in human ratification summary only | Low — v0 acceptable |
| Cross-vendor challenge rigor | assumed: message grammar constrains, not eliminates | Medium — demo uses same MCP client family |
| Metadata privacy W11 | assumed: accepted limitation | Low — documented |
| SPAKE2 library | **decided: RustCrypto spake2 → WASM (wasm-pack)** | Low — T3 implements, no npm PAKE |
| OpenAPI→C codegen | **resolved:** quicktype cjson + schema extraction | Low — verified Jul 2026 |
| OS keychain | assumed: file 0600 for v0; keytar deferred | Low |

---

## Implementation Notes

- Relay deploy path: `/opt/agentpair/docker-compose.yml` — separate from `/opt/kareema/`
- Relay listens `127.0.0.1:3001` only; cloudflared already routes `relay.yagura.space`
- Pairing code TTL: 5 minutes; session open pending TTL: 1 hour
- Tunnel ID: `1e06c5cf-3690-4e7d-8555-f573bf9e515f` (existing)
- Demo cast: implementer + one real partner, two machines
- Pairing retry after allowlist rollback: new PAKE session_id, **same code**, original 5min TTL still applies (no transcript replay)
- Relay compose: bind `127.0.0.1:3001:3001` explicitly; per-IP rate limit + max body size on public endpoints
- E2E test: two MCP server instances **in-process** (library import), not dual stdio spawn
- T3 build prereqs: Rust toolchain + `wasm-pack` on dev machines (both arm64 Mac + partner machine)

---

## Rollback Plan

- Stop agentpair Docker compose: `docker compose -f /opt/agentpair/docker-compose.yml down`
- cloudflared tunnel independent — leave running or disable via `systemctl stop cloudflared` without affecting kareema
- MCP clients: `revoke()` all bonds; delete local keychain entries
- SQLite relay data: remove Docker volume to wipe state
- No migrations on kareema Postgres — relay uses isolated SQLite volume
