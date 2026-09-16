# Changelog

Entries are per task (3–6 lines: what, notable decisions, follow-ups). Newest first.

## Follow-ups

_(none yet)_

---

## T0.1 — Repo & toolchain

- Bun project with Vite 7.3.6, React 19.3.0, TypeScript 5.9.3, Tailwind 4.3.3 (`@tailwindcss/vite`), Biome 2.5.14, vitest 4.1.11 + happy-dom 20.14.5; all versions pinned exactly (no `^`).
- Solution-style tsconfig: `tsconfig.ui.json` (DOM), `tsconfig.engine.json` (WebWorker only, excludes tests and `nodeDirHandle.ts`), `tsconfig.node.json` (bun types; scripts, tests, vite/playwright config). Verified: `document` in `src/engine` fails `tsc -b`; `importScripts` in `src/ui` fails; `self.postMessage` passes in the engine (note: it also type-checks under DOM because `Window.postMessage` exists, so the UI-side guard is demonstrated with a worker-only global).
- `src/engine/errors.ts` canonical registry (`FS_CODES`, `PUBLIC_CODES`, `INTERNAL_CODES`, `WARNING_CODES`, `EngineError`, `fsError`), `src/engine/types.ts` from Plan §4 + amendments (`sourceRef/targetRef`, `generation`, `RefSnapshot`, `synthetic`, `generated`), `src/engine/diffSource.ts` implemented (pure, tiny) rather than stubbed so the UI track can use it before T1.4 tests it.
- `vite.config.ts` parses `public/_headers` into `preview.headers` (production CSP under `vite preview`); worker format `es`, build target `es2022`; vitest scoped to `src/ui/**`, `bun test` to `src/engine` + `src/test`.
- `scripts/check-guards.sh` starts the grep guards (engine must not import react/ui); later tasks append theirs. `PATH_TYPE_CHANGED` added to `WARNING_CODES` because T2.4 emits it.
- Decision: Vite 7 (per Plan §7) with `@vitejs/plugin-react` 5.2.0 (6.x requires Vite 8); vitest 4.1.11 (5.x targets Vite 8 too).
