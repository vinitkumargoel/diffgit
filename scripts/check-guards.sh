#!/usr/bin/env bash
# Layering and safety guards run by `bun run check`. Each guard prints the offending lines and fails.
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0

guard() {
  local name="$1"; shift
  local hits
  if hits=$("$@" 2>/dev/null); then
    if [ -n "$hits" ]; then
      echo "GUARD FAILED: $name"
      echo "$hits"
      fail=1
    fi
  fi
}

# Engine must not import React, the DOM, or UI code (tasks/README.md conventions).
guard "src/engine imports react or src/ui" \
  grep -rnE "from ['\"](react|react-dom|react/.*|\.\./ui|\.\./\.\./ui|.*/src/ui)['\"/]" src/engine --include='*.ts'

exit $fail
