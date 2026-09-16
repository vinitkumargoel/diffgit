# Contributing

## Toolchain

Pinned exactly in `package.json` (no `^`): Bun 1.3.13, Vite 7, React 19, TypeScript 5.9, Tailwind 4,
Biome 2, vitest 4 + happy-dom, Playwright 1.63, isomorphic-git 1.42. `bun install` then:

| Command | What it runs |
|---|---|
| `bun run dev` | Vite dev server (real engine in a worker). `VITE_MOCK_ENGINE=1` serves the recorded-JSON mock. |
| `bun run check` | Biome (format + lint), `tsc -b` over the three solution tsconfigs, `bun test` (engine), `vitest run` (UI), `scripts/check-guards.sh`. Must be green before every commit. |
| `bun run perf` | Perf budgets on the `perf-5k` fixture (`docs/perf.md`); `PERF_STRICT=1` also asserts timings. |
| `bun run e2e` | Playwright against `vite preview` with the production CSP (`VITE_E2E=1` build). |
| `bun run record` | Re-records `src/test/recorded/{basic,worktree}.*` from the engine. |
| `scripts/make-fixtures.sh`, `scripts/fixture-expectations.sh` | Rebuild `fixtures/` and git's own answers in `fixtures/<name>/expected/`. |
| `bun run deploy` | `build` → `scripts/check-dist.sh` → wrangler Pages deploy (`docs/deploy.md`). |

## Layout

- `src/engine/**` — pure TypeScript, runs in a Web Worker (`tsconfig.engine.json`, lib ES2022 + WebWorker).
  Public surface: `src/engine/api.ts` (worker contract), `src/engine/types.ts`, `src/engine/errors.ts`
  (the closed code registry), `src/engine/session.ts` (`RepoSession`, `toPublicError`).
- `src/ui/**` — React app (`tsconfig.ui.json`). `src/ui/store.ts` is the only module that talks to the
  worker client; components and hooks read the store.
- `src/ui/refresh/**` — scheduler, observer classifier, poller. `scheduler.request()` is the only
  refresh entry point.
- `src/test/**`, `*.test.ts(x)`, `e2e/**`, `scripts/**` — `tsconfig.node.json`.

## Guards (`scripts/check-guards.sh`, part of `bun run check`)

Each guard is a grep that must return nothing. They encode decisions from `Plan.md` §0 and the task
amendments; when one fires, fix the code, do not widen the guard.

| Guard | Rule it enforces |
|---|---|
| `src/engine imports react or src/ui` | Engine stays DOM-free and UI-free (runs in a worker, tested under bun). |
| `instanceof FileSystem* in src/engine` | Handles are duck-typed by `.kind` so the memory/Node adapters work (T0.4). |
| `D16 write-capable FSA call in src/` | `createWritable`, `removeEntry`, `.move(`, `create: true`, `"readwrite"` never appear: the app cannot write. |
| `component imports the worker client` | Components/hooks import from `store.ts`, never `workerClient`/`engineClient` (T4.2). |
| `literal colour outside src/index.css` | Every colour is a design token (Design §10, T5.6). |
| `computeDiff called outside store.ts / workerClient` | The store's `recompute` is the single executor (T6.1). |
| `recompute() called outside store.ts / refresh/scheduler.ts` | Everything else goes through `requestRefresh` / `scheduler.request` (T6.1). |
| `empty catch body in src/` | Every catch rethrows, converts to a registry code, or emits a warning; comment-only bodies must say why (T7.3, `docs/errors.md`). |

Related gates: `scripts/check-dist.sh` (production bundle: no E2E shim, no eval/WebAssembly, no inline
or remote scripts, `_headers` identical), `scripts/check-prod.sh` (served headers and no edge-injected
scripts), `src/ui/errors.docs.test.ts` (code registry ↔ `docs/errors.md` ↔ UI copy parity).

## Conventions

- Error codes come only from `src/engine/errors.ts`; use `errorCode(e)` to read a code off anything
  thrown. New code → add it to the registry, `describeError` / `WARNING_COPY`, and `docs/errors.md`
  (the parity test tells you what is missing).
- Engine tests are parity tests against git's own output in `fixtures/*/expected`; add a fixture step
  in `scripts/make-fixtures.sh` rather than hand-writing expectations.
- Exports: a symbol is exported only when another module (or a test) imports it. Constants that
  document a limit stay module-private with a comment. Component prop interfaces may stay exported.
- Commits: Conventional Commits with the task id, e.g. `feat(T7.5): ...`; every task adds a
  `docs/CHANGELOG.md` entry and updates the board in `START.md`.
- Dead-code check: `bunx knip@5 --config <cfg>` with entries `src/main.tsx`, the two workers,
  `scripts/*.ts`, `e2e/*.ts`, tests and `src/test/*.ts` (T7.5 ran it; see the changelog).
