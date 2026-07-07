# AgentPair v0 — Monorepo scaffold (Phase 1 of 3)

**Date:** 2026-07-07
**Original plan:** docs/pocket/plans/2026-07-07-agentpair-v0/execution-plan.md
**Prerequisite:** None (first phase)
**Contains tasks:** {T1, T2, T3, T5, T7}
**Unlocks next:** Phase 2

---

## Task List

Total: 5 tasks | Prerequisite phases must be complete before starting

T1: Monorepo scaffold [prereq]
T2: Protocol crypto and envelope [depends: T1]
T3: Rust SPAKE2 WASM + pake-adapter [depends: T2]
T5: Relay server [depends: T2]
T7: Acceptance runners [depends: T2]

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

## Phase Completion Gate

DONE when ALL of the following:
- Every task in this phase: status DONE
- All tests pass
- All commits created with correct format
- No task has status BLOCKED or NEEDS_CONTEXT

Hand off to Phase 2 ONLY after this gate passes.
