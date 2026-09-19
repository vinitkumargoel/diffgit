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

# T11.14: the installable app. The service worker must be stamped by the build (placeholders gone),
# must precache exactly the built assets, and must contain no remote URL of any kind — it runs under
# the same `connect-src 'none'` header as the page and fetches nothing but same-origin files.
check "no remote URL or importScripts in dist/sw.js" -nE 'https?://|importScripts\(' dist/sw.js
if [ -f dist/manifest.webmanifest ] && grep -q '"file_handlers"' dist/manifest.webmanifest; then
  echo "OK   manifest present with file_handlers"
else echo "FAIL dist/manifest.webmanifest missing or has no file_handlers"; fail=1; fi
if grep -q '__SW_' dist/sw.js; then echo "FAIL dist/sw.js still holds a build placeholder"; fail=1
else echo "OK   dist/sw.js stamped by the build"; fi
sw_list=$(sed -n '/^const PRECACHE = \[/,/^\];/p' dist/sw.js | grep -oE '"/[^"]+"' | tr -d '"' | sort)
dist_list=$(cd dist && find . -type f \( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.svg' -o -name '*.woff' -o -name '*.woff2' \) | sed 's|^\.||' | grep -v '^/sw\.js$' | grep -v '^/_' | sort)
if [ "$sw_list" = "$dist_list" ] && [ -n "$sw_list" ]; then
  echo "OK   sw.js precaches every built asset ($(printf '%s\n' "$sw_list" | wc -l | tr -d ' ') files)"
else
  echo "FAIL sw.js precache list differs from dist/"; diff <(printf '%s\n' "$sw_list") <(printf '%s\n' "$dist_list") | head -10; fail=1
fi

if cmp -s public/_headers dist/_headers; then echo "OK   dist/_headers identical to public/_headers"
else echo "FAIL dist/_headers differs from public/_headers"; fail=1; fi
if [ "$(sed -n '/^\/\*$/,/^$/p' dist/_headers | grep -c "connect-src 'none'")" = "1" ]; then
  echo "OK   page CSP has connect-src 'none'"
else echo "FAIL page CSP lacks connect-src 'none'"; fail=1; fi
# T11.14: the worker's own block must detach that policy and allow same-origin fetches, or no
# service worker can run at all (it unregisters itself if this is missing; see public/sw.js).
sw_block=$(sed -n '/^\/sw\.js$/,/^$/p' dist/_headers)
if printf '%s' "$sw_block" | grep -q "! Content-Security-Policy" &&
   printf '%s' "$sw_block" | grep -q "connect-src 'self'"; then
  echo "OK   /sw.js block detaches the page CSP and allows connect-src 'self'"
else echo "FAIL /sw.js header block missing or wrong"; fail=1; fi
[ -f dist/_redirects ] && echo "OK   _redirects present" || { echo "FAIL _redirects missing"; fail=1; }
if grep -qE 'name="build-id" content="[0-9a-f]{7,}"' dist/index.html; then echo "OK   build id meta present ($(grep -oE 'name="build-id" content="[^"]+"' dist/index.html | sed 's/.*content="//; s/"$//'))"
else echo "FAIL build id meta missing or not a commit id (dev build?)"; fail=1; fi
exit $fail
