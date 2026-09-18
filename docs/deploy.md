# Deploying diffgit (Cloudflare Pages)

Static site, project `diffgit`, custom domain `diffgit.com` (zone `diffgit.com` is on Cloudflare).
`public/_headers` (CSP with `connect-src 'none'`) and `public/_redirects` (SPA fallback) are copied into
`dist/` by Vite and applied by Pages.

## One-time setup (owner)

1. `bunx wrangler login` — interactive OAuth; cannot be automated.
2. `bunx wrangler pages project create diffgit --production-branch main`
3. `bun run deploy` — builds and uploads `dist/`; note the `*.pages.dev` URL it prints.
4. Attach the domain. Wrangler 4.x has no `pages domain` command; use the dashboard
   (Workers & Pages → diffgit → Custom domains → Set up a custom domain → `diffgit.com`), which
   also creates the CNAME automatically because the zone is on the same account. Via the API the
   domain registration is:
   `curl -X POST -H "Authorization: Bearer $TOKEN" -d '{"name":"diffgit.com"}' https://api.cloudflare.com/client/v4/accounts/<account>/pages/projects/diffgit/domains`
   but the DNS record is **not** created for you — add `CNAME diff → diffgit.pages.dev` (proxied) in
   the zone (needs a token with `dns_records:write`; wrangler's OAuth token has only `zone:read`).
   Status is visible at `.../pages/projects/diffgit/domains/diffgit.com` (`pending` →
   `active`); certificate issuance takes a few minutes after DNS resolves.
5. Verify: `scripts/check-prod.sh` (CSP header identical to `public/_headers`, no injected scripts,
   deep links return 200).

## Every release

```
bun run check && bunx playwright test   # green first
bun run deploy                          # = bun run build && scripts/check-dist.sh && bunx wrangler pages deploy dist --project-name diffgit
scripts/check-prod.sh https://diffgit.com "$(git rev-parse --short HEAD)"   # headers + served build id
```

`scripts/check-dist.sh` (T7.4) refuses to ship a bundle that contains the E2E memory-handle shim
(only present when built with `VITE_E2E=1`), `eval`/`new Function`, WebAssembly, an inline script,
or a `_headers` file that differs from `public/_headers`.

Every build carries the short commit id: `<meta name="build-id">` in `index.html` and "Build <id>"
in the help dialog (`?`). `check-prod.sh <url> <id>` fails when a host serves a different commit.

## Cloudflare edge injection — must stay OFF (D15 / CSP)

Each of these injects third-party or inline script into served HTML, which both breaks the CSP and
violates "nothing leaves the browser". Check them once after setup and after any dashboard change:

| Setting | Where | State |
|---|---|---|
| Web Analytics (auto-inject beacon) | Pages project → Settings → Web Analytics; and Analytics & Logs → Web Analytics | off / not added for this hostname |
| Rocket Loader | Zone → Speed → Optimization → Content | off |
| Email Address Obfuscation | Zone → Scrape Shield | off for this site (or globally) |
| Auto Minify | Zone → Speed → Optimization → Content | off (feature is retired on new zones; verify) |
| Mirage / Polish | Zone → Speed → Optimization → Image | off |
| Zaraz | Zone → Zaraz | no tools configured |

Zone-level toggles apply to every hostname in `diffgit.com`; if another site needs Rocket Loader or
Email Obfuscation, scope it with a Configuration Rule that disables them for `diffgit.com`.
`scripts/check-prod.sh` greps the served HTML for `beacon|rocket-loader|cloudflareinsights|zaraz|email-decode`.

## Notes from the first deploy (2026-09-16)

- `wrangler pages project create` in wrangler 4.132 delegates to the Workers-based Pages and fails
  without an entry point; `--force` created the classic Pages project (only needed once).
- `diffgit.pages.dev` serves the hello-world with every header from `public/_headers`; the deep
  link returns 200. `scripts/check-prod.sh <url>` uses GET (HEAD may omit custom headers) with retries
  (this network shows intermittent TLS resets to Cloudflare edges).
- Custom domain `diffgit.com` was registered on the project (status `pending`, "CNAME record not
  set") and is waiting for the owner to add the CNAME as described in step 4.
- 2026-09-18: the project was renamed to `diffgit` and the single production hostname is
  `diffgit.com`. It waits for its proxied CNAME `diffgit.com → diffgit.pages.dev`; it does not
  resolve yet. The custom domain serves the same latest production deployment as `diffgit.pages.dev`.

## Rollback

Dashboard → Workers & Pages → diffgit → Deployments → (previous deployment) → ⋯ → **Rollback to this deployment**.
Or redeploy an older commit: `git checkout <sha> && bun run deploy`.

## Optional: Git-connected automatic deploys

Pages → diffgit → Settings → Builds & deployments → Connect to Git; build command `bun run build`,
output `dist`. Keep `bun run deploy` as the manual path; both use the same `_headers`.
