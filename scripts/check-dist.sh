#!/usr/bin/env bash
# Post-build gate (T7.4): the bundle about to be deployed must be the production build.
# Fails when the E2E shim, eval-like constructs, WebAssembly, inline scripts or a mismatched _headers
# file are present in dist/. Run by `bun run deploy` and CI after `bun run build`.
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0
[ -d dist/assets ] || { echo "FAIL dist/assets missing (run bun run build)"; exit 1; }

check() { # check <name> <grep args...> ; fails when grep finds something
  local name="$1"; shift
  if hits=$(grep "$@" 2>/dev/null) && [ -n "$hits" ]; then
    echo "FAIL $name"; printf '%s\n' "$hits" | head -5; fail=1
  else echo "OK   $name"; fi
}

check "no E2E memory-handle shim in dist (built with VITE_E2E=1?)" -lE 'mutationApplied|rehydrateMarker|applyMutation' dist/assets/*.js
check "no eval / new Function / WebAssembly in dist" -lE 'new Function\(|[^a-zA-Z_.]eval\(|WebAssembly\.' dist/assets/*.js
check "no remote import()/importScripts in dist chunks" -lE 'import\("https?://|importScripts\(' dist/assets/*.js
check "no inline <script> in dist/index.html" -E '<script(?![^>]*\ssrc=)' -P dist/index.html
check "no remote script/style/link URLs in dist/index.html" -E '(src|href)="https?://' dist/index.html

if cmp -s public/_headers dist/_headers; then echo "OK   dist/_headers identical to public/_headers"
else echo "FAIL dist/_headers differs from public/_headers"; fail=1; fi
if grep -q "connect-src 'none'" dist/_headers; then echo "OK   CSP has connect-src 'none'"
else echo "FAIL CSP lacks connect-src 'none'"; fail=1; fi
[ -f dist/_redirects ] && echo "OK   _redirects present" || { echo "FAIL _redirects missing"; fail=1; }
exit $fail
