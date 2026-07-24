#!/usr/bin/env bash
# Gates docs/dogfood/** + skills/agentpair/SKILL.md only (no docs/pocket/).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
fail() { echo "verify-dogfood-docs: $*" >&2; exit 1; }
require_file() { [[ -f "$1" ]] || fail "missing file: $1"; }
require_grep() { grep -qE "$2" "$1" || fail "$1 must match /$2/"; }
require_not_grep() { grep -qE "$2" "$1" && fail "$1 must NOT match /$2/" || true; }
# T1: scaffold
require_file docs/dogfood/.gitkeep
require_file docs/dogfood/prompts/.gitkeep
# T2: runbook (fails until written)
RUNBOOK=docs/dogfood/M3.4-wishlist-dashboard.md
require_file "$RUNBOOK"
require_grep "$RUNBOOK" 'agentpair@0\.1\.20'
require_grep "$RUNBOOK" 'artifact_put.*shipped|shipped.*artifact_put'
require_grep "$RUNBOOK" 'inbox_wait.*shipped|shipped.*inbox_wait'
require_grep "$RUNBOOK" 'pair_init.*profiles|profiles.*pair_init'
for pat in 'session_extend_budget' 'api\.schema\.json' 'criterion_id.*["'\'']A1["'\'']|criterion_id: "A1"' 'challenge' 'inbox_wait' 'dry-run' 'artifact_put\(\{ content \}\)|artifact_put\(\{ content\}\)'; do
  require_grep "$RUNBOOK" "$pat"
done
require_grep "$RUNBOOK" 'joiner alone|initiator omits|bond lacks atest'
require_grep "$RUNBOOK" 'atest_run fails|tests_not_green|challenges_incomplete'
require_grep "$RUNBOOK" 'ratify-checklist\.md'
# T3: prompts
for f in docs/dogfood/prompts/pm-initiator.md docs/dogfood/prompts/dev-joiner.md; do
  require_file "$f"
  for pat in 'inbox_wait' 'section_id' 'challenge' 'artifact_put' 'atest_run' 'session_sign' 'profiles' 'criterion_id' 'A1' 'session_extend_budget'; do
    require_grep "$f" "$pat"
  done
  require_grep "$f" 'spec\.product|spec\.api|impl\.ui|impl\.server'
  require_not_grep "$f" 'sleep [0-9]|poll every|manual poll'
done
# T4: checklists
require_file docs/dogfood/ratify-checklist.md
for pat in 'co_signed_hash' 'judgment' 'index\.html' 'product-spec' 'server\.mjs' 'executable'; do
  require_grep docs/dogfood/ratify-checklist.md "$pat"
done
require_file docs/dogfood/papercut-template.md
require_grep docs/dogfood/papercut-template.md 'dx'
require_grep docs/dogfood/papercut-template.md 'dry-run|official'
# T5: skill documents shipped tools only (no milestone-specific dogfood links)
require_grep skills/agentpair/SKILL.md 'artifact_put'
require_grep skills/agentpair/SKILL.md 'profiles'
echo "verify-dogfood-docs: OK"
