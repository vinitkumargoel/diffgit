/**
 * diffgit's service worker (T11.14, Design §14.6) — the whole reason an installed diffgit opens
 * with the network off.
 *
 * Two placeholders are rewritten at build time by the `diffgit-sw-precache` plugin in
 * `vite.config.ts`: `VERSION` becomes the build id plus a hash of the file list, so every deploy is
 * a byte-different worker the browser installs, and `PRECACHE` becomes the list of built assets
 * (`scripts/check-dist.sh` asserts that list against `dist/`). In `vite dev` the file is served
 * unrewritten and never registered — `src/ui/pwa.ts` registers it only in a production build.
 *
 * **It never touches another origin.** Every handler starts by dropping anything that is not
 * same-origin, and the file contains no URL at all (`scripts/check-dist.sh` greps it).
 *
 * **The CSP gotcha, and the fail-safe.** A worker's policy comes from the headers of its own script
 * response. Under the page's `connect-src 'none'` a worker cannot fetch at all — not even to
 * pass a page chunk through — so `public/_headers` gives `/sw.js` the same policy with
 * `connect-src 'self'`; the page keeps `'none'`. Should that ever not arrive (a host that merges
 * headers instead of replacing them), the install-time probe below fails, this worker
 * **unregisters itself**, and the application goes back to behaving exactly as it did without one.
 */

const VERSION = "__SW_VERSION__";
const PRECACHE = ["__SW_PRECACHE__"];
const CACHE = `diffgit-${VERSION}`;
const INDEX = "/index.html";

/** Same-origin GETs of files this build owns; anything else is left to the browser. */
function isOurs(url) {
  return PRECACHE.includes(url.pathname);
}

/**
 * What install time pulls: the shell only (the document, the entry chunk and the stylesheet). The
 * rest of `PRECACHE` — the lazily imported route chunks and Shiki's per-language grammars, several
 * MB of them — is cached as the page asks for it, so installing diffgit never downloads a megabyte
 * of grammars nobody opened.
 */
const SHELL = PRECACHE.filter(
  (path) => path === INDEX || /\/assets\/index-[^/]+\.(js|css)$/.test(path),
);

/** null = not probed in this instance; false = this worker is about to disappear. */
let usable = null;

async function precache() {
  try {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL);
    usable = true;
  } catch (e) {
    // The only way this fails for a same-origin file is a policy that forbids the worker to fetch.
    // Serving from a cache it can never fill would break every page it controls, so it steps aside.
    usable = false;
    console.warn("sw: cannot fetch its own assets (CSP?); unregistering", e);
    await self.registration.unregister();
  }
}

async function dropOldCaches() {
  const names = await caches.keys();
  await Promise.all(
    names
      .filter((name) => name.startsWith("diffgit-") && name !== CACHE)
      .map((name) => caches.delete(name)),
  );
}

/**
 * Cache-first for the built assets (their names are content-hashed, so a hit is always correct) and
 * for the app shell; a navigation that cannot be fetched falls back to the cached shell, which is
 * what "works offline" means for a single-page app with no routes.
 */
async function respond(request, url) {
  const cache = await caches.open(CACHE);
  const key = request.mode === "navigate" ? INDEX : url.pathname;
  const hit = await cache.match(key);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok && response.type === "basic" && (isOurs(url) || request.mode === "navigate")) {
    await cache.put(key, response.clone());
  }
  return response;
}

// No `skipWaiting()`: a new build's chunks have new names, so taking over a page that is still
// running the old ones would break its lazy imports. The new worker waits; `src/ui/pwa.ts` says so
// once, in one toast, and the reload is the user's.
self.addEventListener("install", (event) => {
  event.waitUntil(precache());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(dropOldCaches().then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  if (usable === false) return;
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // nothing remote, ever
  if (!isOurs(url) && request.mode !== "navigate") return;
  event.respondWith(respond(request, url));
});
