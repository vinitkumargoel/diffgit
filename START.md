# START HERE — diffgoel implementation kickoff

This file is the entry point for whoever (human or agent) drives the implementation. It tells you what to read, in what order to run the tasks, how to brief an implementation agent, and how to track progress.

## 1. What we are building (30 seconds)

A static web app at https://diff.vinitk.dev. In Chrome you pick a local git repo folder, choose a **base** branch (default: the repo's default branch) and a **compare** branch (default: the checked-out one), and read a GitHub-style diff of what compare adds on top of base, including uncommitted work when compare is the checked-out branch. It auto-refreshes as you edit. Nothing leaves the browser and nothing on disk is ever written.

## 2. Reading order

1. `Plan.md` §0 (decisions — do not re-open) and §14 (review amendments).
2. `tasks/README.md` — conventions, error registry, E2E policy, dependency table.
3. **UI tasks only (T4.4, T5.x):** `Design.md` — the approved visual spec (direction A "Classic"). Tokens, type, layout and every component's rendered look live there; do not restyle.
4. The task file you are about to run, then the Plan and Design sections it cites.

Nothing else is required to start a task.

## 3. Prerequisites on this machine

| Tool | Have | Needed |
|------|------|--------|
| Bun | 1.3.13 | ≥ 1.3 |
| Node | 24.12 | for tooling that needs it |
| git | 2.50.1 | fixtures are built with the real CLI |
| Chrome/Edge | — | desktop Chromium ≥ 133 for live refresh |
| wrangler | not installed | use `bunx wrangler` |

## 4. Owner-only steps (do these before the tasks that need them)

- **Before T0.2**: run `bunx wrangler login` once (interactive).
- **Before T1.6 and T8.2**: pick three real local repos (one small, one with `node_modules`, one after `git gc`) and write their paths into `docs/engine-notes.md` under "S2 repos".

## 5. Run order

```
Step 1 (sequential, one agent):   T0.1 → T0.3 → T0.4 → T0.2
Step 2 (two agents in parallel):
   Engine track:  T1.1 → T1.5 → T1.2 → T1.3 → T1.4 → T1.6 → T2.2 → T2.1 → T2.3 → T2.4 → T3.1 → T3.2 → T3.3 → T3.4 → T3.5
   UI track:      T4.1 → T4.2 → T4.3 → T4.4 → T5.0 → T5.1 → T5.2 → T5.3 → T5.4 → T5.5 → T5.6
Step 3 (after T3.5 and T5.6):     T6.0 → T6.1 → T6.2 → T6.3 → T6.4
Step 4 (sequential):              T7.1 → T7.2 → T7.3 → T7.4 → T7.5 → T8.1 → T8.2 → T8.3
```

Inside a track, tasks whose "Depends on" are all merged may run in parallel (e.g. T2.2 with T2.1, T5.1 with T5.2). The UI track runs on the mock worker client (`VITE_MOCK_ENGINE=1`) until T3.5 lands, then switches to the real one.

Spikes gate work: T1.6 must pass before Phase 2 starts; T5.0 before T5.3; T6.0 before T6.2. If a spike fails, stop and update the affected task files before continuing.

## 6. How to brief an implementation agent

Give the agent **one task file** and this prompt (fill in the id):

```
You are implementing task <ID> of the diffgoel project.
Working directory: /Users/homepc/Official/work/personal/diffgoel
Read, in order: tasks/README.md, tasks/<phase-dir>/<ID>-*.md, then the Plan.md sections that file cites. For a UI task (T4.4, T5.x) also read Design.md in full and the Design sections the task cites.
Rules: follow tasks/README.md conventions exactly; implement only that task's deliverables; UI must match Design.md (tokens only, no literal colours, no restyling); never write to a user's git repo; no Playwright tests outside T7.1.
Definition of done: code + tests, `bun run check` green, every acceptance criterion ticked with evidence, a 3–6 line entry in docs/CHANGELOG.md, and a Conventional Commit `feat(<ID>): ...`.
If something in the task is impossible or contradicts the Plan, stop and report instead of improvising.
```

For a review after a task, brief a reviewer agent with the same files plus the diff and ask for standards (tasks/README.md) and spec (the task file's acceptance criteria) compliance. For UI tasks add a third axis: visual compliance with `Design.md` (tokens used, sizes and placement per §6–§7, both themes).

## 7. Tracking

Keep this board updated (edit this file; one line per task):

| Task | Status | Agent / date | Notes |
|------|--------|--------------|-------|
| T0.1 | done | agent / 2026-09-16 | |
| T0.2 | blocked: owner must add CNAME diff → diffgoel.pages.dev | agent / 2026-09-16 | project + deploy + domain registration done; pages.dev passes check-prod |
| T0.3 | done | agent / 2026-09-16 | 27 fixtures, jq required |
| T0.4 | done | agent / 2026-09-16 | shim verified in bun (E2E policy) |
| T1.1 | done | agent / 2026-09-16 | |
| T1.2 | done | agent / 2026-09-16 | |
| T1.3 | done | agent / 2026-09-16 | flattenTree perf-5k ≈ 30–150 ms |
| T1.4 | done | agent / 2026-09-16 | |
| T1.5 | done | agent / 2026-09-16 | |
| T1.6 | done | agent / 2026-09-16 | spike passed on 3 real repos; MIDX supported |
| T2.1 | todo | | |
| T2.2 | todo | | |
| T2.3 | todo | | |
| T2.4 | todo | | |
| T3.1 | todo | | |
| T3.2 | todo | | |
| T3.3 | todo | | |
| T3.4 | todo | | |
| T3.5 | todo | | |
| T4.1 | todo | | |
| T4.2 | todo | | |
| T4.3 | todo | | |
| T4.4 | todo | | Design §7.8 |
| T5.0 | todo | | spike, gates T5.3; theme via Design §3.2/§3.5 |
| T5.1 | todo | | Design §7.1–7.2 |
| T5.2 | todo | | Design §7.4 |
| T5.3 | todo | | Design §7.5–7.6 |
| T5.4 | todo | | Design §7.7 |
| T5.5 | todo | | Design §3.4, §7.3, §7.8 |
| T5.6 | todo | | Design §3, §8, §9, §11 |
| T6.0 | todo | | spike, gates T6.2 |
| T6.1 | todo | | |
| T6.2 | todo | | |
| T6.3 | todo | | |
| T6.4 | todo | | |
| T7.1 | todo | | 3 smoke specs only |
| T7.2 | todo | | |
| T7.3 | todo | | |
| T7.4 | todo | | |
| T7.5 | todo | | |
| T8.1 | todo | | |
| T8.2 | todo | | owner: 3 real repos |
| T8.3 | todo | | |

Statuses: `todo` → `in-progress` → `review` → `done` (or `blocked: <reason>`).

## 8. Everyday commands (exist after T0.1/T0.3)

```
bun install
bun run fixtures        # build test repos with git (T0.3)
bun run dev             # Vite dev server
VITE_MOCK_ENGINE=1 bun run dev   # UI against recorded data
bun run check           # tsc -b + biome + bun test + vitest
bun run build && bun run preview  # production build with production CSP headers
bunx playwright test    # the three smoke specs (after T7.1)
bun run deploy          # Cloudflare Pages (after T0.2)
```

## 9. When you are unsure

The decision log in `Plan.md` §0 is final, and `Design.md` is final for anything visual (when unsure how something should look, do what github.com does). Anything not covered there and not in a task file is a routine judgement call: pick the option that keeps the app read-only, offline, and matching git, note it in `docs/CHANGELOG.md`, and continue.
