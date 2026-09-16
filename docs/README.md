# docs/

| Document | What it covers |
|---|---|
| [adr-001-diff-renderer.md](adr-001-diff-renderer.md) | Why the hunks are rendered with react-diff-view over our own hunk model, and the alternatives tried in Spike S1. |
| [engine-notes.md](engine-notes.md) | Engine internals and spike results: index parser, worktree scan, rename scoring, S2 zero-write runs on real repositories, S3 FileSystemObserver behaviour. |
| [errors.md](errors.md) | Every error and warning code: where it is thrown, the user copy, the action; the silent-failure review; torn-read handling. |
| [perf.md](perf.md) | Performance budgets, measured numbers, and the decisions behind them. |
| [privacy.md](privacy.md) | What never leaves the browser, what is stored locally, read-only guarantees, inert rendering, how to clear data. |
| [deploy.md](deploy.md) | Cloudflare Pages setup, custom domains, edge-injection settings that must stay off, release steps, rollback. |
| [contributing.md](contributing.md) | Toolchain, repository layout, the guards in `bun run check`, conventions. |
| [backlog.md](backlog.md) | Deferred items with the reason and the review that raised them. |
| [CHANGELOG.md](CHANGELOG.md) | One entry per task (T0.1 → T8.3) with evidence for each acceptance criterion. |
| [screenshots/](screenshots/) | README screenshots, regenerated with `bun scripts/screenshots.ts`. |
