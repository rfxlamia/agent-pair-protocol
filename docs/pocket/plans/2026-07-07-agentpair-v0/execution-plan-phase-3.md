# AgentPair v0 — Deploy relay and E2E happy path (Phase 3 of 3)

**Date:** 2026-07-07
**Original plan:** docs/pocket/plans/2026-07-07-agentpair-v0/execution-plan.md
**Prerequisite:** Phase 2 must be COMPLETE — all tests green, all commits created
**Contains tasks:** {T9}
**Unlocks next:** All phases complete — proceed to final validation

---

## Task List

Total: 1 tasks | Prerequisite phases must be complete before starting

T9: Deploy relay and E2E happy path [depends: T8]

---

## Pocket Packets

---

### Task 9: Deploy relay and E2E happy path [depends: T8]

## OBJECTIVE
Docker compose for relay at /opt/agentpair/ on school VPS (`127.0.0.1:3001:3001` bind); E2E with **two in-process MCP instances** (dual-server.ts), not dual stdio spawn.

Files:
- Create: `docker-compose.yml`, `deploy/school-compose.yml`
- Create: `packages/mcp-server/src/e2e/dual-server.ts`
- Test: `packages/mcp-server/src/e2e/happy-path.test.ts`

Steps:
1. Write failing E2E: import two AgentPairServer instances in-process; pair → session → ratify
2. Create deploy compose (debian-slim relay image, isolated network, 127.0.0.1 bind)
3. Deploy to school: `/opt/agentpair/` only via SSH
4. Verify: curl https://relay.yagura.space/health returns 200
5. PASS + commit: `feat(deploy): relay on school and e2e happy path`

## REFERENCES LOADED
Spec — Rule: Infrastructure constraint, full §8 scenario

## WHY THIS APPROACH
Complexity: deep — deploy + integration

## SANDWICH CONTEXT
[CRITICAL: ZERO touch /opt/kareema/, kareema docker network, Caddyfile]
[RESTATE: Deploy only to /opt/agentpair/ — isolated compose]
Files: docker-compose.yml, deploy/**, e2e test

## DELIVERABLE
Given relay deployed, When curl /health, Then 200
Given E2E test, When full happy path runs, Then co-signed hash produced
[must-not] Given deploy script, When run, Then must NOT modify /opt/kareema/

## QUALITY BAR
Must-not-have: Any kareema container/network changes
Rollback: docker compose down in /opt/agentpair only

## STOP CONDITIONS
Done when: health 200 on relay.yagura.space and E2E passes
Escalate when: deploy touches kareema

---

## Review Status

- Plan validation report: C1/C2 addressed; **PAKE pre-committed: Rust WASM (B)**
- Spec Reviewer: pending
- Test-Architect: pending

---

## Phase Completion Gate

DONE when ALL of the following:
- Every task in this phase: status DONE
- All tests pass
- All commits created with correct format
- No task has status BLOCKED or NEEDS_CONTEXT

Hand off to (none — all phases complete) ONLY after this gate passes.
