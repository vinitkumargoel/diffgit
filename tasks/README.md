# diffgoel — Task index for implementation agents

Source of truth: [`../Plan.md`](../Plan.md) for behaviour and [`../Design.md`](../Design.md) for appearance (approved direction A "Classic", 2026-09-16). Every task file cites the Plan sections it implements; UI task files also cite Design sections. Read those sections before starting; do not re-open decisions in Plan §0 or restyle away from Design.md.

## How to work a task

1. Read the task file top to bottom, then the cited Plan sections (§) and decisions (D#).
2. Check **Depends on** — every listed task must be merged. If not, stop and report.
3. Implement only what is in **Deliverables**. If you discover the task needs something outside its scope, write it in `docs/CHANGELOG.md` under "Follow-ups" and stop at the boundary.
4. Definition of done, for every task:
   - Code + tests in place, `bun run check` green (typecheck + Biome lint + `bun test` + `vitest` if UI touched).
   - A 3–6 line entry in `docs/CHANGELOG.md`: what, notable decisions, follow-ups.
   - Every acceptance criterion in the task file is ticked with evidence (test name or command output).
5. Never write to a user's repo. `FsaFs` write methods throw. This is invariant D16; a task that needs a write is a planning bug — report it.

## Conventions (apply to every task)

- TypeScript `strict: true`, no `any` without a comment, no default exports except React lazy chunks.
- `src/engine/**` must not import React, DOM APIs, or anything from `src/ui/**`. It runs in a Web Worker and in `bun test` via `DirHandleLike` (see T0.4).
- Errors thrown from the engine are `EngineError` subclasses with a stable `code` (`ENOENT`, `EROFS`, `UNSUPPORTED_LAYOUT`, `INDEX_UNSUPPORTED`, `PERMISSION`, `CANCELLED`, `TOO_LARGE`, ...). Never swallow errors; never `catch {}` without rethrow or explicit warning emission.
- Cross-worker data is plain JSON-able objects (no class instances, no `Map` in results; use arrays or records).
- Paths are POSIX-style, repo-relative, no leading `./`, no trailing `/`.
- Tests live next to the code as `*.test.ts` (bun) or `*.test.tsx` (vitest). Fixture repos come from `scripts/make-fixtures.sh` (T0.3) — never hand-craft `.git` directories in tests except for the byte-level index parser tests.
- Commit messages: Conventional Commits, scope = task id, e.g. `feat(T2.1): index reader v2/v3/v4`.
- UI code (`src/ui/**`) uses only the colour tokens in Design §3 (via Tailwind utilities mapped in `src/index.css`, or `var(--token)`); a literal hex/rgb colour in a component is a review failure. Sizes, spacing and placement follow Design §5–§7. Every component renders correctly in both themes.

## Task list and dependency graph

| ID | Task | Size | Depends on |
|----|------|------|------------|
| T0.1 | Repo & toolchain | S | — |
| T0.2 | Cloudflare Pages pipeline | S | T0.1 |
| T0.3 | Fixture builder | M | T0.1 |
| T0.4 | Test harness (DirHandleLike, Node/Memory handles, Playwright shim) | M | T0.1, T0.3 |
| T1.1 | FsaFs read-only adapter | M | T0.4 |
| T1.2 | Layout checks | S | T1.1 |
| T1.3 | ObjectDb (isomorphic-git wrapper) | M | T1.1 |
| T1.4 | RefStore | M | T1.3, T1.5 |
| T1.5 | Git config parser | S | T1.1 |
| T1.6 | Spike S2: read-only verification on real repos | S | T1.1–T1.4 |
| T2.1 | IndexReader | L | T1.1 |
| T2.2 | Blob hashing | S | T0.4 |
| T2.3 | Ignore rules | M | T1.1 |
| T2.4 | WorktreeScanner | L | T2.1, T2.2, T2.3, T1.3 |
| T3.1 | Tree diff | S | T1.3 |
| T3.2 | DiffEngine layering | L | T3.1, T2.4, T1.4 |
| T3.3 | Rename detection | M | T3.2, T2.2 |
| T3.4 | Binary detection, text diff, stats, content loading | M | T3.2 |
| T3.5 | RepoSession + worker entry | M | T3.3, T3.4, T1.2 |
| T4.1 | Worker client | S | T0.1 (mock worker until T3.5) |
| T4.2 | Store | S | T4.1 |
| T4.3 | Persistence | M | T4.2 |
| T4.4 | BrowserGate + HomeScreen | M | T4.3 |
| T5.0 | Spike S1: diff renderer decision | S | T0.1 |
| T5.1 | TopBar + BranchPicker | M | T4.2, T4.4 |
| T5.2 | Sidebar | M | T4.2 |
| T5.3 | DiffPane + FileCard | L | T5.0, T4.2 |
| T5.4 | ImageDiff, BinaryNotice, LargeFileGate | M | T5.3 |
| T5.5 | Empty / error / loading / warning states | S | T5.1, T5.2 |
| T5.6 | Theme, keyboard, help, a11y | M | T5.1–T5.5 |
| T6.0 | Spike S3: FileSystemObserver behaviour | S | T0.3 |
| T6.1 | Refresh scheduler | M | T3.5, T4.2 |
| T6.2 | FileSystemObserver wiring | M | T6.0, T6.1 |
| T6.3 | Polling fallback | M | T6.1 |
| T6.4 | Force refresh | S | T6.1 |
| T7.1 | E2E smoke suite (3 specs only) | M | T5.6, T6.3 |
| T7.2 | Performance pass | M | T7.1 |
| T7.3 | Error taxonomy review | M | T7.1 |
| T7.4 | Security review | S | T7.1 |
| T7.5 | Code review + simplification | M | T7.2–T7.4 |
| T8.1 | README | S | T7.5 |
| T8.2 | Deploy v1 | S | T8.1 |
| T8.3 | v2 backlog | S | T8.2 |

```
Phase 0 ──► Phase 1 ──► Phase 2 ──► Phase 3 ──┐
   │                                          ├──► Phase 6 ──► Phase 7 ──► Phase 8
   └──► Phase 4 ──► Phase 5 (S1) ─────────────┘
```

Two agent tracks can run in parallel after Phase 0: **engine** (1→2→3) and **UI** (4→5, against recorded `DiffResult` JSON from fixtures until T3.5 lands).

## Owner-only steps

- T0.2: `bunx wrangler login` is interactive; the owner runs it once.
- T1.6 and T8.2: need three real local repos on the owner's machine; the owner names them.

---

## Review round 1 amendments (supersede anything above or in a task file that contradicts them)

### Canonical error registry (owned by T0.1, file `src/engine/errors.ts`)
Two tiers. **Fs-tier** codes are Node-shaped because isomorphic-git branches on them and never leave the engine: `ENOENT`, `EISDIR`, `ENOTDIR`, `EINVAL`, `EROFS`, `EACCES`, `EIO`. **Public-tier** codes are the only ones that cross the worker boundary; `RepoSession` translates fs-tier → public-tier (`EACCES`→`PERMISSION`, `ENOENT` on the root→`HANDLE_GONE`, `EIO`→`IO_ERROR`, `EROFS`→`INTERNAL`):
`NOT_A_REPO`, `WORKTREE_GITDIR`, `BARE_REPO`, `REFTABLE`, `OBJECT_FORMAT_SHA256`, `ALTERNATES`, `PARTIAL_CLONE`, `PACK_TOO_LARGE`, `INDEX_UNSUPPORTED`, `PERMISSION`, `HANDLE_GONE`, `IO_ERROR`, `REF_NOT_FOUND`, `CANCELLED`, `STALE`, `TOO_LARGE`, `WORKER_CRASHED`, `STORAGE_UNAVAILABLE`, `INTERNAL`.
Warning codes (non-fatal, `RepoWarning.code`): `MULTI_PACK_INDEX`, `SHALLOW`, `LFS_PRESENT`, `AUTOCRLF`, `PACK_LARGE`, `INDEX_CHECKSUM`, `SPLIT_INDEX`, `SPARSE_INDEX`, `INDEX_TOO_LARGE`, `UNTRACKED_CAPPED`, `RENAME_LIMIT`, `FILE_TOO_LARGE`, `EMBEDDED_REPO`, `UNRELATED_HISTORIES`, `MULTIPLE_MERGE_BASES`, `WORKTREE_NOT_APPLICABLE`, `GLOBAL_EXCLUDES_UNAVAILABLE`, `CONFIG_INCLUDE_SKIPPED`, `STALE_PACK_RETRIED`, `REFRESH_DEGRADED`.
`errors.ts` exports `PUBLIC_CODES`, `WARNING_CODES` arrays; T4.1 and T5.5 tests iterate them. No task may invent a code outside this file.

### Test runners split by directory, not extension
`bun test` runs `src/engine/**`. vitest `include` is `src/ui/**/*.test.{ts,tsx}` only. Never import `bun:test` under `src/ui`.

### D16 lint guard (T0.4)
`bun run check` greps `src/` for `createWritable`, `removeEntry`, `.move(`, `create: true`, `"readwrite"` and fails on any hit. `FsaFs` throwing is a second line of defence; the raw handle in UI code must never be able to write either.

### Shared helper
`src/engine/diffSource.ts` (pure, no I/O): `isWorktreeSource(src: DiffSource, refs: RefSnapshot): boolean` and `defaultDiffSource(refs): DiffSource`. Both the engine (T3.2) and the store (T4.2) import it; no duplicated rule.

### `DiffSource` carries full ref names
`{ kind: "branches"; source: string; target: string; sourceRef: string; targetRef: string; includeWorktree: boolean }` where `*Ref` are `refs/heads/...` / `refs/remotes/...` or the literal `"HEAD"`. `"origin/main"` alone is ambiguous with a local branch of that name.

### Results carry a generation
`DiffResult.generation: number`. `fileDiff`, `fileStats`, `fileBytes` take `generation` and reject with `STALE` when it is not current. The store drops stale responses silently.

### UI vocabulary
The UI labels the pickers GitHub-style: `base: [target ▾] ← compare: [source ▾]`. Engine names stay `source`/`target`.

### Design approval (2026-09-16)
The owner approved direction A "Classic" from three mocks. `Design.md` is the visual contract for T4.4 and T5.0–T5.6; each of those task files carries a **Design refs** line and a "Design amendments" section that supersede any appearance detail in the task text or in Plan §6. Shared primitives `StatusIcon`, `LayerChip`, `Badge` are created in T5.2 and reused, not re-implemented.

### Start order
Before either agent track starts: T0.1 (with `errors.ts`, tsconfig references, preview headers), T0.3 (fixtures incl. the additions below), T0.4 (shim transport). Three phase groups independently depend on those gaps being closed.

### Parity scope
"Matches git" means file set, status, rename pairing (similarity ±5), and `numstat` lines. Hunk boundaries are **not** asserted against git (jsdiff's Myers differs from git's indent heuristic).

### E2E policy (keep implementation fast)
Playwright is limited to the **three smoke specs in T7.1**. Every other behaviour is tested in `bun test` (engine, parity with git on fixtures) or vitest (UI logic on recorded `DiffResult` JSON). No screenshot baselines, no Playwright perf spec, no per-feature browser tests. If a task's original text mentions a Playwright test outside T7.1, that mention is void.
