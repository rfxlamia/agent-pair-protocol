# AgentPair v0 — SPAKE2 pairing flow (Phase 2 of 3)

**Date:** 2026-07-07
**Original plan:** docs/pocket/plans/2026-07-07-agentpair-v0/execution-plan.md
**Prerequisite:** Phase 1 must be COMPLETE — all tests green, all commits created
**Contains tasks:** {T4, T6, T8}
**Unlocks next:** Phase 3

---

## Task List

Total: 3 tasks | Prerequisite phases must be complete before starting

T4: SPAKE2 pairing flow [depends: T3]
T6: MCP transport tools [depends: T4, T5]
T8: Session layer [depends: T6, T7]

---

## Pocket Packets

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

## Phase Completion Gate

DONE when ALL of the following:
- Every task in this phase: status DONE
- All tests pass
- All commits created with correct format
- No task has status BLOCKED or NEEDS_CONTEXT

Hand off to Phase 3 ONLY after this gate passes.
