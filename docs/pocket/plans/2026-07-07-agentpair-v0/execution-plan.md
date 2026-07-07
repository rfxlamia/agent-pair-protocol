# EXECUTION PLAN — AgentPair v0

**Date:** 2026-07-07
**Spec:** docs/pocket/spec/2026-07-07-agentpair-v0/agentpair-v0.md
**Status:** draft
**Total tasks:** 9

---

## Execution Overview

### Recommended Order
```
T1 → T2 → T3 → T4 → T5 → T6, T7 (parallel) → T8 → T9
```

### Parallelizable Groups
| Group | Tasks | Unblocked After |
|-------|-------|-----------------|
| Protocol pairing / Relay | T3, T4 | T2 completes |
| MCP transport / Runners | T5, T7 | T3+T4 / T2 |

### Constraints Reminder
**Architecture:** Keys never leave MCP; relay dumb queue; HARD CONSTRAINT — no touch `/opt/kareema/` or intankarimah.*
**Out-of-scope:** GitHub Issues transport, CF Worker relay, A2A, discovery, real-time
**Assumptions at risk:** Vitest greenfield; PAKE = Rust WASM (pre-committed)
**Sequencing:** Recommended order only — pocket enforces blocking rules

### File Structure Map

```
Rule: Monorepo scaffold
  Create: package.json, pnpm-workspace.yaml, tsconfig.base.json (created by: T1)
  Create: packages/protocol/package.json (created by: T1)
  Create: packages/relay/package.json (created by: T1)
  Create: packages/mcp-server/package.json (created by: T1)
  Create: packages/runner-esp32/Dockerfile (created by: T1)
  Test:   vitest.config.ts (created by: T1)

Rule: Protocol crypto + envelope
  Create: packages/protocol/src/crypto/keys.ts (created by: T2)
  Create: packages/protocol/src/crypto/encrypt.ts (created by: T2)
  Create: packages/protocol/src/envelope.ts (created by: T2)
  Create: packages/protocol/src/sign.ts (created by: T2)
  Test:   packages/protocol/src/envelope.test.ts (created by: T2)

Rule: PAKE WASM build
  Create: packages/protocol/wasm/spake2-pake/ (Rust crate, created by: T3)
  Create: packages/protocol/src/pairing/pake-adapter.ts (created by: T3)
  Create: docs/pocket/decisions/pake-selection.md (created by: T3)

Rule: Pairing SPAKE2
  Create: packages/protocol/src/pairing/flow.ts (created by: T4)
  Test:   packages/protocol/src/pairing/flow.test.ts (created by: T4)

Rule: Relay server
  Create: packages/relay/src/middleware/rate-limit.ts (created by: T5)
  Create: packages/relay/src/server.ts (created by: T5)
  Create: packages/relay/src/db/schema.sql (created by: T5)
  Create: packages/relay/src/routes/card.ts (created by: T5)
  Create: packages/relay/src/routes/allowlist.ts (created by: T5)
  Create: packages/relay/src/routes/pair.ts (created by: T5)
  Create: packages/relay/src/routes/inbox.ts (created by: T5)
  Create: packages/relay/src/routes/artifact.ts (created by: T5)
  Test:   packages/relay/src/routes/inbox.test.ts (created by: T5)

Rule: MCP transport + human gates
  Create: packages/mcp-server/src/index.ts (created by: T6)
  Create: packages/mcp-server/src/tools/pair.ts (created by: T6)
  Create: packages/mcp-server/src/tools/inbox.ts (created by: T6)
  Create: packages/mcp-server/src/tools/human-approve.ts (created by: T6)
  Create: packages/mcp-server/src/store/keys.ts (created by: T6)
  Create: packages/mcp-server/src/store/pending.ts (created by: T6)
  Test:   packages/mcp-server/src/tools/pair.test.ts (created by: T6)

Rule: Session layer
  Create: packages/mcp-server/src/session/state-machine.ts (created by: T8)
  Create: packages/mcp-server/src/tools/session.ts (created by: T8)
  Test:   packages/mcp-server/src/session/state-machine.test.ts (created by: T8)

Rule: Runners
  Create: packages/runner-esp32/Dockerfile (created by: T7)
  Create: packages/runner-esp32/vendor/cJSON.h (created by: T7)
  Create: packages/runner-esp32/run.sh (created by: T7)
  Create: packages/mcp-server/src/runners/openapi-schemas.ts (created by: T7)
  Create: packages/mcp-server/src/runners/codegen-compile.ts (created by: T7)
  Create: packages/mcp-server/src/runners/payload-size.ts (created by: T7)
  Create: packages/mcp-server/src/runners/spectral.ts (created by: T7)
  Test:   packages/mcp-server/src/runners/codegen-compile.test.ts (created by: T7)

Rule: Deploy + E2E
  Create: docker-compose.yml (created by: T9)
  Create: deploy/school-compose.yml (created by: T9)
  Create: packages/mcp-server/src/e2e/happy-path.test.ts (created by: T9)
  Create: packages/mcp-server/src/e2e/dual-server.ts (created by: T9)
```

---

## Pocket Packets

---

### Task 1: Monorepo scaffold [prereq]

## OBJECTIVE
Initialize TypeScript monorepo with npm/pnpm workspaces, Vitest, and package skeletons for protocol, relay, mcp-server, runner-esp32.

Files:
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`
- Create: `packages/*/package.json` (4 packages)
- Test: `vitest.config.ts` smoke test

Steps:
1. Create workspace structure with Node 22 engine constraint
2. Add Vitest + typescript devDependencies at root
3. Verify: `pnpm install && pnpm vitest run --passWithNoTests`
4. Commit: `chore(agentpair): scaffold monorepo with vitest`

## REFERENCES LOADED
docs/pocket/spec/2026-07-07-agentpair-v0/agentpair-v0.md — Design: Option A monorepo

## WHY THIS APPROACH
Complexity: lightweight — greenfield scaffold

## SANDWICH CONTEXT
[CRITICAL: Do not create files under /opt/kareema/ — VPS deploy is separate in T8]
Spec: docs/pocket/spec/2026-07-07-agentpair-v0/agentpair-v0.md
Test framework: Vitest (greenfield, user-confirmed via TypeScript stack)

## DELIVERABLE
Given empty repo, When pnpm install && vitest run, Then workspace resolves with 4 packages
Format: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED

## QUALITY BAR
Must-have: Vitest configured; workspaces for protocol/relay/mcp-server/runner-esp32
Must-not-have: Touch kareema paths
Mark: [no-tdd — structural task]

## STOP CONDITIONS
Done when: install succeeds, vitest runs
Escalate when: constraint breach

---

### Task 2: Protocol crypto and envelope [depends: T1]

## OBJECTIVE
Implement Ed25519 keygen/sign, X25519 ECDH + XChaCha20-Poly1305 encrypt, envelope format with sig verification.

Files:
- Create: `packages/protocol/src/crypto/keys.ts`, `encrypt.ts`, `sign.ts`, `envelope.ts`
- Test: `packages/protocol/src/envelope.test.ts`

Steps:
1. Write failing test: envelope round-trip encrypt/sign/verify
2. Run: `pnpm --filter @agentpair/protocol test` — expect FAIL
3. Implement using @noble/curves and @noble/ciphers
4. Run test — expect PASS
5. Commit: `feat(protocol): envelope crypto and signing`

## REFERENCES LOADED
docs/pocket/spec/2026-07-07-agentpair-v0/agentpair-v0.md — Rule: Transport security

## WHY THIS APPROACH
Complexity: standard — crypto must use libraries not hand-roll

## SANDWICH CONTEXT
[CRITICAL: No hand-roll crypto — use @noble/* only]
Files in scope: packages/protocol/src/**

## DELIVERABLE
Given bonded keypairs, When envelope signed and encrypted, Then verify and decrypt succeeds
Given tampered sig, When verify, Then rejection
[must-not] Given raw private key in envelope, When serialize, Then must NOT expose key

## QUALITY BAR
Must-not-have: Hand-roll Ed25519 or AEAD

## STOP CONDITIONS
Done when: envelope tests pass

---

### Task 3: Rust SPAKE2 WASM + pake-adapter [depends: T2]

## OBJECTIVE
Build RustCrypto `spake2` to WASM via wasm-pack; expose thin `pake-adapter.ts` for Node; document decision in `docs/pocket/decisions/pake-selection.md`.

**Pre-committed decision: Option B — Rust WASM** (reject npm `spake2@1.0.2` and npm `cpace`).

Files:
- Create: `packages/protocol/wasm/spake2-pake/Cargo.toml`, `src/lib.rs`
- Create: `packages/protocol/src/pairing/pake-adapter.ts`
- Create: `docs/pocket/decisions/pake-selection.md`
- Test: `packages/protocol/src/pairing/pake-spike.test.ts`

Steps:
1. Scaffold Rust crate with `spake2` (RustCrypto) + `wasm-bindgen`
2. Build: `wasm-pack build --target nodejs` → output to `packages/protocol/wasm/pkg/`
3. Write failing test: two parties, same code → matching shared key via pake-adapter
4. Implement pake-adapter wrapping WASM exports (init, start, respond, finish)
5. Document decision (B chosen, A rejected with reasons)
6. Commit: `feat(protocol): Rust SPAKE2 WASM pake-adapter`

## SANDWICH CONTEXT
[CRITICAL: Do NOT install npm `cpace` or npm `spake2` — use Rust WASM only]
[CRITICAL: No hand-roll SPAKE2 math in TypeScript]

## DELIVERABLE
Given WASM pake-adapter, When two clients run SPAKE2 with same code, Then matching shared key
Decision doc records Option B as chosen

## QUALITY BAR
Must-have: wasm-pack build in CI/local documented; interop test passes
Must-not-have: elliptic/bn.js SPAKE2 path

## STOP CONDITIONS
Done when: WASM builds, pake-adapter test passes, decision doc written
Escalate when: wasm-pack cannot target Node 22 on arm64/x64 demo machines

---

### Task 4: SPAKE2 pairing flow [depends: T3]

## OBJECTIVE
Implement pair_init/pair_join state machine using T3 pake-adapter, scope/mode proposal, all-or-nothing allowlist commit.

Files:
- Create: `packages/protocol/src/pairing/pake-adapter.ts` (wraps T3 choice)
- Create: `packages/protocol/src/pairing/flow.ts`
- Test: `packages/protocol/src/pairing/flow.test.ts`

Steps:
1. Write failing test: successful pairing + wrong code abort + reject with explanation + allowlist rollback retry
2. Run: `pnpm --filter @agentpair/protocol test pairing` — FAIL
3. Implement flow using pake-adapter (not raw spake2 import scattered)
4. PASS + commit: `feat(protocol): SPAKE2 pairing flow`

## REFERENCES LOADED
Spec — Rule: Pairing HITL and all-or-nothing bond

## WHY THIS APPROACH
Complexity: standard

## SANDWICH CONTEXT
[CRITICAL: Code consumed only on bilateral allowlist push success]
[CRITICAL: Retry after rollback = new PAKE session_id, same code, original 5min TTL — no transcript replay]
Files: packages/protocol/src/pairing/**

## DELIVERABLE
Given matching code, When SPAKE2 completes and both pushes succeed, Then bonded
Given wrong code, When pair_join, Then abort
Given joiner reject, When flow completes, Then explanation returned

## QUALITY BAR
Must-not-have: Plaintext code on relay wire

## STOP CONDITIONS
Done when: pairing flow tests pass

---

### Task 5: Relay server [depends: T2]

## OBJECTIVE
Hono relay with SQLite: card, allowlist PUT, pair POST, inbox POST/GET with challenge-response (401+nonce, 60s TTL, single-use), artifact PUT/GET, seq numbers, rate limit, health.

Files:
- Create: `packages/relay/src/**` per file map including `middleware/rate-limit.ts`
- Test: `packages/relay/src/routes/inbox.test.ts`

Steps:
1. Write failing test: default-deny inbox, challenge-response (reject reused nonce), gap detection, rate limit
2. Run: `pnpm --filter @agentpair/relay test` — FAIL
3. Implement routes + SQLite schema + per-IP rate limit + max body size
4. PASS + commit: `feat(relay): HTTP relay with sqlite`

## REFERENCES LOADED
Spec — Relay API, Inbox challenge-response, Relay metadata visibility

## WHY THIS APPROACH
Complexity: standard — multiple routes but cohesive

## SANDWICH CONTEXT
[CRITICAL: Relay must not decrypt payloads — opaque storage only]
[CRITICAL: Relay MAY read envelope routing fields (from/to/thread/seq/type) for allowlist/seq]
Files: packages/relay/**

## DELIVERABLE
Given non-bonded sender, When POST inbox, Then drop
Given GET inbox without sig, When request, Then 401 + challenge nonce
Given reused nonce, When pull, Then 403
Given seq gap, When pull, Then gap_detected

## QUALITY BAR
Must-have: Per-IP rate limit on POST /pair, POST /inbox, PUT /artifact
Must-not-have: Parse encrypted payload content

## STOP CONDITIONS
Done when: relay tests pass on localhost:3001

---

### Task 6: MCP transport tools [depends: T4, T5]

## OBJECTIVE
MCP server: pair_init, pair_join, inbox, send, revoke, human_approve; local key store (file 0600, no keytar v0); relay client.

Files:
- Create: `packages/mcp-server/src/**` per file map (transport only)
- Test: `packages/mcp-server/src/tools/pair.test.ts`

Steps:
1. Write failing test: pair_init→pair_join with mock relay; allowlist rollback on push fail
2. Run: `pnpm --filter @agentpair/mcp-server test pair` — FAIL
3. Implement MCP SDK server + tools
4. PASS + commit: `feat(mcp): transport and pairing tools`

## REFERENCES LOADED
Spec — MCP Tool Surface, Rule: Pairing HITL

## WHY THIS APPROACH
Complexity: standard

## SANDWICH CONTEXT
[CRITICAL: Keys never leave MCP server process]
Files: packages/mcp-server/src/**

## DELIVERABLE
Given pair flow, When both allowlist pushes succeed, Then bonded
Given human_approve pending, When agent tries self-approve, Then rejected

## QUALITY BAR
Must-not-have: Private keys in tool responses

## STOP CONDITIONS
Done when: pair + inbox integration tests pass against relay

---

### Task 8: Session layer [depends: T6, T7]

## OBJECTIVE
session_open, session_msg, session_sign, session_status; pending 1h timeout; open_reject/expired envelopes; test_report; ratify co-sign; ephemeral bond cleanup.

Files:
- Create: `packages/mcp-server/src/session/state-machine.ts`, `tools/session.ts`
- Test: `packages/mcp-server/src/session/state-machine.test.ts`

Steps:
1. Write failing test: full session state transitions through co-sign
2. Run: `pnpm --filter @agentpair/mcp-server test session` — FAIL
3. Implement session state machine
4. PASS + commit: `feat(mcp): session negotiation layer`

## REFERENCES LOADED
Spec — Rule: Session open gates, Negotiation and verification, Ratification

## WHY THIS APPROACH
Complexity: deep — full happy path state machine

## SANDWICH CONTEXT
[CRITICAL: human_required actions blocked without human_approve]
Files: packages/mcp-server/src/session/**, tools/session.ts

## DELIVERABLE
Given session_open, When R human_approve, Then live
Given both test_report pass, When session_sign, Then accepted
Given ratification approved, When finalize, Then co-signed hash

## QUALITY BAR
Must-not-have: Agent ratify without human_approve

## STOP CONDITIONS
Done when: session state machine tests pass

---

### Task 7: Acceptance runners [depends: T2]

## OBJECTIVE
Docker runner-esp32 (xtensa-esp-elf syntax-only, NOT full ESP-IDF), payload-size (json-schema-faker), spectral lint, codegen-compile via quicktype cjson.

Files:
- Create: `packages/runner-esp32/Dockerfile` (multi-arch, debian-slim + xtensa-esp-elf toolchain ~200MB)
- Create: `packages/runner-esp32/vendor/cJSON.h`
- Create: `packages/runner-esp32/run.sh`
- Create: `packages/mcp-server/src/runners/openapi-schemas.ts` (extract components.schemas)
- Create: `packages/mcp-server/src/runners/codegen-compile.ts`
- Create: `packages/mcp-server/src/runners/payload-size.ts`
- Create: `packages/mcp-server/src/runners/spectral.ts`
- Test: `packages/mcp-server/src/runners/codegen-compile.test.ts`

Steps:
1. Write failing test: extract schemas from sample OpenAPI → quicktype cjson → Docker `-fsyntax-only` pass
2. Write failing test: oversized payload → json-schema-faker → payload-size fail
3. Vendor cJSON.h into runner image; build multi-arch Dockerfile
4. PASS + commit: `feat(runners): quicktype cjson codegen-compile pipeline`

## REFERENCES LOADED
Spec — Codegen-compile pipeline, Rule: Negotiation and verification

## WHY THIS APPROACH
Complexity: standard — codegen tool now explicit (quicktype, verified Jul 2026)

## SANDWICH CONTEXT
[CRITICAL: Both parties must pass — mismatch escalates]
[CRITICAL: No silent pass when Docker unavailable]
Files: packages/runner-esp32/**, packages/mcp-server/src/runners/**

## DELIVERABLE
Given OpenAPI draft, When codegen-compile runs, Then quicktype cjson + xtensa-esp-elf-gcc -fsyntax-only pass
Given oversized schema, When payload-size runs, Then fail
Given Docker pull fails, When codegen-compile, Then explicit error

## QUALITY BAR
Must-have: quicktype --lang cjson; schema extraction step; vendored cJSON.h
Must-not-have: Full espressif/idf 4GB image; silent pass without Docker

## STOP CONDITIONS
Done when: codegen-compile + payload-size tests pass

---

### Task 9: Deploy relay and E2E happy path [depends: T8]

## OBJECTIVE
Docker compose for relay at /opt/agentpair/ on school VPS (`127.0.0.1:3001:3001` bind); E2E with **two in-process MCP instances** (dual-server.ts), not dual stdio spawn.

Files:
- Create: `docker-compose.yml`, `deploy/school-compose.yml`
- Create: `packages/mcp-server/src/e2e/dual-server.ts`
- Test: `packages/mcp-server/src/e2e/happy-path.test.ts`

Steps:
1. Write failing E2E: import two AgentPairServer instances in-process; pair → session → ratify
2. Create deploy compose (debian-slim relay image, isolated network, 127.0.0.1 bind)
3. Deploy to school: `/opt/agentpair/` only via SSH
4. Verify: curl https://relay.yagura.space/health returns 200
5. PASS + commit: `feat(deploy): relay on school and e2e happy path`

## REFERENCES LOADED
Spec — Rule: Infrastructure constraint, full §8 scenario

## WHY THIS APPROACH
Complexity: deep — deploy + integration

## SANDWICH CONTEXT
[CRITICAL: ZERO touch /opt/kareema/, kareema docker network, Caddyfile]
[RESTATE: Deploy only to /opt/agentpair/ — isolated compose]
Files: docker-compose.yml, deploy/**, e2e test

## DELIVERABLE
Given relay deployed, When curl /health, Then 200
Given E2E test, When full happy path runs, Then co-signed hash produced
[must-not] Given deploy script, When run, Then must NOT modify /opt/kareema/

## QUALITY BAR
Must-not-have: Any kareema container/network changes
Rollback: docker compose down in /opt/agentpair only

## STOP CONDITIONS
Done when: health 200 on relay.yagura.space and E2E passes
Escalate when: deploy touches kareema

---

## Review Status

- Plan validation report: C1/C2 addressed; **PAKE pre-committed: Rust WASM (B)**
- Spec Reviewer: pending
- Test-Architect: pending
