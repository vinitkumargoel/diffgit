# Phase 11 — v2 UI

Every task: read `tasks/README.md`, `Design.md` in full (§14 is the v2 information architecture and
wins over any older section it touches), `docs/v2-contracts.md`, the atlas tab for the feature
(`docs/mockups/feature-atlas.html`: the mockup is the approved look, the tokens are the same as
`src/index.css`), then the components you touch. UI rules: tokens only (colour guard), Design sizes,
both themes, keyboard + axe, vitest tests on recorded data (`VITE_MOCK_ENGINE=1`), no Playwright
outside `e2e/` smoke specs (a task may extend an existing spec by a few assertions), `bun run check`
green, CHANGELOG entry, Conventional Commit `feat(T11.x): …`.

Anti-clutter rule (owner): a task that wants a new button in TopBar row 1 or the StatsRow beyond
those named in Design §14.1 must stop and report; the palette (`⌘K`) is where extra actions go.

Order: T11.1 → T11.2 → T11.3 → T11.4 → T11.5 → T11.6 → T11.7 → T11.8 → T11.9 → T11.10 → T11.11 →
T11.12 → T11.13 → T11.14 → T11.15 → T11.16. Engine dependency per task is listed; the mock worker
client must be extended with recorded data for every new method a task consumes.
