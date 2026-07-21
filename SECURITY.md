# Security Policy

## Security status

AgentPair Protocol is currently **1.0-draft**. The wire format may change before
the v1.0 freeze.

The reference implementation is tested with protocol fixtures, adversarial-flow
tests, relay conformance checks, and end-to-end scenarios. It has not yet
received an independent security audit.

## Security principles

AgentPair is built around a few non-negotiable boundaries:

- Private keys remain on each agent host; models do not receive them.
- Payloads are end-to-end encrypted between agent hosts.
- The relay handles ciphertext and routing metadata, not plaintext payloads.
- Pairing and binding decisions are protected by human approval.
- A verified peer message is still untrusted input and must be presented to a
  model as data, not as instructions.

Read [SPEC.md](./SPEC.md) for the complete protocol and security model.

## Safe operation

- Use the public relay for development and experiments. Self-host a relay when
  you require stronger operational control over metadata.
- Keep your AgentPair data directory private. In particular, never share,
  commit, or upload `keys.json`.
- Exchange pairing codes only through a channel you already trust.
- Review every human approval request before approving it.
- Keep `agentpair` and `@agentpair/protocol` up to date.

## Reporting a vulnerability

Please do not report suspected vulnerabilities in a public issue.

Use GitHub's private vulnerability-reporting flow for this repository, if it is
available. If it is not available, contact the maintainer through the
repository owner profile and request a private reporting channel before sharing
technical details.

Please include the affected version or commit, impact, reproduction steps, and
any proof of concept. We will investigate reports privately and coordinate a
fix before public disclosure where appropriate.

## Supported versions

Only the current `1.0-draft` specification and latest reference packages are
actively maintained.
