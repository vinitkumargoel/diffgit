# Changelog

Entries are per task (3–6 lines: what, notable decisions, follow-ups). Newest first.

## Follow-ups

- **T3.5**: consider `FileDiff.newMtime?: number` for a stricter viewed key on untracked files (T4.2).
- **T3.5**: throw `EngineError#toJSON()` (plain object) at the worker boundary so `code` survives comlink serialisation (T4.1).

---

## T5.0 — Spike S1: diff renderer (ADR-001)

- `spikes/s1-diff-renderer/` (own Vite root, excluded from the app build): `@git-diff-view/react` page (DiffFile in a Web Worker with `@git-diff-view/shiki`, hydrated via `createInstance`) and `react-diff-view` page (our `HunkModel` → `HunkData`, `markEdits`, `expandFromRawCode`, `Decoration` hunk headers), both styled to Design §7.6 with §3.2 tokens, plus a Shiki 4 JS-engine cost page; `measure.ts` drives them in headless Chromium under `vite preview` with the production CSP.
- Numbers (gzip / Chromium 153): `@git-diff-view/react` adds 341.6 kB main-thread JS (≈ 300 kB is `lowlight(all)` imported eagerly by `DiffView`) + 380.6 kB worker; renders the 5,600-row case in 908 ms; expand-context and worker mode work; 0 CSP violations. `react-diff-view` adds 23.2 kB; 414 ms for the same case; expand via `expandFromRawCode` works; 0 CSP violations. Shiki 4 core + JS engine + two themes: 55 kB, 16 kB per grammar, 245 ms first tokenise of 252 lines.
- **Decision:** `react-diff-view@3.3.3` + `HunkModel`, Shiki 4 (`@shikijs/core`, `@shikijs/engine-javascript`, lazy `@shikijs/langs/*`, `github-light`/`github-dark`) in a UI-owned worker, `markEdits` for word-level marks. `@git-diff-view/react` fails the < 250 kB rule, needs patch text plus full contents on the main thread, and its Tailwind-utility markup fights §7.6. Details and comparison table in `docs/adr-001-diff-renderer.md`; T5.3 "Renderer" section rewritten with the API notes.
- Dependencies: `react-diff-view`, `@shikijs/core|engine-javascript|langs|themes` (4.4.3) moved to runtime deps; `@git-diff-view/*` and the `shiki` meta-package removed (spike README documents how to reinstall to re-run). Also found: `DiffFile` treats per-hunk strings without `---`/`+++` headers as an empty diff.

## T4.4 — BrowserGate + HomeScreen

- `src/index.css` now holds the full Design §3.1–§3.4 token set for `:root` and `.dark` (neutrals/accent, diff colours, status squares, chips, badges, banner levels, progress track, checkerboard, popover shadow, backdrop) exposed via `@theme inline` (`bg-surface`, `text-muted`, `border-line`, `bg-status-m-bg`, …), the §4 font stacks, base styles (13/20 px, tabular-nums, focus ring per §5, reduced-motion) and `.btn` / `.btn-primary` / `.btn-icon` / `.spin` component classes. T5.6 reconciles.
- `src/ui/theme.ts`: `applyTheme("system" | "light" | "dark")` toggles `.dark` on `<html>`, following `prefers-color-scheme` via a `matchMedia` listener for "system"; `App` applies `prefs.theme` (toggle UI in T5.6).
- Components per Design §7.8: `CenteredColumn` shell (560 px, 15 px, 24 px gaps), `BrowserGate` (feature-detects `showDirectoryPicker`; `lucide:monitor-x`), `HomeScreen` (`lucide:book-bookmark` — lucide 1.x renamed `book-marked`; privacy paragraph; `--success` primary button; `showDirectoryPicker({ mode: "read", id: "diffgoel-repo" })` → `upsertRepo` → `openRepo` with remembered branches; AbortError silent, other errors toast; `o` shortcut), `RecentRepoList` (44 px rows, `lucide:folder-git-2`, "opened 3 h ago", × on hover/focus, Enter/Space opens, Delete removes, inline `--danger` "Permission denied. Try again"), `LoadingScreen` (four phases with check/spinner/circle icons, tabular counts, Cancel → `closeRepo`).
- `App.tsx` switches on `store.screen`; `RepoScreen`/`ErrorScreen` are lazy placeholders completed in T5.x. AC: grep for `#hex`/`rgb(` in the component files returns nothing; vitest covers gate, recents, AbortError, toast, `o` key, denied path, loading phases.

## T4.3 — Persistence

- `src/ui/persistence/repos.ts` (idb-keyval, DB `diffgoel-repos`): `listRepos` (newest first, max 20), `upsertRepo` (dedupe via `isSameEntry` asked of whichever side still has the method — stored copies lose prototypes — or `snapshotId` for E2E markers), `touchRepo`, `removeRepo`, `getRepo`, `ensurePermission` (query → request, markers always granted).
- `viewed.ts` (DB `diffgoel-viewed`): key → timestamp, pruned to 5,000 by age every 50 writes. `prefs.ts`: localStorage JSON validated field-by-field (`sidebarWidth` clamped 220–480), `setPrefsStorage` test seam.
- `storage.ts`: every IndexedDB/localStorage op is wrapped; the first failure fires `onStorageError` once → `installPersistence()` turns it into a warning toast with the `STORAGE_UNAVAILABLE` copy. `main.tsx` calls `installPersistence()`, which injects the adapters into the store.
- Tests use `fake-indexeddb/auto` with `Date.now` spies (vitest fake timers stall fake-indexeddb's scheduler) and a prototype-based mock handle (own-property functions are not structured-cloneable).
- `HANDLE_GONE` handling ("forget this repo" after confirmation) lands in the ErrorScreen (T5.5) on top of `removeRepo`.

## T4.2 — Store

- `src/ui/store.ts` (zustand): slices `screen/repo/loading/error/diffSource/diff/stats/warnings/prefs/viewed/filter/activeFileId/collapsed/refresh/fileDiffs/toasts/announcement`; actions `openRepo(handle, {id,lastSource,lastTarget})`, `closeRepo`, `setSource/setTarget/swapBranches` (accept a `RepoRef` or a name/full ref), `setIncludeWorktree` (guarded by `isWorktreeSource`), `recompute`, `loadFileDiff` (per-whitespace-variant LRU of 200, `AbortController` + `cancelFileDiff`), `toggleViewed` (collapses the card), filter, prefs, collapse, warnings, toasts, `prioritise`, `fileBytes`.
- Defaults from `defaultDiffSource(repo)`; remembered branches applied only if they still exist; source falls to `"HEAD"` for detached/unborn repos. Responses are checked against `diff.generation`; `STALE`/`CANCELLED` are dropped silently; `HANDLE_GONE`/`PERMISSION` go to the error screen; other recompute failures become a toast with Retry.
- Selectors: `selectVisibleFiles` (substring or glob via `treeModel.makePathFilter`), `selectTotals` (merges pushed stats), `selectViewedCount`, `selectCanIncludeWorktree`, `selectTreeModel` (`buildTree` with GitHub-style chain compaction), `selectActiveWarnings`, `selectFileDiff`. Stats arrive via the sink's `onStats`; the store only forwards `prioritise(ids)`.
- Viewed key `repoId|sourceRef|targetRef|fileId|(newOid ?? "wt:"+newSize)|(oldOid ?? "-")` in `viewedKey.ts`. Follow-up: `FileDiff` has no worktree mtime, so the untracked fallback uses size only; T3.5 could add `newMtime?: number` to tighten it.
- Persistence is injected via `configurePersistence()` (T4.3 wires IndexedDB/localStorage); `setStoreClient()` is the test seam. Crash restarts from the client trigger a toast + recompute.

## T4.1 — Worker client

- `src/ui/workerClient.ts`: `WorkerClient` interface = `EngineApi` (src/engine/api.ts) + `onRestart`, `lastSource`, `terminate`, `isMock`; comlink proxy with a single proxied `ProgressSink` registered at `open`; every rejection normalised via `toUiError` to `{code, message, hint?}` with `INTERNAL` fallback.
- Crash recovery: `error`/`messageerror` rejects in-flight calls with `WORKER_CRASHED`, terminates and recreates the worker, re-opens the retained handle + sink and notifies `onRestart(info, error)`; the client keeps the last `DiffSource` for the store to recompute. Tested with a `MessageChannel`-backed fake worker.
- `src/ui/workerClient.mock.ts` (`VITE_MOCK_ENGINE=1` via `src/ui/engineClient.ts`): serves `src/test/recorded/{basic,worktree}.{repoinfo,diffresult}.json` (hand-written, drop-in names for T3.5's recordings), deterministic texts + LCS hunks (`src/ui/mock/mockContents.ts`), background `onStats` batches, `STALE`/`CANCELLED` semantics, `mutate()` changes `probe()` signatures, `loadLarge` gating, PNG bytes for image ids.
- `src/ui/errors.ts`: `describeError` for exactly `PUBLIC_CODES` (+ action), `toUiError`. Guard added: components/hooks must not import the worker client.
- Follow-up for T3.5: throw plain `{code,message,hint}` (e.g. `err.toJSON()`) at the comlink boundary; `Error` instances lose `code` in comlink's default serialisation.

## T0.2 — Cloudflare Pages pipeline

- `wrangler.toml` (`pages_build_output_dir = "dist"`), `public/_headers` (CSP + nosniff, no-referrer, Permissions-Policy, COOP), `public/_redirects` SPA rule, `bun run deploy`, `scripts/check-prod.sh` (CSP identical to the file, security headers, no Cloudflare-injected scripts, deep link 200; GET with retries), `docs/deploy.md`.
- Project `diffgoel` created on classic Pages (`--force` was needed once because wrangler 4.132 delegates `pages project create` to Workers and fails without an entry point). Hello-world deployed: https://diffgoel.pages.dev — `scripts/check-prod.sh https://diffgoel.pages.dev` passes all six checks.
- Custom domain `diff.vinitk.dev` registered on the project via the Pages API (wrangler 4.x has no `pages domain` command). Status `pending: CNAME record not set` — the wrangler OAuth token only has `zone:read`, so the CNAME must be added by the owner (dashboard "Set up a custom domain" or a DNS record `diff → diffgoel.pages.dev`, proxied). Everything else in this task is done; the two domain ACs are ticked once DNS exists.
- Edge-injection settings (Web Analytics, Rocket Loader, Email Obfuscation, Auto Minify, Mirage/Polish, Zaraz) documented in `docs/deploy.md`; the served HTML currently contains none of their markers.

## T0.4 — Test harness

- `src/engine/fs/dirHandleLike.ts` (structural FSA view + `handleError`/`isHandleError` with browser error names), `nodeDirHandle.ts` (test-only; follows symlinks like Chrome, integer `lastModified`, dangling links invisible), `memoryDirHandle.ts` (`MemoryFs` + handles that see later mutations; `Mutation` ops write/remove/touch/rename/mkdir/dropRoot; base64 snapshots).
- Node-only snapshot helpers live in `src/test/memorySnapshot.ts` (`snapshotFromDisk`, `toInitScript`, `fromInitScript`) so the engine file stays free of `node:` imports; `src/test/torn.ts` (T0.3 amendment) provides `truncateIndex`/`restoreIndex`/`swapPack`/`dropRoot` mutations.
- E2E transport per amendment: `e2e/fsaShim.ts` (`installFsaShim` for `addInitScript`: marker-returning `showDirectoryPicker`, snapshot server, `window.__diffgoel.{mutate,listRoot,emitObserverRecords,setPick}`, `FileSystemObserver` stub); engine side `src/engine/e2e/{protocol,memoryChannel}.ts` and `src/engine/fs/resolveHandle.ts` behind `import.meta.env.VITE_E2E === "1"`. Verified the production bundle contains no `diffgoel-e2e` string (tree-shaken).
- `playwright.config.ts` (Chromium only, `VITE_E2E=1` build + `vite preview` web server, trace on first retry). Browsers are installed in T7.1. Per the E2E policy (only T7.1's three specs may exist), the shim/rehydration/mutation AC is proven here by `resolveHandle.test.ts` running the real `BroadcastChannel` RPC in Bun; the browser run happens inside T7.1 spec 2/3.
- Guards added to `scripts/check-guards.sh`: no `instanceof FileSystem*` in `src/engine`, D16 grep (`createWritable`, `removeEntry`, `.move(`, `create: true`, `"readwrite"`) over `src/`.

## T0.3 — Fixture builder

- `scripts/make-fixtures.sh` builds 27 fixtures (+ `perf-5k` with `FIXTURES_PERF=1`) with the real git CLI in ~6 s; idempotent (`rm -rf fixtures/` first) and deterministic (fixed identity/dates, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`; the script compares `basic/feature` before/after and fails on drift). Verified twice: `d77b2f48…` both runs.
- `scripts/fixture-expectations.sh` dumps `expected/*.json` per fixture via `jq` (`-z` output parsed for name-status/numstat so paths are safe): refs, ls-files -s, status porcelain v2, merge-base (+ `--all`), name-status 3-dot (±renames), numstat (±`-w`), ls-tree for base/tips, worktree-layer, meta, hash-object (basic/packed/large), check-ignore (ignore). `jq` is required (present on macOS dev box and ubuntu runners) — no `.txt` fallback.
- `expected/` sits inside each worktree, so the script appends `expected/` to that repo's `info/exclude` (via `git rev-parse --git-path`, correct for the linked worktree too) — git and the engine both ignore it, keeping status parity intact.
- Decisions: `renames` similar pair scores R058 in git (spec said ~60 %; parity tests read git's number). `unrelated` records a two-dot `main feature` range in `meta.diffRange`, matching T3.2's fallback. `remote`/`remote-master` check out `feature`; `no-origin-head` checks out `main`. `_remotes/` holds local bare origins; `_worktree-main/` backs `worktree-gitdir`.
- `src/test/fixtures.ts`: `fixturePath`, `hasFixture`, `loadExpected<T>` + typed shapes of every expected file. `.github/workflows/ci.yml` runs `bun run fixtures` before `bun run check`. Biome config migrated to the 2.x `preset: "recommended"` form.

## T0.1 — Repo & toolchain

- Bun project with Vite 7.3.6, React 19.3.0, TypeScript 5.9.3, Tailwind 4.3.3 (`@tailwindcss/vite`), Biome 2.5.14, vitest 4.1.11 + happy-dom 20.14.5; all versions pinned exactly (no `^`).
- Solution-style tsconfig: `tsconfig.ui.json` (DOM), `tsconfig.engine.json` (WebWorker only, excludes tests and `nodeDirHandle.ts`), `tsconfig.node.json` (bun types; scripts, tests, vite/playwright config). Verified: `document` in `src/engine` fails `tsc -b`; `importScripts` in `src/ui` fails; `self.postMessage` passes in the engine (note: it also type-checks under DOM because `Window.postMessage` exists, so the UI-side guard is demonstrated with a worker-only global).
- `src/engine/errors.ts` canonical registry (`FS_CODES`, `PUBLIC_CODES`, `INTERNAL_CODES`, `WARNING_CODES`, `EngineError`, `fsError`), `src/engine/types.ts` from Plan §4 + amendments (`sourceRef/targetRef`, `generation`, `RefSnapshot`, `synthetic`, `generated`), `src/engine/diffSource.ts` implemented (pure, tiny) rather than stubbed so the UI track can use it before T1.4 tests it.
- `vite.config.ts` parses `public/_headers` into `preview.headers` (production CSP under `vite preview`); worker format `es`, build target `es2022`; vitest scoped to `src/ui/**`, `bun test` to `src/engine` + `src/test`.
- `scripts/check-guards.sh` starts the grep guards (engine must not import react/ui); later tasks append theirs. `PATH_TYPE_CHANGED` added to `WARNING_CODES` because T2.4 emits it.
- Decision: Vite 7 (per Plan §7) with `@vitejs/plugin-react` 5.2.0 (6.x requires Vite 8); vitest 4.1.11 (5.x targets Vite 8 too).
