#!/usr/bin/env bash
# Builds every fixture repository under fixtures/ with the real git CLI (T0.3).
# Idempotent: deletes and rebuilds fixtures/. Deterministic: fixed author/committer identity and
# dates, no global/system git config. Run `FIXTURES_PERF=1` to also build `perf-5k` and `perf-log`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIX="$ROOT/fixtures"
REMOTES="$FIX/_remotes"

export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
export GIT_AUTHOR_DATE="2024-01-01T00:00:00Z" GIT_COMMITTER_DATE="2024-01-01T00:00:00Z"
export LC_ALL=C

# Every git call goes through G so fixtures are independent of the machine's configuration.
G() {
  git -c core.autocrlf=false -c init.defaultBranch=main -c commit.gpgsign=false \
      -c core.hooksPath=/dev/null -c protocol.file.allow=always -c advice.detachedHead=false \
      -c core.untrackedCache=false -c core.fsmonitor=false -c gc.auto=0 "$@"
}
# Same, with autocrlf on (crlf fixture only).
GCRLF() {
  git -c core.autocrlf=true -c init.defaultBranch=main -c commit.gpgsign=false \
      -c core.hooksPath=/dev/null -c protocol.file.allow=always -c advice.detachedHead=false "$@"
}

commit() { # commit <repo> <message>   (stages everything)
  G -C "$1" add -A >/dev/null
  G -C "$1" commit -q --allow-empty -m "$2"
}
w() { # w <repo> <path> <content...>  (writes file, creating dirs)
  local repo="$1" path="$2"; shift 2
  mkdir -p "$(dirname "$repo/$path")"
  printf '%s' "$*" > "$repo/$path"
}
lines() { # lines <prefix> <from> <to>   prints "<prefix> <n>" per line
  local p="$1" i
  for ((i=$2; i<=$3; i++)); do printf '%s %d\n' "$p" "$i"; done
}
b64() { printf '%s' "$2" | base64 -d > "$1"; }

PNG_RED2='iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR42mP4z8AARAwQCgAf7gP9Y167WwAAAABJRU5ErkJggg=='
PNG_BLUE3='iVBORw0KGgoAAAANSUhEUgAAAAMAAAADCAIAAADZSiLoAAAAD0lEQVR42mNgYPgPQ5gsAH2gCPimIH9kAAAAAElFTkSuQmCC'
PNG_GREEN4='iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAD0lEQVR42mNgOMGAQMRxAEVDDIFAMwhLAAAAAElFTkSuQmCC'

# ----------------------------------------------------------------------------------------------
# basic: main (3 commits) ← feature (2 commits); main gains 1 more commit after divergence.
build_basic() { # build_basic <dir>
  local r="$1"; mkdir -p "$r"; G -C "$r" init -q
  w "$r" README.md "# basic fixture"$'\n'"A small repo for diffgit tests."$'\n'
  w "$r" src/a.txt "$(lines alpha 1 10)"$'\n'
  w "$r" src/b.txt "$(lines beta 1 5)"$'\n'
  w "$r" docs/guide.md "# Guide"$'\n'"Step one."$'\n'"Step two."$'\n'
  commit "$r" "c1: initial files"
  w "$r" src/a.txt "$(lines alpha 1 8)"$'\n'"alpha 9 edited"$'\n'"alpha 10"$'\n'
  commit "$r" "c2: edit a.txt"
  w "$r" src/c.txt "$(lines gamma 1 3)"$'\n'
  commit "$r" "c3: add c.txt"
  G -C "$r" checkout -q -b feature
  w "$r" src/a.txt "$(lines alpha 1 8)"$'\n'"alpha 9 edited"$'\n'"alpha 10"$'\n'"alpha 11 feature"$'\n'
  rm "$r/src/b.txt"
  w "$r" src/new.txt "brand new on feature"$'\n'
  commit "$r" "f1: modify a, delete b, add new"
  w "$r" docs/guide.md "# Guide"$'\n'"Step one."$'\n'"Step two, revised."$'\n'"Step three."$'\n'
  w "$r" lib/util.txt "util 1"$'\n'"util 2"$'\n'
  commit "$r" "f2: guide + util"
  G -C "$r" checkout -q main
  w "$r" README.md "# basic fixture"$'\n'"A small repo for diffgit tests."$'\n'"Updated on main after divergence."$'\n'
  w "$r" src/main-only.txt "only on main"$'\n'
  commit "$r" "c4: main moves on"
  G -C "$r" checkout -q feature
}

build_renames() {
  local r="$FIX/renames"; mkdir -p "$r"; G -C "$r" init -q
  w "$r" old/exact.txt "$(lines exact 1 12)"$'\n'
  w "$r" similar.txt "$(lines similar 1 20)"$'\n'
  w "$r" rewrite.txt "$(lines rewrite 1 20)"$'\n'
  w "$r" dup/a.txt "$(lines duplicate 1 6)"$'\n'
  w "$r" keep.txt "stays"$'\n'
  commit "$r" "c1: files to be renamed"
  G -C "$r" checkout -q -b feature
  mkdir -p "$r/new" "$r/moved" "$r/other"
  G -C "$r" mv old/exact.txt new/exact.txt
  # ~60% similar: keep 12 of 20 lines
  { lines similar 1 12; lines changed 13 20; } > "$r/similar.txt"
  G -C "$r" mv similar.txt moved/similar.txt
  # below threshold: keep 4 of 20 lines
  { lines rewrite 1 4; lines totally-different 5 20; } > "$r/rewrite.txt"
  G -C "$r" mv rewrite.txt moved/rewrite.txt
  rm "$r/dup/a.txt"
  w "$r" other/b.txt "$(lines duplicate 1 6)"$'\n'
  commit "$r" "f1: renames of every kind"
}

build_binary() {
  local r="$FIX/binary"; mkdir -p "$r/img" "$r/data" "$r/text"; G -C "$r" init -q
  b64 "$r/img/logo.png" "$PNG_RED2"
  printf 'BIN\x00\x01\x02\x03header\x00tail' > "$r/data/blob.bin"
  w "$r" img/icon.svg '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="red"/></svg>'$'\n'
  w "$r" text/becomes-binary.txt "plain text line 1"$'\n'"plain text line 2"$'\n'
  commit "$r" "c1: binary and image files"
  G -C "$r" checkout -q -b feature
  b64 "$r/img/logo.png" "$PNG_BLUE3"
  b64 "$r/img/new.png" "$PNG_GREEN4"
  printf 'BIN\x00\x09\x08\x07header\x00tail-changed' > "$r/data/blob.bin"
  w "$r" img/icon.svg '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="blue"/></svg>'$'\n'
  printf 'plain text line 1\nplain text line 2\nnow with a NUL \x00 byte\n' > "$r/text/becomes-binary.txt"
  commit "$r" "f1: change binaries"
}

build_worktree_base() { # history shared by worktree/index-v3/index-v4
  local r="$1"; mkdir -p "$r"; G -C "$r" init -q
  w "$r" staged-mod.txt "$(lines staged 1 5)"$'\n'
  w "$r" unstaged-mod.txt "$(lines unstaged 1 5)"$'\n'
  w "$r" both.txt "$(lines both 1 5)"$'\n'
  w "$r" deleted-unstaged.txt "will be deleted without staging"$'\n'
  w "$r" deleted-staged.txt "will be git rm'd"$'\n'
  w "$r" script.sh '#!/bin/sh'$'\n''echo hi'$'\n'
  w "$r" reverted.txt "$(lines base 1 4)"$'\n'
  w "$r" clean.txt "never touched"$'\n'
  commit "$r" "c1: initial"
  w "$r" clean.txt "never touched"$'\n'"second line"$'\n'
  commit "$r" "c2: touch clean"
  G -C "$r" checkout -q -b feature
  w "$r" reverted.txt "$(lines base 1 4)"$'\n'"added on feature, reverted in worktree"$'\n'
  w "$r" feature-only.txt "committed on feature"$'\n'
  commit "$r" "f1: feature commit"
  G -C "$r" checkout -q main
  w "$r" main-only.txt "main after divergence"$'\n'
  commit "$r" "c3: main moves on"
  G -C "$r" checkout -q feature
}

build_worktree() {
  local r="$FIX/worktree"; build_worktree_base "$r"
  w "$r" staged-mod.txt "$(lines staged 1 5)"$'\n'"staged extra"$'\n'
  G -C "$r" add staged-mod.txt
  w "$r" unstaged-mod.txt "$(lines unstaged 1 4)"$'\n'"unstaged 5 changed"$'\n'
  w "$r" both.txt "$(lines both 1 5)"$'\n'"staged part"$'\n'
  G -C "$r" add both.txt
  w "$r" both.txt "$(lines both 1 5)"$'\n'"staged part"$'\n'"unstaged part"$'\n'
  w "$r" staged-new.txt "new and staged"$'\n'
  G -C "$r" add staged-new.txt
  w "$r" untracked.txt "not tracked"$'\n'
  w "$r" newdir/untracked2.txt "not tracked either"$'\n'
  rm "$r/deleted-unstaged.txt"
  G -C "$r" rm -q deleted-staged.txt
  chmod +x "$r/script.sh"; G -C "$r" add script.sh
  w "$r" reverted.txt "$(lines base 1 4)"$'\n'   # back to merge-base content
}

build_conflict() {
  local r="$FIX/conflict"; mkdir -p "$r"; G -C "$r" init -q
  w "$r" file.txt "line1"$'\n'"line2"$'\n'"line3"$'\n'
  w "$r" other.txt "untouched"$'\n'
  commit "$r" "c1: base"
  G -C "$r" checkout -q -b feature
  w "$r" file.txt "line1"$'\n'"line2 from feature"$'\n'"line3"$'\n'
  commit "$r" "f1: feature edit"
  G -C "$r" checkout -q main
  w "$r" file.txt "line1"$'\n'"line2 from main"$'\n'"line3"$'\n'
  commit "$r" "c2: main edit"
  if G -C "$r" merge -q feature >/dev/null 2>&1; then echo "conflict fixture: merge unexpectedly succeeded" >&2; exit 1; fi
}

build_packed() {
  local r="$FIX/packed"; build_basic "$r"
  G -C "$r" gc -q --aggressive --prune=now
  G -C "$r" pack-refs --all
}

# perf-log: 2,000 linear commits + 50 branches, for the history-walk budget in docs/perf.md
# (T10.5b nit 8: the perf-5k HEAD is two commits deep, so its "first page of 50" measured nothing).
# Built through `git fast-import` — still the real git CLI, and the only way 2,000 commits do not
# cost 2,000 process spawns. Fixed committer dates keep the oids byte-identical across rebuilds.
build_perf_log() {
  local r="$FIX/perf-log"; mkdir -p "$r"; G -C "$r" init -q
  local i when msg body
  {
    for ((i=1; i<=2000; i++)); do
      when=$(( 1717200000 + i * 60 ))
      msg="c$i: commit $i"$'\n'
      body="line $i"$'\n'
      printf 'commit refs/heads/main\n'
      printf 'mark :%d\n' "$i"
      printf 'author test <test@example.com> %d +0000\n' "$when"
      printf 'committer test <test@example.com> %d +0000\n' "$when"
      printf 'data %d\n%s' "${#msg}" "$msg"
      [ "$i" -gt 1 ] && printf 'from :%d\n' "$(( i - 1 ))"
      printf 'M 644 inline log.txt\ndata %d\n%s\n' "${#body}" "$body"
    done
    for ((i=1; i<=50; i++)); do
      printf 'reset refs/heads/topic%02d\nfrom :%d\n\n' "$i" "$(( i * 37 + 1 ))"
    done
    printf 'done\n'
  } | G -C "$r" fast-import --quiet --done
  rm -f "$r/.git/fast_import_crash_"* 2>/dev/null || true
  G -C "$r" symbolic-ref HEAD refs/heads/main
  G -C "$r" reset -q --hard main
  G -C "$r" commit-graph write --reachable
  G -C "$r" pack-refs --all
  [ "$(G -C "$r" rev-list --count main)" = 2000 ] || { echo "perf-log: not 2000 commits" >&2; exit 1; }
  [ "$(G -C "$r" for-each-ref --format=x refs/heads | wc -l | tr -d ' ')" = 51 ] ||
    { echo "perf-log: expected main + 50 topics" >&2; exit 1; }
}

make_bare_from_basic() { # make_bare_from_basic <bare-path> [rename-main-to]
  local tmp="$FIX/_tmp-basic"; rm -rf "$tmp"; build_basic "$tmp"
  if [ -n "${2:-}" ]; then G -C "$tmp" branch -m main "$2"; fi
  G clone -q --bare "$tmp" "$1"
  G -C "$1" symbolic-ref HEAD "refs/heads/${2:-main}"
  rm -rf "$tmp"
}

build_remote() {
  mkdir -p "$REMOTES"
  make_bare_from_basic "$REMOTES/basic.git"
  local r="$FIX/remote"
  G clone -q "$REMOTES/basic.git" "$r"
  G -C "$r" checkout -q -b feature origin/feature
  G -C "$r" branch -q topic main
  G -C "$r" checkout -q topic
  w "$r" topic.txt "topic branch"$'\n'
  commit "$r" "t1: topic commit"
  G -C "$r" checkout -q feature
}

build_remote_master() {
  make_bare_from_basic "$REMOTES/basic-master.git" master
  local r="$FIX/remote-master"
  G clone -q "$REMOTES/basic-master.git" "$r"
  G -C "$r" checkout -q -b feature origin/feature
}

build_no_origin_head() {
  local r="$FIX/no-origin-head"
  G clone -q "$REMOTES/basic.git" "$r"
  G -C "$r" remote set-head origin -d
  G -C "$r" branch -q master main
  G -C "$r" checkout -q -b feature origin/feature
  G -C "$r" checkout -q main
}

build_index_v4() {
  local r="$FIX/index-v4"; build_worktree_base "$r"
  w "$r" staged-mod.txt "$(lines staged 1 5)"$'\n'"staged extra v4"$'\n'
  w "$r" staged-new.txt "new and staged v4"$'\n'
  G -C "$r" add staged-mod.txt staged-new.txt
  G -C "$r" update-index --index-version 4
}

build_index_v3() {
  local r="$FIX/index-v3"; build_worktree_base "$r"
  w "$r" staged-mod.txt "$(lines staged 1 5)"$'\n'"staged extra v3"$'\n'
  G -C "$r" add staged-mod.txt
  w "$r" intent.txt "intent to add"$'\n'
  G -C "$r" add -N intent.txt
  G -C "$r" update-index --index-version 3
}

build_ignore() {
  local r="$FIX/ignore"; mkdir -p "$r"; G -C "$r" init -q
  w "$r" .gitignore "build/"$'\n'"*.log"$'\n'"node_modules/"$'\n'"ignored-dir/"$'\n'
  w "$r" src/.gitignore "!keep.log"$'\n'
  w "$r" README.md "ignore fixture"$'\n'
  w "$r" src/main.txt "main"$'\n'
  w "$r" ignored-dir/tracked.txt "tracked despite ignore"$'\n'
  G -C "$r" add -A; G -C "$r" add -f ignored-dir/tracked.txt
  G -C "$r" commit -q -m "c1: ignore rules"
  printf 'secret.txt\n' >> "$r/.git/info/exclude"
  w "$r" build/x "built"$'\n'
  w "$r" a.log "log"$'\n'
  w "$r" src/keep.log "kept log"$'\n'
  w "$r" src/other.log "ignored log"$'\n'
  w "$r" secret.txt "excluded via info/exclude"$'\n'
  w "$r" notes.txt "untracked and visible"$'\n'
  w "$r" ignored-dir/untracked.txt "inside ignored dir"$'\n'
  local i
  for ((i=1; i<=200; i++)); do w "$r" "node_modules/pkg$((i % 10))/file$i.js" "module.exports = $i;"$'\n'; done
  w "$r" node_modules/pkg/index.js "module.exports = 0;"$'\n'
}

build_detached() {
  local r="$FIX/detached"; build_basic "$r"
  G -C "$r" checkout -q --detach feature~1
}

build_unborn() {
  local r="$FIX/unborn"; mkdir -p "$r"; G -C "$r" init -q
  w "$r" first.txt "staged in an unborn repo"$'\n'
  w "$r" dir/second.txt "also staged"$'\n'
  G -C "$r" add -A
  w "$r" untracked.txt "not staged"$'\n'
}

build_unrelated() {
  local r="$FIX/unrelated"; mkdir -p "$r"; G -C "$r" init -q
  w "$r" main.txt "main history"$'\n'
  w "$r" shared.txt "same name, main version"$'\n'
  commit "$r" "c1: main root"
  G -C "$r" checkout -q --orphan feature
  G -C "$r" rm -rfq .
  w "$r" feature.txt "feature history"$'\n'
  w "$r" shared.txt "same name, feature version"$'\n'
  commit "$r" "f1: orphan root"
}

build_crlf() {
  local r="$FIX/crlf"; mkdir -p "$r"; G -C "$r" init -q
  printf 'line one\r\nline two\r\nline three\r\n' > "$r/dos.txt"
  printf 'unix one\nunix two\n' > "$r/unix.txt"
  commit "$r" "c1: crlf file committed verbatim"
  G -C "$r" checkout -q -b feature
  printf 'line one\r\nline two changed\r\nline three\r\n' > "$r/dos.txt"
  commit "$r" "f1: edit crlf file"
  G -C "$r" config core.autocrlf true
}

build_large() {
  local r="$FIX/large"; mkdir -p "$r"; G -C "$r" init -q
  lines "line" 1 3200 > "$r/big-change.txt"
  awk 'BEGIN { for (i = 1; i <= 30000; i++) printf "medium file line %06d: the quick brown fox jumps over\n", i }' > "$r/medium.txt"
  commit "$r" "c1: large files"
  G -C "$r" checkout -q -b feature
  { lines "line" 1 100; lines "changed" 101 3100; lines "line" 3101 3200; } > "$r/big-change.txt"
  printf 'appended line on feature\n' >> "$r/medium.txt"
  awk 'BEGIN { for (i = 1; i <= 200000; i++) printf "huge generated line %07d abcdefghijklmnopqrstuvwxyz\n", i }' > "$r/huge.txt"
  commit "$r" "f1: change 3000 lines, modify 1.5MB file, add 11MB file"
}

build_embedded() {
  local r="$FIX/embedded"; build_basic "$r"
  mkdir -p "$r/inner"; G -C "$r/inner" init -q
  w "$r" inner/inner.txt "inside the embedded repo"$'\n'
  commit "$r/inner" "i1: embedded repo commit"
  w "$r" visible-untracked.txt "outside the embedded repo"$'\n'
}

build_symlink() {
  local r="$FIX/symlink"; mkdir -p "$r"; G -C "$r" init -q
  w "$r" target.txt "target content"$'\n'
  w "$r" other.txt "other content"$'\n'
  ln -s target.txt "$r/link"
  ln -s target.txt "$r/link2"
  commit "$r" "c1: symlinks"
  G -C "$r" checkout -q -b feature
  rm "$r/link"; ln -s other.txt "$r/link"
  rm "$r/link2"; w "$r" link2 "now a regular file"$'\n'
  w "$r" target.txt "target content changed"$'\n'
  commit "$r" "f1: retarget link, link2 becomes a file, edit target"
}

build_worktree_gitdir() {
  local main="$FIX/_worktree-main"; build_basic "$main"
  G -C "$main" checkout -q main
  G -C "$main" worktree add -q "$FIX/worktree-gitdir" feature
}

build_submodule() {
  mkdir -p "$REMOTES"
  local subsrc="$FIX/_tmp-sub"; rm -rf "$subsrc"; mkdir -p "$subsrc"; G -C "$subsrc" init -q
  w "$subsrc" sub.txt "submodule v1"$'\n'
  commit "$subsrc" "s1"
  local sub1; sub1=$(G -C "$subsrc" rev-parse HEAD)
  w "$subsrc" sub.txt "submodule v2"$'\n'
  commit "$subsrc" "s2"
  G clone -q --bare "$subsrc" "$REMOTES/sub.git"; rm -rf "$subsrc"
  local r="$FIX/submodule"; mkdir -p "$r"; G -C "$r" init -q
  w "$r" README.md "superproject"$'\n'
  commit "$r" "c1: super"
  G -C "$r" -c protocol.file.allow=always submodule add -q "$REMOTES/sub.git" sub
  G -C "$r/sub" checkout -q "$sub1"
  commit "$r" "c2: add submodule at s1"
  G -C "$r" checkout -q -b feature
  G -C "$r/sub" checkout -q main
  commit "$r" "f1: bump submodule to s2"
  G -C "$r" submodule -q deinit -f sub >/dev/null
}

# ----------------------------------------------------------------------------------------------
# jj (T10.12): a colocated jujutsu workspace — an empty `.jj/` beside `.git/`, and a detached HEAD.
# Built with git alone, on purpose: `jj` is not on the build machine's PATH, and it does not need
# to be. jj writes an ordinary `.git` and leaves git's HEAD detached at the working-copy commit;
# diffgit reads exactly two things about jj — that `.jj/` exists, and that HEAD is detached — so a
# git repository with a detached HEAD and an empty `.jj/` is a faithful stand-in for both.
build_jj() {
  local r="$FIX/jj"; mkdir -p "$r"; G -C "$r" init -q
  w "$r" README.md "# jj fixture"$'\n'"A colocated jj workspace, as far as git can tell."$'\n'
  w "$r" src/a.txt "$(lines alpha 1 6)"$'\n'
  commit "$r" "c1: initial files"
  w "$r" src/a.txt "$(lines alpha 1 5)"$'\n'"alpha 6 edited"$'\n'
  commit "$r" "c2: edit a.txt"
  G -C "$r" checkout -q -b feature
  w "$r" src/b.txt "beta 1"$'\n'"beta 2"$'\n'
  commit "$r" "f1: add b.txt"
  G -C "$r" checkout -q main
  # jj checks its working-copy commit out with a detached git HEAD; that is the state to reproduce.
  G -C "$r" checkout -q --detach main
  mkdir -p "$r/.jj"
}

# ----------------------------------------------------------------------------------------------
# lfs (T10.12): files tracked by Git LFS, committed as the pointer text git actually stores.
# No `git lfs` binary is involved — a pointer is three lines of ASCII, and the filter that would
# swap it for the real object is exactly what diffgit never runs. Three shapes:
#   assets/hero.psd  pointer on both sides, marked `binary` so the row is a binary row as well
#   data/table.dat   pointer added on the feature side only (one-sided parse, plain text row)
#   notes.txt        an ordinary file, so the fixture also proves nothing else is mistaken for one
# `git lfs track` itself writes `-text` rather than `binary`. The `binary` macro is used here
# because git and the engine agree on it: git's `diff_filespec_is_binary` reads the `diff`
# attribute, so a file marked only `-text` is still diffed as text by git while
# `GitAttributes.isBinary` (T3.4) calls it binary — a divergence recorded as a follow-up in
# docs/CHANGELOG.md, not something this fixture should paper over or provoke.
LFS_OID_A=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
LFS_OID_B=4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393
LFS_OID_C=60303ae22b998861bce3b28f33eec1be758a213c86c93c076dbe9f558c11c752
lfs_pointer() { # lfs_pointer <repo> <path> <oid> <size>
  w "$1" "$2" "version https://git-lfs.github.com/spec/v1"$'\n'"oid sha256:$3"$'\n'"size $4"$'\n'
}
build_lfs() {
  local r="$FIX/lfs"; mkdir -p "$r"; G -C "$r" init -q
  w "$r" .gitattributes "*.psd filter=lfs merge=lfs binary"$'\n'"*.dat filter=lfs"$'\n'
  w "$r" notes.txt "not a pointer"$'\n'"version 2"$'\n'
  lfs_pointer "$r" assets/hero.psd "$LFS_OID_A" 12400000
  commit "$r" "c1: hero.psd as an LFS pointer"
  G -C "$r" checkout -q -b feature
  lfs_pointer "$r" assets/hero.psd "$LFS_OID_B" 12900000
  lfs_pointer "$r" data/table.dat "$LFS_OID_C" 5242880
  w "$r" notes.txt "not a pointer"$'\n'"version 3"$'\n'
  commit "$r" "f1: new hero revision, add table.dat"
  G -C "$r" checkout -q main
}

build_crisscross() {
  local r="$FIX/crisscross"; mkdir -p "$r"; G -C "$r" init -q
  w "$r" base.txt "base"$'\n'
  commit "$r" "c0: root"
  G -C "$r" checkout -q -b feature
  w "$r" feature.txt "f1"$'\n'
  commit "$r" "f1"
  local f1; f1=$(G -C "$r" rev-parse HEAD)
  G -C "$r" checkout -q main
  w "$r" main.txt "m1"$'\n'
  commit "$r" "m1"
  local m1; m1=$(G -C "$r" rev-parse HEAD)
  G -C "$r" merge -q --no-ff -m "m2: merge f1 into main" "$f1"
  G -C "$r" checkout -q feature
  G -C "$r" merge -q --no-ff -m "f2: merge m1 into feature" "$m1"
  w "$r" feature.txt "f1"$'\n'"f3"$'\n'
  commit "$r" "f3"
  G -C "$r" checkout -q main
  w "$r" main.txt "m1"$'\n'"m3"$'\n'
  commit "$r" "m3"
  G -C "$r" checkout -q feature
}

build_rebase_detached() {
  local r="$FIX/rebase-detached"; mkdir -p "$r"; G -C "$r" init -q
  w "$r" base.txt "base"$'\n'
  commit "$r" "c1"
  G -C "$r" checkout -q -b feature
  w "$r" one.txt "one"$'\n'
  commit "$r" "f1"
  w "$r" two.txt "two"$'\n'
  commit "$r" "f2"
  GIT_SEQUENCE_EDITOR="sed -i.bak -e 's/^pick/edit/'" G -C "$r" rebase -q -i main >/dev/null 2>&1 || true
  [ -d "$r/.git/rebase-merge" ] || { echo "rebase-detached: rebase-merge dir missing" >&2; exit 1; }
}

build_attributes() {
  local r="$FIX/attributes"; mkdir -p "$r/generated"; G -C "$r" init -q
  w "$r" .gitattributes "*.lock -diff"$'\n'"*.dat binary"$'\n'"generated/** linguist-generated"$'\n'"*.txt text"$'\n'
  w "$r" deps.lock "$(lines lock 1 5)"$'\n'
  w "$r" data.dat "$(lines data 1 5)"$'\n'
  w "$r" generated/out.js "$(lines 'var g =' 1 5)"$'\n'
  w "$r" notes.txt "$(lines note 1 5)"$'\n'
  commit "$r" "c1: attributes"
  G -C "$r" checkout -q -b feature
  w "$r" deps.lock "$(lines lock 1 6)"$'\n'
  w "$r" data.dat "$(lines data 1 6)"$'\n'
  w "$r" generated/out.js "$(lines 'var g =' 1 7)"$'\n'
  w "$r" notes.txt "$(lines note 1 4)"$'\n'"note five changed"$'\n'
  commit "$r" "f1: change attributed files"
}

build_sha256() {
  local r="$FIX/sha256"; mkdir -p "$r"; G -C "$r" init -q --object-format=sha256
  w "$r" file.txt "sha256 repo"$'\n'
  commit "$r" "c1"
}

build_alternates() {
  G clone -q --shared "$FIX/basic" "$FIX/alternates"
  [ -f "$FIX/alternates/.git/objects/info/alternates" ] || { echo "alternates missing" >&2; exit 1; }
}

build_partial() {
  G -C "$REMOTES/basic.git" config uploadpack.allowFilter true
  G clone -q --filter=blob:none "file://$REMOTES/basic.git" "$FIX/partial"
}

build_perf_5k() {
  local r="$FIX/perf-5k"; mkdir -p "$r"; G -C "$r" init -q
  local d f
  for ((d=0; d<200; d++)); do
    mkdir -p "$r/dir$d"
    for ((f=0; f<25; f++)); do printf 'dir %d file %d\nline two\nline three\n' "$d" "$f" > "$r/dir$d/file$f.txt"; done
  done
  commit "$r" "c1: 5000 files"
  G -C "$r" checkout -q -b other
  printf 'other branch\n' > "$r/dir0/file0.txt"; commit "$r" "o1"
  G -C "$r" checkout -q main
  G -C "$r" checkout -q -b feature
  for ((d=0; d<50; d++)); do printf 'dir %d file 0\nchanged on feature\nline three\n' "$d" > "$r/dir$d/file0.txt"; done
  commit "$r" "f1: change 50 files"
  G -C "$r" gc -q --aggressive --prune=now
  G -C "$r" pack-refs --all
}

# ----------------------------------------------------------------------------------------------
# v2 fixtures (T10.0) — docs/v2-contracts.md § "Fixtures to add".
# Everything below is built with the real git CLI and fixed identities/dates, so rebuilds are
# byte-identical wherever git allows it.

commit_as() { # commit_as <repo> <iso-date> <author-name> <author-email> <message>
  local r="$1" d="$2" an="$3" ae="$4" m="$5"
  G -C "$r" add -A >/dev/null
  (
    export GIT_AUTHOR_DATE="$d" GIT_COMMITTER_DATE="$d" \
           GIT_AUTHOR_NAME="$an" GIT_AUTHOR_EMAIL="$ae" \
           GIT_COMMITTER_NAME="$an" GIT_COMMITTER_EMAIL="$ae"
    G -C "$r" commit -q --allow-empty -m "$m"
  )
}
merge_as() { # merge_as <repo> <iso-date> <author-name> <author-email> <message> <rev...>
  local r="$1" d="$2" an="$3" ae="$4" m="$5"; shift 5
  (
    export GIT_AUTHOR_DATE="$d" GIT_COMMITTER_DATE="$d" \
           GIT_AUTHOR_NAME="$an" GIT_AUTHOR_EMAIL="$ae" \
           GIT_COMMITTER_NAME="$an" GIT_COMMITTER_EMAIL="$ae"
    G -C "$r" merge -q --no-ff -m "$m" "$@"
  )
}
hday() { # hday <n> → deterministic ISO date; 28 days per month from 2024-01-01
  printf '2024-%02d-%02dT%02d:00:00Z' "$(( ($1 / 28) + 1 ))" "$(( ($1 % 28) + 1 ))" "$(( $1 % 24 ))"
}

# tags: 2 lightweight + 2 annotated; v1.0.0 sits on `release`'s tip as well.
build_tags() {
  local r="$FIX/tags"; mkdir -p "$r"; G -C "$r" init -q
  w "$r" file.txt "release one"$'\n'
  w "$r" CHANGELOG.md "# changelog"$'\n'
  commit "$r" "c1: first release"
  G -C "$r" tag v0.1.0
  w "$r" file.txt "release two"$'\n'
  commit "$r" "c2: second release"
  G -C "$r" tag v0.2.0
  w "$r" file.txt "release three"$'\n'
  commit "$r" "c3: third release"
  G -C "$r" branch release
  G -C "$r" tag -a v1.0.0 -m "annotated release 1.0.0"
  w "$r" file.txt "release four"$'\n'
  commit "$r" "c4: fourth release"
  G -C "$r" tag -a v1.1.0 -m "annotated release 1.1.0"
  # T10.5b B1: a lightweight tag on a blob and one on a tree. git.git itself ships
  # refs/tags/junio-gpg-pub (a blob); `git log --all` skips such refs instead of failing.
  G -C "$r" tag blob-tag "$(G -C "$r" rev-parse HEAD:CHANGELOG.md)"
  G -C "$r" tag tree-tag "$(G -C "$r" rev-parse 'HEAD^{tree}')"
  [ "$(G -C "$r" cat-file -t blob-tag)" = blob ] || { echo "tags: blob-tag is not a blob" >&2; exit 1; }
  [ "$(G -C "$r" cat-file -t tree-tag)" = tree ] || { echo "tags: tree-tag is not a tree" >&2; exit 1; }
}

# stash: two stashes, the newest pushed with -u (three parents), plus a dirty worktree.
build_stash() {
  local r="$FIX/stash"; mkdir -p "$r"; G -C "$r" init -q
  w "$r" a.txt "$(lines alpha 1 6)"$'\n'
  w "$r" b.txt "$(lines beta 1 6)"$'\n'
  commit "$r" "c1: base"
  w "$r" a.txt "$(lines alpha 1 5)"$'\n'"alpha 6 stashed first"$'\n'
  G -C "$r" stash push -q -m "wip: tracked only"
  w "$r" b.txt "$(lines beta 1 5)"$'\n'"beta 6 stashed second"$'\n'
  w "$r" stashed-untracked.txt "untracked, captured by stash -u"$'\n'
  G -C "$r" stash push -q -u -m "wip: with untracked"
  w "$r" a.txt "$(lines alpha 1 6)"$'\n'"alpha 7 left dirty"$'\n'
  w "$r" left-untracked.txt "still untracked"$'\n'
  [ "$(G -C "$r" stash list | wc -l | tr -d ' ')" = 2 ] || { echo "stash: expected two stashes" >&2; exit 1; }
  [ "$(G -C "$r" rev-list --parents -n 1 'stash@{0}' | wc -w | tr -d ' ')" = 4 ] ||
    { echo "stash: stash@{0} is not a three-parent (-u) stash" >&2; exit 1; }
}

# rebase-conflict: `git rebase -i` stopped at step 2 of 3 with one UU and one AA path.
build_rebase_conflict() {
  local r="$FIX/rebase-conflict"; mkdir -p "$r"; G -C "$r" init -q
  w "$r" file.txt "$(lines line 1 6)"$'\n'
  w "$r" keep.txt "untouched by either side"$'\n'
  commit "$r" "c1: base"
  G -C "$r" checkout -q -b topic
  w "$r" one.txt "first topic commit"$'\n'
  commit "$r" "t1: clean commit (rebase step 1 of 3)"
  { lines line 1 2; echo "line 3 from topic"; lines line 4 6; } > "$r/file.txt"
  w "$r" both-added.txt "both-added, topic version"$'\n'
  commit "$r" "t2: conflicting commit (rebase step 2 of 3)"
  w "$r" three.txt "third topic commit"$'\n'
  commit "$r" "t3: clean commit (rebase step 3 of 3)"
  G -C "$r" checkout -q main
  { lines line 1 2; echo "line 3 from main"; lines line 4 6; } > "$r/file.txt"
  w "$r" both-added.txt "both-added, main version"$'\n'
  commit "$r" "c2: main edits the same line and adds the same path"
  G -C "$r" checkout -q topic
  GIT_SEQUENCE_EDITOR=true GIT_EDITOR=true G -C "$r" rebase -q -i main >/dev/null 2>&1 || true
  local d="$r/.git/rebase-merge"
  [ -f "$d/git-rebase-todo" ] && [ -f "$d/done" ] ||
    { echo "rebase-conflict: rebase-merge/{git-rebase-todo,done} missing" >&2; exit 1; }
  [ "$(cat "$d/msgnum")" = 2 ] && [ "$(cat "$d/end")" = 3 ] ||
    { echo "rebase-conflict: expected to stop at step 2 of 3" >&2; exit 1; }
  local st; st=$(G -C "$r" status --porcelain=v1)
  grep -qxF 'UU file.txt' <<< "$st" ||
    { echo "rebase-conflict: file.txt is not UU" >&2; exit 1; }
  grep -qxF 'AA both-added.txt' <<< "$st" ||
    { echo "rebase-conflict: both-added.txt is not AA" >&2; exit 1; }
}

# merge-conflict: mid-merge with MERGE_HEAD, one UU and one modify/delete (deleted by them).
build_merge_conflict() {
  local r="$FIX/merge-conflict"; mkdir -p "$r"; G -C "$r" init -q
  w "$r" file.txt "$(lines line 1 6)"$'\n'
  w "$r" gone.txt "$(lines gone 1 4)"$'\n'
  w "$r" keep.txt "untouched by either side"$'\n'
  commit "$r" "c1: base"
  G -C "$r" checkout -q -b topic
  { lines line 1 2; echo "line 3 from topic"; lines line 4 6; } > "$r/file.txt"
  G -C "$r" rm -q gone.txt
  commit "$r" "t1: edit file.txt, delete gone.txt"
  G -C "$r" checkout -q main
  { lines line 1 2; echo "line 3 from main"; lines line 4 6; } > "$r/file.txt"
  { lines gone 1 3; echo "gone 4 edited on main"; } > "$r/gone.txt"
  commit "$r" "c2: edit file.txt and gone.txt"
  if G -C "$r" merge -q -m "merge topic into main" topic >/dev/null 2>&1; then
    echo "merge-conflict: merge unexpectedly succeeded" >&2; exit 1
  fi
  [ -f "$r/.git/MERGE_HEAD" ] || { echo "merge-conflict: MERGE_HEAD missing" >&2; exit 1; }
  local st; st=$(G -C "$r" status --porcelain=v1)
  grep -qxF 'UU file.txt' <<< "$st" ||
    { echo "merge-conflict: file.txt is not UU" >&2; exit 1; }
  grep -qxF 'UD gone.txt' <<< "$st" ||
    { echo "merge-conflict: gone.txt is not UD (deleted by them)" >&2; exit 1; }
}

# cherry-pick-conflict: CHERRY_PICK_HEAD present (T10.2 operation detection).
build_cherry_pick_conflict() {
  local r="$FIX/cherry-pick-conflict"; mkdir -p "$r"; G -C "$r" init -q
  w "$r" file.txt "$(lines line 1 6)"$'\n'
  w "$r" keep.txt "untouched by either side"$'\n'
  commit "$r" "c1: base"
  G -C "$r" checkout -q -b topic
  { lines line 1 3; echo "line 4 from topic"; lines line 5 6; } > "$r/file.txt"
  commit "$r" "t1: the commit that gets cherry-picked"
  G -C "$r" checkout -q main
  { lines line 1 3; echo "line 4 from main"; lines line 5 6; } > "$r/file.txt"
  commit "$r" "c2: main edits the same line"
  if G -C "$r" cherry-pick topic >/dev/null 2>&1; then
    echo "cherry-pick-conflict: cherry-pick unexpectedly succeeded" >&2; exit 1
  fi
  [ -f "$r/.git/CHERRY_PICK_HEAD" ] ||
    { echo "cherry-pick-conflict: CHERRY_PICK_HEAD missing" >&2; exit 1; }
}

# reflog-orphan: `git reset --hard` leaves two commits reachable only from the reflog.
build_reflog_orphan() {
  local r="$FIX/reflog-orphan"; mkdir -p "$r"; G -C "$r" init -q
  w "$r" a.txt "one"$'\n'
  commit "$r" "c1: first"
  w "$r" a.txt "two"$'\n'
  commit "$r" "c2: second"
  w "$r" a.txt "three"$'\n'
  commit "$r" "c3: third (orphaned by the reset)"
  w "$r" b.txt "orphan payload"$'\n'
  commit "$r" "c4: fourth (orphaned by the reset)"
  local orphan; orphan=$(G -C "$r" rev-parse HEAD)
  G -C "$r" reset -q --hard HEAD~2
  w "$r" c.txt "work after the reset"$'\n'
  commit "$r" "c5: work after the reset"
  G -C "$r" cat-file -e "$orphan^{commit}" ||
    { echo "reflog-orphan: the orphaned commit was pruned" >&2; exit 1; }
  local reflog; reflog=$(G -C "$r" reflog --format=%H)
  grep -qxF "$orphan" <<< "$reflog" ||
    { echo "reflog-orphan: the orphaned commit is not in the reflog" >&2; exit 1; }
}

# history: 60 commits on main (incl. a merge of `topic`), a rename, a whitespace-only commit,
# a .mailmap, a [bot] author, three lightweight + one annotated tag, a commit-graph, and the
# preflight/base + preflight/a pair T10.11 predicts a rebase for.
build_history() {
  local r="$FIX/history"; mkdir -p "$r/src" "$r/docs"; G -C "$r" init -q
  local ADA="Ada Lovelace" ADA1="ada@example.com" ADA2="ada.lovelace@corp.example.com"
  local GRACE="Grace Hopper" GRACE1="grace@example.com"
  local BOT="renovate[bot]" BOT1="renovate[bot]@users.noreply.github.com"
  local n=0 i ver=1 pfbase="" topicbase=""

  w "$r" README.md "# history fixture"$'\n'"Long, many-author history for the v2 walker, blame, insights, search and preflight."$'\n'
  printf '%s <%s> <%s>\n' "$ADA" "$ADA1" "$ADA2" > "$r/.mailmap"
  lines hot 1 60 > "$r/src/hot.txt"
  lines indent 1 12 > "$r/src/indent.txt"
  lines moved 1 20 > "$r/src/renamed-from.txt"
  w "$r" src/stable.txt "this file is never touched again"$'\n'
  printf '{ "name": "history-fixture", "version": "0.0.%d" }\n' "$ver" > "$r/package.json"
  commit_as "$r" "$(hday $n)" "$ADA" "$ADA1" "c00: root commit"; n=$((n + 1))

  for ((i = 1; i <= 4; i++)); do
    lines module 1 $((5 + i)) > "$r/src/mod$i.txt"
    commit_as "$r" "$(hday $n)" "$GRACE" "$GRACE1" "$(printf 'c%02d: add module %d' "$n" "$i")"
    n=$((n + 1))
  done
  pfbase=$(G -C "$r" rev-parse HEAD)
  G -C "$r" branch preflight/base "$pfbase"
  G -C "$r" tag v0.1.0 "$pfbase"

  # The commit preflight/a's first commit collides with: the same three lines of src/hot.txt.
  { lines hot-main 1 3; lines hot 4 60; } > "$r/src/hot.txt"
  commit_as "$r" "$(hday $n)" "$ADA" "$ADA1" "$(printf 'c%02d: rework the top of hot.txt' "$n")"
  n=$((n + 1))

  w "$r" docs/guide.md "# Guide"$'\n'"Step one."$'\n'"Step two."$'\n'
  commit_as "$r" "$(hday $n)" "$ADA" "$ADA2" "$(printf 'c%02d: add the guide (second email, mapped by .mailmap)' "$n")"
  n=$((n + 1))

  ver=$((ver + 1)); printf '{ "name": "history-fixture", "version": "0.0.%d" }\n' "$ver" > "$r/package.json"
  commit_as "$r" "$(hday $n)" "$BOT" "$BOT1" "$(printf 'c%02d: chore(deps): bump manifest to 0.0.%d' "$n" "$ver")"
  n=$((n + 1))

  for ((i = 8; i <= 15; i++)); do
    printf 'guide note %d\n' "$i" >> "$r/docs/guide.md"
    lines module 1 $((5 + i)) > "$r/src/mod$((i % 4 + 1)).txt"
    # one edit before the rename, so `git log --follow` has more to follow than the root commit
    if [ "$i" = 12 ]; then printf 'moved 21 (edited before the rename)\n' >> "$r/src/renamed-from.txt"; fi
    if [ $((i % 2)) = 0 ]; then
      commit_as "$r" "$(hday $n)" "$GRACE" "$GRACE1" "$(printf 'c%02d: iterate on modules and the guide' "$n")"
    else
      commit_as "$r" "$(hday $n)" "$ADA" "$ADA1" "$(printf 'c%02d: iterate on modules and the guide' "$n")"
    fi
    n=$((n + 1))
    if [ "$i" = 11 ]; then topicbase=$(G -C "$r" rev-parse HEAD); fi
  done

  G -C "$r" checkout -q -b topic "$topicbase"
  for ((i = 16; i <= 27; i++)); do
    printf 'topic work %d\n' "$i" >> "$r/src/topic.txt"
    commit_as "$r" "$(hday $n)" "$GRACE" "$GRACE1" "$(printf 't%02d: topic step %d' "$n" $((i - 15)))"
    n=$((n + 1))
  done
  G -C "$r" checkout -q main
  merge_as "$r" "$(hday $n)" "$ADA" "$ADA1" "$(printf 'c%02d: merge topic into main' "$n")" topic
  G -C "$r" tag v0.2.0
  n=$((n + 1))

  { lines hot-main 1 3; lines hot 4 24; lines hot-later 25 30; lines hot 31 60; } > "$r/src/hot.txt"
  commit_as "$r" "$(hday $n)" "$GRACE" "$GRACE1" "$(printf 'c%02d: rework the middle of hot.txt' "$n")"
  n=$((n + 1))

  G -C "$r" mv src/renamed-from.txt src/renamed-to.txt
  { lines moved 1 19; echo "renamed payload marker"; } > "$r/src/renamed-to.txt"
  commit_as "$r" "$(hday $n)" "$ADA" "$ADA1" "$(printf 'c%02d: git mv renamed-from.txt and touch one line' "$n")"
  G -C "$r" tag v0.3.0
  n=$((n + 1))

  sed 's/^/    /' "$r/src/indent.txt" > "$r/src/indent.next" && mv "$r/src/indent.next" "$r/src/indent.txt"
  commit_as "$r" "$(hday $n)" "$GRACE" "$GRACE1" "$(printf 'c%02d: reindent indent.txt (whitespace only)' "$n")"
  n=$((n + 1))

  ver=$((ver + 1)); printf '{ "name": "history-fixture", "version": "0.0.%d" }\n' "$ver" > "$r/package.json"
  commit_as "$r" "$(hday $n)" "$BOT" "$BOT1" "$(printf 'c%02d: chore(deps): bump manifest to 0.0.%d' "$n" "$ver")"
  n=$((n + 1))

  for ((i = 33; i <= 59; i++)); do
    # one edit after the rename, so the no-follow history has more than the rename commit
    if [ "$i" = 40 ]; then printf 'renamed tail line\n' >> "$r/src/renamed-to.txt"; fi
    case $((i % 5)) in
      0) lines module 1 $((5 + i)) > "$r/src/mod1.txt"
         commit_as "$r" "$(hday $n)" "$ADA" "$ADA1" "$(printf 'c%02d: extend mod1' "$n")" ;;
      1) lines module 1 $((5 + i)) > "$r/src/mod2.txt"
         commit_as "$r" "$(hday $n)" "$ADA" "$ADA2" "$(printf 'c%02d: extend mod2' "$n")" ;;
      2) lines module 1 $((5 + i)) > "$r/src/mod3.txt"
         commit_as "$r" "$(hday $n)" "$GRACE" "$GRACE1" "$(printf 'c%02d: extend mod3' "$n")" ;;
      3) ver=$((ver + 1)); printf '{ "name": "history-fixture", "version": "0.0.%d" }\n' "$ver" > "$r/package.json"
         commit_as "$r" "$(hday $n)" "$BOT" "$BOT1" "$(printf 'c%02d: chore(deps): bump manifest to 0.0.%d' "$n" "$ver")" ;;
      *) lines module 1 $((5 + i)) > "$r/src/mod4.txt"
         commit_as "$r" "$(hday $n)" test test@example.com "$(printf 'c%02d: extend mod4' "$n")" ;;
    esac
    n=$((n + 1))
  done
  G -C "$r" tag -a v1.0.0 -m "annotated release 1.0.0"

  # preflight/a: one commit that collides with main, one that touches the same file elsewhere,
  # one that touches nothing else does. T10.11 predicts likely / possible / clean for these.
  G -C "$r" checkout -q -b preflight/a "$pfbase"
  { lines hot-preflight 1 3; lines hot 4 60; } > "$r/src/hot.txt"
  commit_as "$r" "$(hday 70)" "$GRACE" "$GRACE1" "p1: rewrite the top of hot.txt (collides with main)"
  { lines hot-preflight 1 3; lines hot 4 49; lines hot-preflight 50 52; lines hot 53 60; } > "$r/src/hot.txt"
  commit_as "$r" "$(hday 71)" "$GRACE" "$GRACE1" "p2: edit hot.txt far from main's hunks (same file, disjoint)"
  w "$r" src/pf-clean.txt "a file only preflight/a touches"$'\n'
  commit_as "$r" "$(hday 72)" "$GRACE" "$GRACE1" "p3: add a file nothing else touches (clean)"
  G -C "$r" checkout -q main

  G -C "$r" commit-graph write --reachable --changed-paths
  [ -f "$r/.git/objects/info/commit-graph" ] || { echo "history: commit-graph missing" >&2; exit 1; }
  [ "$(G -C "$r" rev-list --count main)" -ge 60 ] ||
    { echo "history: fewer than 60 commits on main" >&2; exit 1; }
}

# secrets: fake credentials planted in staged and unstaged hunks, one allowlisted, one hex sha.
build_secrets() {
  local r="$FIX/secrets"; mkdir -p "$r/config"; G -C "$r" init -q
  w "$r" README.md "# secrets fixture"$'\n'"Fake, non-functional credentials for the T10.7 scanner."$'\n'
  w "$r" config/settings.ini "[app]"$'\n'"name = diffgit"$'\n'"debug = false"$'\n'
  w "$r" config/deploy.sh '#!/bin/sh'$'\n''echo deploying'$'\n'
  w "$r" clean.txt "$(lines clean 1 5)"$'\n'
  commit "$r" "c1: clean base"
  # unstaged layer
  cat >> "$r/config/settings.ini" <<'EOF'
aws_access_key_id = AKIAIOSFODNN7EXAMPLE
github_token = ghp_0oP3xQz7LmT4vB9kY2wR6sN1dF8hJ5cA3eG0
release_commit = 9f2c0a1b7d4e6c8a3b5d7f9e1c2a4b6d8e0f2a4c
legacy_token = ghp_1aB2cD3eF4gH5iJ6kL7mN8oP9qR0sT1uV2wX # diffgit:allow-secret
EOF
  # staged layer
  cat >> "$r/config/deploy.sh" <<'EOF'
export ANTHROPIC_API_KEY=sk-ant-api03-7hQ2vLp9XcR4mZ0tK6yB3nW1dS8fA5gJ2eU7iO4rT9qY6xC3vN0bM8kH5lP2zD7wG4jF1sR6tY3uI9oA-QwErTyB
EOF
  cat > "$r/config/id_rsa" <<'EOF'
-----BEGIN RSA PRIVATE KEY-----
MIIBOgIBAAJBAJ9y7hQ2vLp9XcR4mZ0tK6yB3nW1dS8fA5gJ2eU7iO4rT9qY6xC3
vN0bM8kH5lP2zD7wG4jF1sR6tY3uI9oAQwErTyBhZ0kCAwEAAQJATl1vZmFrZWtl
-----END RSA PRIVATE KEY-----
EOF
  G -C "$r" add config/deploy.sh config/id_rsa
}

# hidden: an ignored dir with three files, an ignored file, skip-worktree, assume-unchanged,
# an 11 MB tracked file modified in the worktree, and a built-in-excluded .DS_Store.
build_hidden() {
  local r="$FIX/hidden"; mkdir -p "$r/src" "$r/dist"; G -C "$r" init -q
  w "$r" .gitignore "dist/"$'\n'".env.local"$'\n'
  w "$r" README.md "# hidden fixture"$'\n'
  w "$r" src/app.txt "$(lines app 1 5)"$'\n'
  w "$r" src/skipped.txt "$(lines skipped 1 5)"$'\n'
  w "$r" src/assumed.txt "$(lines assumed 1 5)"$'\n'
  awk 'BEGIN { for (i = 1; i <= 210000; i++) printf "huge tracked line %07d abcdefghijklmnopqrstuvwxyz\n", i }' > "$r/big.txt"
  commit "$r" "c1: tracked files including an 11 MB one"
  w "$r" dist/bundle.js "console.log(1)"$'\n'
  w "$r" dist/bundle.js.map "{}"$'\n'
  w "$r" dist/index.html "<html></html>"$'\n'
  w "$r" .env.local "TOKEN=local-only"$'\n'
  printf '\x00\x00\x00\x01Bud1' > "$r/.DS_Store"
  G -C "$r" update-index --skip-worktree src/skipped.txt
  G -C "$r" update-index --assume-unchanged src/assumed.txt
  w "$r" src/skipped.txt "$(lines skipped 1 5)"$'\n'"edited, but skip-worktree hides it"$'\n'
  w "$r" src/assumed.txt "$(lines assumed 1 5)"$'\n'"edited, but assume-unchanged hides it"$'\n'
  printf 'huge tracked line 9999999 modified in the worktree\n' >> "$r/big.txt"
  w "$r" notes.txt "untracked and visible"$'\n'
  [ "$(wc -c < "$r/big.txt" | tr -d ' ')" -gt 11000000 ] ||
    { echo "hidden: big.txt is under 11 MB" >&2; exit 1; }
}

# octopus: a three-parent merge.
build_octopus() {
  local r="$FIX/octopus"; mkdir -p "$r"; G -C "$r" init -q
  w "$r" base.txt "base"$'\n'
  commit "$r" "c1: root"
  G -C "$r" checkout -q -b side-a
  w "$r" a.txt "side a"$'\n'
  commit "$r" "a1: side-a commit"
  G -C "$r" checkout -q main
  G -C "$r" checkout -q -b side-b
  w "$r" b.txt "side b"$'\n'
  commit "$r" "b1: side-b commit"
  G -C "$r" checkout -q main
  w "$r" main.txt "main"$'\n'
  commit "$r" "c2: main moves on"
  G -C "$r" merge -q --no-ff -m "c3: octopus merge of side-a and side-b" side-a side-b >/dev/null
  [ "$(G -C "$r" rev-list --parents -n 1 HEAD | wc -w | tr -d ' ')" = 4 ] ||
    { echo "octopus: HEAD is not a three-parent merge" >&2; exit 1; }
  # T10.5b nit 1: the only fixture whose commit-graph needs an EDGE chunk (3rd..nth parents).
  G -C "$r" commit-graph write --reachable
  [ -f "$r/.git/objects/info/commit-graph" ] || { echo "octopus: commit-graph missing" >&2; exit 1; }
}

# ----------------------------------------------------------------------------------------------
# skew: committer dates that do NOT decrease monotonically toward the parents (T10.5b S1).
#
#   r --- P --- M            (main)            dates: r 00:00  P 08:00  M 09:00
#    \      \
#     T ----- C --- S        (side)            dates: T 03:00  C 05:00  S 07:00
#
# P is *newer* than its child C, which is the one shape a streaming topological release gets
# wrong: P becomes eligible (its only discovered child M was emitted) and, being the newest
# entry in the queue, is emitted before C is discovered at all. `git log --date-order` computes
# the indegree over the whole list first and prints M S C P T r.
# Built with `commit-tree` because only that lets every commit carry its own committer date.
build_skew() {
  local r="$FIX/skew"; mkdir -p "$r"; G -C "$r" init -q
  local root p m t c s
  # <content> -> tree oid
  skew_tree() {
    printf '%s\n' "$1" > "$r/file.txt"
    G -C "$r" add -A >/dev/null
    G -C "$r" write-tree
  }
  # <hh> <message> <parent...> -> commit oid
  skew_commit() {
    local hh="$1" msg="$2"; shift 2
    local args=() one
    for one in "$@"; do args+=(-p "$one"); done
    GIT_AUTHOR_DATE="2024-06-01T$hh:00:00Z" GIT_COMMITTER_DATE="2024-06-01T$hh:00:00Z" \
      G -C "$r" commit-tree "$(skew_tree "$msg")" ${args[@]+"${args[@]}"} -m "$msg"
  }
  root=$(skew_commit 00 "r: root")
  p=$(skew_commit 08 "P: parent newer than its child" "$root")
  m=$(skew_commit 09 "M: main tip" "$p")
  t=$(skew_commit 03 "T: side base" "$root")
  c=$(skew_commit 05 "C: merge of T and P, older than P" "$t" "$p")
  s=$(skew_commit 07 "S: side tip" "$c")
  G -C "$r" update-ref refs/heads/main "$m"
  G -C "$r" update-ref refs/heads/side "$s"
  G -C "$r" symbolic-ref HEAD refs/heads/main
  G -C "$r" reset -q --hard main
  [ "$(G -C "$r" log --date-order --format=%H --all | head -1)" = "$m" ] ||
    { echo "skew: unexpected --date-order head" >&2; exit 1; }
}

# ----------------------------------------------------------------------------------------------
main() {
  local before="" t0; t0=$(date +%s)
  if [ -d "$FIX/basic/.git" ]; then before=$(G -C "$FIX/basic" rev-parse feature 2>/dev/null || true); fi
  rm -rf "$FIX"; mkdir -p "$FIX" "$REMOTES"

  build_basic "$FIX/basic";   echo "  basic"
  build_renames;              echo "  renames"
  build_binary;               echo "  binary"
  build_worktree;             echo "  worktree"
  build_packed;               echo "  packed"
  build_remote;               echo "  remote"
  build_remote_master;        echo "  remote-master"
  build_no_origin_head;       echo "  no-origin-head"
  build_index_v4;             echo "  index-v4"
  build_index_v3;             echo "  index-v3"
  build_ignore;               echo "  ignore"
  build_detached;             echo "  detached"
  build_unborn;               echo "  unborn"
  build_unrelated;            echo "  unrelated"
  build_crlf;                 echo "  crlf"
  build_large;                echo "  large"
  build_embedded;             echo "  embedded"
  build_symlink;              echo "  symlink"
  build_worktree_gitdir;      echo "  worktree-gitdir"
  build_submodule;            echo "  submodule"
  build_jj;                   echo "  jj"
  build_lfs;                  echo "  lfs"
  build_crisscross;           echo "  crisscross"
  build_rebase_detached;      echo "  rebase-detached"
  build_attributes;           echo "  attributes"
  build_sha256;               echo "  sha256"
  build_alternates;           echo "  alternates"
  build_partial;              echo "  partial"
  if [ "${FIXTURES_PERF:-0}" = "1" ]; then
    build_perf_5k;            echo "  perf-5k"
    build_perf_log;           echo "  perf-log"
  fi
  build_tags;                 echo "  tags"
  build_stash;                echo "  stash"
  build_reflog_orphan;        echo "  reflog-orphan"
  build_history;              echo "  history"
  build_secrets;              echo "  secrets"
  build_hidden;               echo "  hidden"
  build_octopus;              echo "  octopus"
  build_skew;                 echo "  skew"
  build_conflict;             echo "  conflict (built last, never gc'd)"
  build_merge_conflict;       echo "  merge-conflict (mid-merge, never gc'd)"
  build_rebase_conflict;      echo "  rebase-conflict (mid-rebase, never gc'd)"
  build_cherry_pick_conflict; echo "  cherry-pick-conflict (mid-cherry-pick, never gc'd)"

  cp "$ROOT/scripts/fixtures-README.md" "$FIX/README.md"

  local after; after=$(G -C "$FIX/basic" rev-parse feature)
  if [ -n "$before" ]; then
    if [ "$before" = "$after" ]; then echo "determinism: basic/feature = $after (unchanged)";
    else echo "DETERMINISM FAILURE: basic/feature was $before, now $after" >&2; exit 1; fi
  else
    echo "determinism: basic/feature = $after (first build; rerun to verify)"
  fi
  echo "fixtures built in $(( $(date +%s) - t0 )) s"
}
main "$@"
