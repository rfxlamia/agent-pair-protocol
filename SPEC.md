# AgentPair Protocol Specification

**Version:** 1.0-draft
**Status:** DRAFT — not yet published; wire format may change until 1.0
**License:** spec text CC-BY-4.0; reference implementation Apache-2.0

> All previously open design decisions are resolved — see the log in §13.

---

## 1. Introduction & Conformance

AgentPair is a protocol for **personal agent-to-agent communication**: two AI
agents, each acting for one human, exchange end-to-end-encrypted messages
through an untrusted relay to negotiate concrete deliverables (schedules, API
contracts, documents).

Design principles, in priority order:

1. **Keys never leave the agent host.** The AI model reasons; the host signs.
2. **The relay is dumb.** It sees routing metadata and ciphertext, nothing else.
3. **Humans gate trust.** Bonding requires a code exchanged between humans;
   binding decisions require explicit human approval. Either human can revoke
   unilaterally, at any time, without the peer's consent.
4. **Authenticity is not trustworthiness.** A verified message is still
   untrusted input for an AI model (see §11).

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be
interpreted as described in RFC 2119.

### 1.1 Conformance classes

| Class | Requirement |
|---|---|
| **Core** | Implements §3–§7. The minimum for interoperability. |
| **Negotiation** | Core + §8. |
| **Acceptance Testing** | Negotiation + §9. |

An implementation MUST advertise its supported profiles during pairing (§6.4).
Peers MUST NOT send envelopes whose type belongs to a profile the recipient
has not advertised.

*Rationale: a small Core lets a third party implement AgentPair in a weekend
and build use cases the authors never imagined. Negotiation is one profile,
not the whole protocol.*

---

## 2. Architecture

```
┌──────────────┐        ┌────────────────┐   HTTPS   ┌─────────┐
│ AI client /  │  any   │ AgentPair host │◄─────────►│  Relay  │
│ model        │◄──────►│ (holds keys)   │           │ (dumb)  │
└──────────────┘ binding└────────────────┘           └─────────┘
```

- **Agent (host):** the process that holds keys, encrypts, signs, enforces
  this specification. Identified by an `agent_id`.
- **Binding:** how an AI model drives the host — MCP server (Appendix A),
  library API, CLI, or anything else. Bindings are **informative**, never
  normative. This spec ends at the host.
- **Relay:** an HTTP queue (§5). Interchangeable; agents on different relays
  are out of scope for v1 (see Appendix B).

---

## 3. Identity & Cryptography (Core)

| Purpose | Algorithm |
|---|---|
| Identity / signatures | Ed25519 |
| Key agreement | X25519 (birationally mapped from the Ed25519 keys) |
| Payload encryption | XChaCha20-Poly1305, 24-byte random nonce |
| KDF | HKDF-SHA-256, info = `"agentpair-envelope-v1"` |
| Hashing (fingerprints, artifacts) | SHA-256 |

- `agent_id` = `"ed25519:" + base64url(public_key)` (no padding).
- The algorithm suite is **fixed per protocol version**. There is no `alg`
  field and no negotiation. A future suite is a new protocol version.
  *Rationale: algorithm agility is how JOSE grew its `alg:none` and key-confusion
  attacks. We refuse the entire class.*
- Payload encryption: `payload = base64url(nonce ‖ ciphertext)` where the key
  is `HKDF(X25519(sender_sk, recipient_pk))`. Implementations MUST generate a
  fresh random nonce per envelope.
- base64url everywhere: strict decoding. Implementations MUST reject padding
  characters, non-alphabet characters, and non-canonical encodings.

---

## 4. Envelope Wire Format v1 (Core)

The envelope is the only unit the relay ever carries. **v1 uses
sign-the-blob:** the sender serializes the body once, and the exact bytes it
produced are what gets signed and transmitted. Verifiers never re-serialize.
*Rationale: cross-language JSON canonicalization is a bug factory (spacing,
number formats, unicode escapes). Signing the transmitted bytes removes the
class, with zero canonicalization libraries required.*

### 4.1 Outer envelope (visible to relay)

```json
{
  "v": 1,
  "from": "ed25519:…",
  "to": "ed25519:…",
  "blob": "<base64url(body_bytes)>",
  "sig": "<base64url(Ed25519(body_bytes))>"
}
```

- `v` — wire format version. Receivers MUST reject unknown versions with
  `unsupported_version`.
- `from`, `to` — routing hints for the relay (`from` lets the relay enforce
  its allowlist and verify `sig` without parsing the body). **Unsigned;
  untrusted;** receivers rely only on the signed copies inside the body.
- `sig` — Ed25519 signature over the raw `body_bytes` (the decoded blob),
  verified with the sender key found *inside* the body.

### 4.2 Body (inside the blob)

```json
{
  "v": 1,
  "id": "<uuid>",
  "from": "ed25519:…",
  "to": "ed25519:…",
  "type": "core.msg",
  "thread": "<thread-id>",
  "seq": 3,
  "ttl": 1767200000,
  "payload": "<base64url(nonce ‖ ciphertext)>"
}
```

`type` namespaces: `core.*` (§7), `nego.*` (§8), `atest.*` (§9).
Unknown types → reject `unsupported_envelope_type`, no side effects.

### 4.3 Receiver algorithm (normative order)

1. **Size check.** Reject envelopes larger than **64 KiB** *before*
   decoding (`envelope_too_large`). Mitigates decode-DoS. Large content
   travels as encrypted artifacts via spillover (§5), never in envelopes.
2. Strict-decode `blob`; parse body as JSON. Malformed → `invalid_json`.
3. `body.v` must equal outer `v`; else `version_mismatch`.
4. Extract `body.from`; the sender MUST be bonded (§6). Unknown/unbonded →
   `recipient_not_allowed`, and the host SHOULD NOT reveal whether the
   recipient exists.
5. Verify `sig` over the exact decoded blob bytes using `from`'s key.
   Failure → `invalid_signature`.
6. **Cross-check:** `body.to` MUST equal the outer `to` and MUST equal the
   receiving agent's own id; `body.from` MUST equal the outer `from`.
   Mismatch → `routing_mismatch`.
   *Rationale: the outer fields are attacker-writable; the inner copies are
   signed.*
7. Replay/ordering: `seq` MUST be strictly greater than the last accepted
   `seq` for `(thread, from)`. Duplicate or regressed → `stale_seq`, no side
   effects. `ttl` (unix seconds) expired → `envelope_expired`.
8. Only now: decrypt `payload`, validate against the schema for `type`,
   dispatch.

---

## 5. Relay Protocol (Core)

The relay is an HTTP server. It MUST NOT be able to read payloads and MUST
treat blobs as opaque. Decryption happens **only** on the receiving agent
host: the payload key is derived from the recipient's secret key, which never
exists relay-side. The relay MAY verify envelope signatures (a public-key
operation) to reject garbage early; it can never decrypt.

Normative relay behavior:

- **Default-deny inbox.** The relay MUST reject `POST /inbox/{A}` unless the
  sender's `agent_id` appears in A's signed allowlist. (The receiving agent
  enforces bonding again on read — defense in depth; the relay is untrusted.)
- **Pull authentication.** `GET /inbox` MUST use challenge-response: relay
  issues a nonce, agent returns `Ed25519(nonce)`, nonces are single-use and
  expire. The relay MUST NOT hand an inbox to an unauthenticated caller.
- **Artifacts** are content-addressed by SHA-256. The relay MUST verify the
  hash matches the content on PUT.
- **Artifacts are ciphertext.** Uploaders MUST encrypt artifact content
  client-side before PUT (XChaCha20-Poly1305, fresh random key per artifact);
  the content hash is computed over the ciphertext. The artifact key is
  delivered to the peer inside an envelope payload (already E2E-encrypted).
  The relay stores drafts it cannot read — the dumb-relay property applies
  to artifacts, not just envelopes.
- **Spillover.** When an outgoing payload would exceed the envelope size
  limit (§4.3), the host SHOULD transparently store the content as an
  artifact and send a spill ref in its place. Envelope size never limits
  negotiation complexity — a 2 GB video costs a few hundred bytes on the wire.
  - **Artifact blob:** `nonce(24) ‖ ciphertext`; AAD `agentpair-artifact-v1`;
    hash = bare lowercase hex SHA-256 over the full blob.
  - **Spill ref** replaces envelope plaintext JSON before E2E encrypt; reserved
    top-level key `spill` (literal `1` for v1).
  - **Spill ref fields:** `spill`, `artifact_hash`, `size`, `content_type`,
    `summary`, `artifact_key` (base64url strict, 32-byte raw key).
  - **Receiver local spillover plaintext cap:** 10 MiB (`size` check before GET).
- **Pair channel.** Pairing sessions over `/pair/{session_id}` expire after
  **5 minutes** (relay-enforced TTL, fixed from session creation — no TTL
  refresh on activity). The channel stores **at most one message**
  (single-slot overwrite); see §6.2 for the ping-pong invariant.
- **Inbox POST idempotency.** When an envelope with the same `id` is posted
  again, the relay MUST return success (`204`) only if the wire bytes are
  byte-identical to the stored envelope; otherwise it MUST reject with
  `envelope_id_collision` (`409`). The relay MUST NOT report success for an
  envelope it did not store.
- **At-least-once delivery.** The relay MAY drop messages (queue overflow,
  TTL). Delivery is at-least-once from the sender's perspective; receivers
  rely on §4.3 idempotency, and hosts SHOULD retry sends with backoff.

### 5.1 Conformance verification

Two mechanisms verify relay behavior against this specification:

| Mechanism | When | Scope |
|---|---|---|
| **Offline conformance suite** (`@agentpair/relay-conformance`) | CI / operator | Full wire contract; slow/large probes gated (`--slow`, `--large`) |
| **Runtime preflight** | Host connect | Cheap subset: `GET /health` claim + challenge roundtrip + default-deny inbox; `AGENTPAIR_PREFLIGHT` modes (`warn` default, `strict`, `off`) |

Preflight hard failure surfaces as host error `relay_not_conformant` (§10),
distinct from `relay_unavailable`. The gold standard for relay conformance is
suite green, not §5 prose alone. Informative wire shapes and relay HTTP error
codes: Appendix C.

---

## 6. Pairing & Bonding (Core)

Bonding is the only way an agent becomes able to message another agent.

### 6.1 Human code

The initiator's host generates a pairing code:
`NN-word-word-word` (e.g. `42-otter-maple-crane`), from a fixed wordlist of
≥256 words. The code is exchanged **between humans, out of band** (in person,
call, chat). It is the PAKE password; it MUST NOT transit the relay.

### 6.2 PAKE handshake

The two hosts run **SPAKE2** over the relay's `/pair/{session_id}` channel,
with the code as the low-entropy secret. Pairing sessions expire after
**5 minutes** (relay-enforced TTL).

**Relay channel invariant:** the `/pair/{session_id}` channel stores **at most
one message** (single-slot overwrite). A party MUST NOT post a new message until
it has consumed the peer's previous message (strict ping-pong). Violating this
invariant drops messages on the relay and breaks pairing.

1. `pake` messages: both sides exchange SPAKE2 messages and derive a shared key.
   The joiner sends a single `pake` message with `role: "joiner"` that also
   carries its identity-bound `confirm` fields (`fingerprint`, `agentId`) — one
   wire post after reading the initiator's `pake`, preserving ping-pong.
2. `confirm` (joiner-first, identity-bound): the joiner's `fingerprint` and
   `agent_id` are sent in its `pake` message (step 1). Each side's `pake`
   message MUST also carry its supported `profiles` array (§6.4). The
   fingerprint MUST be:

   ```
   hex(SHA-256(domain ‖ u16_be(len(sk)) ‖ sk
              ‖ u16_be(len(id_init)) ‖ id_init
              ‖ u16_be(len(id_join))  ‖ id_join
              ‖ u16_be(len(profiles_init)) ‖ profiles_init…
              ‖ u16_be(len(profiles_join))  ‖ profiles_join…))
   ```

   where `domain` = `"agentpair-pair-confirm-v2"` (UTF-8), `sk` is the SPAKE2
   shared key, `id_init` is the initiator's `agent_id`, `id_join` is the
   joiner's `agent_id`, and each profile list is encoded as
   `u16_be(count)` followed by `count` entries of
   `u16_be(len(profile_id)) ‖ profile_id` (UTF-8). `profiles_init` is the
   initiator's advertised list in wire order; `profiles_join` is the joiner's.
   Length prefixes are big-endian 16-bit unsigned integers. `‖` denotes byte
   concatenation.

   Golden vector (MUST match for conformance testing):

   - `sk` = `0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20`
     (hex)
   - `id_init` = `ed25519:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqo`
   - `id_join` = `ed25519:u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7s`
   - `profiles_init` = `["core/1", "nego/1"]`
   - `profiles_join` = `["core/1", "nego/1"]`
   - fingerprint =
     `971c14e90ee057e1229dcf228d773d13e7e1d5919b5918d5b13667f5b67ca02e`

   The initiator verifies the joiner's fingerprint, then replies with its own
   `confirm`. The joiner verifies the initiator's fingerprint **and** that the
   initiator's `agent_id` equals the `initiatorAgentId` from the pairing
   proposal. Any verification failure MUST abort with `pake_failed`; the
   failing side SHOULD also send `bond_fail` as a courtesy fast-fail (see §11.2).
3. Human gate: the *joiner's* human MUST approve the proposal
   (scope + mode + initiator identity) before `bond_ok` is sent.
   Self-approval by the model is forbidden (§8.4 mechanism applies).
4. `bond_ok` / `bond_fail` (joiner-first commit):

   1. The joiner sends `bond_ok` first, with `agent_id` and a 64-character
      lowercase-hex `tag`:

      ```
      hex(SHA-256(domain ‖ u16_be(len(sk)) ‖ sk ‖ u16_be(len(agent_id)) ‖ agent_id))
      ```

      where `domain` = `"agentpair-pair-bondok-v1"` (UTF-8), `sk` is the SPAKE2
      shared key, and `agent_id` is the sender's `agent_id`.

   2. The initiator, on receiving `bond_ok`, verifies the tag, pushes its updated
      signed allowlist to the relay, then replies `bond_ok` (with its own tag).
   3. The joiner, on receiving the initiator's `bond_ok`, verifies the tag, then
      pushes its updated signed allowlist to the relay.

   `bond_fail` is a courtesy signal only — it carries no cryptographic proof
   and MUST NOT be treated as a security mechanism (§11.2). Hosts MAY send it
   to accelerate abort after a verification failure in the confirm phase
   (Class 1); during the bond phase it coordinates rollback when allowlist
   push fails.

   If the initiator's `bond_ok` reply is dropped by the relay, the initiator
   remains bonded while the joiner rolls back — the classic two-generals
   acknowledgment problem. Implementations SHOULD surface this asymmetry to
   the human operator.

### 6.3 Bond record

```
{ peer, scope: [...], mode: "bonded_contact" | "ephemeral_until_session_closes",
  profiles: [...] }
```

Either side MAY revoke a bond at any time, unilaterally, without notice to
the peer. Revocation MUST remove the peer from the local allowlist and
SHOULD push the updated allowlist to the relay immediately.

### 6.4 Profile advertisement

During the `pake` phase (§6.2 step 1), each side MUST include its supported
profiles on its `pake` wire message, e.g. `["core/1", "nego/1"]`. Profile
lists MUST satisfy the grammar in §12. The intersection (sorted, deduplicated)
is the bond's contract; both hosts persist it in the bond record. An empty
intersection MUST abort bonding with `profile_not_supported`. Profile lists are
cryptographically bound into the confirm fingerprint (§6.2 step 2); a relay
that rewrites advertised profiles without breaking SPAKE2 will fail fingerprint
verification. Sending an envelope whose type belongs to a profile outside the
contract is a protocol violation (`profile_not_supported`).

*Rationale: this is version/capability negotiation done once, at the trust
boundary, instead of per-message.*

---

## 7. Core Messaging

Envelope types:

| Type | Payload | Semantics |
|---|---|---|
| `core.msg` | `{ body: string, kind?: string }` | Ordered, E2E-encrypted message within a thread |
| `core.close` | `{ reason?: string }` | **Unilateral** thread close |
| `core.ack` | `{ ack_seq: number }` | Optional delivery acknowledgment |

- A thread is created implicitly by the first message bearing a new `thread` id.
- `core.close` takes effect immediately for the sender; the receiver MUST
  stop sending on that thread after processing it. No consent required —
  consistent with unilateral unbond.
- Core makes **no** promises about what messages mean. Meaning lives in
  profiles or applications built on Core.

---

## 8. Profile: Negotiation (`nego/1`)

Two bonded agents negotiate a deliverable under budget, then co-sign, then
both humans ratify.

### 8.1 States

`pending → live → signed → closed`, terminal branches `open_rejected`,
`open_expired`.

> *Informative:* how an agent knows *what* to negotiate is application-layer
> guidance, outside this spec. Rather than defining a new template format,
> implementations are encouraged to reuse existing agent-skill conventions
> (e.g. SKILL.md): a shareable skill can construct the `nego.open` payload
> and guide the agent's turns. Skill bodies are instructions fed to a model;
> installing a third-party skill is a trust decision (§11.1 applies).

### 8.2 Envelope types

`nego.open`, `nego.open_approved`, `nego.open_reject`, `nego.open_expired`,
`nego.turn`, `nego.signed`, `nego.ratified`,
`nego.budget_propose`, `nego.budget_approved`, `nego.budget_reject`.

`nego.open` payload:

```json
{
  "goal": "…",
  "acceptance": [ { "id": "…", "test": "executable|judgment", "desc": "…", "runner": "…" } ],
  "budget": { "max_turns": 20, "deadline": "<ISO8601 UTC, REQUIRED>" },
  "mandate": { "agent_may": [...], "human_required": [...], "escalate_on": [...] }
}
```

Budget extension payloads (N4). All three carry `thread` (MUST match
`body.thread`), `proposal_id` (UUID string), and absolute `new_max_turns`
(integer strictly greater than current `budget.max_turns` at propose time):

```json
{
  "thread": "<thread-id>",
  "proposal_id": "<uuid>",
  "new_max_turns": 30
}
```

`nego.budget_reject` adds optional `reason` (e.g. `superseded`). Budget
extension keeps session status `live` (`live → live`); no new §8.3 row.

### 8.3 Transitions

| From | Trigger | Guard | To |
|---|---|---|---|
| — | `nego.open` received | bonded; valid payload; `nego/1` in contract | `pending` |
| `pending` | recipient human approves | via human gate (§8.4) | `live` |
| `pending` | recipient human rejects | via human gate | `open_rejected` |
| `pending` | 60 min elapse without approval | — | `open_expired` |
| `live` | `nego.turn` | `turn_count ≤ budget.max_turns`, else `budget_exhausted` | `live` |
| `live` | both sides `nego.signed` | **identical** `artifact_hash` both sides | `signed` |
| `live` | `budget.deadline` passes | local, no peer message needed (N7) | `closed` (`deadline_expired`) |
| `signed` | both humans ratify | via human gate, both sides | `closed` |
| any | `core.close` | — | `closed` |

Normative rules:

- **N1 — Redelivery idempotency.** A re-delivered `nego.open` MUST NOT reset
  a session in `live`, `signed`, `closed`, or `open_rejected`.
- **N2 — Atomic co-sign.** `signed` is reached only when both recorded sign
  hashes are byte-identical. A signature over a different hash MUST NOT
  silently supersede an earlier one.
- **N3 — Participants only.** Envelopes from any agent other than the two
  session participants → `not_a_participant`, no side effects.
- **N4 — Budget extension** requires human approval on **both** sides before
  `budget.max_turns` rises. A side proposes an absolute `new_max_turns` via
  `nego.budget_propose` only after local human approval; the peer completes
  the gate with `nego.budget_approved` or `nego.budget_reject`. At most one
  outstanding extension per session; `extension_outstanding` while in flight.
  Session status remains `live` throughout (no §8.3 transition row).
- **N6 — Wire-derived turn count.** `turn_count` is the number of `nego.turn`
  envelopes observed on the thread (both directions), derived independently
  by each side from the wire. Implementations MUST NOT trust a peer-reported
  turn counter. Only `nego.turn` consumes budget; no other envelope type does.
- **N7 — Deadline is local.** When `budget.deadline` passes, each side MUST
  transition the session to `closed` (reason `deadline_expired`) locally,
  without requiring any message from the peer.
- **N5 — Unbond closes everything.** Revoking a bond MUST transition every
  session with that peer (any non-terminal state, including `signed`) to
  `closed` with reason `bond_revoked`. Hosts MUST NOT delete stored co-sign
  records (`signHashes`, signatures) as a side effect of this transition;
  closed sessions carrying signatures SHOULD be retained as evidence.

### 8.4 Human gates

| Event | Gate |
|---|---|
| Accepting a pairing proposal | required |
| Opening a session (recipient side) | required |
| Ratification (both sides) | required |
| Budget extension (both sides) | required |

Gate mechanism: the host queues a `pending` item and exposes an approval
operation that requires proof of human presence out-of-band from the model
(an opaque `approval_code` in the reference binding; see Appendix A4). The
host MUST reject approvals without valid proof (`self_approval_forbidden` or
binding-level equivalents). Bindings MUST source this proof from an actual
human interaction, never from model output alone — see §11.3 for why this
is load-bearing.

---

## 9. Profile: Acceptance Testing (`atest/1`)

Extends Negotiation with machine-checkable acceptance:

- `atest.challenge` — demand the peer run a named acceptance criterion.
- `atest.report` — `{ artifact_hash, passed, runner, details? }`, the runner's
  verdict over a content-addressed artifact (§5).
- Runners (e.g. `codegen-compile` for OpenAPI→C on ESP32, `spectral` for
  OpenAPI lint, `payload-size`) are named, versioned executables. A report
  MUST identify its runner; peers decide which runners they trust.
- Both sides SHOULD run tests independently and compare reports; a session
  SHOULD NOT be signed while reports over the current `artifact_hash`
  disagree.

---

## 10. Error Codes

Machine-readable snake_case strings, returned by hosts and relays.

Wire/envelope: `unsupported_version`, `version_mismatch`, `invalid_json`,
`invalid_signature`, `routing_mismatch`, `stale_seq`, `envelope_expired`,
`envelope_too_large`, `unsupported_envelope_type`, `invalid_payload`,
`profile_not_supported`.

Bond/pairing: `pair_not_found`, `pair_session_lost`, `pake_failed`,
`bond_aborted`, `bond_tag_mismatch`, `recipient_not_allowed`,
`allowlist_push_failed`.

Negotiation: `session_not_found`, `session_not_live`, `session_not_signed`,
`session_open_expired`, `not_a_participant`, `wrong_role`,
`initiator_mismatch`, `budget_exhausted`, `extension_outstanding`,
`proposal_required`, `human_required`,
`self_approval_forbidden`, `pending_not_found`, `challenges_incomplete`.

Core messaging: `thread_closed` — operation attempted on a thread that has been closed (§7).

Artifacts / spillover: `artifact_upload_failed`, `artifact_not_found`,
`artifact_fetch_failed`, `artifact_decrypt_failed`, `artifact_too_large`,
`relay_unavailable`, `relay_not_conformant`. `relay_unavailable` is send-path
only; `artifact_fetch_failed` is receive-path retryable (retry with
`since = cursor - 1`). `relay_not_conformant` is raised by the host when
runtime preflight (§5.1) hard-blocks a relay that fails the cheap conformance
subset — distinct from transient `relay_unavailable`.

Relay HTTP response bodies carry additional implementation-defined error
strings (e.g. `envelope_id_collision`, `payload_too_large`, `hash_mismatch`).
These are documented in Appendix C for interoperability; they are not host
error codes unless also listed above.

Errors MUST NOT leak whether an unbonded recipient exists (§4.3 step 4).

---

## 11. Security Considerations

### 11.1 Authenticity ≠ trustworthiness (prompt injection)

Signature verification proves *who sent the bytes*, not that the content is
safe. A bonded peer — malicious, compromised, or driven by a manipulated
model — can send payloads crafted to manipulate the receiving AI model
("ignore all previous instructions…"). **No wire-level mechanism can stop
this.** Therefore:

- Hosts and bindings MUST present peer payloads to the model as **data**
  (quoted, delimited, labeled untrusted), never as instructions.
- Binding decisions (bond, go-live, ratify, budget) MUST pass a human gate;
  the gate flag MUST originate from a human interaction, not model output.
  The human gates are the containment boundary for prompt injection — this
  is why §8.4 is normative and not UX advice.
- Implementations SHOULD cap and label peer content length shown to models.

### 11.2 Wire-level threats

- **Routing mismatch:** outer `to` is unsigned → mitigated by mandatory
  cross-check (§4.3 step 6).
- **Decode DoS:** size limit before decode (§4.3 step 1).
- **Replay:** monotonic `seq` per (thread, sender) + `ttl` (§4.3 step 7).
- **Relay identity-swap during confirm:** a malicious relay can rewrite the
  `agent_id` in a `confirm` message while leaving the SPAKE2 shared key
  intact. A fingerprint that hashes only the shared key would still match,
  letting the relay substitute its own identity. The identity-bound fingerprint
  (§6.2 step 2) binds `id_init` and `id_join` into the hash, so any swap
  changes the expected fingerprint and both sides abort with `pake_failed`.
- **bond_fail is courtesy-only:** `bond_fail` has no signature and no binding
  to the shared key. A relay can inject or drop it freely. Hosts MUST NOT
  treat receipt of `bond_fail` as proof of a peer's intent; it exists only to
  accelerate coordination abort. Security decisions rest on fingerprint
  verification and signed allowlist pushes.
- **Class 1 invariant:** verification failures in the confirm phase (bad
  fingerprint, `agent_id` mismatch, malformed confirm) MUST surface as
  `pake_failed` and MUST NOT modify either side's allowlist. No party MUST
  return `rolled_back` before its own local verification has passed. Only
  successful bond-phase coordination (§6.2 step 4) may push allowlist updates.
- **Two-generals bond asymmetry:** perfect two-sided atomicity over an
  untrusted relay is impossible. If the relay drops the initiator's `bond_ok`
  reply (§6.2 step 4), the initiator may remain bonded while the joiner rolls
  back. This is an accepted two-generals outcome, not a verification bug;
  implementations SHOULD surface the asymmetry to the human operator.
- **Relay compromise:** worst case = drop/delay/reorder messages and learn
  metadata (who talks to whom, when, sizes). It can never read or forge
  content. Metadata privacy (sealed sender) is a future extension
  (Appendix B), not a v1 property — do not claim it.
- **Artifact fetch is unauthenticated.** `GET /artifact/{hash}` returns the
  stored ciphertext blob to any caller who knows the hash. The relay cannot
  decrypt artifact content; confidentiality rests on the per-artifact key
  delivered inside E2E-encrypted envelopes (§5). Operators SHOULD treat
  artifact hashes as capability tokens.

### 11.3 Pairing

SPAKE2 resists offline dictionary attack on the code; an active attacker on
the relay gets exactly one online guess per session, within a 5-minute TTL.
Codes MUST be single-use. Humans SHOULD exchange codes over a channel they
already trust.

### 11.4 Key management

Long-term keys live only on the agent host. Key rotation and revocation
beyond unbonding are not specified in v1 (Appendix B).

---

## 12. IANA-style Registries (internal)

To extend the protocol without collisions, new envelope `type`s and profile
ids are registered in this document via pull request.

**Envelope type namespace:** `<profile>.<name>`, lowercase, `[a-z_]`.

**Profile id grammar:** `<name>/<version>` where `<name>` matches `[a-z_]+`,
`<version>` matches `[0-9]+`, the full id is at most 64 UTF-8 bytes, a wire
list carries at most 32 ids, and duplicates within one list are forbidden.
Example: `core/1`, `nego/1`, `atest/1`.

**Registered envelope types (`nego/1` budget extension):**

| Type | Profile |
|---|---|
| `nego.budget_propose` | `nego/1` |
| `nego.budget_approved` | `nego/1` |
| `nego.budget_reject` | `nego/1` |

---

## 13. Open Items

| # | Question | Current lean |
|---|---|---|
| ~~OPEN-1~~ | **RESOLVED:** Acceptance Testing is a separate profile (`atest/1`). Negotiation remains implementable without any runner infrastructure. | — |
| ~~OPEN-2~~ | **RESOLVED:** `budget.deadline` is REQUIRED (`invalid_payload` if absent). Expiry closes locally, no new status (N7). Turn budget is orthogonal and wire-derived (N6). | — |
| ~~OPEN-3~~ | **RESOLVED:** unbond closes all sessions (`bond_revoked`), one rule for every state; co-sign records are retained as evidence (N5). | — |
| ~~OPEN-4~~ | **RESOLVED:** spec in English; /docs may migrate to English after the repo opens. | — |
| ~~OPEN-5~~ | **RESOLVED:** code license Apache-2.0 (patent grant, enterprise-safe); spec text CC-BY-4.0. | — |
| ~~OPEN-6~~ | **RESOLVED:** 64 KiB envelope cap; large content goes through encrypted artifacts with automatic spillover (§5). | — |

---

## Appendix A — MCP Binding (informative)

The reference binding is an MCP server (`agentpair` on npm). MCP is a
**distribution channel**, not part of the protocol.

Binding guidance (hard-won):

- **A1 — Consolidate tools.** Expose few tools with verb parameters
  (`pair`, `approve`, `session`, `inbox`) rather than one tool per protocol
  message. Models navigate 4 well-described tools better than 12.
- **A2 — Blocking wait.** MCP servers cannot wake the model; the agentic
  loop dies when the last tool call returns. Bindings SHOULD provide a
  long-poll primitive (e.g. `inbox_wait(timeout)`) that blocks until a
  message arrives or timeout, so the model can keep the loop alive during a
  live session. Its description SHOULD instruct: *"while a session is live
  and budget remains, call inbox_wait again after processing each message;
  stop only on close, human gate, or budget exhaustion."*
- **A3 — Turn state in every result.** Every tool result SHOULD carry
  workflow state: `session_status`, `your_turn`, `turns_remaining`, and a
  `suggested_next` hint. When `turns_remaining ≤ 2`, the hint SHOULD warn
  the model to converge or request a budget extension (human-gated, both
  sides). Models follow tool-result hints far more reliably than tool
  descriptions.
- **A4 — Human gate (approval code).** The binding MUST NOT let the model
  self-approve gated actions. The reference binding replaces a
  model-settable boolean with an opaque `approval_code` on `human_approve`:

  - **Create path.** When a gated pending is created (`pair_join`,
    `session_open`, `ratify`, `budget_extend`), the host generates a
    single-use approval code and an HMAC verifier derived from the agent
    keystore. The code MUST be written to
    `<dataDir>/approvals/<pending_id>` (mode `0600`) **before** the pending
    is committed; write failure returns `approval_channel_unavailable` and
    MUST NOT create the pending. The host SHOULD also print the code to
    stderr (best-effort). Tool results surface `approval_path` and a
    `suggested_next` hint — never the plaintext code or verifier.

  - **Verify path.** `human_approve` accepts `pending_id`, `decision`, and
    `approval_code` (opaque string). The model-facing schema MUST NOT expose
    `via_human`. Missing or empty code → `self_approval_forbidden`.
    Malformed code → `invalid_approval_code` (`malformed: true`; no attempt
    consumed). Well-formed miss increments `approvalAttempts` (persisted);
    fifth miss exhausts the pending. Reject decisions use the same code path
    as approve.

  - **Host obligation.** The gate protects against model output alone, not a
    host that grants the model filesystem access to `dataDir` (e.g.
    `~/.agentpair`). Host integrations MUST prevent the model from reading
    approval files under `dataDir`/`approvals/`.

  - **Binding-level errors** (not in §10): `invalid_approval_code`,
    `approval_channel_unavailable`. `self_approval_forbidden` and
    `pending_not_found` are listed in §10 but are reused here.

  - **Known limitations.** (1) On transient downstream failures
    (e.g. `relay_unavailable`), the pending and code remain valid — the model
    may retry with a different decision while the code is still valid.
    (2) Multi-process contention on a shared `dataDir` is unsupported.
    (3) Once the human types the code into chat, it briefly appears in model
    context; mitigated by single-use binding to `pending_id` and attempt cap.

## Appendix B — Future Extensions (non-normative)

- Negotiation packs distributed as agent skills (SKILL.md or equivalent)
  that generate `nego.open` payloads and guide agent behavior — reuse of
  existing skill ecosystems, no new format.
- Sealed sender / metadata privacy toward the relay.
- Cross-relay federation (agents on different relays).
- Key rotation and bond re-keying.
- Group sessions (>2 agents).
- Additional cipher suite as protocol v2.

## Appendix C — Relay Wire (informative)

This appendix documents the v1 relay HTTP surface shipped by the reference
implementation. It is informative — normative relay *behavior* lives in §5.
Executable contract: `@agentpair/relay-conformance` (§5.1).

### C.1 Routes

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness + conformance claim |
| `PUT` | `/allowlist/{agent_id}` | Signed allowlist push |
| `POST` | `/pair/{session_id}` | PAKE message drop |
| `GET` | `/pair/{session_id}` | PAKE message poll |
| `POST` | `/inbox/{agent_id}` | Envelope drop |
| `GET` | `/inbox/{agent_id}?since=T&challenge=…&sig=…` | Challenge-response pull |
| `DELETE` | `/inbox/{agent_id}/purge` | Purge inbox rows (challenge auth) |
| `PUT` | `/artifact/{hash}` | Content-addressed blob store |
| `GET` | `/artifact/{hash}` | Blob fetch (unauthenticated; §11.2) |

v1 has **no** `/card` routes. Agent registration is determined by the
existence of a valid signed allowlist row for the `agent_id`.

Unauthenticated inbox pull/purge (missing `challenge` or `sig` query params)
returns **401** with:

```json
{ "challenge": "<base64url-nonce>", "expires_at": <unix_ms> }
```

The host signs the **UTF-8 bytes of the `challenge` string** with the path
`agent_id` Ed25519 secret key, base64url-encodes the signature as `sig`, and
retries with `?challenge=…&sig=…` (same shape for `GET /inbox/{agent_id}` and
`DELETE /inbox/{agent_id}/purge`).

### C.2 `GET /health` claim

```json
{
  "status": "ok",
  "spec_version": "1.0-draft",
  "relay_conformance": "agentpair-relay/1",
  "artifact_quota_bytes": 52428800,
  "artifact_retention_ms": 2592000000
}
```

- `spec_version` and `relay_conformance` are REQUIRED for runtime preflight.
- `artifact_quota_bytes` and `artifact_retention_ms` are optional operator
  advisories (mirrored from environment configuration).

### C.3 Allowlist push — sign-the-blob

`PUT /allowlist/{agent_id}` body:

```json
{ "blob": "<base64url(allowlist_json_bytes)>", "sig": "<base64url(Ed25519(blob_bytes))>" }
```

The relay verifies `sig` over the exact decoded `blob` bytes and
schema-validates the JSON (`agent_id` must match the path, valid ids, no
duplicates). Interop cap: `allowed` MUST NOT exceed **1024** entries
(`ALLOWLIST_MAX_ALLOWED`). The relay MUST NOT reject on sort order; hosts
SHOULD sort before push.

### C.4 Per-route body limits

| Route | Limit | Oversize error |
|---|---|---|
| `POST /inbox/{agent_id}` | ~128 KiB wire bytes | `envelope_too_large` (`413`) |
| `PUT /artifact/{hash}` | ≥ 10 MiB | `payload_too_large` (`413`) |
| Other routes | relay default | `payload_too_large` (`413`) |

The inbox cap is a superset of the §4.3 64 KiB envelope MUST; hosts still
enforce 64 KiB before decode.

### C.5 Pair channel errors

| Status | Body `error` | When |
|---|---|---|
| `404` | `pair_not_found` | Unknown `session_id` |
| `410` | `pair_session_lost` | Session expired (fixed TTL from creation) |

Hosts branch on HTTP status; body strings are informative.

### C.6 Inbox POST idempotency

| Condition | Response |
|---|---|
| First insert | `204` |
| Same `id`, byte-identical wire | `204` |
| Same `id`, different wire bytes | `409` + `envelope_id_collision` |

### C.7 Conformance suite probes

| Probe | Tier | Asserts |
|---|---|---|
| `default-deny` | REQUIRED | Unallowlisted inbox POST → `recipient_not_allowed` |
| `challenge-roundtrip` | REQUIRED | Challenge issue + signed pull |
| `allowlist-blob` | REQUIRED | Sign-the-blob allowlist PUT |
| `inbox-idempotency` | REQUIRED | Byte-identical retry → `204` |
| `hash-verify` | REQUIRED | Artifact PUT `hash_mismatch` |
| `purge-dyad` | REQUIRED | Inbox purge with challenge auth |
| `inbox-pull-shape` | REQUIRED | Pull JSON shape (`envelopes`, `rowids`, `cursor`) |
| `pair-ttl` | slow (`--slow`) | Fixed TTL expiry → `410` |
| `artifact-10mb` | large (`--large`) | 10 MiB artifact upload |
