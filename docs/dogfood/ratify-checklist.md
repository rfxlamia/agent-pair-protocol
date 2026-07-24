# M3.4 Ratify Checklist

Human gate at session close. Use this checklist **after** both agents reach `signed` and **before** either operator calls `human_approve` on the `ratify` pending.

**Runbook:** [M3.4 Wishlist Dashboard — Operator Runbook](./M3.4-wishlist-dashboard.md)

> **CRITICAL — one co-sign per session:** Ratify is terminal. The co-signed artifact is `api.schema.json` **only**. Never co-sign `index.html`, `server.mjs`, or `product-spec.json`. HTML, spec tone, and server behavior are verified here via human judgment, not the `co_signed_hash`.

---

## Pre-ratify (both operators)

- [ ] Session status is `signed` on both machines.
- [ ] Both agents recorded the **same** `artifact_hash` for `api.schema.json` before `session_sign`.
- [ ] `atest_run` passed on **both** sides for criterion `A1` (executable gate complete).
- [ ] Both agents sent `session_msg` type `challenge` before sign (no `challenges_incomplete`).
- [ ] Co-sign target is `api.schema.json` only — not HTML, server, or product spec.

---

## Session acceptance criteria

Verify each acceptance criterion from `session_open` before approving ratify.

### A1 — executable

- [ ] **Session acceptance A1 executable:** `atest_run({ criterion_id: "A1" })` passed on both sides against the agreed `api.schema.json` hash (`payload-size` runner; samples ≤ 4096 bytes).

### A2 — judgment

- [ ] **Session acceptance A2 judgment:** Review `index.html` in the negotiation thread. Confirm the static mockup includes a wishlist signup form (email + up to 3 items) and a release-notification signup path.

### A3 — judgment

- [ ] **Session acceptance A3 judgment:** Review `product-spec.json` for locked PM constraints (max 3 wishlist items, formal English copy, hero mentions AgentPair v1).
- [ ] **Session acceptance A3 judgment:** Review `server.mjs` — Hono in-memory stub matches the agreed schema; private human constraints (not in `session_open.goal`) were respected.

---

## Co-sign and ratify ceremony

- [ ] Compare `co_signed_hash` on both sides — must match SHA-256 of the minified `api.schema.json` bytes both agents signed.
- [ ] Each human independently completes this checklist (do not delegate judgment artifacts to the agent).
- [ ] Both humans call `human_approve` on the `ratify` pending.
- [ ] After dual approve, session closes with matching `co_signed_hash` and status `closed`.

---

## Do not

- Do not approve ratify while `atest_run` A1 is red (`tests_not_green`).
- Do not approve ratify if `index.html`, `product-spec.json`, or `server.mjs` fail A2/A3 judgment — send agents back to negotiate counters instead.
- Do not attempt a second co-sign in the same session; open a new session if the contract must change.

---

## Papercuts

Friction discovered during the run is filed separately — see [papercut-template.md](./papercut-template.md) and the runbook papercuts section. Ratify approval is independent of papercut filing.
