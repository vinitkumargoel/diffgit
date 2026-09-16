# ADR-001 — Diff renderer for the file card body

**Status:** accepted (T5.0, 2026-09-16) · **Deciders:** ui-agent · **Supersedes:** Plan §7 stack row "Diff render" and §1 finding 5

## Context

Plan §11 S1 asked us to choose, with evidence, between `@git-diff-view/react` (+ `@git-diff-view/core`,
`@git-diff-view/shiki`, all 0.1.7) and `react-diff-view` 3.3.3 fed by our own `HunkModel`
(`src/engine/api.ts`). Inputs to the decision (task T5.0 and its amendments): expand context must work,
worker mode must work, added bundle < 250 kB gzip, the production CSP from `public/_headers` must hold
(`connect-src 'none'`, no `unsafe-eval`, no network at all), and the body must be styleable to Design §7.6
with §3.2 tokens and Design §3.5 Shiki themes.

The spike lives in `spikes/s1-diff-renderer/` (own Vite root, never part of the app bundle). Two pages
render the same three cases: (1) a 252-line TypeScript file with 6 hunks, (2) a 3,000-line file with
2,800 changed lines, (3) a 60-line rename with 60 % similarity. A third page measures the Shiki 4
JavaScript-engine cost. All numbers below come from `vite build` output (gzip) and from headless
Chromium 153 driven by Playwright 1.63 against `vite preview` serving the production headers
(`spikes/s1-diff-renderer/measure.ts`). Render time is measured from the React state update that hands
the renderer its data to the second `requestAnimationFrame` after it, one card mounted at a time.

## Findings

### Feature checks

| | `@git-diff-view/react` 0.1.7 | `react-diff-view` 3.3.3 + `HunkModel` |
|---|---|---|
| Diff from two strings | **No.** `DiffFile` consumes a unified patch; `generateDiffFile` lives in `@git-diff-view/file` (adds jsdiff). We would serialise `HunkModel` → patch text. Per-hunk strings without `---`/`+++` headers parse to zero changes (see `probe.ts`). | Direct: `HunkModel.hunks` → `HunkData[]` (13-line mapper, `hunkText.ts` shows the inverse). |
| Unified / split toggle | Yes (`diffViewMode`). | Yes (`viewType`). |
| Word-level diff | Yes (fast-diff; 90 marks in case 1). | Yes (`markEdits`, block mode; 12 marks in case 1). |
| Expand context up / down / all | Yes: `onUnifiedHunkExpand(dir, index)`, `onSplitHunkExpand`, `onAllExpand(mode)`. Case 1: 79 → 257 rows. | Yes: `expandFromRawCode(hunks, oldText, start, end)` with `FileDiffPayload.oldText`. Case 1: 78 → 258 rows. |
| Whitespace-ignore | No option; engine pre-filters (`FileDiffOptions.ignoreWhitespace`). | Same. |
| Web Worker mode | Yes: `getBundle()` → `DiffFile.createInstance(data, bundle)`. Bundle is 128 kB of JSON for case 1 and the main thread still needs both full texts for expand. | Not applicable: the engine worker already returns `HunkModel`; highlighting runs in a UI-owned worker. |
| Bundled grammars, no network, CSP clean | Yes via `@git-diff-view/shiki` (nested `shiki@3.23`, JS regex engine). 0 CSP violations, 44 same-origin requests (lazy grammar chunks), 0 foreign hosts. | Yes with Shiki 4 (`@shikijs/core` + `@shikijs/engine-javascript`, lazy `@shikijs/langs/*`). 0 CSP violations, 6 same-origin requests, 0 foreign hosts. |
| Theme from CSS variables (Design §11) | **With overrides.** Colours are inline `style="background-color: var(--diff-del-content--)"`; 21 declarations in `spike.css` remap them to our `--diff-*` tokens. | **Yes.** Class-based markup (`diff-gutter`, `diff-code-insert`, …); we ship our own stylesheet, its 4 kB default CSS is optional. |
| Can match Design §7.6 without forking the renderer's CSS | **With overrides, fragile:** gutters are sticky `w-[1%] min-w-[100px]` Tailwind utilities, content indent `pl-[2.0em]`, hunk rows carry the library's own buttons and icons. Hitting 46/46/22 px means overriding utility classes by specificity. | **Yes:** `table-layout: fixed` + column widths are ours; hunk header is a `Decoration` render prop, so the `↑ ↓ all` mini-buttons are our markup. |
| React 19 | Works. | Works (peer `react >= 16.14`). |
| API stability | 0.1.x; `DiffView` reads `_`-prefixed internals of `DiffFile`. | 3.x since 2018. |

### Size (gzip, `vite build`, target es2022; the shared React 19 chunk ≈ 70 kB is excluded)

| | `@git-diff-view/react` | `react-diff-view` |
|---|---|---|
| Main-thread JS | **341.6 kB** (1,113.9 kB raw). ≈ 300 kB of it is `@git-diff-view/lowlight` → `lowlight(all)` (every highlight.js grammar), imported eagerly by `DiffView`. | **23.2 kB** (68.5 kB raw) |
| Main-thread JS with `@git-diff-view/lowlight` aliased to a stub (`S1_STUB_LOWLIGHT=1`, unsupported) | 39.7 kB | — |
| CSS | 3.2 kB (`diff-view-pure.css`) | 0.8 kB (ours replaces it) |
| Worker JS | 380.6 kB (core + `@git-diff-view/shiki` + nested shiki 3) + 300 lazy grammar chunks (12 MB on disk) | — |
| Highlighting stack we would add anyway | second Shiki major if the app also uses Shiki 4 | Shiki 4 core + JS engine + 2 themes: **55.1 kB**; TypeScript grammar 16.0 kB; each theme 2.5 kB |

### Runtime (Chromium 153 headless, production build)

| | `@git-diff-view/react` | `react-diff-view` |
|---|---|---|
| Case 1 (252-line TS, 6 hunks) render | 48 ms, 80 rows | 54 ms, 78 rows |
| Case 2 (3,000 lines, 2,800 changed) render | **908 ms**, 5,609 rows | **414 ms**, 5,607 rows |
| Case 3 (rename 60 %) render | 86 ms, 53 rows | 53 ms, 52 rows |
| Unified → split, whole page (3 cards, ≈ 5,700 rows) | 2,039 ms | 905 ms |
| JS heap after all interactions | 117 MB | 51 MB |
| Data preparation | worker: 814 ms for case 1 including highlighter init (shiki 3 with 35 eager grammars), 26 ms for case 2 without highlighting | `HunkModel` → `HunkData` 0.9–3.7 ms (LCS from the mock engine) |
| Shiki 4 JS engine (`hl.html`) | — | init 24 ms; tokenise 252 lines of TS 245 ms on first call → must run in a worker |

Both renderers exceed the T5.3 target of < 500 ms for a 3,000-line diff when the file has 2,800
changed lines (5,600 rows); `react-diff-view` is under it, `@git-diff-view/react` is not. T3.4's
`tooLarge` classification (> 3,000 changed lines) already gates such files behind "Load diff", and T5.3
virtualises cards, so both would be usable; the numbers still favour `react-diff-view` by 2×.

## Decision

**`react-diff-view` 3.3.3 rendering our `HunkModel`**, with syntax highlighting from **Shiki 4 with the
JavaScript regex engine** (`@shikijs/core`, `@shikijs/engine-javascript`, lazy `@shikijs/langs/<id>`,
`@shikijs/themes/github-light` and `github-dark`) executed in a UI-owned Web Worker, and word-level
highlights from `markEdits`.

`@git-diff-view/react` fails the decision rule on size (341.6 kB > 250 kB gzip added). The stub-alias
variant that would pass (39.7 kB) relies on aliasing an internal transitive package and is not a
configuration the library supports. Independently of size it fits the architecture worse: it does not
diff two strings itself, so we would convert `HunkModel` to patch text only for it to parse it back;
its worker mode needs full file contents plus a 128 kB bundle on the main thread; it ships a second
Shiki major; and Design §7.6 gutters and hunk headers require fighting its Tailwind utilities.

## Consequences

- Runtime dependencies: `react-diff-view@3.3.3`, `@shikijs/core@4.4.3`, `@shikijs/engine-javascript@4.4.3`,
  `@shikijs/langs@4.4.3`, `@shikijs/themes@4.4.3` (all pinned). `@git-diff-view/*` and the `shiki`
  meta-package are removed; the spike's README says how to reinstall them to re-run it.
- Plan §7 stack row "Diff render" and Plan §1 finding 5 are superseded by this ADR. Plan §230 item 9
  ("diff happens in the worker via `@git-diff-view/core`") is already implemented by T3.4's own hunk
  model; nothing changes in `src/engine/**`.
- T5.3 renders `DiffBody` with `Diff`/`Hunk`/`Decoration`; the hunk header is our component (Design §7.6
  `↑ ↓ all` mini-buttons calling `expandFromRawCode` with `FileDiffPayload.oldText`). API notes are in
  `tasks/phase-5-diff-ui/T5.3-diff-pane-file-card.md` § Renderer.
- Highlighting is never done on the main thread: a `src/ui/highlight/highlight.worker.ts` owns the
  Shiki highlighter (created once, grammars imported on demand, both themes loaded) and returns
  react-diff-view token arrays. Grammars are same-origin Vite chunks, so the CSP stays as is. Languages
  without a grammar fall back to plain tokens; files above the `tooLarge` threshold skip highlighting.
- The renderer's default stylesheet is not imported; `src/index.css` styles `.diff`, `.diff-gutter`,
  `.diff-code*`, `.diff-hunk-header` with §3.2 tokens (the mapping used in `spike.css` is the starting point).

## Reproduce

```sh
bun add -d @git-diff-view/core@0.1.7 @git-diff-view/react@0.1.7 @git-diff-view/shiki@0.1.7   # rejected candidate
bunx vite build --config spikes/s1-diff-renderer/vite.config.ts
bunx vite preview --config spikes/s1-diff-renderer/vite.config.ts --port 4174 &
bun spikes/s1-diff-renderer/measure.ts            # timings, rows, CSP, requests → JSON
S1_STUB_LOWLIGHT=1 bunx vite build --config spikes/s1-diff-renderer/vite.config.ts   # size experiment only
```
