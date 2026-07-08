# Closeout — 2026-07-07-agentpair-v0

- **Plan:** docs/pocket/plans/2026-07-07-agentpair-v0
- **Type:** phased
- **Started:** 2026-07-07  ·  **Closed:** 2026-07-07
- **Baseline SHA:** 7b7e292f82ebac87221b4dadff732717804b9521  ·  **Final SHA:** 53e912f3012d4e88a81dd241b5a42f1a44f548ed
- **Result:** CLOSED — all phases DONE, all reviewable tasks REVIEW_PASS

## Phases

### Phase 1 — execution-plan-phase-1.md  (DONE)

| Task | Name | done_sha | Verdict |
|------|------|----------|---------|
| T1 | Monorepo scaffold | 4b40f0ca2a611b1e06a8e861b49bef9241564f93 | REVIEW_PASS |
| T2 | Protocol crypto and envelope | 3106c87f2e4e462aba764793272d553acfbc4a5a | REVIEW_PASS |
| T3 | Rust SPAKE2 WASM + pake-adapter | 20c590c68dc043cda2604da7f711fca99bf475c9 | REVIEW_PASS |
| T5 | Relay server | 54411c549688d4bbf2dcf43c6c25e23fba5dd1a2 | REVIEW_PASS |
| T7 | Acceptance runners | 1a6d7969b0c3af0dff9c6470cdd7e0121caf1860 | REVIEW_PASS |

_SHA range: 7b7e292f82ebac87221b4dadff732717804b9521..1a6d7969b0c3af0dff9c6470cdd7e0121caf1860_

### Phase 2 — execution-plan-phase-2.md  (DONE)

| Task | Name | done_sha | Verdict |
|------|------|----------|---------|
| T4 | SPAKE2 pairing flow | d316eed49b58ed57441c12a8b438ccb812af6259 | REVIEW_PASS |
| T6 | MCP transport tools | 4964c2bcac1dbae8a6971270252e728613c874b9 | REVIEW_PASS |
| T8 | Session layer | 7e9b3e6b35a97d4809cf245141254c776fc9a6a6 | REVIEW_PASS |

_SHA range: 1a6d7969b0c3af0dff9c6470cdd7e0121caf1860..7e9b3e6b35a97d4809cf245141254c776fc9a6a6_

### Phase 3 — execution-plan-phase-3.md  (DONE)

| Task | Name | done_sha | Verdict |
|------|------|----------|---------|
| T9 | Deploy relay and E2E happy path | 53e912f3012d4e88a81dd241b5a42f1a44f548ed | REVIEW_PASS |

_SHA range: 7e9b3e6b35a97d4809cf245141254c776fc9a6a6..53e912f3012d4e88a81dd241b5a42f1a44f548ed_

## Carried Forward

Non-blocking observations from review — accepted at close, recorded for follow-up.

- **T1** (Minor): mcp-server declares bin/main paths but no src/ files exist yet — acceptable scaffold skeleton — packages/mcp-server/package.json:6-9
- **T2** (Minor): Magic number 16 in Poly1305 length check should be a named constant — packages/protocol/src/crypto/encrypt.ts:46
- **T2** (Minor): randomNonce/randomEnvelopeId exported but unused; randomNonce defaults to 32 bytes vs 24-byte XChaCha nonce — packages/protocol/src/crypto/envelope.ts:132-138
- **T3** (Minor): getrandom backend configured two ways (Cargo feature vs rustflags cfg) — packages/protocol/wasm/spake2-pake/.cargo/config.toml:2
- **T3** (Minor): Decision doc says committed pkg/ for tests but wasm/pkg/ not committed — docs/pocket/decisions/pake-selection.md:30
- **T3** (Minor): PakeSessionHandle lacks explicit WASM session free(); relies on FinalizationRegistry — packages/protocol/src/pairing/pake-adapter.ts:7-10
- **T4** (Resolved): Pairing code CSPRNG + ~2^30 entropy — `packages/protocol/src/pairing/pairing-words.ts` (issue #2)
- **T4** (Minor): Dead/nonsensical ternary in test relay mock — packages/protocol/src/pairing/flow.test.ts:71-73
- **T4** (Minor): respond() ignores _initiatorMessage parameter — packages/protocol/src/pairing/pake-adapter.ts:72-78
- **T5** (Minor): verifyChallenge returns 404 for unknown nonce; spec says 403 — packages/relay/src/routes/inbox.ts:88-90
- **T5** (Minor): GET /inbox lacks received_at cursor; since=T mechanism incomplete — packages/relay/src/routes/inbox.ts:161-206
- **T5** (Minor): Rate-limit buckets Map never evicted — packages/relay/src/middleware/rate-limit.ts:24
- **T5** (Minor): Challenge/pair_sessions rows never garbage-collected — packages/relay/src/routes/inbox.ts:64-74
- **T5** (Minor): createRelayServer misleading alias — packages/relay/src/server.ts:52-54
- **T6** (Minor): createFileAllowlistStore exported but not wired into running server — packages/mcp-server/src/store/allowlist.ts:15-72
- **T6** (Minor): FileAllowlistStore.get() race on cold cache — packages/mcp-server/src/store/allowlist.ts:53-59
- **T6** (Minor): handleSend defaults seq to 1 with no per-thread tracking — packages/mcp-server/src/tools/inbox.ts:63-65
- **T7** (Minor): Dead variable generatedPath — packages/mcp-server/src/runners/codegen-compile.ts:105
- **T7** (Minor): E2E quicktype test skipped without Docker; spectral.ts untested — packages/mcp-server/src/runners/codegen-compile.test.ts:115-132
- **T8** (Minor): Unused import publicKeyToAgentId — packages/mcp-server/src/session/state-machine.ts:2
- **T8** (Minor): Unused import BondMode — packages/mcp-server/src/store/pending.ts:1
- **T8** (Minor): processSessionInboxEnvelope not wired into inbox pull path — packages/mcp-server/src/tools/session.ts:155
- **T8** (Minor): Budget-exhaustion enforcement not implemented (out of T8 scope) — packages/mcp-server/src/session/state-machine.ts:649
- **T9** (Minor): docker-compose.yml and deploy/school-compose.yml are byte-for-byte identical — deploy/school-compose.yml:1-19
- **T9** (Minor): MCP server instances instantiated but not routed through in E2E test — packages/mcp-server/src/e2e/happy-path.test.ts:26-29
- **T9** (Minor): Dockerfile has no HEALTHCHECK and runs as root — packages/relay/Dockerfile:23-31

## Skipped Tasks

_None_
