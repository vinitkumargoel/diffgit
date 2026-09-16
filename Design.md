# diffgoel — Design spec (approved direction A "Classic")

**Status:** Approved by the owner on 2026-09-16 from three mocked directions (artifact `36d3fa56-a90f-4e69-8646-d8e6ddfa3974` v1, section A). This file is the **only** visual reference for implementation agents. Do not borrow from the other two directions; do not restyle.

**Relationship to other files:** `Plan.md` §6 says *what* the UI contains; this file says *how it looks and behaves visually*. Where the two differ on appearance, this file wins. Task files under `tasks/phase-4-app-shell/` and `tasks/phase-5-diff-ui/` cite the sections below by number (`Design §n`).

---

## 1. Direction in one paragraph

GitHub's pull-request "Files changed" tab, one to one. Light and dark, neutral grey scale with a single blue accent, two-row control bar, collapsible file tree on the left, every file as a bordered card stacked in path order, unified diff by default. Nothing decorative: every colour encodes a state (added / removed / modified / renamed / staged / unstaged / untracked / viewed) and every control is where a GitHub user expects it. If a choice is not covered here, do what github.com does.

## 2. Principles (apply to every screen)

1. **Colour is never the only signal.** Every status has a letter (`A M D R T`), every chip has a word, every dot has a label.
2. **Density of a code tool, not a marketing page.** Base type 13 px, diff type 12 px, row heights 24–28 px. No hero sections, no large empty margins.
3. **Sticky context.** The top bar and each file card header stay visible while the diff scrolls.
4. **Quiet chrome, loud diff.** Chrome uses greys and one accent; the diff body owns green and red.
5. **Both themes are first-class.** Every colour is a token defined for light and dark. No literal colours in components.

## 3. Colour tokens

Define in `src/index.css` as CSS custom properties on `:root`, redefined under `.dark` (class on `<html>`, set by the theme toggle; default follows `prefers-color-scheme`). Expose to Tailwind v4 through `@theme` so utilities like `bg-surface`, `text-muted`, `border-line` exist.

### 3.1 Neutrals and accent

| Token | Role | Light | Dark |
|---|---|---|---|
| `--bg` | page ground (behind cards, sidebar tree, top bar row 2) | `#f6f8fa` | `#0d1117` |
| `--surface` | cards, top bar row 1, sidebar, popovers | `#ffffff` | `#161b22` |
| `--surface-raised` | card headers, hover rows, segmented-control track | `#f6f8fa` | `#1c2129` |
| `--line` | all borders and dividers | `#d0d7de` | `#30363d` |
| `--ink` | primary text | `#1f2328` | `#e6edf3` |
| `--muted` | secondary text, labels, icons at rest | `#656d76` | `#8d96a0` |
| `--accent` | links, active segment, focus ring, active row bar | `#0969da` | `#4493f8` |
| `--accent-subtle` | active row background, hunk header background, `default` badge background | `#ddf4ff` | `#121d2f` |
| `--success` | `+n`, HEAD badge, staged chip, refresh "Live" dot, primary button | `#1a7f37` | `#3fb950` |
| `--danger` | `−n`, deleted status, conflict chip, error text | `#cf222e` | `#f85149` |
| `--attention` | warning banner text/icon, modified status, unstaged chip, "Polling" dot | `#9a6700` | `#d29922` |
| `--done` | renamed status, untracked chip, typechange status | `#8250df` | `#a371f7` |

### 3.2 Diff colours (from Plan §6.4, extended)

| Token | Role | Light | Dark |
|---|---|---|---|
| `--diff-add-bg` | added line background | `#dafbe1` | `#12261e` |
| `--diff-add-num` | added line gutter background | `#aceebb` | `#1b4d2b` |
| `--diff-add-word` | word-level highlight inside added line | `#abf2bc` | `#2ea04366` (alpha) |
| `--diff-del-bg` | removed line background | `#ffebe9` | `#25171c` |
| `--diff-del-num` | removed line gutter background | `#ffcecb` | `#5d2426` |
| `--diff-del-word` | word-level highlight inside removed line | `#ff818266` (alpha) | `#f8514966` (alpha) |
| `--diff-hunk-bg` | hunk header row | `#ddf4ff` | `#121d2f` |
| `--diff-hunk-ink` | hunk header text | `#57606a` | `#8d96a0` |
| `--diff-ctx-num` | context line gutter background | `#f6f8fa` | `#161b22` |
| `--diff-empty` | split view placeholder cell (hatched) | `repeating-linear-gradient(-45deg, transparent 0 6px, #eaeef2 6px 7px)` | `repeating-linear-gradient(-45deg, transparent 0 6px, #1c2129 6px 7px)` |

Text on add/del backgrounds is `--ink`; measured contrast ≥ 4.5:1 in both themes (T5.6 verifies).

### 3.3 Status and chip palettes

Each is a `bg` / `fg` pair (light → dark). Border of a chip = its `fg` at 40 % alpha.

| Key | Meaning | Light bg / fg | Dark bg / fg |
|---|---|---|---|
| `M` | modified | `#fff8c5` / `#9a6700` | `#2d2a16` / `#d29922` |
| `A` | added | `#dafbe1` / `#1a7f37` | `#12261e` / `#3fb950` |
| `D` | deleted | `#ffebe9` / `#cf222e` | `#25171c` / `#f85149` |
| `R` | renamed | `#ddf4ff` / `#0969da` | `#121d2f` / `#58a6ff` |
| `T` | typechange | `#fbefff` / `#8250df` | `#271e3a` / `#a371f7` |
| chip `staged` | | `#dafbe1` / `#1a7f37` | `#12261e` / `#3fb950` |
| chip `unstaged` | | `#fff8c5` / `#9a6700` | `#2d2a16` / `#d29922` |
| chip `untracked` | | `#fbefff` / `#6639ba` | `#271e3a` / `#a371f7` |
| chip `conflict` | | `#ffebe9` / `#cf222e` | `#25171c` / `#f85149` |
| chip `generated` | | `#f6f8fa` / `#656d76` | `#1c2129` / `#8d96a0` |
| badge `HEAD` | on compare picker | `#dafbe1` / `#1a7f37`, border `#4ac26b` | `#12261e` / `#3fb950` |
| badge `default` | on base picker | `#ddf4ff` / `#0969da`, border `#54aeff` | `#121d2f` / `#58a6ff` |
| badge `remote` | on remote-tracking entries | `#f6f8fa` / `#656d76` | `#1c2129` / `#8d96a0` |

### 3.4 Banners

| Level | Background | Border | Icon/text |
|---|---|---|---|
| warning (default for most codes) | light `#fff8c5`, dark `#272115` | light `#d4a72c`, dark `#9e6a03` | `--attention`, message in `--ink` |
| info (`WORKTREE_NOT_APPLICABLE`) | `--accent-subtle` | light `#54aeff`, dark `#1f6feb` | `--accent` |
| error (`SPLIT_INDEX`, `INDEX_TOO_LARGE`) | light `#ffebe9`, dark `#25171c` | light `#ff8182`, dark `#8e1519` | `--danger` |

### 3.5 Syntax highlighting

Shiki themes `github-light` and `github-dark` (bundled, no network; T5.0 confirms the loader). No custom token colours.

## 4. Typography

| Role | Stack | Size / line height | Weight |
|---|---|---|---|
| UI text | `-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif` | 13 px / 20 px | 400; labels 500; repo name and "Files changed" 600 |
| Small UI (chips, badges, kbd hints, captions) | same | 11–12 px / 16 px | 500; badges 600 |
| Code, paths, branch names, `+n −m` | `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace` | diff body 12 px / 20 px; paths 12 px; picker text 12 px | 400; file basename and card path 600 |

No web fonts are loaded (CSP `connect-src 'none'`, and the app must work offline). All numbers use `font-variant-numeric: tabular-nums`.

## 5. Spacing, radii, elevation

- Spacing scale: 4 / 8 / 12 / 16 px. Card gap 16 px. Pane padding 16 px.
- Radius: controls and cards 6 px; chips and badges 999 px; status squares 4 px; checkboxes 3 px.
- Borders: 1 px `--line` everywhere. No shadows except popovers (`0 8px 24px rgba(140,149,159,.2)` light, `0 8px 24px #010409` dark).
- Focus ring: `outline: 2px solid var(--accent); outline-offset: 1px` on `:focus-visible` only.
- Icons: `lucide-react`, 16 px in the top bar and card headers, 14 px inside buttons and rows, colour `--muted` at rest and `--ink` on hover. Tree folder icon 14 px `--muted`.

## 6. Layout (repo screen)

Optimised for ≥ 1024 px wide; usable down to 900 px (sidebar collapses to an overlay toggled from the top bar below 900 px, out of scope for v1 polish).

```
┌ TopBar row 1 (44 px, --surface) ───────────────────────────────────────────┐
│ ▣ repo   base: [main ▾ default] ← compare: [feat/x ▾ HEAD] ⇄  ☑ Include…   ↻ Refresh ● Live  ☼ │
├ TopBar row 2 (40 px, --surface) ───────────────────────────────────────────┤
│ 11 files changed · +576 −131 │ 3 / 11 viewed ▬▬▬  …  [🔍 Filter files… /] [Unified|Split] [␣] │
├ WarningBanners (36 px each, stack) ────────────────────────────────────────┤
├ Sidebar 300 px (--surface, right border) ┬ DiffPane (--bg, scrolls) ──────┤
│ Files changed (11)      [Tree|Flat]      │ ┌ FileCard ────────────────────┐ │
│ ▾ 📁 src/engine/git                      │ │ ▾ M src/engine/git/worktree.ts│ │
│     M worktree.ts  unstaged  +142 −18 ☐  │ │ @@ hunk header               │ │
│     …                                    │ │ diff rows                    │ │
└──────────────────────────────────────────┴───────────────────────────────┘
```

- The whole app is `height: 100dvh`, column flex; only the sidebar tree and the diff pane scroll (independently).
- Sidebar: default 300 px, resizable 220–480 px by a 4 px drag handle on its right edge; width persisted (T5.2).
- Diff pane: cards are full width of the pane minus 16 px padding; no max width.

## 7. Components

Names match Plan §6.2 and the task files. Sizes are the rendered values, not Tailwind class names.

### 7.1 TopBar row 1 (T5.1)

Left to right, 8 px gap, vertically centred:

1. **Repo name**: `lucide:book-marked` 16 px + name, 14 px / 600. Not a button.
2. `base:` label (`--muted`, 12 px) then **BranchPicker** trigger; `←` glyph (`--muted`, `title="Shows what compare adds on top of base"`); `compare:` label then the second trigger.
3. **SwapButton**: 28 × 28 px bordered button with `⇄` (`lucide:arrow-left-right`). Disabled state at 50 % opacity when source === target.
4. 1 px vertical divider, 20 px tall.
5. **IncludeWorktreeToggle**: native-looking checkbox (14 px, checked = `--accent` fill with white tick) + "Include uncommitted changes". Disabled: 50 % opacity, tooltip from T5.1.
6. Spacer.
7. **RefreshControl**: bordered button, `lucide:refresh-cw` 14 px + "Refresh" + 8 px status dot + word. Dot/word: `--success` "Live", `--attention` "Polling", `--muted` "Manual". Spinner replaces the icon while busy. Tooltip "Last refreshed 12 s ago".
8. **Theme toggle**: 28 × 28 px bordered icon button, `lucide:sun` / `lucide:moon`.

**BranchPicker trigger**: bordered, `--bg` fill, 6 px radius, 4 px 8 px padding, `min-width: 170px` (prevents layout shift), monospace 12 px / 500 branch name, then badge(s) (`HEAD`, `default`, `remote`), then `▾` caret pushed right (`--muted`, 10 px). Popover: `--surface`, `--line` border, popover shadow, 320 px wide, search input on top (auto-focused, placeholder "Find a branch…"), then groups "Local" / "Remote: origin" / other remotes as 11 px uppercase `--muted` group headers; rows 28 px, monospace, current selection with a `lucide:check` on the left, keyboard highlight uses `--surface-raised`. Synthetic `HEAD (detached @ 3f9a1c2)` row pinned first when present.

### 7.2 TopBar row 2 (T5.1)

Left: **summary** `11 files changed` (600) `·` `+576` (`--success` 600) `−131` (`--danger` 600), 12 px. Divider. **ViewedCounter**: `3 / 11 viewed` (`--muted`, tabular) + 80 × 6 px progress bar (`#e7ecf0` light / `#21262d` dark track, `--success` fill, 3 px radius). Spacer. **FileFilter**: bordered input 240 px, `lucide:search` 13 px, placeholder "Filter files…", `/` kbd hint on the right (10 px monospace, bordered), clear `×` appears when non-empty; below the input nothing, but the sidebar header shows "n of m files" while a filter is active. **ViewControls**: segmented control (bordered, 6 px radius, 4 px 10 px padding per segment) `Unified | Split`, active segment `--surface` fill with 1 px inset `--accent` ring and `--accent` text; then a 28 × 28 px icon button for whitespace (`lucide:space` or the `␣` glyph, tooltip "Ignore whitespace", pressed state uses the same active treatment).

### 7.3 WarningBanners (T5.5)

Full width, 8 px 16 px padding, 12.5 px text, icon (`lucide:triangle-alert` / `info` / `circle-x`, 14 px) then bold subject then message, dismiss `×` on the right (`--muted`). One row per warning code, stacked, each independently dismissible. Colours in §3.4.

### 7.4 Sidebar (T5.2)

- Header 36 px: "Files changed" 600 12 px + `(11)` `--muted`; right: `Tree | Flat` mini segmented control (2 px 7 px padding, 11 px).
- Tree: 6 px vertical padding; indent 14 px per level starting at 12 px. Folder rows 24 px: `▾`/`▸` 9 px, `lucide:folder` 14 px `--muted`, name 12 px `--muted`; compacted chains render as one row `src/engine/git`.
- **FileRow** 26 px, 7 px gap: status square 16 × 16 px (§3.3, letter 10 px / 700 monospace) → basename 12.5 px / 500 (tree) or `dir/` `--muted` + basename 500 (flat) with `text-overflow: ellipsis` → layer chips (11 px, 0 6px padding, 999 px radius) → `+n −m` monospace 11 px, `—` for binary, 32 px skeleton bar while stats load → viewed checkbox 14 px (tick `--success`).
- Active row: `--accent-subtle` background + `box-shadow: inset 2px 0 0 var(--accent)`. Hover: `--surface-raised`. Viewed row: 55 % opacity. Keyboard focus: focus ring on the row.
- Flat mode: same row, full path with directory in `--muted`.

### 7.5 FileCard (T5.3)

- Container: `--surface`, 1 px `--line`, 6 px radius, `overflow: hidden`.
- **FileHeader** sticky (`top: 0` inside the scrolling pane, `z-index: 1`): `--surface-raised` background, bottom border, 8 px 12 px padding, 10 px gap, 12 px text. Order: collapse chevron (`--muted`, 10 px) → status square → path in monospace 600 with directory portion at 400 / 70 % opacity; renames `old → new (87%)` with arrow and percentage in `--muted`; typechange text after the path → mode change `100644 → 100755` monospace 11 px `--muted` → `+n −m` → layer/generated chips → right group: copy-path icon button (`lucide:copy`), `⇕ Expand all` small bordered button (2 px 6 px, 11 px), `Viewed` checkbox + label.
- Checking Viewed collapses the body (header only) and dims the sidebar row; unchecking restores it.
- `generated` cards start collapsed with a centred notice "Generated file, click to expand · 245 lines changed" (28 px padding, `--muted`, 13 px).
- Error boundary body: same notice style, `--danger` icon, "Couldn't render this diff" + `[Retry]` `[View raw]` small bordered buttons.
- **LoadingSkeleton**: 6 rows of 14 px `--surface-raised` bars at 60/80/40/90/70/50 % width, 8 px gap, 12 px padding, no animation when `prefers-reduced-motion`.

### 7.6 DiffBody (T5.3, renderer per ADR-001)

Whatever the renderer, style it to this:

- Table, `table-layout: fixed`, monospace 12 px / 20 px. Unified columns: old no. 46 px, new no. 46 px, sign 22 px, code auto. Split: per side no. 44 px, sign 22 px, code auto, 1 px `--line` between sides.
- Gutter numbers right-aligned, 8 px right padding, `--muted`; on add/del rows the gutter uses `--diff-add-num` / `--diff-del-num` and `--ink` text.
- Row backgrounds per §3.2; context rows transparent. Sign column shows `+` / `−` / blank.
- Code cell `white-space: pre`, horizontal overflow scrolls the card body (wrapping is a per-file toggle, off by default).
- Hunk header row: `--diff-hunk-bg`, `--diff-hunk-ink`, 6 px 12 px padding, 11.5 px; left group of three 18 × 18 px bordered mini-buttons `↑` `↓` `all` (`lucide:chevron-up`, `chevron-down`, `unfold-vertical`) then the `@@ -a,b +c,d @@ …` text. Expand-all-context in the header removes hunk rows for that file.
- Word-level highlights use `--diff-add-word` / `--diff-del-word` with 2 px radius.
- "Whitespace changes only" body: centred notice with a link "Show them".

### 7.7 Notices (T5.4)

All notices share: 28 px padding, centred, 13 px `--muted`, optional bordered button below with 8 px gap.

- **ImageDiff**: two columns, 16 px gap and padding; each pane bordered 6 px radius on a 16 px checkerboard (`repeating-conic-gradient(#eef1f4 0 25%, #fff 0 50%)`, dark `#161b22` / `#0d1117`), image centred with `max-height: 480px`, caption `512 × 512 · 18.2 KB` 12 px `--muted`. Old pane border `--diff-del-num`, new pane border `--diff-add-num`. Added/deleted: single pane.
- **BinaryNotice**: "Binary file not shown" + sizes + `View as text` button when < 1 MB.
- **LargeFileGate**: "Large diff (3,412 lines changed)." + `Load diff` button; > 10 MB: "Diff too large to display" + sizes, no button.
- **SubmoduleNotice**: monospace `Subproject commit abc123 → def456`.
- **TypechangeNotice**: one-line banner-style row at the top of the body, `--accent-subtle`, "Symlink → regular file".

### 7.8 Home, loading, empty, error screens (T4.4, T5.5)

Same tokens, centred column `max-width: 560px`, 15 px body text, 24 px gaps.

- **HomeScreen**: `lucide:book-marked` 32 px + "diffgoel" 24 px / 600; one-paragraph privacy statement in `--muted`; primary button "Open repository" (`--success` fill, white text, 6 px radius, 8 px 16 px, 14 px / 500; `lucide:folder-open` 16 px); then **RecentRepoList** as a bordered list (`--surface`, 6 px radius): rows 44 px with `lucide:folder-git-2`, name 500, "opened 3 h ago" `--muted` 12 px, `×` remove on hover/focus. Denied state shows an inline `--danger` line "Permission denied. Try again" under the row.
- **BrowserGate**: same column; `lucide:monitor-x` 32 px; "This browser can't open local folders"; list of supported browsers as plain text; privacy line.
- **LoadingScreen**: repo name, four phases as a vertical list (`lucide:circle-check` `--success` done, spinner current, `lucide:circle` `--muted` pending) with counts `Scanning working tree 1,240 / 5,000` tabular; `Cancel` bordered button.
- **EmptyState** (replaces the pane; sidebar hidden): `lucide:git-compare` 32 px `--muted`; "No changes between `feat/x` and `main`" with branch names in monospace; "Working tree is clean" line when applicable; secondary bordered button "Change base".
- **ErrorScreen**: `lucide:circle-x` 32 px `--danger`; title from `describeError`; hint text `--muted`; buttons per T5.5 (bordered; the primary action uses `--success` fill).
- **Toasts**: bottom-right, `--surface`, `--line` border, popover shadow, 6 px radius, 12 px 16 px, 13 px; `Retry` link in `--accent`; auto-dismiss 8 s.

### 7.9 HelpDialog (T5.6)

Modal 520 px, `--surface`, popover shadow, 12 px radius, title "Keyboard shortcuts" 16 px / 600, two-column table of `kbd` + description (kbd: monospace 11 px, bordered, `--bg` fill, 3 px radius), then a "Privacy" section with the three sentences: read-only folder access, nothing leaves the browser, no analytics. Backdrop `rgba(1,4,9,.5)`.

## 8. States and interaction

| State | Treatment |
|---|---|
| Hover (buttons, rows) | background `--surface-raised`; icon colour `--ink` |
| Active/pressed segment | `--surface` fill, inset 1 px `--accent` ring, `--accent` text |
| Disabled | 50 % opacity, `cursor: not-allowed`, tooltip explains why |
| Focus | focus ring (§5) on `:focus-visible` only |
| Busy | `lucide:loader-circle` spinning 1 s linear; no skeleton shimmer |
| Viewed | row 55 % opacity; card collapsed |
| Selection in diff | native selection limited to the code column (`user-select: none` on gutters and signs) |

Motion: none beyond the spinner and a 120 ms opacity/height transition on card collapse; both removed under `prefers-reduced-motion`.

## 9. Accessibility (T5.6 enforces)

- Contrast ≥ 4.5:1 for all text, including `--muted` on `--bg` and `--ink` on diff backgrounds, in both themes.
- Status squares and chips carry `aria-label` (`Modified`, `Added`, `Staged change`…).
- Sidebar rows use roving `tabindex`; the tree exposes `role="tree"`/`treeitem`.
- The refresh dot's meaning is in the adjacent word and tooltip, never the colour alone.
- `aria-live="polite"` region announces "Diff updated: n files".
- Skip link "Skip to diff" as the first focusable element.

## 10. Do / don't

- **Do** use tokens from §3 only. A literal colour in `src/ui/**` fails review.
- **Do** keep the two-row top bar; do not merge rows or move controls to a status bar.
- **Do** keep unified as the default view and the tree as the default sidebar mode.
- **Don't** add a dark-only or light-only component; every component renders in both themes.
- **Don't** add a web font, a shadow on cards, gradients, or rounded pills for buttons.
- **Don't** introduce a third accent hue. Green and red belong to the diff and to `+n −m`.

## 11. Implementation notes

- `src/index.css`: `@import "tailwindcss";` then `:root { … }` / `.dark { … }` token blocks from §3, then `@theme inline { --color-bg: var(--bg); … }` so Tailwind utilities read the runtime tokens (needed for the toggle to work without a rebuild).
- Theme toggle (T5.6) sets `document.documentElement.classList.toggle("dark")` and persists `prefs.theme` (`"system" | "light" | "dark"`); on `"system"` a `matchMedia("(prefers-color-scheme: dark)")` listener drives the class.
- `src/ui/components/StatusIcon.tsx`, `LayerChip.tsx`, `Badge.tsx` are small shared primitives created in T5.2 and reused by T5.1/T5.3; do not duplicate their styling.
- Icons come from `lucide-react` (added in Phase 5). Import icons individually.
- The diff renderer chosen in ADR-001 is themed via CSS variables in §3.2; if it exposes its own theme object, map it from the same variables rather than hard-coding hex values twice.
