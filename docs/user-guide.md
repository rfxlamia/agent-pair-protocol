# User guide — AgentPair MCP

[Bahasa Indonesia](./user-guide-ID.md) · [Docs index](./README.md) · [Root README](../README.md)

How to run the AgentPair MCP server, pair with another human’s agent, exchange
encrypted messages, and negotiate a co-signed deliverable.

## What AgentPair does

| Piece | Role |
|-------|------|
| **AI client** (Cursor, Claude Desktop, …) | Reasons and calls MCP tools |
| **`agentpair` MCP server** | Holds keys, signs, encrypts, enforces bonds |
| **Relay** | Queues ciphertext; cannot read payloads |

Keys never leave the MCP host. The model only reasons; the host signs.

## Prerequisites

| Item | Notes |
|------|--------|
| Node.js | 22+ |
| MCP client | Cursor, Claude Desktop, Claude Code, or any MCP host |
| Partner | Another person with the same setup |
| Relay | Same URL on both sides — public test or self-hosted |

## Install

### From npm (recommended)

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

Restart the client after saving. No global install required — the client spawns
`npx` on demand.

### From source (development)

```bash
git clone https://github.com/rfxlamia/agent-pair-protocol.git
cd agent-pair-protocol
pnpm install
pnpm build
```

Point the client at the built CLI:

```json
{
  "mcpServers": {
    "agentpair": {
      "command": "node",
      "args": ["/absolute/path/to/agent-pair-protocol/packages/mcp-server/dist/cli.js"],
      "env": {
        "AGENTPAIR_RELAY_URL": "https://relay.yagura.space"
      }
    }
  }
}
```

The server speaks **stdio** MCP. Let the AI client start the process; do not run
it as a detached background daemon for normal use.

### Identity keys

On first run the host creates an Ed25519 keypair at:

```text
~/.agentpair/keys.json
```

Permissions `0600`. **Do not share or commit this file.** Your public identity is
`agent_id` = `ed25519:` + base64url(public key).

Override the data directory with `AGENTPAIR_DATA_DIR` (keys live at
`$AGENTPAIR_DATA_DIR/keys.json`).

## Client setup

### Cursor

Workspace: `.cursor/mcp.json`, or your global Cursor MCP config. Use the npm or
from-source snippets above. Reload the window, then ask the agent to call
`inbox` — an empty inbox (`ok: true`, `envelopes: []`) before pairing is normal.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
with the same `mcpServers.agentpair` block. Restart Claude Desktop.

### Other MCP clients

Same pattern: command `npx`, args `["-y", "agentpair"]`, env
`AGENTPAIR_RELAY_URL`.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `AGENTPAIR_RELAY_URL` | `http://127.0.0.1:3001` | Relay base URL (both peers must match) |
| `AGENTPAIR_DATA_DIR` | `~/.agentpair` | Keys, bonds, pending queue, cursors |
| `AGENTPAIR_PEER_CONTENT_CAP_BYTES` | `8192` (max `65536`) | Cap on peer payload text presented to the model |
| `AGENTPAIR_PREFLIGHT` | `warn` | Relay `/health` check: `warn`, `strict`, or `off` |

Preflight expects relay health to advertise `spec_version: "1.0-draft"` and
`relay_conformance: "agentpair-relay/1"`.

## MCP tools

| Tool | Purpose |
|------|---------|
| `pair_init` | Start pairing; returns a shareable code |
| `pair_join` | Redeem a code; queues human approval |
| `pair_init_complete` | Retry initiator completion if auto-complete stalled |
| `human_approve` | Approve/reject pending join, session open, or ratify |
| `list_bonds` | List bonded peers |
| `inbox` | Pull and verify envelopes |
| `inbox_wait` | Block until peer mail arrives or timeout (live sessions) |
| `send` | Send `core.msg` to a bonded peer |
| `close` | Send `core.close` on a thread (unilateral) |
| `revoke` | Drop a bond locally and push allowlist to the relay |
| `session_open` | Open negotiation (`nego.open`) |
| `session_msg` | `propose` / `counter` / `accept` / `challenge` / `test_report` |
| `session_sign` | Sign artifact hash when ready |
| `session_status` | Snapshot of session state |
| `atest_run` | Run a registered acceptance runner on an artifact |

## Main workflows

### 1. Pair

Both sides must use the **same** `AGENTPAIR_RELAY_URL`.

| Step | Who | Action |
|------|-----|--------|
| 1 | A | `pair_init` with `scope` (string array) and `mode` |
| 2 | A → B | Share the returned code out of band (call, chat, in person) |
| 3 | B | `pair_join` with that code — returns `pending_id` + `approval_path` |
| 4 | B | Read the 6-digit code from `approval_path`, then `human_approve` (`decision: "approve"`, `approval_code`) |
| 5 | A | Initiator completion usually runs in the background; call `pair_init_complete` only if it stalls |
| 6 | Either | `list_bonds` — peer `agent_id` should appear |

**Bond modes**

| Mode | Meaning |
|------|---------|
| `ephemeral_until_session_closes` | Bond removed when a negotiated session finalizes |
| `bonded_contact` | Bond persists until `revoke` |

Pairing codes expire after about **5 minutes**.

### 2. Send a message

```text
send(to: "<peer agent_id>", body: "hello")
```

Success returns `{ ok: true, id, thread, seq }`. Common failure:
`recipient_not_allowed` (not bonded). Peer pulls with `inbox`.

### 3. Negotiate a deliverable

Requires a bond. Reference MCP advertises profiles `core/1` and `nego/1` by
default.

1. **Open** — A calls `session_open` with `to`, `goal`, `acceptance[]`,
   `budget: { max_turns, deadline }` (ISO-8601 datetime), and `mandate`.
   Status becomes `pending` until B approves.
2. **Pull open** — B uses `inbox_wait` (see §4) so the inbound `nego.open` is processed and
   a session-open pending appears (`pending_id` + `approval_path`). Plain `inbox` still processes
   open when mail is already available.
3. **Approve open** — B reads the code from `approval_path`, then `human_approve`
   → session `live`.
4. **Turn** — `session_msg` with `type` `propose` | `counter` | `accept` (and
   optionally `challenge` / `test_report` when using `atest/1`).
5. **Sign** — both sides `session_sign` with the agreed `artifact_hash` when
   executable checks (if any) are green.
6. **Ratify** — each side pulls/surfaces its ratify pending as needed, then both
   humans `human_approve` → co-signed result; session `closed`.

Wire types use the `nego.*` prefix (for example `nego.open`), not `session.open`.

Check progress with `session_status(thread)`.

### 4. Live sessions — waiting for the peer

During an open negotiation, the agent must stay responsive while the peer
thinks. Use `inbox_wait` — not a manual sleep-and-poll loop.

```text
inbox_wait({ timeout_ms?: 30000 })
```

`inbox_wait` blocks until deliverable mail arrives or the timeout elapses.
The result matches `inbox` plus `timed_out` and `waited_ms`. Default timeout
is 30 seconds; `timeout_ms` is clamped to a maximum of 55 seconds.

**Loop pattern while a session is live and budget remains:**

1. Call `inbox_wait`.
2. Process any envelopes (reply with `session_msg`, pause for a human gate,
   or read the close outcome).
3. If `timed_out: true` and the session is still live, call `inbox_wait`
   again.
4. Stop on close, human gate, or budget exhaustion.

Do not run concurrent `inbox_wait` and `inbox` calls. Use plain `inbox` only
for a one-shot pull when you are not waiting on the peer.

### 5. Revoke

```text
revoke(peer: "<peer agent_id>")
```

Removes the local bond and pushes allowlist updates. Sessions tied to the bond
close; there is no `revoke.notice` envelope type. Revocation is unilateral —
the peer does not approve it.

## Human gates

Pending actions (pair join, session open, ratify) require `human_approve` with:

- `pending_id` — from the gated tool result (or `session_status` / inbox side effects)
- `decision` — `"approve"` or `"reject:<reason>"`
- `approval_code` — the 6-digit code from the host filesystem (see below)

### How to get the approval code (reference MCP)

The plaintext code is **never** included in tool JSON (secrets are stripped before
results reach the model). When a gated pending is created, the host:

1. Writes a file at **`approval_path`** — typically
   `~/.agentpair/approvals/<pending_id>` (or `$AGENTPAIR_DATA_DIR/approvals/…`),
   mode `0600`, containing a 6-digit code
2. Returns `approval_path` and `suggested_next` on the gated tool / inbox result
3. Best-effort logs the code to stderr:
   `[agentpair] approval code for pending …`

**Operator steps:** open `approval_path` → copy the 6-digit code → call
`human_approve(pending_id, decision, approval_code)`.

The model must **not** invent the code. Missing or wrong codes yield
`self_approval_forbidden` / `invalid_approval_code`.

## Acceptance runners (live)

With profile `atest/1`, `atest_run` can execute registered runners:

| Runner | Role |
|--------|------|
| `payload-size` | Size / schema payload checks |
| `spectral` | OpenAPI lint via Spectral |

Only these two are registered in the reference MCP today.

**Runner dependencies:** `npx -y agentpair` ships the `payload-size` runner
(`json-schema-faker` is a production dependency). The `spectral` runner is
opt-in: install `@stoplight/spectral-cli` in the same Node project as
`agentpair` (a bare `npx` cache install cannot see packages you add elsewhere).
Full runner packaging (`@agentpair/runners`, codegen-compile, npx resolution)
is planned for v1.1 — see issue tracker.

## Troubleshooting

**MCP tools missing in the client**  
Reload/restart the client. Confirm `npx -y agentpair` runs on your PATH with
Node 22+. Check the client’s MCP log for spawn errors.

**Pairing fails**  
Same relay URL on both sides? Code still within TTL? Joiner must open
`approval_path` and `human_approve` before SPAKE2 finishes. Initiator: try
`pair_init_complete` with the original code.

**Messages never arrive**  
Call `inbox` on the receiver. Confirm `list_bonds` on both sides. Wrong relay
URL is the usual cause.

**`relay_unavailable` / preflight warnings**  
Check `AGENTPAIR_RELAY_URL` and `GET {relay}/health`. For local relay:
`docker compose up -d` in this repo.

**From-source WASM / build errors**  
Protocol build needs Rust + `wasm-pack` once. Run `pnpm build` from the repo
root and point the client at `packages/mcp-server/dist/cli.js`.

## Relay: public test vs self-host

| Option | URL | Notes |
|--------|-----|--------|
| Public test | `https://relay.yagura.space` | Convenient for experiments; operator sees metadata |
| Local | `http://127.0.0.1:3001` | `docker compose up -d` |
| Your VPS | your HTTPS URL | See [developer guide](./developer-guide.md) |

Both peers **must** share one relay. Relays see routing metadata (who, when,
sizes) even though payloads are encrypted.

## Limits and status

- Protocol is **1.0-draft** — wire may change until freeze; see [SPEC.md](../SPEC.md).
- v1 assumes both agents use the **same** relay.
- Peer content shown to the model is length-capped (`AGENTPAIR_PEER_CONTENT_CAP_BYTES`).
- Verified peer messages are still **untrusted input** to your model.
