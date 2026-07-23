# Roadmap — AgentPair v1.0 (public launch)

**Window:** 2026-07-09 → 2026-08-08 (4 weeks + 3-day buffer)
**Goal:** publish SPEC 1.0 + conformant reference implementation (`agentpair`, `@agentpair/protocol`, relay) with docs good enough for a third party to implement Core in a weekend.

## Where we are (2026-07-08)

**Done (v0):** crypto suite, SPAKE2 pairing + wordlist, relay (default-deny inbox, challenge-response pull, content-addressed artifacts + quota + rate limit), MCP server (consolidated tools, human gates via opaque `approval_code` / A4, session state machine with N1/N3, Zod payload validation, disk persistence), runners (spectral, codegen-compile, payload-size), e2e happy path, docker deploy. Published: `agentpair` 0.1.11, `@agentpair/protocol` 0.1.2.

**Done (2026-07-12, off-milestone security fix):** identity-bound pairing fingerprint (§6.2: `SHA-256(domain ‖ shared_key ‖ id_init ‖ id_join)`, length-prefixed, golden vector), joiner-first confirm riding the joiner `pake` message (single-slot relay ping-pong invariant now normative), `bond_ok` joiner-first with identity-bound tag, status taxonomy (`pake_failed` = local verification not passed, `rolled_back` = verified but not committed), adversarial suite (identity swap, manifest tamper, injected/dropped `bond_fail`, malformed confirm). Closes relay identity-swap vulnerability. `@agentpair/protocol` 0.3.0 (breaking wire; no interop with 0.2.x pairing). Spec artifacts: docs/pocket/spec/2026-07-11-identity-bound-pairing-fingerprint/.

**Done (2026-07-13, M2.1):** spillover (§5): payload > 64 KiB wire cap → auto-encrypt artifact (fresh XChaCha20-Poly1305 key, AAD `agentpair-artifact-v1`), PUT to relay, send spill ref `{spill, artifact_hash, size, content_type, summary, artifact_key}`; receiver auto-fetch + decrypt via `resolveSpillover`; 10 MiB plaintext cap; §10 artifact/spillover error codes; golden vector `artifact-spillover.json`; e2e round-trip for oversized `core.msg` and `nego.turn`. Closes #28.

**Gap vs SPEC v1:** profile advertisement (§6.4), N5/N7 session rules, atest separation from mcp-server, root README. Wire format v1 (outer envelope, sign-the-blob, namespaced types, §10 error codes, golden vectors) landed in M1.1–M1.6; `@agentpair/protocol@0.4.0` freezes HKDF info `agentpair-envelope-v1`.

---

## Milestone 1 — Wire Format v1 (Jul 9–15)

Breaking change; everything else builds on it. Land first.

- [x] **M1.1** Outer envelope + sign-the-blob (§4.1–4.2): `{v, from, to, blob, sig}`, signature over raw body bytes, verifiers never re-serialize. Remove `canonicalSignBytes`. `label:protocol` `size:L`
- [x] **M1.2** Receiver algorithm in normative order (§4.3 steps 1–8), incl. 64 KiB pre-decode size check → `envelope_too_large`, cross-check outer vs signed inner `from`/`to` → `routing_mismatch`. `label:protocol` `size:M`
- [x] **M1.3** Strict base64url decoding everywhere: reject padding, non-alphabet, non-canonical (§3). `label:protocol` `size:S`
- [x] **M1.4** Namespace envelope types: `core.msg`, `core.close`, `core.ack`, `nego.*`; unknown type → `unsupported_envelope_type`, no side effects. Scope expanded (spec 2026-07-10): absorbs full `core.close` semantics + close registry + MCP `send` reshape. `label:protocol` `size:L`
- [x] **M1.5** Align all error codes with §10 (`stale_seq`, `envelope_expired`, `version_mismatch`, `unsupported_version`, …); errors must not leak unbonded-recipient existence. `label:protocol` `size:S`
- [x] **M1.6** Golden test vectors: fixed keys → expected envelopes/signatures, committed as JSON fixtures so third-party implementations can verify against them. `label:testing` `size:M`
- [x] **M1.7** CI: GitHub Actions — lint + build + test on push/PR (currently none). `label:infra` `size:S`

**Exit:** all packages on wire v1, v0 paths deleted, vectors published, CI green.

## Milestone 2 — Core Conformance (Jul 16–22)

- [x] **M2.1** Spillover (§5): payload > cap → auto-encrypt artifact (fresh key), PUT to relay, send `{artifact_hash, size, content_type, summary}`; receiver auto-fetch + decrypt. `label:protocol` `size:L` — done 2026-07-13 (#28)
- [x] **M2.2** Profile advertisement in pairing `confirm` (§6.4): bond record stores contract intersection; sending outside contract → `profile_not_supported`. `label:protocol` `size:M`
  — Note (post identity-binding, 2026-07-12): joiner's `confirm` now rides its `pake` message (§6.2 step 1–2); profiles must ride the same message AND be cryptographically bound (into the fingerprint preimage with `u16_be` length prefix, or a MAC per `bond_ok` tag pattern). Unbound fields on the pairing wire re-open the relay-tamper class just fixed. §6.4 wording ("during confirm") needs touch-up. See docs/pocket/spec/2026-07-11-identity-bound-pairing-fingerprint/.
- [x] **M2.3** N5 — unbond closes every non-terminal session (`bond_revoked`); co-sign records retained as evidence. `label:protocol` `size:M` — done 2026-07-15 (#30)
- [x] **M2.4** N7 — `budget.deadline` REQUIRED (`invalid_payload` if absent); local expiry → `closed` (`deadline_expired`), no peer message needed. `label:protocol` `size:M` — done 2026-07-15 (#31)
- [x] **M2.5** N6 audit — turn count derived from wire only, both directions; property test that peer-reported counters are never trusted. `label:testing` `size:S` — done 2026-07-15 (#32)
- [x] **M2.6** Relay inbox conformance: size gate, pre-verify routing cross-check, strict base64url sig decode on inbox/allowlist/artifact (reject garbage early, never decrypt). `label:relay` `size:S` — done 2026-07-15 (#33)
- [x] **M2.7** Conformance checklist doc: table of every MUST in §3–§7 → test that covers it. Gaps become issues. `label:testing` `size:M` — done 2026-07-15 (#34, `docs/conformance-checklist.md`; gap #53)

**Exit:** Core + Negotiation profiles pass conformance checklist end-to-end over a real relay (docker compose, two hosts).

## Milestone 3 — Profile Separation + Hardening (Jul 23–29)

- [x] **M3.1** Extract `atest/1` (§9): `atest.challenge` / `atest.report` envelopes; runners become the atest implementation; Negotiation must work with zero runner infra. `label:protocol` `size:L`
- [x] **M3.2** Security self-audit vs §11: injection containment (peer payloads presented as data, length caps), replay, decode-DoS, pairing single-use codes, gate flag provenance (A4). Findings → issues, fix P0/P1. `label:security` `size:M` — done 2026-07-23 (#36; P0/P1 #56–#59; optional #60–#61)
  — Audit findings filed and fixed: A4 `approval_code` replaces model-settable `via_human` (#56); untrusted peer presentation + length caps (#57); single-use pairing codes / `pairRetry` removed (#58); `budget_extend` human gate (#59). SPEC §11.2 relay wording narrowed for courtesy signals (#60); relay P2 hardening (#61). Second audit + focused tests PASS before close.
- [x] **M3.3** Adversarial e2e suite: tampered outer `to`, replayed seq, oversized envelope, unbonded sender, self-approval attempt, redelivered `nego.open` in every state. `label:testing` `size:M`
- [ ] **M3.4** Fresh-clone dogfood: two humans, two machines, real relay — pair, negotiate, co-sign, ratify a real deliverable. Log every papercut as an issue. `label:dx` `size:M`
- [ ] **M3.5** SPEC 1.0 freeze: reconcile spec ↔ implementation drift found in M1–M3, resolve remaining wording, remove DRAFT banner. After this, wire changes need a version bump. `label:spec` `size:M`

**Exit:** spec frozen, adversarial suite green, dogfood session completed by non-author.

## Milestone 4 — Publish (Jul 30 – Aug 5)

- [ ] **M4.1** Root README: problem (cross-principal gap — MCP covers agent→tool, A2A covers enterprise; we cover bonded personal pairs), 5-min quickstart, architecture diagram, conformance classes. `label:docs` `size:M`
- [ ] **M4.2** Docs pass: user guide + developer guide in English, "implement Core in a weekend" guide built on M1.6 vectors. `label:docs` `size:M`
- [ ] **M4.3** Repo hygiene: CONTRIBUTING, SECURITY.md (disclosure policy), issue/PR templates, dual license files (Apache-2.0 code / CC-BY-4.0 spec), type registry process (§12). `label:infra` `size:S`
- [ ] **M4.4** Release: npm publish `agentpair@1.0.0` + `@agentpair/protocol@1.0.0`, tag, GitHub Release with changelog + migration note (v0 wire is dead). `label:release` `size:S`
- [ ] **M4.5** Public relay deployment (small VPS, rate-limited) + hosted-relay disclaimer (metadata visible per §11.2). `label:infra` `size:M`
- [ ] **M4.6** Launch assets: demo of two agents negotiating a real deliverable (asciinema/GIF), Show HN draft, blog post using M×N → M+N narrative from the research report. `label:launch` `size:M`

**Exit:** v1.0 live on npm, repo public-ready, launch post out.

**Buffer:** Aug 6–8 — launch-day fixes only.

---

## Cut lines (if behind schedule)

1. **First cut: M3.1 (atest/1)** → ships as v1.1. Spec's conformance classes make this legitimate: Core + Negotiation is a complete product.
2. **Second cut: M4.5 public relay** → launch with docker-compose self-host only.
3. **Never cut:** M1 (wire v1), M2.7 (conformance), M3.2 (security audit), M3.5 (spec freeze). Publishing a spec whose reference implementation diverges from it kills the "implement it in a weekend" pitch.

## Execution order & file-touch map

Rule of thumb: **two issues that touch the same file must not be in flight at the same time.** The hotspots are `protocol/src/crypto/envelope.ts` (M1.1, M1.3), `protocol/src/session/state-machine.ts` (M1.4, M2.3, M2.4, M3.1 — moved to protocol pkg post-M1.2), and `mcp-server/src/tools/inbox.ts` (M1.2, M1.4, M1.5).

| Issue | Touches | Blocked by |
|---|---|---|
| M1.7 CI | `.github/workflows/` (new) | — (do first) |
| M1.1 sign-the-blob | `protocol/crypto/envelope.ts`, `sign.ts`, `index.ts`; ripples into `mcp-server/relay/client.ts`, `relay/routes/inbox.ts` | — |
| M1.3 strict base64url | `protocol/crypto/` (same file as M1.1) | M1.1 |
| M1.2 receiver algorithm | `mcp-server/tools/inbox.ts`, protocol verify path | M1.1 |
| M1.4 namespace types | `protocol/envelope/schema.ts` (new), `protocol/session/state-machine.ts`, `protocol/session/validate.ts`, `mcp-server/tools/inbox.ts`, `mcp-server/tools/pair.ts`, `mcp-server/index.ts`, `store/closed-threads.ts` (new), `e2e/dual-server.ts` | M1.1; serialize with M1.2 (shared `inbox.ts`) |
| M1.5 error codes | error returns in `tools/*`, `relay/routes/*`, `SPEC.md` §10 (`thread_closed`) | M1.2, M1.4 (do last in M1; must land before M3.5) |
| M1.6 golden vectors | new `fixtures/`, protocol tests | M1.1, M1.3, M1.4 (needs final type strings) |
| M2.2 profile advertisement | `protocol/pairing/flow.ts`, `mcp-server/store/bonds.ts`, `tools/pair.ts` | M1.4 (shared `pair.ts`); parallel-safe with M2.1 |
| M2.1 spillover | `tools/session.ts`, `relay/client.ts`, artifact crypto in protocol | M1.1 |
| M2.3 N5 bond_revoked | `protocol/session/state-machine.ts`, revoke path in tools | M1.4 (same file) |
| M2.4 N7 deadline | `protocol/session/state-machine.ts`, `protocol/envelope/schema.ts` | M2.3 (same file — or one PR with M2.3) |
| M2.5 N6 audit | tests only | M2.4 |
| M2.6 relay sig verify | `relay/routes/inbox.ts` only | M1.1 |
| M2.7 conformance checklist | docs + tests (read-only on src) | runs all week, closes after M2.x land |
| M3.1 atest extraction | `runners/*`, `protocol/session/*`, `protocol/envelope/schema.ts` (rename NOT repeated — see decisions/2026-07-10-m31) | M1.4, M2.4 |
| M3.2 security audit | read + targeted fixes | M2 complete |
| M3.3 adversarial e2e | `e2e/*` | M1, M2 complete |
| M3.4 dogfood | no code | M3.3 |
| M3.5 spec freeze | `SPEC.md` | M3.1–M3.4 findings |
| M4.1–M4.3, M4.6 | docs/infra only | — (parallel-safe) |
| M4.4 release | version bumps | all code issues |
| M4.5 relay deploy | `deploy/` | M2.6 |

**Safe parallel lanes** (never share files): M1.7 ‖ M1.1 · M1.6 ‖ M1.2 · M2.1 ‖ M2.2 ‖ M2.6 · M3.1 ‖ M3.3 · semua M4 docs ‖ satu sama lain.

## Risks

| Risk | Mitigation |
|---|---|
| Wire v1 migration touches everything | Do it Week 1, nothing depends on v0 externally yet (0.x on npm) |
| Spec ↔ impl drift found late | Conformance checklist (M2.7) forces the diff early |
| Solo bottleneck on review | Adversarial tests (M3.3) + dogfood (M3.4) substitute for a second reviewer |
| Scope creep from Appendix B ideas | Appendix B is post-1.0 by definition; new ideas become issues labeled `post-1.0` |
