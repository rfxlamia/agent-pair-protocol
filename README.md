# AgentPair

[![npm agentpair](https://img.shields.io/npm/v/agentpair.svg)](https://www.npmjs.com/package/agentpair)
[![npm @agentpair/protocol](https://img.shields.io/npm/v/@agentpair/protocol.svg)](https://www.npmjs.com/package/@agentpair/protocol)
[![CI](https://github.com/rfxlamia/agent-pair-protocol/actions/workflows/ci.yml/badge.svg)](https://github.com/rfxlamia/agent-pair-protocol/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](./LICENSE)

[Bahasa Indonesia](./README-ID.md)

> Personal agent-to-agent protocol: two AI agents, each acting for one human, exchange end-to-end-encrypted messages through an untrusted relay.

**Spec status:** [SPEC.md](./SPEC.md) is **1.0-draft** — the wire format may still change until the 1.0 freeze. Reference packages on npm are usable today.

## Why AgentPair?

Two people each have an AI agent. They need a shared deliverable — a schedule,
an API contract, a document — without turning the humans into messengers and
without handing the draft to a third party that can read it.

Today that usually looks like: agent proposes → human copy-pastes → other human
pastes into their agent → repeat. Or everyone piles into a shared SaaS that sees
every revision. That is a **messenger tax** plus a **trust tax**.

AgentPair cuts the messenger tax and keeps the trust tax where it belongs:

- **Agents talk; humans gate trust.** Pairing uses a short code exchanged between
  people. Opening a negotiation and ratifying the result require explicit human
  approval. Either side can revoke the bond unilaterally, at any time.
- **Keys never leave the host.** The model reasons and calls tools; the local
  AgentPair process holds keys, signs, and encrypts.
- **The relay is dumb.** It queues ciphertext and routing metadata. It cannot
  read payloads. A public test relay is fine for experiments; self-host when you
  care about metadata privacy.
- **Authenticity is not trustworthiness.** A verified peer message is still
  untrusted input to your model.

The reference binding is an MCP server (`agentpair` on npm). The protocol itself
is binding-agnostic — see [SPEC.md](./SPEC.md).

## Built with OpenAI Codex & GPT-5.6

Developed and demoed for **OpenAI Build Week** with **OpenAI Codex** (model
**GPT-5.6**) as a primary agent environment — both as a coding agent in the repo
and as the dual-agent runtime for the end-to-end walkthrough.

### How Codex was used

| Role | What we did with Codex |
|------|------------------------|
| **Coding agent** | Scaffold and iterate the monorepo (`@agentpair/protocol`, `agentpair` MCP server, relay): envelope/receiver paths, pairing flows, tests, and docs. |
| **Agent runtime (demo)** | Two Codex sessions as **Agent A (initiator)** and **Agent B (joiner)**, each with its own `agentpair` MCP server and data dir, talking over a shared relay. |
| **Protocol dogfood** | Full happy path via MCP tools: `pair_init` → `pair_join` + human approve → `session_open` → propose/accept → `session_sign` → dual `human_approve` (ratify). |
| **Hardening loop** | Reproduce edge cases (approval gates, inbox polling, hash co-sign) and tighten tool descriptions so peer content stays untrusted input. |

### Why Codex + AgentPair fit

- **Codex** is the *reasoner* (and the UI the human uses).
- **`agentpair`** is the *host*: keys, SPAKE2 pairing, encrypt/sign, session state.
- **GPT-5.6** never holds keys; it only calls MCP tools. That split is the product
  thesis: *models negotiate, humans gate trust, hosts hold crypto.*

### Demo for judges

1. **Video** — dual-agent walkthrough on the submission (pair → negotiate pitch →
   co-sign → ratify).
2. **Raw session logs (source of truth)** — full dual-Codex transcripts from the
   live dogfood, not a scripted mock:
   - [Agent A · initiator](./docs/demo/agent-a-chat.txt)
   - [Agent B · joiner](./docs/demo/agent-b-chat.txt)  
   Same pairing code (`25-laku-gula-gadis`), same thread, matching co-signed
   artifact hash, dual human ratify → session closed.
3. **In-repo replay** — open
   [`docs/demo/agentpair-e2e-demo.html`](./docs/demo/agentpair-e2e-demo.html) in a
   browser for a timed dual-panel visualization *derived from those logs* (happy
   path condensed for clarity; the `.txt` files are the unedited evidence).
4. **Live (optional)** — two Codex windows + shared relay (see Quick start below).

Wire crypto and MCP tools live in this repository and on npm. Prefer the
transcripts when you want proof; prefer the HTML when you want a 60s walkthrough.

## Quick start (≈5 minutes)

You need Node.js 22+, any MCP-capable client (Cursor, Claude Desktop, Claude Code,
…), and a partner with the same setup.

**1. Point both sides at the same relay**

Public test relay (shared by both peers):

```bash
export AGENTPAIR_RELAY_URL=https://relay.yagura.space
```

Or self-host locally:

```bash
docker compose up -d
export AGENTPAIR_RELAY_URL=http://127.0.0.1:3001
```

If `AGENTPAIR_RELAY_URL` is unset, the MCP server defaults to
`http://127.0.0.1:3001` — not the public relay. Both peers must match.

The public relay is for testing. Relay operators can see metadata (who talks to
whom, when, sizes) even though payloads stay encrypted — see the threat model
in [SPEC.md](./SPEC.md).

**2. Add the MCP server to your client**

```json
{
  "mcpServers": {
    "agentpair": {
      "command": "npx",
      "args": ["-y", "agentpair"],
      "env": {
        "AGENTPAIR_RELAY_URL": "https://relay.yagura.space"
      }
    }
  }
}
```

Restart the client so it picks up the server.

**3. Pair (two humans, out-of-band code)**

Pairing codes expire after about **5 minutes**.

| Step | Who | Tool |
|------|-----|------|
| 1 | A | `pair_init` — share the returned code with B (chat, call, in person) |
| 2 | B | `pair_join` with that code — returns `pending_id` and `approval_path` |
| 3 | B | Open `approval_path` (6-digit code on disk; not in tool JSON), then `human_approve` with that `approval_code` |
| 4 | A | Wait for auto-completion (or call `pair_init_complete` if needed) |
| 5 | Either | `list_bonds` — confirm the peer appears |

Details: [user guide — Human gates](./docs/user-guide.md#human-gates).

**4. Smoke check**

Send a short `send` to the peer `agent_id`, then `inbox` on the other side.
For a full negotiate → sign → ratify flow, see the [user guide](./docs/user-guide.md).

## Architecture

```mermaid
flowchart LR
  subgraph humanA [Human A]
    ClientA["AI client<br/>Cursor / Claude / …"]
  end
  subgraph humanB [Human B]
    ClientB["AI client"]
  end
  HostA["AgentPair host<br/>keys · sign · encrypt"]
  HostB["AgentPair host<br/>keys · sign · encrypt"]
  Relay["Relay<br/>dumb HTTPS queue"]

  ClientA -->|MCP stdio| HostA
  ClientB -->|MCP stdio| HostB
  HostA <-->|ciphertext + routing metadata| Relay
  HostB <-->|ciphertext + routing metadata| Relay
```

| Piece | Role |
|-------|------|
| **AI client** | Reasons and calls MCP tools. Never holds keys. |
| **AgentPair host** (`agentpair`) | Local process: identity, bonds, encrypt/sign, session state. |
| **Relay** | Interchangeable HTTP queue. Sees metadata, not payloads. Both peers must use the **same** relay URL. |

Bindings other than MCP are allowed by the spec; this repo ships the MCP reference binding.

## Pairing and session flows

Two separate happy paths. Both peers use the same relay (omitted below for clarity — every host↔host hop goes through it). Profiles: `core/1` + `nego/1`.

### 1. Pairing (bond)

```mermaid
sequenceDiagram
  actor HA as Human A
  participant A as Host A
  participant B as Host B
  actor HB as Human B

  HA->>A: pair_init
  HA-->>HB: share code (out of band)
  HB->>B: pair_join(code)
  HB->>B: human_approve (join)
  Note over A,B: SPAKE2 + allowlist over relay
  Note over A,B: bonded — list_bonds shows peer
```

### 2. Session (negotiate → co-sign)

Requires an existing bond.

```mermaid
sequenceDiagram
  actor HA as Human A
  participant A as Host A
  participant B as Host B
  actor HB as Human B

  HA->>A: session_open
  HB->>B: inbox (receive nego.open)
  HB->>B: human_approve (open)
  Note over A,B: session live
  A->>B: nego.turn (propose / counter / accept)
  B->>A: nego.turn
  HA->>A: session_sign
  HB->>B: session_sign
  HA->>A: human_approve (ratify)
  HB->>B: human_approve (ratify)
  Note over A,B: co-signed deliverable · session closed
```

Optional profile **`atest/1`** adds machine-checkable challenges (`atest_run` / reports) before signing. The reference MCP advertises `core/1` + `nego/1` by default.

## Conformance classes

| Class | Implements | What you get |
|-------|------------|--------------|
| **Core** | Identity through core messaging in [SPEC.md](./SPEC.md) | Identity, envelopes, relay, pairing/bonding, encrypted messaging |
| **Negotiation** | Core + profile `nego/1` | Session open → turns → co-sign → ratify a deliverable |
| **Acceptance Testing** | Negotiation + profile `atest/1` | Machine-checkable challenges before signing |

Advertise supported profiles at pairing. Do not send envelope types for a profile the peer did not advertise.

Third-party Core implementors: [conformance checklist](./docs/conformance-checklist.md) and [Implement Core in a weekend](./docs/implement-core-weekend.md) (golden vectors in `packages/protocol/fixtures/`).

## Documentation

| Doc | For |
|-----|-----|
| [User guide](./docs/user-guide.md) | Install, MCP setup, pairing & session |
| [Developer guide](./docs/developer-guide.md) | Monorepo, architecture, tests, self-hosting the relay |
| [Implement Core in a weekend](./docs/implement-core-weekend.md) | Byte-match Core against published fixtures |
| [SPEC.md](./SPEC.md) | Normative protocol (**1.0-draft**) |
| [docs/](./docs/README.md) | Index (EN + [ID](./docs/README-ID.md)) |

[Bahasa Indonesia root README](./README-ID.md)

## License

Code: Apache-2.0. Specification text: CC-BY-4.0 (see [SPEC.md](./SPEC.md)).
