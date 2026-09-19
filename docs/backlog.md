# Backlog

Items deferred from v1 with the reason, and the v2 candidates (T8.3). Sizes: S ≤ 1 day, M ≤ 1 week,
L more. Each v2 item names the abstraction that makes it possible.

## v2 candidates (T8.3)

| # | Item | Size | Enabled by | Rationale |
|---|---|---|---|---|
| V1 | `DiffSource` kinds `{kind:"commit", oid}` (single commit, `git show` semantics) and `{kind:"range", from, to}` (arbitrary refs / SHAs), plus a SHA input in the branch pickers. | M | `DiffSource` is already a discriminated union resolved in `DiffEngine.compute` (`resolveSourceRef`, merge-base step); a new kind adds a resolver and skips the merge base. | Most-requested PR-tool feature after branches; no engine rewrite. |
| V2 | Commit history panel: walk `readCommit` from the source with pagination, pick a range from it. | M | `ObjectDb` already reads commits for the merge base; the panel is a new sidebar tab using V1's range kind. | Turns the branch diff into a code-review tool for stacked work. |
| V3 | Per-path incremental recompute: the scheduler already passes `paths`; the engine re-scans only those and patches `DiffResult` instead of recomputing. | M | `Scheduler.request(reason, paths)` and `RepoSession.invalidate(scope, paths)` exist; needs a `patchResult` on `DiffEngine` and a generation-preserving payload. | Recompute is 29 ms on 50 changed files (`docs/perf.md`); this matters only above ~2k changed files. |
| V4 | Copy detection (`-C`). | S | `detectRenames` already computes spanhash similarity; copies add unmodified sources as candidates. | Rare in PR review; cheap once renames exist. |
| V5 | `core.autocrlf` and `.gitattributes` `text` / `eol` normalisation before diffing. | M | `GitAttributes.attributesFor(path)` returns the attributes; `describeFile` would normalise both sides before `lineKeys`. | Removes line-ending-only noise on Windows checkouts (today: `AUTOCRLF` banner + `-w`). |
| V6 | LFS pointer rendering ("LFS object, N bytes, oid …") instead of raw pointer text. | S | `FileDescription` classification already flags `LFS_PRESENT`; parse the pointer in `describeFile`. | Cosmetic; pointer text is readable today. |
| V7 | Multi-pack-index and reftable support. | L | Needs an own `.midx` / reftable reader or isomorphic-git upstream support; `ObjectDb` isolates the object store. | Both are rare in developer checkouts; currently a warning / refusal. |
| V8 | Firefox / Safari fallback: `webkitdirectory` upload of small repositories into a `MemoryFs`. | M | `MemoryFs` + `DirHandleLike` already back the E2E shim; the missing piece is a file-list → snapshot builder and a "no live refresh" mode. | Read-only, no handles → no refresh; acceptable for small repos. |
| V9 | Sharable read-only snapshot export: static HTML of the current diff (still no server). | M | `DiffResult` + `FileDiffPayload` are plain JSON; a renderer-only bundle with the data inlined. | Lets a reviewer share a diff without pushing. |
| V10 | Debug metrics panel (`/#debug`) → opt-in perf trace export (JSON of `EngineMetrics` + `performance` marks). | S | `store.debugMetrics()` and the `diffgit:*` marks exist. | Makes T8.2-style smoke numbers reproducible by users. |

## Deferred from v1 (with the review that raised them)

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
| B10 | Settings toggle for the built-in excludes (`.DS_Store`, `._*`, `Thumbs.db`, `desktop.ini`). **Engine side done in T10.4**: `OpenOptions.builtinExcludes` reaches `IgnoreRules` through `WorkerClient.open` / `RepoSession.open`, and `explainPath` names `(built-in excludes)` as the source. The UI preference is T11.4. | The wire is in place; only the checkbox and the `Prefs` key are left. | T8.1, engine T10.4, UI T11.4 |
