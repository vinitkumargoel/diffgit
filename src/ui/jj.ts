/**
 * Colocated jujutsu workspaces (T11.16, Design §14, atlas tab 19).
 *
 * jj writes an ordinary `.git` and keeps its own state in `.jj/` beside it, with git's `HEAD`
 * detached at the working-copy commit. diffgit reads exactly two things about that: the engine
 * reports `.jj/` as `RepoInfo.jj` and raises `JJ_COLOCATED` once per open, and `loadRefs` spells
 * the detached head `jj working copy @ <sha7>` instead of `HEAD (detached @ <sha7>)`
 * (`docs/v2-contracts.md` `<!-- T10.12 -->`). This module is the one string the *page* adds: the
 * tag next to the repo name, which is what tells the user their detached HEAD is normal here.
 *
 * There is deliberately nothing else. `RefSnapshot.detached` stays true — the resolver, the
 * operation detector and the branch table depend on it — and the engine has no detached-HEAD
 * warning code at all, so "no detached-HEAD banner when jj" needs no suppression anywhere.
 */
export const JJ_TAG = "jj colocated";
export const JJ_TITLE =
  "A jujutsu workspace beside this .git. Its working-copy commit is why git's HEAD is detached; diffgit shows git's view of it.";
