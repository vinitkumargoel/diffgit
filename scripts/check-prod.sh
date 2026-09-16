#!/usr/bin/env bash
# Asserts the deployed site serves the production CSP and no Cloudflare-injected scripts (T0.2, T7.4, T8.2).
# Usage: scripts/check-prod.sh [url]   (default https://diff.vinitk.dev)
set -euo pipefail
URL="${1:-https://diff.vinitk.dev}"
fail=0

expected_csp=$(grep -i 'Content-Security-Policy' "$(dirname "$0")/../public/_headers" | sed 's/^[[:space:]]*Content-Security-Policy:[[:space:]]*//')
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

deep=$(curl -s --retry 5 --retry-all-errors -o /dev/null -w '%{http_code}' "$URL/some/deep/link")
if [ "$deep" = "200" ]; then echo "OK   deep link returns 200 (SPA fallback)"; else echo "FAIL deep link returned $deep"; fail=1; fi

exit $fail
