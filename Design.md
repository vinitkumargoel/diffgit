# diffgit — Design spec (direction "Precision")

**Status:** Direction A "Classic" was approved on 2026-09-16 and shipped. On 2026-09-18 the owner approved the **Precision** direction for the marketing site and asked for the product to be unified with it; the product name became **diffgit** (`diffgit.com`) and the brand mark became the diff-coloured branch (§12). Precision is a *tightening* of Classic, not a redesign: the layout, components, density and behaviour below are unchanged, and only the surfaces, hairlines, text colours and brand are restated. Later on 2026-09-18 the owner approved the **states review** (`docs/mockups/review-history-loading-stats-errors-gate.html`, 41 states H0–H6, L1–L6, S1–S8, E1–E7, B1–B6) in full; §7.2, §7.3, §7.8 and §13 below are restated from it and the state ids are cited so an implementation can be checked against the mockup. This file is the **only** visual reference for implementation agents. Do not restyle beyond it.

**Relationship to other files:** `Plan.md` §6 says *what* the UI contains; this file says *how it looks and behaves visually*. Where the two differ on appearance, this file wins. Task files under `tasks/phase-4-app-shell/` and `tasks/phase-5-diff-ui/` cite the sections below by number (`Design §n`).

---

## 1. Direction in one paragraph

GitHub's pull-request "Files changed" tab, one to one, drawn on paper-white (or true-black) ground with hairline rules instead of tonal blocks. Light and dark, neutral grey scale with a single blue accent and green as the brand hue, two-row control bar, collapsible file tree on the left, every file as a bordered card stacked in path order, unified diff by default. Structure is carried by 1 px lines and type weight, not by filled panels: the page ground and the card face are the same colour, and a card is legible because of its border. Nothing decorative: every colour encodes a state (added / removed / modified / renamed / staged / unstaged / untracked / viewed) and every control is where a GitHub user expects it. If a choice is not covered here, do what github.com does.

## 2. Principles (apply to every screen)

1. **Colour is never the only signal.** Every status has a letter (`A M D R T`), every chip has a word, every dot has a label.
2. **Density of a code tool.** Base type 13 px, diff type 12 px, row heights 24–28 px. No hero sections, no large empty margins, no illustrations. (The marketing site at `diffgit.com` is the one exception and has its own rules in §13; nothing from it leaks into the app.)
3. **Sticky context.** The top bar and each file card header stay visible while the diff scrolls.
4. **Quiet chrome, loud diff.** Chrome uses greys and one accent; the diff body owns green and red.
5. **Both themes are first-class.** Every colour is a token defined for light and dark. No literal colours in components.
6. **Separation by line, not by fill.** Prefer a 1 px `--line` border over a background change to separate two regions. `--surface-raised` is reserved for chrome that must recede (card headers, hover, segmented tracks); `--surface-sunken` for the one region that must sit *under* the content (the sidebar).

## 3. Colour tokens

`--bg` and `--surface` are deliberately the same colour in both themes: cards read as cards because of their `--line` border, not because of a tonal step. Define in `src/index.css` as CSS custom properties on `:root`, redefined under `.dark` (class on `<html>`, set by the theme toggle; default follows `prefers-color-scheme`). Expose to Tailwind v4 through `@theme` so utilities like `bg-surface`, `text-muted`, `border-line` exist.

### 3.1 Neutrals and accent

| Token | Role | Light | Dark |
|---|---|---|---|
| `--bg` | page ground (diff pane, behind cards) | `#ffffff` | `#0d1117` |
| `--surface` | cards, top bar row 2, popovers, dialogs, toasts | `#ffffff` | `#0d1117` |
| `--surface-sunken` | sidebar tree ground (the one region under the content) | `#fafbfc` | `#0b0f14` |
| `--surface-raised` | card headers, top bar row 1, hover rows, segmented-control track | `#f6f8fa` | `#161b22` |
| `--line` | borders of cards, controls, sidebar and panes | `#d0d7de` | `#30363d` |
| `--line-subtle` | dividers *inside* a surface (top bar row 1 → row 2, list separators) | `#e6e8eb` | `#21262d` |
| `--ink` | primary text | `#0b0c0e` | `#f0f3f6` |
| `--muted` | secondary text, labels, icons at rest | `#67707b` | `#8b949e` |
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
| `--diff-hunk-ink` | hunk header text | `#57606a` | `#8b949e` |
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
| chip `generated` | | `#f6f8fa` / `#67707b` | `#1c2129` / `#8b949e` |
| badge `HEAD` | on compare picker | `#dafbe1` / `#1a7f37`, border `#4ac26b` | `#12261e` / `#3fb950` |
| badge `default` | on base picker | `#ddf4ff` / `#0969da`, border `#54aeff` | `#121d2f` / `#58a6ff` |
| badge `remote` | on remote-tracking entries | `#f6f8fa` / `#67707b` | `#1c2129` / `#8b949e` |

**Layer code** (§7.4, T9.1): git's `status --short` XY columns as two monospace characters, 10 px / 600, 0.08 em tracking, in a 1 px `--line` box on `--surface` (3 px radius). The x column is `--chip-staged-fg`, the y column `--chip-unstaged-fg`; `?` is `--chip-untracked-fg`, `U` is `--chip-conflict-fg` and the empty column `·` is `--muted`. The glyphs are `aria-hidden`; the box carries the spelled-out label.

### 3.4 Banners

| Level | Background | Border | Icon/text |
|---|---|---|---|
| warning (default for most codes) | light `#fff8c5`, dark `#272115` | light `#d4a72c`, dark `#9e6a03` | `--attention`, message in `--ink` |
| info (`WORKTREE_NOT_APPLICABLE`) | `--accent-subtle` | light `#54aeff`, dark `#1f6feb` | `--accent` |
| error (`SPLIT_INDEX`, `INDEX_TOO_LARGE`) | light `#ffebe9`, dark `#25171c` | light `#ff8182`, dark `#8e1519` | `--danger` |

### 3.5 Syntax highlighting

Shiki themes `github-light` and `github-dark` (bundled, no network; T5.0 confirms the loader). No custom token colours.

### 3.6 Age heat ramp (added by T11.6)

One five-step ramp, oldest → newest, used by the blame gutter's 6 px age strip (§14.1 / atlas tab 02)
and by the Insights activity heatmap (§14.6). `--heat1` is the **oldest** bucket and `--heat5` the
newest, which is the direction the atlas mockup's own legend prints (`old → new`). The strip is
decorative: every row states its commit, author and age in text as well, so the ramp never carries
information on its own and needs no contrast ratio.

| Token | Light | Dark |
|---|---|---|
| `--heat1` | `#dafbe1` | `#12261e` |
| `--heat2` | `#aceebb` | `#1b4d2b` |
| `--heat3` | `#6fdd8b` | `#2ea043` |
| `--heat4` | `#2da44e` | `#3fb950` |
| `--heat5` | `#116329` | `#56d364` |

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
- Borders: 1 px `--line` for anything with an edge (cards, controls, panes); 1 px `--line-subtle` for a divider drawn inside one surface. No shadows except popovers, dialogs and toasts (`0 16px 40px -16px rgba(11,12,14,.24), 0 1px 2px rgba(11,12,14,.06)` light; `0 16px 40px -16px #010409, 0 1px 2px rgba(1,4,9,.6)` dark).
- Focus ring: `outline: 2px solid var(--accent); outline-offset: 1px` on `:focus-visible` only.
- Icons: `lucide-react`, 16 px in the top bar and card headers, 14 px inside buttons and rows, colour `--muted` at rest and `--ink` on hover. Tree folder icon 14 px `--muted`.

## 6. Layout (repo screen)

Optimised for ≥ 1024 px wide; usable down to 900 px (sidebar collapses to an overlay toggled from the top bar below 900 px, out of scope for v1 polish).

```
┌ TopBar row 1 (44 px, --surface-raised) ────────────────────────────────────┐
│ ▣ repo   base: [main ▾ default] ← compare: [feat/x ▾ HEAD] ⇄  ☑ Include…   ↻ Refresh ● Live  ☼ │
├ TopBar row 2 (40 px, --surface) ── divided from row 1 by --line-subtle ────┤
│ 11 files changed · +576 −131 │ 3 / 11 viewed ▬▬▬  …  [🔍 Filter files… /] [Unified|Split] [␣] │
├ WarningBanners (36 px each, stack) ────────────────────────────────────────┤
├ Sidebar 300 px (--surface-sunken, right border) ┬ DiffPane (--bg, scrolls)┤
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

Background `--surface-raised`, bottom border `--line-subtle`. Left to right, 8 px gap, vertically centred:

1. **Repo name**: `lucide:book-marked` 16 px + name, 14 px / 600. Not a button.
2. `base:` label (`--muted`, 12 px) then **BranchPicker** trigger; `←` glyph (`--muted`, `title="Shows what compare adds on top of base"`); `compare:` label then the second trigger.
3. **SwapButton**: 28 × 28 px bordered button with `⇄` (`lucide:arrow-left-right`). Disabled state at 50 % opacity when source === target.
4. 1 px vertical divider, 20 px tall.
5. **IncludeWorktreeToggle**: native-looking checkbox (14 px, checked = `--accent` fill with white tick) + "Include uncommitted changes". Disabled: 50 % opacity, tooltip from T5.1.
6. Spacer.
7. **RefreshControl**: bordered button, `lucide:refresh-cw` 14 px + "Refresh" + 8 px status dot + word. Dot/word: `--success` "Live", `--attention` "Polling", `--muted` "Manual". Spinner replaces the icon while busy. Tooltip "Last refreshed 12 s ago".
8. **Theme toggle**: 28 × 28 px bordered icon button, `lucide:sun` / `lucide:moon`.

**BranchPicker trigger**: bordered, `--bg` fill, 6 px radius, 4 px 8 px padding, `min-width: 170px` (prevents layout shift), monospace 12 px / 500 branch name, then badge(s) (`HEAD`, `default`, `remote`), then `▾` caret pushed right (`--muted`, 10 px). Popover: `--surface`, `--line` border, popover shadow, 320 px wide, search input on top (auto-focused, placeholder "Find a branch…"), then groups "Local" / "Remote: origin" / other remotes as 11 px uppercase `--muted` group headers; rows 28 px, monospace, current selection with a `lucide:check` on the left, keyboard highlight uses `--surface-raised`. Synthetic `HEAD (detached @ 3f9a1c2)` row pinned first when present.

### 7.2 TopBar row 2 — StatsRow (T5.1, states S1–S8)

Background `--surface`, bottom border `--line` (the bar's outer edge), 40 px, 12.5 px text, 1 px `--line` dividers 18 px tall. Left to right:

1. **Count** `11 files changed` (number 600). While a filter is active: `8 of 118 match` (S5), tooltip carries the whole-diff totals.
2. **Totals** `+576` (`--success`, mono 600) `−131` (`--danger`) — printed only once every countable file has stats. While stats stream (S2) they are two 36 × 10 px `--surface-raised` skeletons followed by a `--accent` busy group: 13 px spinner + `stats 42 / 118`. When some files can never be counted (S3) an `--attention` group follows: 14 px `lucide:triangle-alert` + accent link `6 not counted` (tooltip "2 files over 1 MB, 3 binary, 1 read error"; click scrolls the sidebar to the first such file). When no stats batch has arrived for 10 s while incomplete (S8): totals dimmed to 55 %, `--attention` group `stats stopped at 70 / 118 ·` + accent link `re-count` (force refresh).
3. **Status breakdown**: 15 px status squares (§3.3) `M A D R T`, each followed by its mono count, zero counts omitted, tooltip "6 modified, 3 added, …". Each square is a toggle button that sets the filter token `status:M` (etc.) and shows `aria-pressed`.
4. **Layer breakdown**: layer chips (§3.3) `staged` `unstaged` `untracked` `conflict` each followed by its mono count, zero counts omitted; toggles for `layer:staged` (etc.).
5. **ViewedCounter**: `3 / 11 viewed` (number 600, rest `--muted`, tabular) + 80 × 6 px progress bar (`--progress-track`, `--success` fill, 3 px radius). Over the visible files while filtering. With no files (S7): muted "nothing to view".
6. Spacer. **FileFilter**: bordered input 240 px, `lucide:search` 13 px, placeholder "Filter files", `/` kbd hint on the right (10 px monospace, bordered), clear `×` and a 1 px inset `--accent` ring when non-empty. Accepts path text / globs plus `status:M`, `layer:staged`, `is:generated` tokens.
7. **ViewControls**: segmented control (bordered, 6 px radius, 4 px 10 px padding per segment) `Unified | Split`, active segment `--surface` fill with 1 px inset `--accent` ring and `--accent` text; then a 28 × 28 px icon button for whitespace (`lucide:space` or the `␣` glyph, tooltip "Ignore whitespace", pressed state uses the same active treatment). Both at 50 % and disabled when the diff has no files.

While a refresh is running (S4) the count, totals, breakdowns and viewed counter drop to 55 % opacity and a busy group `updating` appears; numbers never flash to zero between computes. Below 1100 px the two breakdown groups collapse into the count's tooltip.

**Sidebar row marks** (§7.4, S3): three reasons, three marks in the `+n −m` slot — `> 1 MB` (mono `--muted`, tooltip "Over 1 MB — Load diff in the card") for gated files, `—` for binary, and a `--danger` `retry` link with 11 px `lucide:circle-x` when the file's diff request failed; the 32 px skeleton stays for stats still streaming.

### 7.3 WarningBanners (T5.5, state E7)

Full width, 8 px 16 px padding, 12.5 px text, icon (`lucide:triangle-alert` / `info` / `circle-x`, 14 px) then bold subject then message, then the engine `detail` in `--muted`, then the **code** in 10.5 px mono at 70 % `--muted` (the FAQ promises "a code you can look up"), then an optional one-word `--accent` action link (`Refresh`, `Ignore whitespace`, `Compare HEAD`, `Show them`, `Why?`), dismiss `×` on the right (`--muted`). One row per warning code, stacked, each independently dismissible. Colours in §3.4.

### 7.4 Sidebar (T5.2, T9.1)

- Header row 1, 36 px, unchanged: "Files changed" 600 12 px + `(11)` `--muted`; right: `Tree | Flat` mini segmented control (2 px 7 px padding, 11 px).
- Header row 2, 30 px, bottom border `--line`, rendered only when the diff has a file in a layer other than `committed`: left, a `Layer | Path` mini segmented control styled exactly like `Tree | Flat` (`aria-pressed`, `fieldset` + sr-only legend "Group files") writing the `sidebarGroup` pref, default `Layer`; right-aligned, `n uncommitted` 11 px `--muted`, counted over the whole diff.
- **Groups** (Layer mode). Fixed order `Conflicts`, `Staged`, `Unstaged`, `Untracked`, `Committed on <compare>`; empty groups are not rendered. A file appears once, in the least-committed layer it touches (precedence conflict → unstaged → staged → untracked → committed), so a staged-then-edited file sits under `Unstaged` and nothing is listed twice. The tree, or in flat mode the file list, is built per group.
- **Group header** 28 px, sticky at the top of the scrolling body (not once the pane virtualises above 300 rows, where rows are positioned with transforms), `--surface-sunken` with a bottom border `--line`, 10 px left padding, 6 px gap, not selectable: chevron `▾`/`▸` 9 px `--muted` → 7 px round dot in the layer's chip `fg` token (`--chip-conflict-fg`, `--chip-staged-fg`, `--chip-unstaged-fg`, `--chip-untracked-fg`; committed `--muted`) → label 12 px / 600 → count pill (monospace 10 px / 600, 5 px side padding, 999 px radius, 1 px `--line` on `--surface-raised`) reading `k`, or `k of n` against the unfiltered diff while a filter is active → spacer → `+n −m` monospace 11 px (`--success` / `--danger`) summed over the group's visible files, omitted entirely while no file in the group has stats → viewed `k/n` monospace 11 px `--muted`, which becomes `✓ k/n` in `--success` with the whole header at 55 % opacity once k = n.
- Hover or focus inside a header reveals two 20 px icon buttons: `lucide:check-check` "Mark all in <label> viewed" (`lucide:rotate-ccw` "Clear viewed in <label>" once every file in the group is viewed) and `lucide:list-collapse` "Collapse other groups", which collapses every other group and opens this one. Clicking the header anywhere else toggles the group.
- Keyboard on a header: `Enter`/`Space` toggle, `→` expands or moves on when already open, `←` collapses, `v` marks the whole group viewed. `←` on a depth-0 row inside a group moves focus to that group's header. `j`/`k` still walk files only, across groups.
- Tree: 6 px vertical padding; indent 14 px per level starting at 12 px. Folder rows 24 px: `▾`/`▸` 9 px, `lucide:folder` 14 px `--muted`, name 12 px `--muted`; compacted chains render as one row `src/engine/git`. While a folder is collapsed the name is followed by its file count and `+n −m` in monospace 11 px `--muted`, the numbers omitted while a countable file inside still has no stats; an open folder shows nothing, its children carry the numbers.
- **FileRow** 26 px, 7 px gap: status square 16 × 16 px (§3.3, letter 10 px / 700 monospace) → basename 12.5 px / 500 (tree) or `dir/` `--muted` + basename 500 (flat) with `text-overflow: ellipsis`, struck through and `--muted` when the status is deleted → layer code (§3.3), in Layer mode only on a file that is both staged and unstaged, in Path mode on every uncommitted file → `+n −m` monospace 11 px, `—` for binary, 32 px skeleton bar while stats load (the other marks in §7.2) → viewed checkbox 14 px (tick `--success`). No layer or `generated` chips on the row; those stay on the card header (§7.5) and in the StatsRow (§7.2).
- Active row: `--accent-subtle` background + `box-shadow: inset 2px 0 0 var(--accent)`. Hover: `--surface-raised`. Viewed row: 55 % opacity. Keyboard focus: focus ring on the row.
- Flat mode: same row, full path with directory in `--muted`; inside a group the files sit at depth 0.
- When no file has an uncommitted layer (*Include uncommitted changes* off, or a compare that is not the checked-out branch) grouping is impossible: header row 2 and the group headers are not rendered, no row carries a layer code, and the sidebar is exactly the pre-T9.1 spec — header row 1, the tree, the FileRow and the row states.

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

### 7.7 Notices (T5.4, state E6)

All notices share: 28 px padding, centred, 10 px gaps; a 22 px icon (the tone tints the icon only: `--danger` for failures, `--muted` otherwise), a bold `--ink` title, a 13 px `--muted` sentence, an optional row of small bordered buttons, and an optional 11 px mono code line at 70 % `--muted` (`TOO_LARGE`, `IO_ERROR · <engine message>`).

- **ImageDiff**: two columns, 16 px gap and padding; each pane bordered 6 px radius on a 16 px checkerboard (`repeating-conic-gradient(#eef1f4 0 25%, #fff 0 50%)`, dark `#161b22` / `#0d1117`), image centred with `max-height: 480px`, caption `512 × 512 · 18.2 KB` 12 px `--muted`. Old pane border `--diff-del-num`, new pane border `--diff-add-num`. Added/deleted: single pane.
- **BinaryNotice**: "Binary file not shown" + sizes + `View as text` button when < 1 MB.
- **LargeFileGate**: "Large diff (3,412 lines changed)." + `Load diff` button; > 10 MB: "Diff too large to display" + sizes, no button.
- **SubmoduleNotice**: monospace `Subproject commit abc123 → def456`.
- **TypechangeNotice**: one-line banner-style row at the top of the body, `--accent-subtle`, "Symlink → regular file".

### 7.8 Home, loading, empty, error screens (T4.4, T5.5; states H, L, S6–S7, E1–E6, B)

Same tokens, centred column `max-width: 560px`, 15 px body text, 24 px gaps. Primary buttons on these screens are **ink** (`--ink` fill, `--bg` text, 8 px radius), secondaries bordered, the destructive/least-likely action a borderless **ghost** (`--muted` text) pushed to the right.

- **HomeScreen** is the marketing landing page (§13) rendered verbatim. History lives in the hero's right column (360 px), which is the facts table on a first visit (H0) and otherwise:
  - one stored repo (H1): the **Continue card** — 12 px radius `--line` border, 16 px 18 px padding; mono uppercase `CONTINUE` label with `lucide:clock` and "opened 3 h ago" right; brand tile 22 px + name 18 px / 600 + access dot; a two-column meta grid (`Last compared` → `base … compare` in mono with `--accent` / `--success`; `Access` → dot + "granted for this session" / "will ask once" / "denied"); actions `Open <name>` (ink), `Different folder`, ghost `×` Forget.
  - two to six repos (H2): the **Recent list** on hairlines: mono uppercase header `RECENT · n` with `Clear all` right; rows 44 px = `lucide:folder-git-2` 16 px `--muted`, name 14 px / 500 over the last pair in 11.5 px mono (`--accent` base `…` `--success` compare; "never compared" dim), right: access dot (`--success` granted, `--attention` will ask once, `--danger` missing/denied) + relative time in mono + `×` on hover/focus; hover `--surface-raised`, focus a 2 px inset `--accent` ring; footer legend of the three dots + "Stored in this browser only".
  - seven or more (H3): a filter input above the list (search icon, `esc` kbd), matched substrings in `<mark>` (`--chip-unstaged-bg`), list scrolls inside the column, footer `n of m match` + key hints `↑ ↓ ⏎ open · ⌫ forget`; no match: "No recent repository matches `zzz`." + "Press o to open a new folder."
  - row outcomes stay on the row (H4), 12.5 px under the name, 13 px icon: opening (`--accent` spinner, "Asking the browser for read access…", row at 55 %); denied (`lucide:lock`, `--danger` "Read access was denied." + `Try again` `Forget`); folder gone (`triangle-alert`, "Folder not found — moved, renamed or deleted." + `Choose it again` `Forget`); not a repo any more (`circle-x`, "Not a git repository any more (`.git` is gone)." + `Choose another` `Forget`); forgotten (row at 50 %, "Forgotten" + `Undo` for 5 s — never a confirm dialog). Order of checks on click: permission → handle still resolves → layout still a repo.
  - the nav (H5) gains a `Recent` button (`lucide:clock` + chevron) opening a 360 px popover (`--surface`, `--line`, 10 px radius, popover shadow) with up to three rows and a footer `r opens this` / `Show all n ↑`; hidden when there is no history; `r` toggles it on Home.
  - storage unavailable (H6): no toast on the landing; the facts row `Matches → git diff -M` becomes `Recent repos → ⚠ not remembered here` in `--attention` with the explanation in its tooltip.
- **BrowserGate** (B1–B6): full page, not the column. A 40 px `--surface-raised` strip: status dot + mono `detected: Firefox 130 · desktop · secure context` + host right. Then a `1fr 340px` grid (40 px gap; single column below 1000 px). Left: brand lockup; h1 display 500, clamp 28→40 px, tracking −0.04em: "This *browser* can't open local folders." where the `--danger` word names the cause — *browser* (Firefox, Safari, unknown), *phone* (mobile), *address* (http / LAN ip), *frame* (embedded), *version* (Chromium < 86), or "A *policy* blocks opening local folders." (picker refused with `SecurityError`); a mono pill with `lucide:monitor-x` naming browser and reason; one or two 15.5 px `--muted` paragraphs; for browser causes a 2 × 2 grid of bordered 10 px-radius links (Chrome 86+, Edge 86+, Brave, Arc); CTA row — `Copy link` (ink) + `See the demo anyway`, or `Share…` on phones, `Open diffgit.com` / `Open in its own tab` / `Update Chrome` / `Try again` per cause; then a hairline privacy strip of three icon facts (read-only · 0 bytes uploaded, by CSP · no analytics). Right: a 12 px-radius card with the canonical URL row (`https://diffgit.com`, copy icon) and a caption, or the three numbered steps for the insecure-context case; below it, for browser causes, a demo card showing two file rows and five diff lines with "The interactive demo runs in any browser. Try it ↓". "See the demo" reveals the landing page under a `--banner-warning-bg` strip. Never a raw user-agent string, never an auto-redirect.
- **LoadingScreen** (L1–L6): column 560 px. Header: brand tile 32 px + repo name 22 px display / 600 with the `base … compare` pair in mono under it (+ "· uncommitted included"); right, mono `--muted`: elapsed `4.2 s` (from 2 s on) over "usually ~6 s" / "first open" / "stopped" / "attempt 2 of 3". Four hairline rows 44 px: icon (`circle-check` `--success` done · spinner `--accent` current · `circle` `--muted` pending · `circle-x` `--danger` failed), label 500 with an 11.5 px mono caption (done rows keep their result: "layout ok · config ok · 412 refs", "8,120 entries · v2", warnings that belong to the step in `--attention`), right a mono count column (`0.3 s` for done, `1,240 / 5,000` for current, `—` when the total is unknown). Under the current row a full-width 6 px bar (`--progress-track`, `--accent` fill; an indeterminate 35 % sweep when the total is unknown; none under `prefers-reduced-motion`). Callouts (8 px radius, 1 px border, 13 px): **slow** at 8 s in `--banner-warning-bg` with `triangle-alert`: "Taking longer than usual." + the reason from the warnings so far + `Skip uncommitted changes` / ghost `Keep waiting`; **restart** in `--accent-subtle` with a spinner: "The diff engine stopped and was restarted." + "Attempt 2 of 3."; **failed** (IO_ERROR, INDEX_UNSUPPORTED, REF_NOT_FOUND, PERMISSION) attached under the failed row in `--banner-error-bg`: bold message, muted fix text, `Retry` (ink) / `Choose another folder` / ghost `Copy details`. Footer: `Cancel` (small bordered) + right hint "esc cancels · nothing has been written"; `Back to start` alone once failed.
- **EmptyState** (S7; replaces the pane, sidebar hidden): `lucide:git-compare` 28 px `--muted`; h1 18 px "No changes between `feat/x` and `main`" with branch names as code chips; "Working tree is clean." when applicable; "Commits on `main` after the merge base are not shown by design."; buttons `Change base` (bordered) and ghost `Swap ⇄`. **FilterEmptyState** (S6; same place when a filter matches nothing): `lucide:search`; "No files match `payments/`"; "118 files changed in this diff. Filters match on path, `status:M` and `layer:staged`."; `Clear filter` with an `esc` kbd.
- **ErrorScreen** (E1–E4): column 560 px, 18 px gaps. Header: a 40 × 40 tile (10 px radius, 1 px border at 45 % of its colour) tinted by tone — `--danger` on `--banner-error-bg` when the repo is unusable here (layout codes), `--attention` on `--banner-warning-bg` for access/environment (PERMISSION, HANDLE_GONE), `--accent` on `--accent-subtle` for transient codes (IO_ERROR, REF_NOT_FOUND, WORKER_CRASHED, INTERNAL), `--muted` on `--surface-raised` for informational — with a 20 px lucide icon; beside it the title (21 px display / 600) and one 11.5 px mono line `CODE · repo name`, the only place a code is shown. Then one 14.5 px sentence on what happened; then the **fix box** (`--surface-sunken`, `--line`, 8 px radius, 12 px 14 px): `auto 1fr` grid of mono uppercase 11 px labels (`WHAT TO DO`, `LOOKED IN`, `FOUND`, `IF NO PROMPT`) and text whose commands/paths are `code` chips; special callouts in `--banner-error-bg` for "Denied again." (E3.2). Actions in a fixed order — primary ink (`Choose another folder` / `Retry` / `Grant access` / `Use defaults` / `Choose it again`), secondaries bordered, ghost `Forget this repo` right-aligned only for repos opened from history, plus ghost `Copy details`. Last, a `<details>` "Details" with the plain-text report (code, message, hint, build, browser) in an 11.5 px mono `--surface-raised` block. STALE, CANCELLED, TOO_LARGE and STORAGE_UNAVAILABLE never render as a screen.
- **In-card failures** (E6, §7.7 notice anatomy with an icon 22 px, bold title, muted sentence, small buttons, dim mono code line): "Couldn't load this diff" (`circle-x` `--danger`, `Retry` `View raw`, `IO_ERROR · <engine message>`), "Diff too large to display" (`scale` `--muted`, both sizes, `TOO_LARGE`, no button), "Couldn't render this diff" (`zap` `--danger`, `Retry` `View raw` ghost `Copy report`), "Binary file not shown" (`file` `--muted`, sizes, `View as text`).
- **Toasts** (E5): bottom-right, 360 px, `--surface`, `--line` border, popover shadow, 6 px radius, 12 px 16 px, 13 px; 14 px icon per level (`circle-x` `--danger`, `triangle-alert` `--attention`, `info` `--accent`, `refresh-cw` for engine restarts); one `--accent` action link at most; auto-dismiss 8 s. Copy: "Couldn't open the folder. The browser refused the request (SecurityError)." · "Engine restarted, refreshing the diff. Your viewed marks are kept." · "Storage is blocked or full. This repo won't be listed in Recent and viewed marks won't persist." · "`feat/x` was deleted. Now comparing `main … HEAD`." · "Read access to `repo` was revoked. Live refresh paused."

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
| Group fully viewed | header 55 % opacity, `✓ k/n` in `--success` |
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
- **Do** separate regions with a border before reaching for a background colour (§2.6).
- **Do** keep unified as the default view and the tree as the default sidebar mode.
- **Don't** add a dark-only or light-only component; every component renders in both themes.
- **Don't** add a web font, a shadow on cards, gradients, or rounded pills for buttons. Shadows belong to popovers, dialogs and toasts only.
- **Don't** reintroduce a tonal step between `--bg` and `--surface`, or give the diff pane a grey ground.
- **Don't** introduce a third accent hue. Green and red belong to the diff and to `+n −m`.

## 11. Implementation notes

- `src/index.css`: `@import "tailwindcss";` then `:root { … }` / `.dark { … }` token blocks from §3 (including `--surface-sunken` and `--line-subtle`, which must exist in both blocks — `contrast.test.ts` asserts the two blocks declare identical token names), then `@theme inline { --color-bg: var(--bg); … }` so Tailwind utilities read the runtime tokens (needed for the toggle to work without a rebuild).
- Theme toggle (T5.6) sets `document.documentElement.classList.toggle("dark")` and persists `prefs.theme` (`"system" | "light" | "dark"`); on `"system"` a `matchMedia("(prefers-color-scheme: dark)")` listener drives the class.
- `src/ui/components/StatusIcon.tsx`, `LayerChip.tsx`, `Badge.tsx` are small shared primitives created in T5.2 and reused by T5.1/T5.3; do not duplicate their styling.
- Icons come from `lucide-react` (added in Phase 5). Import icons individually.
- The diff renderer chosen in ADR-001 is themed via CSS variables in §3.2; if it exposes its own theme object, map it from the same variables rather than hard-coding hex values twice.

## 12. Brand

**Name:** `diffgit`, always lower-case, one word, never capitalised mid-sentence. Domain `diffgit.com`.

**Mark ("branch, diff-coloured"):** a git branch glyph on a `#0d1117` tile with a 7/32 corner radius.
The trunk and its two nodes are `#e6edf3` — the base branch, the thing that already exists. The
diverging arm and its node are `#3fb950` — the compare branch, the work you added. The mark therefore
says what the product does, not merely "git". It ships as `public/favicon.svg` at 32 × 32 and must stay
legible at 16 px: do not add a third colour, an outline, or a gradient, and do not recolour the tile
for light mode — the dark tile is the mark in both themes.

**Wordmark:** `diff` in `--ink` + `git` in `--success`, weight 600, tracking −0.01em. Use the split
colour only where the wordmark stands alone (site header, footer, README); the app's HomeScreen
heading is plain `--ink`.

**In-app use:** the app does not render the tile. The HomeScreen shows `lucide:git-branch` at 32 px in
`--success` (§7.8), which echoes the mark using tokens only — an inline SVG with literal hexes would
fail the §10 colour guard.

**Green's two jobs.** `--success` is both the brand hue and the diff's "added" hue. That is deliberate
and is not a third accent: blue stays the interactive colour (links, focus, active segment) and green
stays the additive/positive colour (`+n`, staged, Live, brand). Never use green for an interactive
control that is not the primary action.

## 13. Marketing site (`diffgit.com`, direction "Precision")

Out of the app bundle and out of scope for the task files; recorded here so the two surfaces stay
related. It shares §3's tokens and §12's brand, and breaks §2.2 (density) on purpose.

- **Frame.** One 1200 px column with a 1 px `--line` rule on the left and right edge, running the whole
  page; every section is separated by a full-width horizontal rule of the same colour. 48 px inner
  gutter, 20 px below 760 px wide.
- **Type.** Display in Inter Tight 500, clamped 44→84 px, tracking −0.045em, line-height 0.98; body
  Inter 400 at 16–20 px; all code, paths, refs and numbers in JetBrains Mono. Fonts must be
  **self-hosted** (`font-src 'self'`) — the CSP forbids fetching them.
- **Hero.** Eyebrow (`local · read-only · no network`), headline with the last phrase in `--success`,
  one-paragraph lede, two buttons, and a right-hand facts table of six `label → value` rows on
  `--line` dividers. No screenshot.
- **Demo, not a screenshot.** Directly under the hero sits a working copy of the diff UI on a sample
  repository: selectable files, Unified/Split, filter, Viewed ticks, an "Include uncommitted" toggle
  that really removes the unstaged and untracked layers, and the `j` `k` `s` `v` `/` keys. It is built
  from the same tokens and row/card specs as §7.
- **Chapters.** Four numbered two-column sections (Layers, Three-dot, Live, Privacy), each a short
  argument beside an explanatory visual — `git status` output against the diffgit tree, an SVG commit
  graph of the merge-base range, the refresh pipeline as a timeline, and the privacy model as a spec
  table quoting the served CSP. No feature-card grids.
- **Close.** A five-question FAQ as `<details>` rows on `--line`, then a single call to action.
- **History.** The hero's right column is the only part of the page that changes with state: the facts table on a first visit, the Continue card or the Recent list once a repository has been opened (§7.8 H0–H6). The nav gains a `Recent` popover when history exists. The list reuses the facts table's rhythm (hairlines, 14 px labels, 13 px mono values) so it reads as part of the page, not as app chrome.


## 14. v2 information architecture (approved 2026-09-19, owner: "all features, no clutter")

The v2 features (see `docs/v2-contracts.md` and `tasks/phase-10-engine`, `tasks/phase-11-ui`) are added
under three rules, in this order of preference:

1. **Contextual first.** A surface appears only when the repository is in the state it explains: the
   operation banner during a rebase, the three-way body on a conflicted file, the secret banner when a
   finding exists, the "Hidden" group only when switched on. When nothing is happening, the repo screen
   looks exactly like v1.
2. **Inside a surface the user already opens.** New sources live in the existing pickers; blame and
   file history are a mode of the file card; search scopes live in the command palette; export is one
   menu in the StatsRow. No new top-level chrome for any of these.
3. **One mode switch for the pages that need a page.** History, Branches and Insights replace the body;
   they are reached from one segmented control and from the palette. Files stays the default and the
   only mode with the sidebar file tree.

### 14.1 The chrome that changes

- **TopBar row 1** gains one control after the repo name: **ModeSwitch**, a segmented control
  `Files | History | Branches | Insights` (same style as `Unified | Split`, §7.2 item 7; 12 px labels,
  28 px tall). Keyboard `1`–`4`. The pickers, swap, worktree toggle, refresh and theme stay where they
  are in every mode; in History mode the pickers still define the branch that is walked (compare) and
  the merge base (base).
- **StatsRow** gains one 28 × 28 px icon button after the whitespace button: **ExportMenu**
  (`lucide:download`, tooltip "Export", opens the menu in §14.6). In History mode the counts describe
  the selected commit or range; in Branches and Insights the row is replaced by the page's own
  header (same height, same border).
- **BranchPicker popover** gains groups after "Local" and "Remote: …": `Tags`, `Stashes`, and
  `Special` (`Working tree`, `Staged only`), and accepts free text (`a1b2c3d`, `HEAD~3`, `v2.3.0^`,
  `stash@{1}`) as a final "Use `<text>`" row that resolves on Enter. A footer row holds the
  `three-dot … | two-dot ..` toggle (default three-dot; two-dot disables the merge-base step).
- **FileHeader** gains a mini segmented control before the Viewed tick: `Diff | Blame | History`,
  11 px, rendered only when the file has a committed side (`oldOid` or `newOid` reachable from a
  commit; untracked-only files do not get it).
- **Sidebar row 1** gains a 20 px icon toggle after `Tree | Flat`: `lucide:eye-off` "Show hidden files"
  (`aria-pressed`), which adds the **Hidden** group (§14.4) at the bottom of the tree.
- **Command palette** (`⌘K` / `Ctrl+K`, `lucide:command` icon button at the far right of row 1 before
  the theme toggle): every action in the app plus the search scopes (§14.5). This is the escape hatch
  that keeps the bars small: anything not visible is one keystroke away.
- **HelpDialog** lists the new keys and the palette.

Nothing else is added to the bars. Bisect, rebase preflight, patch export of a commit, "compare with",
"open submodule" are row actions in a `…` menu or palette commands, never buttons in the chrome.

### 14.2 Files mode (default)

v1 plus: extended pickers; conflict cards (§14.3); operation and secret banners in the WarningBanners
stack (§7.3 levels: operation = info or warning, secret = error, both with an action link); the
Hidden group; `Diff | Blame | History` on cards; ExportMenu. The diff pane, sidebar and shortcuts are
unchanged otherwise.

### 14.3 Contextual surfaces

- **Operation banner**: `▶ Rebase in progress · step 3 of 7 · replaying a09d3c1 onto main` with action
  "Show steps" (popover listing the todo with done/current/remaining) — warning level while conflicts
  exist, info level otherwise. Merge, cherry-pick, revert and bisect variants use the same banner with
  their own wording. A second info banner explains a detached HEAD during an operation.
- **Conflict card**: for a file in the `conflict` layer the card body is the three-way view
  (Base · Ours · Theirs, each a `DiffBody` column of the base→side hunks, 3-column grid, stacked below
  900 px) above the working-tree file with marker lines highlighted `--purple-bg`/`--done`. A Notice
  under it: "diffgit shows conflicts; resolving happens in your editor" with a copyable next command.
  When the working tree no longer contains markers the notice reads "resolved in the working tree, not
  yet staged".
- **Secret banner**: `! 1 possible secret in uncommitted changes` (danger banner) with "Show" scrolling
  to the file; the row in the sidebar carries a `secret` chip (`--chip-conflict` palette); the line in
  the diff has a 3 px `--danger` left rule and a popover (rule, entropy, where, allowlist help, Reveal
  and Mask buttons). Findings are masked by default everywhere including copy.
- **Why hidden**: rows in the Hidden group are muted; clicking one opens a popover naming the reason
  (rule file + line + pattern, or the index flag, or the size gate) with the copyable
  `git check-ignore -v <path>` / `git update-index --no-skip-worktree <path>` command.

### 14.4 Sidebar groups (extends §7.4 / T9.1)

Order: Conflicts, Staged, Unstaged, Untracked, Committed on `<compare>`, then **Hidden** (only when
the toggle is on). Hidden rows: ignored directories as one row with a count (never their contents),
ignored files, skip-worktree and assume-unchanged files, files over 10 MB. Each row wears a small
`ref`-style tag: `ignored`, `skip-worktree`, `assume-unchanged`, `> 10 MB`, `sparse`.

### 14.5 History mode

- Sidebar becomes the **commit list**: row 1 `Commits | Stack | Reflog` segmented control and the
  count (`50 of 1,284`); row 2 a search input "Search message, author or SHA" and two toggles
  (`first-parent`, `all branches`). Rows 30 px: a 44 px SVG lane column, short SHA (mono, `--accent`),
  subject, ref badges (`HEAD`, branch, remote, tag — §3.3 badge palettes; stash badge uses the
  `T` typechange palette), then author and age right-aligned; `+n −m` when known.
- Diff pane: a **CommitCard** on top (subject, body, author, committer, date, parents, tree, signed
  flag, note, refs) with actions `Show diff` (default), `Compare with base…`, `Copy SHA` and a `…`
  menu (`Export as .patch`, `Copy cherry-pick command`, `Bisect: mark good`, `Bisect: mark bad`,
  `Blame here`); below it the same FileCards as Files mode for the selected commit (range source
  `parent…commit`, root commit against the empty tree).
- Shift-click a second row → range `older…newer` (StatsRow shows both SHAs).
- **Stack** sub-tab: the commits of compare since the merge base, newest on top, each a collapsed
  card with subject, SHA, file count and `+n −m`, expanding to its per-commit diff; an "Uncommitted"
  entry on top when the worktree is included.
- **Reflog** sub-tab: `HEAD@{n}` rows (action, message, age) with orphaned commits marked
  `unreachable` (badge, `--done` palette); clicking opens the commit as in Commits.
- **Bisect** is a strip above the commit list once started (from the palette or the CommitCard menu):
  `Bisect · good 6345f55 … bad 414e4ed · 14 between · ≈ 4 steps · test a1b2c3d` with `Good` `Bad`
  `Skip` `Stop` buttons and a copyable checkout command; the candidate is selected in the list.

### 14.6 Branches, Insights, Export, Home

- **Branches mode**: page with `Active | Stale > 90 d | Tags` filter, a search box, and a table
  (branch with badges, vs upstream, vs base, last commit, author, age). Ahead/behind cells are a 60 px
  two-colour bar (`--success` ahead, `--danger` behind) plus numbers; `merged` and `pull`/`push` hints
  are `ref`-style tags. Row `…` menu: `Set as compare`, `Set as base`, `Compare with base`,
  `Preflight rebase onto base`, `Copy name`. Tags table: name, annotated/lightweight, message, tagger,
  age, `Compare with previous tag`.
- **Rebase preflight** opens as a panel in the diff pane area (Branches mode): table of commits to
  replay with `Touches`, `Overlaps with <onto>`, `Prediction` (clean / possible / likely chips), the
  `git rebase -i <onto>` command and a `Copy todo` button. Report only; no reorder controls.
- **Insights mode**: header with `90 d | 1 y | All`; sections Hotspots (commits × size, horizontal
  bars, manifests greyed and excluded from ranking), Activity (52-week heatmap using the `--heat*`
  ramp), Contributors (opt-in disclosure, commit counts only, `.mailmap` honoured). Cached per tip.
- **ExportMenu** (`Export ▾`): `Copy as unified diff`, `Save as .patch`, `Save review snapshot
  (.html)`, `Copy file list as Markdown`, `Copy stats line`; sizes shown; blocked with a list when the
  secret scan has findings (override link "export anyway"). Saves go through `showSaveFilePicker()`
  when available, otherwise a download; never into the repository.
- **Home**: RecentRow becomes a **RepoCard** grid: name, branch, ahead/behind vs upstream, layer
  counts as `LayerChip`s, operation tag, last commit age, `Open` / `Re-authorise`. Summaries come
  from a background `summarise()` per repository with granted permission, cached by index mtime.
- **BrowserGate** (Firefox/Safari): "Open a repository once" (`webkitdirectory`) → Snapshot mode:
  a `--attention` tag `Snapshot mode · read at 14:02 · Re-open to refresh` in row 2, no Live dot,
  no recents.
- **Install**: `lucide:download-cloud` "Install" button in row 1 only while `beforeinstallprompt`
  is pending; `.patch`/`.diff` files opened through the OS or dropped on the page render as a
  patch-only diff (no repository) with an info banner.

### 14.7 Keyboard additions

`1`–`4` modes · `⌘K`/`Ctrl+K` palette · `b` blame on the active file · `h` file history · `g` / `x`
bisect good / bad while a bisect runs · `e` export menu · `Shift+H` hidden files toggle.
All existing keys keep their meaning. Every new surface is reachable by keyboard and passes the axe
checks from T5.6.
