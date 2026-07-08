#!/usr/bin/env bash
# Deploy AgentPair relay to school VPS (/opt/agentpair only — never touches /opt/kareema).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${DEPLOY_HOST:-school}"
REMOTE="${AGENTPAIR_REMOTE:-/opt/agentpair}"
HEALTH_MAX_ATTEMPTS="${HEALTH_MAX_ATTEMPTS:-30}"
HEALTH_DELAY_SECONDS="${HEALTH_DELAY_SECONDS:-2}"

wait_for_url() {
  local label="$1"
  local url="$2"
  local max_attempts="${3:-$HEALTH_MAX_ATTEMPTS}"
  local delay_seconds="${4:-$HEALTH_DELAY_SECONDS}"

  for ((attempt = 1; attempt <= max_attempts; attempt++)); do
    if response="$(curl -sf "$url")"; then
      echo "==> ${label} healthy (attempt ${attempt}/${max_attempts})"
      echo "${response}"
      return 0
    fi
    echo "==> Waiting for ${label}... (${attempt}/${max_attempts})"
    sleep "$delay_seconds"
  done

  echo "ERROR: ${label} not healthy after ${max_attempts} attempts: ${url}" >&2
  return 1
}

echo "==> Sync source to ${HOST}:${REMOTE}"
rsync -avz --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude dist \
  --exclude .pi \
  --exclude .pnpm-store \
  --exclude 'packages/protocol/wasm/spake2-pake/target' \
  "${ROOT}/" "${HOST}:${REMOTE}/"

echo "==> Build and restart relay on ${HOST}"
ssh "${HOST}" bash -s <<REMOTE
$(declare -f wait_for_url)
set -euo pipefail
HEALTH_MAX_ATTEMPTS="${HEALTH_MAX_ATTEMPTS}"
HEALTH_DELAY_SECONDS="${HEALTH_DELAY_SECONDS}"
cd "${REMOTE}"
docker compose -f docker-compose.yml build --no-cache relay
docker compose -f docker-compose.yml up -d relay
docker compose -f docker-compose.yml ps
wait_for_url "Local relay" "http://127.0.0.1:3001/health"
REMOTE

echo "==> Public health check"
wait_for_url "Public relay" "https://relay.yagura.space/health"
echo "Deploy complete: https://relay.yagura.space"
