#!/usr/bin/env bash
# Smoke-test agentpair as an npm consumer would install it (not monorepo devDeps).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MCP_DIR="${ROOT}/packages/mcp-server"
PROTO_DIR="${ROOT}/packages/protocol"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

echo "==> Building protocol and agentpair"
pnpm --filter @agentpair/protocol build
pnpm --filter agentpair build

echo "==> Packing @agentpair/protocol tarball"
PROTO_TGZ="$(cd "${PROTO_DIR}" && npm pack --pack-destination "${TMP_DIR}" | tail -1)"
PROTO_PACKED="${TMP_DIR}/${PROTO_TGZ}"
PROTO_VERSION="$(node -p "JSON.parse(require('node:fs').readFileSync('${PROTO_DIR}/package.json','utf8')).version")"

echo "==> Staging publish-shaped agentpair package (no workspace: protocol dep)"
STAGE_DIR="${TMP_DIR}/agentpair-stage"
mkdir -p "${STAGE_DIR}/dist"
cp -R "${MCP_DIR}/dist/." "${STAGE_DIR}/dist/"
cp "${MCP_DIR}/LICENSE" "${STAGE_DIR}/LICENSE"
node --input-type=module -e "
import { readFileSync, writeFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync('${MCP_DIR}/package.json', 'utf8'));
const publishable = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  license: pkg.license,
  type: pkg.type,
  bin: pkg.bin,
  main: pkg.main,
  types: pkg.types,
  files: pkg.files,
  engines: pkg.engines,
  publishConfig: pkg.publishConfig,
  dependencies: {
    ...pkg.dependencies,
    '@agentpair/protocol': '^${PROTO_VERSION}',
  },
};
writeFileSync('${STAGE_DIR}/package.json', JSON.stringify(publishable, null, 2));
"

AGENT_TGZ="$(cd "${STAGE_DIR}" && npm pack --pack-destination "${TMP_DIR}" | tail -1)"
AGENT_PACKED="${TMP_DIR}/${AGENT_TGZ}"

echo "==> Asserting packed manifest lists json-schema-faker under dependencies"
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
  console.error('FAIL: staged pack still contains workspace: protocol dependency');
  process.exit(1);
}
console.log('OK: packed manifest ships json-schema-faker as a production dependency');
"

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
