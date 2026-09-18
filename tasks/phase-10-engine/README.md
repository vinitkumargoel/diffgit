# Phase 10 — v2 engine

Every task: read `tasks/README.md`, `docs/v2-contracts.md` (names are fixed), `Design.md` §14 (what the
UI will do with the data), the atlas tab for the feature (`docs/mockups/feature-atlas.html`, the
"How it works offline" and "Risks" sections are the spec's rationale), then the engine files you touch.
Engine rules: no React/DOM, structured-cloneable results, `EngineError` codes only from `errors.ts`,
one in-flight call per new method (`CANCELLED` on supersede), `STALE` on old generations, fixtures from
`scripts/make-fixtures.sh` with git's own output as the expectation, `bun run check` green, CHANGELOG
entry, Conventional Commit `feat(T10.x): …`. Never write to the repository (D16).

Order: T10.0 → T10.1 → T10.2 → T10.3 → T10.4 → T10.5 → T10.6 → T10.7 → T10.8 → T10.9 → T10.10 →
T10.11 → T10.12. Each depends on the previous being committed (they all touch `api.ts` and
`session.ts`).
