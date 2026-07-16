# AgentPair Core Conformance Checklist

Maps every normative **MUST** / **MUST NOT** in [SPEC.md](../SPEC.md) §1.1 (Core), §3–§7 to tests in this repository. Rows marked **(SHOULD)** in the SPEC column are included for completeness but are not normative MUSTs.

**Inventory (full table):** 64 rows — 60 `covered`, 2 `invariant`, 2 `partial`, 0 `gap`.

**MUST-scope tally** (excludes 3 informational rows below): 61 rows — 57 `covered`, 2 `invariant`, 2 `partial`, 0 `gap`.

| Excluded from MUST tally | ID | Reason |
|--------------------------|-----|--------|
| SHOULD, not MUST | §6.3-revoke-push | SPEC §6.3: push allowlist on revoke is SHOULD |
| Optional, not MUST | §7-core-ack | SPEC §7: optional delivery acknowledgment |
| Fixture row | §4-golden-happy | M1.6 golden-vector wire; not a standalone SPEC MUST sentence |

| Status | Meaning |
|--------|---------|
| `covered` | At least one automated test asserts the requirement |
| `partial` | Behavior exists but test is indirect or split across layers |
| `gap` | No automated test; tracked in a GitHub issue |
| `invariant` | Architectural property verified by code structure, not a runtime test |

**Conformance class:** Core = §3–§7. This checklist is the M2.7 exit gate ([ROADMAP.md](../ROADMAP.md), issue [#34](https://github.com/rfxlamia/agent-pair-protocol/issues/34)).

**Golden vectors:** Third-party byte-match fixtures live in [`packages/protocol/fixtures/`](../packages/protocol/fixtures/) — see [`fixtures/README.md`](../packages/protocol/fixtures/README.md). CI runs `pnpm --filter @agentpair/protocol run verify-fixtures`.

**E2E smoke (full stack):** `packages/mcp-server/src/e2e/happy-path.test.ts`, `profile-pairing.test.ts`, `spillover-roundtrip.test.ts` — pair → negotiate → ratify over a live relay.

---

## §1.1 Conformance classes (Core subset)

| ID | SPEC MUST | Test(s) | Status |
|----|-----------|---------|--------|
| §1.1-advertise | Implementation MUST advertise supported profiles during pairing | `packages/protocol/src/pairing/flow.test.ts` — `stores full profile contract when both sides advertise the reference set`; `pairRetry includes profiles on initiator pake wire`; `packages/mcp-server/src/e2e/profile-pairing.test.ts` | covered |
| §1.1-contract | Peers MUST NOT send envelopes whose type belongs to a profile the recipient has not advertised | `packages/mcp-server/src/tools/inbox-profile.test.ts` — `send nego.open rejected with profile_not_supported before relay`, `receive nego.turn returns profile_not_supported with no side effects`; `packages/protocol/src/profile/envelope-profile.test.ts` | covered |

---

## §3 Identity & Cryptography

| ID | SPEC MUST | Test(s) | Status |
|----|-----------|---------|--------|
| §3-agent-id | `agent_id` = `ed25519:` + base64url(public_key), no padding | `packages/protocol/src/crypto/base64url.test.ts`; `packages/protocol/src/fixtures/keys.test.ts` | covered |
| §3-suite-fixed | Algorithm suite fixed per protocol version (no `alg` negotiation) | No runtime test — enforced by single code path in `encrypt.ts` / `envelope.ts` | invariant |
| §3-nonce | Implementations MUST generate a fresh random nonce per envelope | `packages/protocol/src/fixtures/crypto-fixtures.test.ts` — `uses a fresh random nonce on each call`; `packages/protocol/src/crypto/encrypt.test.ts` — `randomNonce` length | covered |
| §3-hkdf | HKDF-SHA-256, info = `agentpair-envelope-v1` | `packages/protocol/src/fixtures/payload-encryption.test.ts` (golden vector byte-match) | covered |
| §3-base64url | MUST reject padding, non-alphabet, and non-canonical base64url | `packages/protocol/src/crypto/base64url.test.ts`; `packages/protocol/src/fixtures/base64url.test.ts`; relay strict decode: `packages/relay/src/routes/inbox.test.ts`, `allowlist.test.ts`, `artifact.test.ts` | covered |

---

## §4 Envelope Wire Format v1

### §4.1–4.2 Structure

| ID | SPEC MUST | Test(s) | Status |
|----|-----------|---------|--------|
| §4-sign-blob | Sign-the-blob: signature over exact transmitted body bytes | `packages/protocol/src/envelope.test.ts` — `createOuterEnvelope → verifyOuterEnvelope true over exact blob bytes` | covered |
| §4-unknown-v | Receivers MUST reject unknown wire `v` with `unsupported_version` | `packages/protocol/src/receive-envelope.test.ts` — step 0; `packages/protocol/src/fixtures/envelope-negative.test.ts` | covered |
| §4-unknown-type | Unknown envelope `type` → `unsupported_envelope_type`, no side effects | `packages/protocol/src/receive-envelope.test.ts` — step 8; `packages/protocol/src/fixtures/envelope-negative.test.ts`; `packages/mcp-server/src/tools/inbox-profile.test.ts` — `unknown.foo returns unsupported_envelope_type` | covered |

### §4.3 Receiver algorithm (normative order)

| ID | SPEC MUST | Test(s) | Status |
|----|-----------|---------|--------|
| §4.3-step-1 | Size check > 64 KiB before decode → `envelope_too_large` | `packages/protocol/src/receive-envelope.test.ts` — step 1; `packages/protocol/src/fixtures/envelope-negative.test.ts`; `packages/relay/src/routes/inbox.test.ts` (M2.6 relay gate) | covered |
| §4.3-step-2 | Strict-decode `blob`; malformed JSON → `invalid_json` | `packages/protocol/src/receive-envelope.test.ts` — step 2; `packages/protocol/src/fixtures/envelope-negative.test.ts` | covered |
| §4.3-step-3 | `body.v` must equal outer `v` → `version_mismatch` | `packages/protocol/src/receive-envelope.test.ts` — step 3; `packages/protocol/src/fixtures/envelope-negative.test.ts` | covered |
| §4.3-step-4 | Sender MUST be bonded → `recipient_not_allowed` | `packages/protocol/src/receive-envelope.test.ts` — step 4; `packages/mcp-server/src/tools/inbox-hygiene.test.ts` — `include_history unbonded → recipient_not_allowed`; `packages/relay/src/routes/inbox.test.ts` — default-deny POST | covered |
| §4.3-step-4-leak | MUST NOT leak whether unbonded recipient exists (§10) | `packages/relay/src/routes/inbox.test.ts` — `returns identical recipient_not_allowed for no-row vs empty allowlist` | covered |
| §4.3-step-5 | Verify `sig` over decoded blob → `invalid_signature` | `packages/protocol/src/receive-envelope.test.ts` — step 5; `packages/protocol/src/envelope.test.ts` — tampered blob/sig; `packages/protocol/src/fixtures/envelope-negative.test.ts` | covered |
| §4.3-step-6 | Cross-check outer vs signed inner `from`/`to` → `routing_mismatch` | `packages/protocol/src/receive-envelope.test.ts` — step 6 (3 cases); `packages/protocol/src/fixtures/envelope-negative.test.ts`; `packages/relay/src/routes/inbox.test.ts` — routing cross-check (M2.6) | covered |
| §4.3-step-7-seq | `seq` MUST be strictly greater than last accepted → `stale_seq` | `packages/protocol/src/receive-envelope.test.ts` — step 7 seq cases; `packages/protocol/src/fixtures/envelope-negative.test.ts`; `packages/mcp-server/src/tools/thread-seq.test.ts` | covered |
| §4.3-step-7-ttl | Expired `ttl` → `envelope_expired` | `packages/protocol/src/receive-envelope.test.ts` — step 7 ttl; `packages/protocol/src/fixtures/envelope-negative.test.ts` | covered |
| §4.3-step-8 | Decrypt, validate schema, dispatch; `invalid_payload` on failure | `packages/protocol/src/receive-envelope.test.ts` — step 8; `packages/protocol/src/fixtures/envelope-negative.test.ts` | covered |
| §4.3-order | Steps run in normative order (dispatch not called on early failure) | `packages/protocol/src/receive-envelope.test.ts` — `order: dispatch must not run when step 7 fails` | covered |
| §4-golden-happy | Golden vector happy-path wire | `packages/protocol/src/fixtures/envelope-core-msg.test.ts` | covered |

---

## §5 Relay Protocol

| ID | SPEC MUST | Specified where? | Test(s) | Status |
|----|-----------|------------------|---------|--------|
| §5-no-decrypt | Relay MUST NOT read payloads; blobs opaque | SPEC §5 | `packages/relay/src/` has no decrypt/import of envelope crypto — verified by absence of decrypt path | invariant |
| §5-default-deny | Relay MUST reject `POST /inbox/{A}` unless sender in A's signed allowlist | SPEC §5; probe `default-deny` | `packages/relay/src/routes/inbox.test.ts` — unbonded sender rejected; `packages/relay-conformance` | covered |
| §5-challenge | `GET /inbox` MUST use challenge-response auth | SPEC §5; probe `challenge-roundtrip` | `packages/relay/src/routes/inbox.test.ts` — challenge issue, sig verify, reused nonce rejected; `packages/relay-conformance` | covered |
| §5-no-unauth-inbox | Relay MUST NOT hand inbox to unauthenticated caller | SPEC §5 | `packages/relay/src/routes/inbox.test.ts` — `returns 401 challenge when GET inbox has no signature` | covered |
| §5-artifact-hash | Relay MUST verify SHA-256 hash matches content on artifact PUT | SPEC §5; probe `hash-verify` | `packages/relay/src/routes/artifact.test.ts` — `returns hash_mismatch before auth side effects`; `packages/relay-conformance` | covered |
| §5-artifact-ciphertext | Uploaders MUST encrypt artifact client-side before PUT | SPEC §5 | `packages/protocol/src/artifact/encrypt.test.ts` — golden vector `artifact-spillover.json`; `packages/mcp-server/src/e2e/spillover-roundtrip.test.ts` | covered |
| §5-spill-ref | Spill ref fields (`spill`, `artifact_hash`, `size`, `content_type`, `summary`, `artifact_key`) | SPEC §5 | `packages/protocol/src/artifact/schema.test.ts`; `packages/protocol/src/artifact/spill.test.ts` | covered |
| §5-spill-plaintext-cap | Receiver local spillover plaintext cap 10 MiB (`size` check before GET) | SPEC §5 | `packages/protocol/src/artifact/encrypt.test.ts` — `MAX_SPILLOVER_PLAINTEXT_BYTES as 10 MiB`; `resolve.test.ts` — `artifact_too_large before GET`; `spill.test.ts` | covered |
| §5-pair-ttl | Pairing sessions expire after 5 minutes (relay-enforced, fixed from creation) | SPEC §5; Appendix C.5; probe `pair-ttl` | `packages/relay/src/routes/pair.test.ts` — `does not extend expires_at on POST activity`; `returns 410 pair_session_lost after TTL and deletes row` | covered |
| §5-pair-slot | `/pair/{session_id}` stores at most one message (single-slot overwrite) | SPEC §5 | `packages/relay/src/routes/pair.test.ts` — `overwrites message_json on POST conflict` | covered |
| §5-pair-errors | Pair GET: `404` → `pair_not_found`; `410` → `pair_session_lost` | Appendix C.5 | `packages/relay/src/routes/pair.test.ts` — `returns 404 pair_not_found for unknown session`; `returns 410 pair_session_lost after TTL` | covered |
| §5-allowlist-blob | Allowlist push uses sign-the-blob `{blob, sig}`; cap 1024 entries | Appendix C.3; probe `allowlist-blob` | `packages/relay/src/routes/allowlist.test.ts` — sign-the-blob cutover; `packages/protocol/src/allowlist/encode.test.ts` — `ALLOWLIST_MAX_ALLOWED = 1024`; `packages/mcp-server/src/relay/client-allowlist.test.ts` | covered |
| §5-inbox-idempotency | Same envelope `id`: byte-identical retry → `204`; different bytes → `409 envelope_id_collision` | SPEC §5; Appendix C.6; probe `inbox-idempotency` | `packages/relay/src/routes/inbox.test.ts` — `returns 409 envelope_id_collision when same id has different wire bytes`; `packages/relay-conformance` | covered |
| §5-at-least-once | Delivery at-least-once; receivers rely on §4.3 idempotency | SPEC §5 | `packages/protocol/src/receive-envelope.test.ts` — `stale_seq` idempotency; host retry paths in `packages/mcp-server/src/relay/client.ts` (indirect) | partial |
| §5-health-claim | `/health` exposes `spec_version` + `relay_conformance` conformance claim | Appendix C.2; §5.1 preflight | `packages/relay/src/routes/health.test.ts`; `packages/mcp-server/src/relay/preflight.test.ts` — claim mismatch → `relay_not_conformant` | covered |
| §5-preflight | Runtime preflight hard block → host `relay_not_conformant` | SPEC §5.1; §10 | `packages/mcp-server/src/relay/preflight.test.ts` — `hard blocks with relay_not_conformant on claim mismatch` | covered |

---

## §6 Pairing & Bonding

### §6.1 Human code

| ID | SPEC MUST | Test(s) | Status |
|----|-----------|---------|--------|
| §6.1-code-format | Pairing code `NN-word-word-word` from ≥256-word list | `packages/protocol/src/pairing/flow.test.ts` — `uses a 256-word list`, `matches NN-word-word-word format` | covered |
| §6.1-code-not-relay | Pairing code MUST NOT transit the relay | `packages/protocol/src/pairing/flow.test.ts` — `assertNoPlaintextCodeOnRelay` in success, wrong-code, and rejection paths | covered |

### §6.2 PAKE handshake

| ID | SPEC MUST | Test(s) | Status |
|----|-----------|---------|--------|
| §6.2-pake | SPAKE2 over `/pair/{session_id}` with code as secret | `packages/protocol/src/pairing/pake-adapter.test.ts`; `pake-spike.test.ts` — matching keys with same code | covered |
| §6.2-ping-pong | Party MUST NOT post until peer's previous message consumed (strict ping-pong) | `packages/relay/src/routes/pair.test.ts` — single-slot overwrite; `packages/protocol/src/pairing/flow-ping-pong.test.ts` — joiner post-without-consume, initiator double-post → `pake_failed`, slot overwrite, zero allowlist | covered |
| §6.2-profiles-on-pake | Each `pake` message MUST carry supported `profiles` | `packages/protocol/src/pairing/flow.test.ts` — profile contract tests; `pairRetry includes profiles on initiator pake wire` | covered |
| §6.2-fingerprint | Confirm fingerprint formula (identity-bound v2) | `packages/protocol/src/pairing/pair-confirm-fingerprint.test.ts`; `packages/protocol/src/fixtures/pair-confirm-fingerprint-v2.json` | covered |
| §6.2-fingerprint-golden | Golden vector MUST match for conformance | `packages/protocol/src/pairing/pair-confirm-fingerprint.test.ts` (v2 vector from SPEC §6.2) | covered |
| §6.2-pake-failed | Verification failure MUST abort with `pake_failed` | `packages/protocol/src/pairing/flow.adversarial.test.ts` — cases 1–3, 5, 9; `flow.test.ts` — wrong code | covered |
| §6.2-human-gate | Joiner's human MUST approve before `bond_ok` | `packages/protocol/src/pairing/flow.test.ts` — `returns rejection explanation to initiator with no bond` (`decision: { reject }`); `packages/mcp-server/src/tools/pair.test.ts` — `pair_join` queues pending, bonds only after `human_approve` with `via_human: true` | covered |
| §6.2-bond-ok-tag | `bond_ok` tag formula | `packages/protocol/src/pairing/pair-bond-ok-tag.test.ts`; `packages/protocol/src/fixtures/pair-bond-ok-tag.test.ts` | covered |
| §6.2-bond-ok-order | Joiner-first `bond_ok`, initiator replies, both push allowlists | `packages/protocol/src/pairing/flow.test.ts` — `does not push initiator allowlist before joiner bond_ok` | covered |
| §6.2-bond-fail-courtesy | `bond_fail` MUST NOT be treated as security mechanism | `packages/protocol/src/pairing/flow.adversarial.test.ts` — cases 4, 5, 8 (inject/drop `bond_fail`, security rests on fingerprint/tags) | covered |
| §6.2-initiator-id | Joiner verifies initiator `agent_id` matches proposal | `packages/protocol/src/pairing/flow.adversarial.test.ts` — case 2 swap initiator agentId | covered |

### §6.3 Bond record & revocation

| ID | SPEC MUST | Test(s) | Status |
|----|-----------|---------|--------|
| §6.3-revoke-allowlist | Revocation MUST remove peer from local allowlist | `packages/mcp-server/src/tools/bug-hunt.test.ts` — `handleRevoke clears bonds store`; revoke integration suite | covered |
| §6.3-revoke-push | (SHOULD) Push updated allowlist immediately on revocation | `packages/mcp-server/src/tools/bug-hunt.test.ts` — `retries purge and push on idempotent revoke`; `reports no_bond_found for never-bonded peer but still pushes allowlist` | covered |

### §6.4 Profile advertisement

| ID | SPEC MUST | Test(s) | Status |
|----|-----------|---------|--------|
| §6.4-profiles-pake | Each side MUST include profiles on `pake` wire message | `packages/protocol/src/pairing/flow.test.ts` — profile contract tests | covered |
| §6.4-grammar | Profile lists MUST satisfy §12 grammar | `packages/protocol/src/profile/wire-schema.test.ts` — rejects duplicates, invalid grammar, >32 profiles | covered |
| §6.4-intersection | Empty intersection MUST abort `profile_not_supported` | `packages/protocol/src/pairing/flow.test.ts` — `returns profile_not_supported when profiles are disjoint`; `when intersection lacks core/1` | covered |
| §6.4-contract-persist | Intersection persisted in bond record | `packages/protocol/src/pairing/flow.test.ts` — `stores partial intersection as bond contract` | covered |
| §6.4-outside-contract | Envelope outside bond contract → `profile_not_supported` | `packages/mcp-server/src/tools/inbox-profile.test.ts`; `packages/protocol/src/profile/envelope-profile.test.ts` | covered |
| §6.4-fingerprint-bind | Profiles cryptographically bound in confirm fingerprint | `packages/protocol/src/pairing/flow.adversarial.test.ts` — `tampered initiator profiles — initiator pake_failed` | covered |

---

## §7 Core Messaging

| ID | SPEC MUST | Test(s) | Status |
|----|-----------|---------|--------|
| §7-core-msg | `core.msg` ordered E2E message in thread | `packages/mcp-server/src/tools/inbox-hygiene.test.ts` (M1.4 core types); `packages/protocol/src/envelope/schema.test.ts` | covered |
| §7-core-close-stop | Receiver MUST stop sending on thread after processing `core.close` | `packages/mcp-server/src/tools/inbox-hygiene.test.ts` — `send after peer core.close receive is rejected` (`thread_closed`); `packages/mcp-server/src/store/closed-threads.test.ts` | covered |
| §7-core-close-unilateral | `core.close` unilateral, immediate for sender | `packages/mcp-server/src/tools/inbox-hygiene.test.ts` — `core.close receive marks closedThreads idempotently`; `handleClose rejects re-close on sender` | covered |
| §7-core-ack | `core.ack` optional delivery acknowledgment | `packages/mcp-server/src/tools/inbox-hygiene.test.ts` (core.ack receive path) | covered |
| §7-thread-implicit | Thread created implicitly by first message with new `thread` id | `packages/mcp-server/src/tools/inbox.test.ts` — seq tracking on new threads (indirect; no dedicated “thread created” assertion) | partial |

---

## Out of scope (M2.7)

Tracked elsewhere in [ROADMAP.md](../ROADMAP.md):

| Topic | SPEC | Milestone |
|-------|------|-----------|
| Negotiation rules N1–N7 | §8 | M2.3–M2.5 (done); session tests in `state-machine.test.ts` |
| Human gate `via_human` provenance | §8.4, §11.3 | M3.2 security audit |
| Single-use pairing codes (`pairRetry` tension) | §11.3 | M3.2 |
| Adversarial e2e (tampered outer `to`, replay, self-approval) | §11.2 | M3.3 |
| Acceptance testing `atest/1` | §9 | M3.1 |

---

## Gap issues

None — all MUST-scope checklist rows are covered, invariant, or partial (see table above).

---

## Maintenance

When adding a SPEC MUST or a test:

1. Add or update a row in this document.
2. If status is `gap`, open a GitHub issue and link it in the Gap issues table.
3. Prefer golden vectors for wire-byte requirements ([`fixtures/README.md`](../packages/protocol/fixtures/README.md)).
