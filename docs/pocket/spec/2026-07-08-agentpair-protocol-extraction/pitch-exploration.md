# Pitch Exploration: agentpair-protocol-extraction
Date: 2026-07-08 | Project: agentpair-monorepo | Status: pitch-only

---

## Problem Statement
AgentPair ships as one complete implementation (protocol pkg + relay + MCP server), not as a protocol independent implementors can adopt. The session grammar that makes AgentPair distinct from Mingle/c2c — negotiate → verify → ratify — lives entirely inside `packages/mcp-server/src/session/` (~1000 lines), with no spec separate from that code, so no one can build a second client without reading and reverse-engineering the TypeScript source.

## Root Tension
Extracting code (moving TS from `mcp-server` into `@agentpair/protocol`) is easy but targets the wrong thing — it only helps an implementor who also writes TS. A real protocol is a wire contract: the message schema and valid state-transition ordering exchanged between two independent parties, decoupled from local bookkeeping (in-memory state, pending IDs, budget tracking) that never crosses the wire.

## Key Constraints
- Relay (`relay.yagura.space`) is a dumb queue — it does not enforce protocol semantics, so transport-agnostic design is nearly free; no relay changes needed.
- Crypto suite (SPAKE2 handshake, Ed25519, envelope encryption) must be pinned exactly — symmetric handshake fails if the two sides implement different versions/parameters.
- Backward compatibility: `agentpair` and `@agentpair/protocol` already published to npm (0.1.0–0.1.10); extraction must be non-breaking or explicitly versioned.
- Versioning / capability negotiation is currently absent from the design and must be an explicit decision (include a version field now vs. defer with a documented reason) — not silently dropped.
- Small team / limited resources — a JSON Schema + golden test vectors is the right formality level; a full RFC or conformance test suite is premature for going from 1 to 2 implementations.

---

## Brainstorming Methods Used

### Question Storming — deep
Key insights:
- What distinguishes "protocol" from "tool"? Working definition: re-implementable from spec alone, without reading the original source.
- Who is implementor #2 — another agent framework, or simply a developer building their own client? (Resolved during synthesis: client/transport/non-MCP, not TS-only.)
- Should the relay be mandatory to the protocol, or should the protocol be transport-agnostic with relay as one reference transport?
- Is the negotiate/verify/ratify state machine protocol logic or application logic layered on top of the protocol? Where's the line?
- Does "becoming a protocol" require a formal spec before a second implementation exists, or does the spec emerge from generalizing after implementation #2 appears?

### First Principles Thinking — creative
Key insights:
- Crypto primitives (SPAKE2, Ed25519, envelope) already live in `@agentpair/protocol`, published independently — already protocol-shaped.
- The session state machine — the part that differentiates AgentPair — is 100% buried in `mcp-server`, not reusable.
- A protocol, at root, is a message grammar independent of who sends/receives it (MCP's real invariant: transport-agnostic message grammar + capability negotiation).
- If session grammar moves up into the protocol package, `mcp-server` automatically becomes "reference client #1," not "the tool."

### Constraint Mapping — deep
Key insights:
- Relay stays a dumb queue — protocol logic can live entirely at the endpoints; extraction requires zero relay changes.
- State is in-memory today; a formal spec needs to either define persistence semantics or explicitly leave it to each implementor.
- The perceived constraint "must go through MCP" is imagined, not real — MCP is just one calling convention; negotiate/verify/ratify could be invoked via REST, CLI, or a library directly.
- Backward compat with already-published npm versions requires either non-breaking extraction or clear semantic versioning (v0 → v1).

### Solution Matrix — structured
Key insights:
- Three variables mapped: session logic location (mcp-server vs. protocol pkg), spec format (TS types only / JSON Schema / full RFC), transport binding (MCP-only vs. agnostic).
- Combination A (session → protocol pkg, JSON Schema per message, transport-agnostic) converged as strongest across all methods.
- Combination B (TS types only, MCP-only transport) looks like protocol-ization but only delivers code reuse for other TS/MCP consumers — a false summit.
- Combination D (full RFC + conformance suite) is the most rigorous but overkill for going from 1 to 2 implementations.

---

## Advisor Synthesis
Three of four methods independently converged on the same split: crypto is already protocol-shaped, but the session grammar is trapped in `mcp-server`. The advisor flagged a trap in the matrix: moving TypeScript code into the protocol package is code reuse, not protocol-ization — it only helps a TS implementor. The real deliverable is the wire contract (message schema + valid transition ordering), which is language-independent, plus golden test vectors to make the schema testable without a full conformance suite. Combination B was named a false summit and discarded; Combination D's conformance suite was trimmed down to just golden vectors. Versioning/capability negotiation was raised then dropped from the matrix — flagged to be decided explicitly, not silently skipped.

---

## Approach Directions

### Direction A: Schema-first extraction
Define a JSON Schema for each wire message (negotiate/verify/ratify + capability/version field), publish it in `@agentpair/protocol` as a spec artifact — not just TS types — with golden test vectors. Refactor `mcp-server` to consume that schema and reframe it as "reference client #1."
+ Closest to a real protocol: language-independent, testable via golden vectors, non-breaking if versioned from the start
− Requires real effort to separate wire messages from local bookkeeping (in-memory state, budget tracking) that must not leak into the spec

### Direction B: Documentation-first (lightweight RFC)
Write a spec doc (markdown/RFC-style) describing the message grammar and state machine formally, without yet producing a machine-readable JSON Schema. Code stays in `mcp-server` for now.
+ Fast, doesn't touch production code, useful for validating direction before committing to a formal schema
− Not actually a protocol yet — implementor #2 still has to reverse-engineer edge cases from code; risk of doc drift from implementation

### Direction C: Dual-track (protocol + conformance harness together)
Same as A, but build a small executable conformance harness alongside extraction — runs golden vectors against the reference client as part of the repo, not just documented vectors.
+ Spec is battle-tested immediately; if the reference client itself fails its own vectors, that surfaces fast
− Bigger scope than this pitch needs; risk of creeping into production-readiness work that's explicitly out of scope here

---

## Open Questions for pocket-grinding
- [ ] Which specific messages in the current state machine cross the wire (relay) vs. which are local-only bookkeeping that must NOT be exported into the spec?
- [ ] Should the version/capability field be added now (v0 semantics) or explicitly deferred — and if deferred, what's the migration story for v0.1.x consumers?
- [ ] What JSON Schema tooling/validation library fits the existing TS build (`tsc`, no bundler) without adding heavy dependencies?
- [ ] How many golden test vectors are enough to consider the spec "testable" (happy path only, or also key failure/rejection paths in ratify)?
- [ ] Does extracting session grammar to `@agentpair/protocol` require a breaking version bump, or can it ship additively alongside existing exports?

---

## Recommended Direction
Direction A — aligns with the root tension (wire contract, not code package) and the small-team resource constraint (golden vectors are testable without building a full conformance harness). Direction B is too weak to make implementor #2 actionable; Direction C is right-sized as a later step once A ships, not as the pitch itself.

---

## Handoff Context (for pocket-grinding)
When pocket-grinding reads this doc:
- Start with this problem statement (Phase 1 context)
- Use Direction A as the working hypothesis for Phase 5 Design Proposals
- Treat Open Questions above as Phase 3 Discovery targets
- Do NOT treat Approach Directions as final architecture — validate through GWT first
