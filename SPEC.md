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
| KDF | HKDF-SHA-256, info = `"agentpair-envelope-v0"` |
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
operation) to reject garbage early; it can never decrypt. Reference API:

```
GET  /health
GET  /card/{agent_id}                # public card / key discovery
PUT  /allowlist/{agent_id}           # signed allowlist push
POST /pair/{session_id}              # PAKE message drop (TTL 5 min)
GET  /pair/{session_id}              # PAKE message poll
POST /inbox/{agent_id}               # envelope drop
GET  /inbox/{agent_id}?since=T       # challenge-response pull
PUT  /artifact/{hash}                # opaque blob store (content-addressed)
GET  /artifact/{hash}
```

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
  artifact and send `{ artifact_hash, size, content_type, summary }` in its
  place. Envelope size never limits negotiation complexity — a 2 GB video
  costs a few hundred bytes on the wire.
- The relay MAY drop messages (queue overflow, TTL). Delivery is at-least-once
  from the sender's perspective; receivers rely on §4.3 idempotency, and
  hosts SHOULD retry sends with backoff.

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

1. `pake` messages: both sides exchange SPAKE2 messages, derive a shared key.
2. `confirm`: each side sends `SHA-256(shared_key)` as fingerprint plus its
   `agent_id`. Mismatched fingerprints → abort `pake_failed`.
3. Human gate: the *joiner's* human MUST approve the proposal
   (scope + mode + initiator identity) before `bond_ok` is sent.
   Self-approval by the model is forbidden (§8.4 mechanism applies).
4. `bond_ok` / `bond_fail`: both sides commit or roll back atomically. On
   commit, each host pushes its updated signed allowlist to the relay.

### 6.3 Bond record

```
{ peer, scope: [...], mode: "bonded_contact" | "ephemeral_until_session_closes",
  profiles: [...] }
```

Either side MAY revoke a bond at any time, unilaterally, without notice to
the peer. Revocation MUST remove the peer from the local allowlist and
SHOULD push the updated allowlist to the relay immediately.

### 6.4 Profile advertisement

During `confirm`, each side MUST include its supported profiles, e.g.
`["core/1", "nego/1"]`. The intersection is the bond's contract; both hosts
persist it in the bond record. Sending an envelope outside the contract is a
protocol violation (`profile_not_supported`).

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

> *Informative:* the `nego.open` payload MAY be generated from a local,
> human-readable **negotiation template** (markdown + YAML frontmatter, in
> the spirit of SKILL.md). Templates are an application-layer convention —
> see the separate Negotiation Templates document (planned). Template bodies
> are instructions fed to a model; installing a third-party template is a
> trust decision (§11.1 applies).

### 8.2 Envelope types

`nego.open`, `nego.open_approved`, `nego.open_reject`, `nego.open_expired`,
`nego.turn`, `nego.signed`, `nego.ratified`.

`nego.open` payload:

```json
{
  "goal": "…",
  "acceptance": [ { "id": "…", "test": "executable|judgment", "desc": "…", "runner": "…" } ],
  "budget": { "max_turns": 20, "deadline": "<ISO8601 UTC, REQUIRED>" },
  "mandate": { "agent_may": [...], "human_required": [...], "escalate_on": [...] }
}
```

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
- **N4 — Budget extension** requires human approval on **both** sides.
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
operation that carries an explicit human-confirmation flag
(`via_human=true` in the reference binding). The host MUST reject approvals
without the flag (`self_approval_forbidden`). Bindings MUST source this flag
from an actual human interaction, never from model output alone — see §11.3
for why this is load-bearing.

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
`recipient_not_allowed`, `allowlist_push_failed`.

Negotiation: `session_not_found`, `session_not_live`, `session_not_signed`,
`session_open_expired`, `not_a_participant`, `wrong_role`,
`initiator_mismatch`, `budget_exhausted`, `human_required`,
`self_approval_forbidden`, `pending_not_found`, `challenges_incomplete`.

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
- **Relay compromise:** worst case = drop/delay/reorder messages and learn
  metadata (who talks to whom, when, sizes). It can never read or forge
  content. Metadata privacy (sealed sender) is a future extension
  (Appendix B), not a v1 property — do not claim it.

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
ids are registered in this document via pull request. Namespace grammar:
`<profile>.<name>`, lowercase, `[a-z_]`.

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
- **A4 — Human gate flag.** The binding MUST NOT let the model set
  `via_human=true` without an actual human confirmation in the client.

## Appendix B — Future Extensions (non-normative)

- Negotiation templates: shareable markdown+frontmatter packs that generate
  `nego.open` payloads and guide agent behavior (separate spec, post-1.0).
- Sealed sender / metadata privacy toward the relay.
- Cross-relay federation (agents on different relays).
- Key rotation and bond re-keying.
- Group sessions (>2 agents).
- Additional cipher suite as protocol v2.
