#!/usr/bin/env bash
# Builds every fixture repository under fixtures/ with the real git CLI (T0.3).
# Idempotent: deletes and rebuilds fixtures/. Deterministic: fixed author/committer identity and
# dates, no global/system git config. Run `FIXTURES_PERF=1` to also build `perf-5k`.
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
  build_crisscross;           echo "  crisscross"
  build_rebase_detached;      echo "  rebase-detached"
  build_attributes;           echo "  attributes"
  build_sha256;               echo "  sha256"
  build_alternates;           echo "  alternates"
  build_partial;              echo "  partial"
  if [ "${FIXTURES_PERF:-0}" = "1" ]; then build_perf_5k; echo "  perf-5k"; fi
  build_conflict;             echo "  conflict (built last, never gc'd)"

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
