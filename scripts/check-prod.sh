#!/usr/bin/env bash
# Asserts the deployed site serves the production CSP and no Cloudflare-injected scripts (T0.2, T7.4, T8.2).
# Usage: scripts/check-prod.sh [url] [expected build id]   (default https://diffgit.com)
set -euo pipefail
URL="${1:-https://diffgit.com}"
EXPECTED_BUILD="${2:-}"
fail=0

headers_file="$(dirname "$0")/../public/_headers"
expected_csp=$(grep -m1 -i '^[[:space:]]*Content-Security-Policy:' "$headers_file" | sed 's/^[[:space:]]*Content-Security-Policy:[[:space:]]*//')
# Use a GET (not HEAD): HEAD responses from the edge may omit custom headers.
headers=$(curl -s --retry 5 --retry-all-errors -D - -o /dev/null "$URL" | tr -d '\r')
actual_csp=$(printf '%s\n' "$headers" | grep -i '^content-security-policy:' | sed 's/^[^:]*:[[:space:]]*//')
if [ "$actual_csp" = "$expected_csp" ]; then echo "OK   CSP header matches public/_headers";
else echo "FAIL CSP header differs"; echo "  expected: $expected_csp"; echo "  actual:   $actual_csp"; fail=1; fi

for h in "x-content-type-options: nosniff" "referrer-policy: no-referrer" "cross-origin-opener-policy: same-origin"; do
  if printf '%s\n' "$headers" | grep -qi "^$h"; then echo "OK   $h"; else echo "FAIL missing header: $h"; fail=1; fi
done

html=$(curl -s --retry 5 --retry-all-errors "$URL")
if printf '%s' "$html" | grep -Eiq 'beacon|rocket-loader|cloudflareinsights|zaraz|email-decode'; then
  echo "FAIL Cloudflare-injected script found in HTML"; fail=1
else echo "OK   no injected scripts (beacon/rocket-loader/cloudflareinsights/zaraz/email-decode)"; fi

served_build=$(printf '%s' "$html" | grep -oE 'name="build-id" content="[^"]+"' | sed 's/.*content="//; s/"$//')
echo "INFO served build id: ${served_build:-none}"
if [ -n "$EXPECTED_BUILD" ]; then
  if [ "$served_build" = "$EXPECTED_BUILD" ]; then echo "OK   served build id matches $EXPECTED_BUILD"
  else echo "FAIL served build id is '${served_build:-none}', expected $EXPECTED_BUILD"; fail=1; fi
fi

# T11.14: the service worker must NOT inherit the page's `connect-src 'none'` — under it a worker
# cannot fetch at all and unregisters itself, so the installed app would never work offline. This is
# the one thing only the real host can answer (Cloudflare joins duplicate headers; the `/sw.js`
# block detaches the `/*` one).
sw_headers=$(curl -s --retry 5 --retry-all-errors -D - -o /dev/null "$URL/sw.js" | tr -d '\r')
sw_csp=$(printf '%s\n' "$sw_headers" | grep -i '^content-security-policy:' | sed 's/^[^:]*:[[:space:]]*//')
if printf '%s' "$sw_csp" | grep -q "connect-src 'none'"; then
  echo "FAIL /sw.js is served connect-src 'none' — the service worker cannot run"; echo "  actual: $sw_csp"; fail=1
else echo "OK   /sw.js CSP allows the worker to fetch its own assets (${sw_csp:-no CSP})"; fi

deep=$(curl -s --retry 5 --retry-all-errors -o /dev/null -w '%{http_code}' "$URL/some/deep/link")
if [ "$deep" = "200" ]; then echo "OK   deep link returns 200 (SPA fallback)"; else echo "FAIL deep link returned $deep"; fail=1; fi

exit $fail
