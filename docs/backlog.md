# Backlog

Items deferred with a reason. T8.3 curates this list at the end of v1.

| # | Item | Why deferred | Source |
|---|---|---|---|
| B1 | `ObjectDb.mergeBase` maps isomorphic-git's `NotFoundError` to "no merge base" (→ `UNRELATED_HISTORIES`); a missing commit object in a corrupt or oddly-shallow repository would look the same. Distinguish by walking the reachable commits before declaring unrelated. | Needs a corrupt-repo fixture; the wrong message is a warning, not data loss. | T7.3 review |
