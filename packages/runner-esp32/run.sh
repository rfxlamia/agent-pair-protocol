#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: run.sh <generated.c> [extra-gcc-args...]" >&2
  exit 2
}

[[ $# -ge 1 ]] || usage

SOURCE_FILE="$1"
shift

if [[ ! -f "$SOURCE_FILE" ]]; then
  echo "Source file not found: $SOURCE_FILE" >&2
  exit 1
fi

xtensa-esp-elf-gcc -fsyntax-only \
  -I/opt/vendor \
  -Wno-unused-function \
  -Wno-unused-variable \
  "$SOURCE_FILE" "$@"
