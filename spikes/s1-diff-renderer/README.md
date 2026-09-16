# Spike S1 — diff renderer (T5.0)

Evidence for `docs/adr-001-diff-renderer.md`. Not part of the app build (own Vite root); not an E2E spec.

| File | Purpose |
|---|---|
| `cases.ts` | The three cases: 252-line TS with 6 hunks, 3,000-line file, 60 % rename; `window.__s1` measurement sink |
| `gdv.html` / `gdv.tsx` / `gdv.worker.ts` | `@git-diff-view/react` page; `DiffFile` computed in a Web Worker (Shiki via `@git-diff-view/shiki`), hydrated with `createInstance(data, bundle)` |
| `hunkText.ts` | `HunkModel` → unified patch text (the input `DiffFile` needs) |
| `rdv.html` / `rdv.tsx` | `react-diff-view` page fed by `HunkModel` from `src/ui/mock/mockContents.ts`; `markEdits`, `expandFromRawCode`, `Decoration` hunk headers |
| `hl.html` / `hl.ts` | Shiki 4 JS-engine cost (bundle, init, tokenise) |
| `spike.css` | Both renderers styled to Design §7.6 with §3.2 tokens (imports `src/index.css`) |
| `measure.ts` | Playwright runner: timings, rows, CSP violations, requests, expand-all, split toggle |
| `debug.ts`, `probe.ts` | Ad-hoc checks (word-level marks; `DiffFile` patch-format behaviour) |
| `lowlightStub.ts` | Size experiment: alias away `@git-diff-view/lowlight` (`S1_STUB_LOWLIGHT=1`) |

The rejected candidate's packages are not in `package.json` any more. To re-run:

```sh
bun add -d @git-diff-view/core@0.1.7 @git-diff-view/react@0.1.7 @git-diff-view/shiki@0.1.7
bunx vite build --config spikes/s1-diff-renderer/vite.config.ts
bunx vite preview --config spikes/s1-diff-renderer/vite.config.ts --port 4174 &
bun spikes/s1-diff-renderer/measure.ts
bun remove @git-diff-view/core @git-diff-view/react @git-diff-view/shiki
```
