# Changelog

## 0.4.0

### Breaking

- HKDF payload-encryption info string changed from `agentpair-envelope-v0` to
  `agentpair-envelope-v1` (SPEC §3). Ciphertext from 0.3.x does not decrypt on
  0.4.0 and vice versa.

### Added

- Committed golden JSON fixtures under `fixtures/` with `generate-fixtures` and
  `verify-fixtures` scripts.
- Fixture-driven conformance tests under `src/fixtures/`.
