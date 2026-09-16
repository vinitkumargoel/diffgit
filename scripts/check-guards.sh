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

# Engine checks `.kind`, never `instanceof FileSystem*` (T0.4).
guard "instanceof FileSystem* in src/engine" \
  grep -rnE "instanceof FileSystem" src/engine --include='*.ts'

# D16: nothing in src/ may be able to write through a handle (T0.4 amendment).
guard "D16 write-capable FSA call in src/" \
  grep -rnE "createWritable|removeEntry|\.move\(|create: true|\"readwrite\"" src --include='*.ts' --include='*.tsx'

# Only the store talks to the engine: components/hooks never import the worker client (T4.2 AC).
guard "component imports the worker client" \
  grep -rnE "from ['\"].*(workerClient|engineClient)['\"]" src/ui/components src/ui/hooks --include='*.ts' --include='*.tsx'

# Design §10 / T5.6 AC: literal colours live only in src/index.css; everything else uses tokens.
# Tests are excluded: contrast.test.ts feeds reference colours to the WCAG maths.
guard "literal colour outside src/index.css" \
  grep -rnE "#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(" src/ui src/App.tsx src/main.tsx --include='*.ts' --include='*.tsx' --include='*.css' --exclude='*.test.ts' --exclude='*.test.tsx'

# T6.1: the scheduler is the only refresh entry point. `computeDiff` is called by the store's
# executor only; `recompute(` is called only from the store and the scheduler; everything else
# goes through `requestRefresh` / `scheduler.request`.
guard "computeDiff called outside store.ts / workerClient" \
  grep -rnE "\.computeDiff\(" src/ui src/App.tsx src/main.tsx --include='*.ts' --include='*.tsx' --exclude='*.test.ts' --exclude='*.test.tsx' --exclude='store.ts' --exclude='workerClient.ts' --exclude='workerClient.mock.ts'
guard "recompute() called outside store.ts / refresh/scheduler.ts" \
  grep -rnE "\.recompute\(" src/ui src/App.tsx src/main.tsx --include='*.ts' --include='*.tsx' --exclude='*.test.ts' --exclude='*.test.tsx' --exclude='store.ts' --exclude='scheduler.ts'

exit $fail
