# AgentPair — a minimal protocol for personal agent-to-agent communication

**Version:** 0.1 (draft for public prototype)
**Status:** Request for comments
**Scope:** The personal layer. Two humans, two AI agents, one shared goal.

---

## 1. What this is, in three sentences

AgentPair lets the AI agent of user A talk to the AI agent of user B to negotiate a concrete deliverable — a schedule, an API contract, a document — without either human relaying messages by hand. The inbox rejects every key that is not bonded; bonding is only formed through a short code exchanged between humans; either side can sever the bond unilaterally, instantly, without the other's consent. Agents negotiate, machines verify, humans ratify.

## 2. What this is not (non-goals for v0)

- **Not an enterprise orchestration protocol.** A2A (Linux Foundation / AAIF) owns that space. AgentPair is the personal layer beneath it. A2A interoperability is an explicit non-goal for v0.
- **Not a discovery network.** There is no agent marketplace, no public directory, no cold contact. This is a feature: no cold inbound means no spam surface and no mass prompt-injection campaigns.
- **Not real-time by default.** v0 is async-first (store-and-forward). Real-time is a special mode where both sides deliberately stand by, not the baseline.
- **Not self-hosted by requirement.** Users use public relays, like Nostr. Self-hosting is an option, never a prerequisite.

## 3. Design principles

1. **Fit the spec on one page per layer.** Transport + pairing is one page. Session semantics is one page. If a minimal implementation needs more, the protocol is too heavy.
2. **Distribute through doors that already exist.** The reference client is an MCP server (`npx agentpair`). No product changes required from any AI vendor; runs on flat-rate subscriptions, not API credit.
3. **Safety model on page one, not in an appendix.** Default-deny inbox, human-anchored pairing, unilateral revoke, structural (not advisory) human-in-the-loop.
4. **The deliverable is an artifact, not a conversation.** Sessions negotiate a document under executable acceptance criteria. Transcripts are scaffolding; the signed artifact is the product.

---

## 4. Architecture

```
┌─────────────────────┐                            ┌─────────────────────┐
│  User A             │                            │  User B             │
│  ┌───────────────┐  │                            │  ┌───────────────┐  │
│  │ AI client     │  │                            │  │ AI client     │  │
│  │ (Claude/GPT/…)│  │                            │  │ (Claude/GPT/…)│  │
│  └──────┬────────┘  │                            │  └──────┬────────┘  │
│         │ MCP       │                            │         │ MCP       │
│  ┌──────┴────────┐  │      ┌──────────────┐      │  ┌──────┴────────┐  │
│  │ agentpair     │◄─┼─────►│    RELAY     │◄─────┼─►│ agentpair     │  │
│  │ MCP server    │  │ HTTPS│ (dumb queue, │ HTTPS│  │ MCP server    │  │
│  │ keys live here│  │      │  sees only   │      │  │ keys live here│  │
│  └───────────────┘  │      │  ciphertext) │      │  └───────────────┘  │
└─────────────────────┘      └──────────────┘      └─────────────────────┘
```

Three components, three trust levels:

| Component | Runs where | Trusted with |
|---|---|---|
| **AI client** | User's subscription (claude.ai, Claude Code, ChatGPT, …) | Reasoning only. Never touches keys. |
| **agentpair MCP server** | User's machine (`npx agentpair`) or user-chosen remote | Keypair, signing, encryption, allowlist. |
| **Relay** | Anyone's server (reference: one Cloudflare Worker + KV) | Nothing. Stores and forwards ciphertext blobs. Cannot read, cannot forge; can only drop or delay (see §9, W6). |

### 4.1 Identity

Each user's agent holds one Ed25519 keypair, generated locally on first run. The public key is the agent's address. No central registry, no account. Identity is portable across relays.

### 4.2 Relay API — the entire transport

```
GET  /card/{agent_id}            → agent card (JSON, signed)
POST /inbox/{agent_id}           → drop one envelope (body: envelope JSON)
GET  /inbox/{agent_id}?since=T   → pull envelopes (auth: signature over challenge)
```

That is the whole wire protocol. Implementable with curl. A relay MUST drop any envelope whose `from` key is not on the recipient's allowlist (default-deny enforced at the edge; the recipient's agent enforces it again on pull — defense in depth).

### 4.3 Agent card

```json
{
  "agent_id": "ed25519:AbC123…",
  "relays": ["https://relay-a.example.com", "https://relay-b.example.net"],
  "capabilities": ["session.negotiate", "chat"],
  "sig": "…"
}
```

Hosted anywhere (relay, Gist, DNS TXT). Signed by the agent's own key. Listing multiple relays mitigates single-relay censorship (§9, W6).

### 4.4 Envelope — the one message format

```json
{
  "id": "uuid",
  "from": "ed25519:AbC…",
  "to": "ed25519:XyZ…",
  "type": "pair.msg1 | pair.msg2 | session.open | session.msg | chat.message | revoke.notice",
  "thread": "uuid",
  "ttl": 86400,
  "payload": "<encrypted-to-recipient-pubkey>",
  "sig": "<ed25519 over all fields>"
}
```

Payloads are end-to-end encrypted (X25519 ECDH from the Ed25519 keys → XChaCha20-Poly1305). The relay sees routing metadata only.

---

## 5. Pairing — Bluetooth semantics, PAKE cryptography

Pairing is the ONLY way into an inbox. There is no friend request, no cold contact.

### 5.1 Flow

1. User A: "pair with Budi's agent." Agent A generates a short code — word-pair format, Magic Wormhole style: `4-kancil-senja`. Single-use, expires in 5 minutes.
2. A shares the code with Budi **out of band** — chat app, phone call, in person. The human channel is the root of trust: the protocol never has to answer "is this really Budi?" because the humans did.
3. Budi gives the code to his agent. Both agents run **SPAKE2** through the relay. The relay carries only opaque PAKE messages.
4. On success, each agent stores the other's public key in its allowlist, along with the negotiated **capability scope** (§5.3). The pair is now **bonded**.

Why PAKE and not a bare comparison: a naive 6-digit code can be brute-forced or man-in-the-middled. Under SPAKE2 the code is used exactly once to prove mutual knowledge; a single wrong guess aborts the entire exchange. A 4–6 character code is sufficient given single-use + short expiry.

### 5.2 Two bond modes (pairing vs bonding, as in Bluetooth)

- **Ephemeral pair** — bonded with a TTL (e.g. 24h, or `until_session_closes`). For one-shot transactions with near-strangers. Expiry removes the key from the allowlist automatically; no residue.
- **Bonded contact** — persistent until revoked. For the standing people in your life. MAY carry an optional expiry with re-pair prompt, which also caps the blast radius of a lost or stolen device.

"Exclusive" means **whitelist**, not monogamy: an agent may hold many bonds simultaneously; what is exclusive is that *only* bonded keys can reach the inbox.

### 5.3 Capability scoping at bond time

Accepting a pair includes declaring what that bond may do:

```json
{ "peer": "ed25519:XyZ…", "scope": ["session.negotiate", "chat"], "denied": ["file.request"] }
```

Bonded ≠ full access. Bonded = access per contract. (Bluetooth profiles: your headset gets audio, not your filesystem.)

### 5.4 Revoke — unilateral, instant, receiver-side

`revoke(key)` deletes the peer from the local allowlist and pushes the updated allowlist to the user's relays. Enforcement happens at the **recipient's** relay and agent — never by asking the sender to stop, because a malicious sender won't. The revoked party's consent is not required and not requested.

---

## 6. Session layer — negotiation with a goal, a budget, and a mandate

Sessions ride on top of the transport as envelope types. The four transport tools stay four; the MCP server exposes session verbs as convenience.

### 6.1 session.open

```json
{
  "type": "session.open",
  "goal": "Agree telemetry API contract v1 between ESP32 firmware and backend",
  "artifact_schema": "openapi+constraints",
  "acceptance": [
    { "id": "A1", "test": "executable", "desc": "generated example payload ≤ 4096 bytes", "runner": "payload-size" },
    { "id": "A2", "test": "executable", "desc": "C structs codegen'd from spec compile for ESP32 target", "runner": "codegen-compile" },
    { "id": "A3", "test": "executable", "desc": "OpenAPI lint passes", "runner": "spectral" },
    { "id": "A4", "test": "judgment",   "desc": "endpoint naming is consistent and ergonomic" }
  ],
  "budget": { "max_turns": 30, "deadline": "2026-07-09T17:00Z" },
  "on_exhausted": "escalate_to_humans",
  "mandate": {
    "agent_may": ["propose", "counter", "accept_section", "challenge"],
    "human_required": ["sign_final", "budget_extend", "constraint_change"],
    "escalate_on": [
      "verification_test_fail_twice_same_section",
      "proposal_touches_locked_constraint",
      "agent_confidence_below_declared"
    ]
  }
}
```

The `mandate` field is the explicit declaration of every human-in-the-loop point. It is a limited power of attorney: the agent has authority to negotiate to the limit, never authority to ratify. `human_required` actions are structurally impossible for agents — the protocol rejects them, it does not merely discourage them.

### 6.2 Constraints-first drafting (no first-mover advantage)

Phase one of every session is **constraint exchange**, not drafting. Both sides submit their constraint documents (firmware: RAM budget, payload ceiling, existing binary formats; backend: query needs, retention). The initial draft is generated mechanically as a merged skeleton with holes. Negotiation fills holes in a joint document; nobody reacts to the other party's framing.

### 6.3 Legal message types inside a session (no free prose)

| Type | Semantics | Rule |
|---|---|---|
| `propose(diff)` | Concrete change to the draft, as a diff | Rationale ≤ 2 sentences |
| `counter(diff)` | Rejection that MUST carry a concrete alternative | Prevents passive deadlock |
| `accept(section_id)` | Locks a section | Locked sections reopen only by mutual consent → progress is monotonic |
| `challenge(report)` | Adversarial pass: best attempt to break the artifact against one's own constraints | MANDATORY once per agent before sign is legal |
| `sign(artifact_hash)` | "Ready for ratification" — NOT ratification | Legal only when all executable acceptance tests are green AND both challenges are filed |

The draft artifact is stored once at the relay and referenced by hash; agents exchange diffs, never the full document. Non-artifact-changing turns (pure commentary) are capped at 2 consecutive before the protocol forces a `propose` or `escalate`.

### 6.4 The three gates

```
  AGENTS NEGOTIATE  ──►  MACHINES VERIFY  ──►  HUMANS RATIFY
  (propose/counter/      (executable            (both principals,
   accept/challenge)      acceptance tests;      shown a decision
                          red = sign illegal)    summary + verification
                                                 report, not 40 pages)
        ▲                      │                        │
        └──────── fail ────────┴──────── reject ────────┘
```

No layer may do another layer's job. Agent `sign` is a proposal to ratify; cryptographic finality attaches only after both humans ratify, at which point each agent signs the artifact hash with its bonded key — producing a mutually signed, auditable contract with a per-decision trail ("why is the timestamp epoch uint32?" has a linkable answer forever).

Ratification UX rule (non-negotiable): humans ratify a **decision summary + verification report** — "12 endpoints agreed, max payload 3.1KB (test green), timestamp epoch uint32 due to RAM constraint, 2 countered-then-accepted decisions: […], compile test: green" — never the raw 40-page spec. Ratification that requires re-reading everything gets rubber-stamped by tired people, and a rubber stamp is premature convergence relocated from agent to human.

---

## 7. Data flow — end to end

```
1. PAIR      A: code out-of-band → B          SPAKE2 via relay → bonded + scoped
2. OPEN      A → session.open (goal, acceptance, budget, mandate)
             B's human approves opening (scope check) → session live
3. CONSTRAIN both sides file constraint docs → skeleton draft generated
4. NEGOTIATE propose/counter/accept diffs; relay stores draft by hash;
             executable tests rerun on every draft change
5. CHALLENGE each agent files adversarial pass
6. SIGN      agents sign(hash) = ready; protocol verifies: tests green + challenges filed
7. RATIFY    both humans review summary + report → approve
8. FINALIZE  agents co-sign hash with bonded keys → artifact final, session closed
   (any step can exit to: escalate_to_humans, budget_exhausted, revoke)
```

---

## 8. Happy path — the firmware/API use case, concretely

**Cast:** V (firmware, ESP32 + MQTT) and R (backend). Both on flat-rate AI subscriptions. Relay: a free-tier Cloudflare Worker neither of them operates.

1. V, on a call with R: "pair code is `4-kancil-senja`." Both type it to their agents. Bonded in seconds, scope `["session.negotiate"]`, ephemeral TTL = until session closes.
2. V's agent opens the session above (§6.1). R approves opening.
3. Constraints exchanged: V files RAM budget, 4KB payload ceiling, existing MQTT topic tree, binary parser formats. R files query patterns and retention needs. Skeleton draft generated.
4. Turn 7: R's agent proposes `timestamp: ISO-8601 string`. V's agent counters: `epoch uint32` — 15 bytes saved per message, trivial C parsing. Payload-size test attached to the counter shows ISO variant at 4.3KB on the batch endpoint: **red**. R's agent accepts. Section locked.
5. Turn 22: all sections locked. Codegen-compile test: green. Lint: green. Payload: 3.1KB green.
6. Challenges: V's agent asks "what breaks on MQTT disconnect mid-batch?" → discovers the spec lacks an idempotency key → one more propose/accept cycle. R's agent challenges field-addition forward-compatibility → spec gains an `additionalProperties` policy. Both challenges filed.
7. Both agents `sign`. Both humans get the summary: 12 endpoints, 2 countered decisions with rationale, all tests green, 2 challenge findings resolved. Both ratify from their phones.
8. Agents co-sign the hash. V's agent immediately starts firmware codegen **from the signed spec**; R's agent scaffolds the backend from the same hash. Neither human re-read a transcript; neither waited on the other; the audit trail answers every future "why."

Total human involvement: one pairing code over a call, one session-open approval, one ratification each. Everything else was agents and compilers.

## 9. Worst paths — failure modes and the protocol's answer

| # | Attack / failure | Protocol response |
|---|---|---|
| W1 | **Wrong or guessed pairing code** | SPAKE2 aborts the entire exchange on a single wrong guess; code is single-use and expires in 5 min. Brute force is structurally impossible. |
| W2 | **MITM on pairing** | PAKE: an attacker who doesn't know the code cannot complete the exchange, even controlling the relay. The code never transits the relay. |
| W3 | **Spam / cold injection campaign** | No cold inbound exists. Non-bonded envelopes are dropped at the relay AND at the agent (defense in depth). Attack surface = people you physically gave a code to. |
| W4 | **Bonded peer turns malicious (injection from inside the fence)** | Capability scope caps what the bond can request; mandate caps what the agent can concede (`constraint_change` is human-only); executable tests reject sabotaged artifacts; unilateral revoke ends it instantly. Residual risk: social-engineering the *human* at ratification — mitigated by the decision-summary format surfacing every countered decision explicitly. This is v0's most honest open front; see §11. |
| W5 | **Premature confident convergence (signed garbage)** | Sign is illegal while any executable test is red; challenges are mandatory before sign; agent sign ≠ ratification; humans ratify summaries. Four independent brakes. |
| W6 | **Malicious relay (drop / selective delay)** | Relay cannot read or forge (E2E encryption + signatures). It CAN drop or delay. Mitigations: multi-relay agent cards (§4.3), sender-side delivery timeout → retry on the peer's next listed relay, and sequence numbers per thread so gaps are *detected*, never silent. Censorship becomes visible and routable-around, not invisible. |
| W7 | **Budget exhausted one section short** | `on_exhausted: escalate_to_humans` — loud failure, `input-required` state. `budget_extend` requires approval from BOTH humans, never the agents. |
| W8 | **Verification loop (same section fails twice)** | Auto-escalation trigger in `mandate.escalate_on`. Agents spinning in place is a defined state, not a token furnace. |
| W9 | **Mid-session revoke** | Session dies instantly with state `revoked`; the artifact remains at its last hash for the wronged party's records; no further envelopes flow. |
| W10 | **Lost / stolen device** | Bonded keys MAY carry expiry + re-pair; peers can revoke the moment the human signals out-of-band; keys live in the MCP server's local store (OS keychain recommended), not in any chat log. And, empirically: thieves open the crypto wallet, not claude.ai. |
| W11 | **Relay operator subpoenaed / logs metadata** | Accepted limitation in v0: the relay sees who-talks-to-whom and when. Payload and artifact content stay opaque. Metadata privacy (padding, mixing) is explicitly deferred — see §11. |

## 10. Distribution plan (why this can actually spread)

- **Tier 0 — the SKILL.md trick:** GitHub as relay. Identity = GitHub account; agent card = `agent.json` in a repo; inbox = Issues on a **private repo**, where the collaborator-invite flow IS the pairing handshake and payloads are encrypted blobs. Zero servers. Two people with Claude Code can run the full loop today. Hacky the way npx-over-stdio was hacky — which is to say: deliberately.
- **Tier 1 — the real protocol:** the three-endpoint relay of §4.2. Same envelope format as Tier 0; GitHub was just one transport.
- **Client:** `npx agentpair` MCP server → works in Claude Code, Claude Desktop, claude.ai custom connectors, and any MCP-capable client, on existing subscriptions. Zero API credit for the demo.
- **The demo that matters:** one video — two laptops, two owners, two agents negotiating a real API contract to a co-signed hash, no human typing in the middle. The spec fits on one page per layer; the demo does the persuading.

## 11. Open problems (honest list, v0 does not solve these)

1. **Ratification-layer social engineering** — a malicious bonded peer optimizing the *summary* humans read (W4 residual). Candidate direction: summaries generated by the *recipient's* agent from the raw trail, never accepted from the peer.
2. **Metadata privacy at the relay** (W11). Padding, timing mixes, or onion-style relay hops are all heavier than v0's one-page budget allows.
3. **Judgment-type acceptance criteria** — "the API is ergonomic" cannot be compiled. v0 routes these to human ratification; a richer rubric language is future work.
4. **Cross-vendor session semantics drift** — a Claude-backed agent and a GPT-backed agent may interpret `challenge` with different rigor. The message-type grammar constrains this; it does not eliminate it.
5. **Real-time mode** — long-polling both sides works for demos; a clean presence/typing layer is deliberately out of scope for v0.

---

## Appendix A — MCP tool surface (reference client)

```
pair(code)                          → run SPAKE2 with peer via relay; returns bonded peer + scope
inbox()                             → pull, verify, decrypt new envelopes
send(to, type, payload)             → encrypt, sign, drop to peer's inbox
revoke(key)                         → remove from allowlist, push to relays
session_open(goal, acceptance, budget, mandate)
session_msg(thread, propose|counter|accept|challenge, body)
session_sign(thread, artifact_hash) → legal only if tests green + challenges filed
session_status(thread)              → state, locked sections, test results, budget remaining
```

Keys never leave the MCP server. The model reasons; the server signs.

## Appendix B — security model, quotable form

> The inbox rejects every key that is not bonded. Bonding is only formed through a short code exchanged between humans. Either side can sever the bond unilaterally, instantly, without the other's consent. Agents negotiate, machines verify, humans ratify.
