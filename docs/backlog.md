# Backlog

Items deferred with a reason. T8.3 curates this list at the end of v1.

| # | Item | Why deferred | Source |
|---|---|---|---|
| B1 | `ObjectDb.mergeBase` maps isomorphic-git's `NotFoundError` to "no merge base" (→ `UNRELATED_HISTORIES`); a missing commit object in a corrupt or oddly-shallow repository would look the same. Distinguish by walking the reachable commits before declaring unrelated. | Needs a corrupt-repo fixture; the wrong message is a warning, not data loss. | T7.3 review |
| B2 | `RepoSession.applyDescription` mutates the shared `FileDiff` row in place from both `fileDiff()` and the stats pump; last writer wins. Add a per-file sequence guard if a field ever depends on the request options. | Both writers run under the same generation and write the same values; documented at the method. | T7.5 typescript review |
| B3 | `DiffPane` subscribes to the whole `collapsed` set and `stats` map for `estimateSize`, and every `StatsBatch` spreads `stats` into a new object, so the pane re-renders per batch. Read them via `getState()` inside `estimateSize` and coalesce batches per frame. | Measured budgets hold at 5k rows (`docs/perf.md`); optimisation without a visible symptom. | T7.5 react review |
| B4 | `FileRow` is not memoised and `FileTree` creates per-row closures each render. Memoise and pass stable per-id callbacks. | Same as B3: virtualised list keeps visible rows ≈ 40. | T7.5 react review |
| B5 | Toast auto-dismiss (8 s) does not pause on hover/focus (WCAG 2.2.1). Pause on `pointerenter`/focus-within. | Needs a design decision on sticky toasts with actions. | T7.5 react review |
| B6 | Sidebar resize handle is an `<hr>` with slider ARIA; use `<div role="separator">` for reliable AT exposure. | Cosmetic markup change; axe passes today. | T7.5 react review |
| B7 | `selectVisibleFiles` / `selectTreeModel` memoise in module-level singletons (correct only with one store instance). Scope the caches per selector factory. | One store by design; comment added. | T7.5 react review |
| B8 | `decodeText` decodes as UTF-8 with replacement characters; non-UTF-8 files (Latin-1, Shift-JIS) show U+FFFD instead of a warning. Consider a `working-tree-encoding` attribute or a heuristic warning. | git itself does not decode; matches `git diff` output for such files. | T7.5 typescript review |
| B9 | Remove `diff` and `@testing-library/user-event` from `package.json`: knip reports both unused (the engine ships its own Myers implementation). | Plan §0 pins the dependency list; owner decision. | T7.5 knip |
