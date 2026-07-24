# M3.4 Papercut Issue Template

Copy this template when filing dogfood friction as a GitHub issue. Use during the **official** non-author run for M3.4 exit evidence.

**Runbook:** [M3.4 Wishlist Dashboard — Operator Runbook](./M3.4-wishlist-dashboard.md)

> **Do not auto-close [#38](https://github.com/rfxlamia/agent-pair-protocol/issues/38)** from individual papercut issues. Link papercuts in the #38 closure comment when the official run is complete.

---

## Title

`[M3.4 dogfood] <short description>`

---

## Run phase

- [ ] **dry-run** (repo author — validate runbook; not M3.4 exit evidence)
- [ ] **official run** (designated non-author — counts toward M3.4 exit)

> **Duplicate dry-run papercuts:** If this item was already noted during a dry-run, record it in the official run report but **do not** re-file as a new GitHub issue unless behavior changed or the fix regressed.

---

## Environment

| Field | Value |
|-------|-------|
| Machine role | PM (initiator) / Developer (joiner) |
| Agent toolchain | e.g. Cursor / Claude Code |
| `agentpair` version | e.g. `0.1.20` (`npx -y agentpair@<pin> --version`) |
| Relay URL | `AGENTPAIR_RELAY_URL` (redact tokens if any) |
| OS | e.g. macOS 15, Ubuntu 24.04 |

---

## Summary

One paragraph: what you were trying to do and what went wrong.

---

## Expected vs actual

**Expected:**

**Actual:**

---

## Repro steps

1.
2.
3.

Include MCP tool names, thread/pairing context, and whether `inbox_wait` was in use.

---

## Logs (redacted)

Paste relevant MCP tool responses or agent transcript excerpts. **Redact** pairing codes, relay credentials, email addresses, and private human constraints.

```
(paste here)
```

---

## Severity / impact

- [ ] Blocker — could not complete ceremony
- [ ] Major — workaround exists but painful
- [ ] Minor — cosmetic or doc gap

---

## Filing

- Label: **`dx`**
- Link this issue in the [#38](https://github.com/rfxlamia/agent-pair-protocol/issues/38) closure comment when the official run finishes.
- Reference the runbook section if the gap is procedural: [M3.4-wishlist-dashboard.md](./M3.4-wishlist-dashboard.md)
