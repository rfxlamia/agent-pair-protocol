# PAKE library selection

**Date:** 2026-07-07  
**Status:** decided  
**Decision:** Option B — RustCrypto `spake2` compiled to WASM via `wasm-pack`

## Context

AgentPair v0 pairing uses SPAKE2 so two agents can derive a shared secret from a human-exchanged code without sending the code over the relay. The protocol package runs in Node 22+ and must expose a thin TypeScript adapter for the pairing flow (T4).

## Options considered

### Option A — npm `spake2@1.0.2` (rejected)

- Unmaintained JavaScript implementation built on `elliptic` / `bn.js`
- Adds a second crypto stack beside `@noble/curves` already used for Ed25519/X25519
- Higher audit surface and dependency risk for a security-critical PAKE primitive
- npm package name `cpace` resolves to an unrelated nodemon wrapper, not a PAKE library

### Option B — RustCrypto `spake2` → WASM (chosen)

- Actively maintained pure-Rust implementation in the RustCrypto PAKEs workspace
- Same algorithm and test vectors as the reference Python/Rust ecosystem
- Compiled once with `wasm-pack build --target nodejs` into `packages/protocol/wasm/pkg/`
- TypeScript consumes a small `pake-adapter.ts` wrapper (`init`, `start`, `respond`, `finish`)
- No hand-rolled SPAKE2 math in TypeScript

## Consequences

- **Build:** Developers need Rust + `wasm-pack` to rebuild the WASM artifact; committed `pkg/` output can be used for tests when the toolchain is present
- **Runtime:** Node loads the WASM module at adapter `init()` time; pairing spike tests verify matching keys for the same code
- **Rejected paths:** Do not add npm `spake2`, npm `cpace`, or elliptic/bn.js SPAKE2 implementations

## Implementation

| Artifact | Path |
|----------|------|
| Rust crate | `packages/protocol/wasm/spake2-pake/` |
| WASM output | `packages/protocol/wasm/pkg/` |
| TS adapter | `packages/protocol/src/pairing/pake-adapter.ts` |
| Spike test | `packages/protocol/src/pairing/pake-spike.test.ts` |

Build command (from `packages/protocol/wasm/spake2-pake/`):

```bash
wasm-pack build --target nodejs --out-dir ../pkg --out-name spake2_pake
```
