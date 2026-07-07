#!/usr/bin/env bash
# Deploy AgentPair relay to school VPS (/opt/agentpair only — never touches /opt/kareema).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${DEPLOY_HOST:-school}"
REMOTE="${AGENTPAIR_REMOTE:-/opt/agentpair}"

echo "==> Sync source to ${HOST}:${REMOTE}"
rsync -avz --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude dist \
  --exclude .pi \
  --exclude 'packages/protocol/wasm/spake2-pake/target' \
  "${ROOT}/" "${HOST}:${REMOTE}/"

echo "==> Build and restart relay on ${HOST}"
ssh "${HOST}" bash -s <<REMOTE
set -euo pipefail
cd "${REMOTE}"
docker compose -f docker-compose.yml build --no-cache relay
docker compose -f docker-compose.yml up -d relay
docker compose -f docker-compose.yml ps
curl -sf http://127.0.0.1:3001/health
REMOTE

echo "==> Public health check"
curl -sf "https://relay.yagura.space/health"
echo ""
echo "Deploy complete: https://relay.yagura.space"
