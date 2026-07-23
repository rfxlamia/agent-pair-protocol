#!/usr/bin/env bash
# Smoke-test agentpair as an npm consumer would install it (not monorepo devDeps).
#
# Uses `pnpm pack` on the real packages (same as publish) so the verified tarball
# matches bin/files/exports and workspace: protocol rewrites — not a hand-built subset.
#
# By default rebuilds protocol + agentpair (standalone-safe). In CI, set
# SKIP_BUILD=1 after Build/Test so only pack + install + smoke runs.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MCP_DIR="${ROOT}/packages/mcp-server"
PROTO_DIR="${ROOT}/packages/protocol"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

tgz_name_for() {
  node --input-type=module -e "
import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync('${1}/package.json', 'utf8'));
const base = pkg.name.startsWith('@') ? pkg.name.slice(1).replace('/', '-') : pkg.name;
console.log(\`\${base}-\${pkg.version}.tgz\`);
"
}

tar_contains() {
  local archive="$1"
  local member="$2"
  local listing
  listing="$(tar -tzf "${archive}")"
  grep -Fq "${member}" <<<"${listing}"
}

require_dist() {
  local missing=0
  for path in \
    "${PROTO_DIR}/dist/index.js" \
    "${PROTO_DIR}/dist/wasm/pkg/spake2_pake.js" \
    "${MCP_DIR}/dist/runners/payload-size.js" \
    "${MCP_DIR}/dist/cli.js"; do
    if [[ ! -f "${path}" ]]; then
      echo "ERROR: missing build artifact: ${path}" >&2
      missing=1
    fi
  done
  if [[ "${missing}" -ne 0 ]]; then
    echo "ERROR: dist artifacts missing; run without SKIP_BUILD=1 or pnpm build first" >&2
    exit 1
  fi
}

if [[ "${SKIP_BUILD:-}" == "1" ]]; then
  echo "==> SKIP_BUILD=1 — using existing dist artifacts"
  require_dist
else
  echo "==> Building protocol and agentpair"
  pnpm --filter @agentpair/protocol build
  pnpm --filter agentpair build
fi

echo "==> Packing @agentpair/protocol (pnpm pack)"
(cd "${PROTO_DIR}" && pnpm pack --pack-destination "${TMP_DIR}" >/dev/null)
PROTO_TGZ="$(tgz_name_for "${PROTO_DIR}")"
PROTO_PACKED="${TMP_DIR}/${PROTO_TGZ}"

echo "==> Packing agentpair (pnpm pack — publish-shaped manifest + files allowlist)"
(cd "${MCP_DIR}" && pnpm pack --pack-destination "${TMP_DIR}" >/dev/null)
AGENT_TGZ="$(tgz_name_for "${MCP_DIR}")"
AGENT_PACKED="${TMP_DIR}/${AGENT_TGZ}"

for packed in "${PROTO_PACKED}" "${AGENT_PACKED}"; do
  if [[ ! -f "${packed}" ]]; then
    echo "ERROR: expected pack output missing: ${packed}" >&2
    exit 1
  fi
done

echo "==> Asserting packed agentpair manifest"
MANIFEST_JSON="${TMP_DIR}/pack-manifest.json"
tar -xzf "${AGENT_PACKED}" -O package/package.json > "${MANIFEST_JSON}"
node --input-type=module -e "
import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync('${MANIFEST_JSON}', 'utf8'));
const deps = pkg.dependencies ?? {};
const devDeps = pkg.devDependencies ?? {};

if (!deps['json-schema-faker']) {
  console.error('FAIL: json-schema-faker missing from packed dependencies');
  process.exit(1);
}
if (devDeps['json-schema-faker']) {
  console.error('FAIL: json-schema-faker still listed in packed devDependencies');
  process.exit(1);
}
if (String(deps['@agentpair/protocol'] ?? '').includes('workspace:')) {
  console.error('FAIL: packed manifest still contains workspace: protocol dependency');
  process.exit(1);
}
if (!pkg.bin?.agentpair) {
  console.error('FAIL: packed manifest missing bin.agentpair');
  process.exit(1);
}
if (!Array.isArray(pkg.files) || !pkg.files.includes('dist')) {
  console.error('FAIL: packed manifest files allowlist drifted from package.json');
  process.exit(1);
}
console.log('OK: pnpm pack manifest rewrites workspace protocol dep and ships json-schema-faker');
"

echo "==> Asserting packed tarball honors files allowlist (bin + runner assets)"
if ! tar_contains "${AGENT_PACKED}" 'package/dist/cli.js'; then
  echo "FAIL: packed tarball missing package/dist/cli.js" >&2
  exit 1
fi
if ! tar_contains "${AGENT_PACKED}" 'package/dist/runners/spectral-ruleset.yaml'; then
  echo "FAIL: packed tarball missing spectral-ruleset.yaml from dist/runners" >&2
  exit 1
fi

echo "==> Installing packed tarballs in isolated consumer dir"
CONSUMER_DIR="${TMP_DIR}/consumer"
mkdir -p "${CONSUMER_DIR}"
cd "${CONSUMER_DIR}"
npm init -y >/dev/null
npm install "${PROTO_PACKED}" "${AGENT_PACKED}" >/dev/null

echo "==> Smoke-testing payload-size runner from consumer install"
node --input-type=module -e "
import { runPayloadSize } from 'agentpair/dist/runners/payload-size.js';
const result = runPayloadSize({ type: 'object', properties: { id: { type: 'string' } } });
if (!result.ok) {
  console.error('FAIL: runPayloadSize returned', result);
  process.exit(1);
}
console.log('OK: payload-size runner works from consumer install');
"

echo "==> npm consumer verify passed"
