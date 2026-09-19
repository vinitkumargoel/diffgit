#!/usr/bin/env bash
# Dumps git's own answers for every fixture into fixtures/<name>/expected/*.json (T0.3).
# Engine parity tests compare against these files; they define "matches git".
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIX="$ROOT/fixtures"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 LC_ALL=C
# The preflight replay (T10.0) rebases throwaway clones, so it needs the same fixed identity/date.
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
export GIT_AUTHOR_DATE="2024-01-01T00:00:00Z" GIT_COMMITTER_DATE="2024-01-01T00:00:00Z"
command -v jq >/dev/null || { echo "jq is required (brew install jq / apt-get install jq)" >&2; exit 1; }

G() {
  git -c core.autocrlf=false -c core.untrackedCache=false -c core.fsmonitor=false \
      -c diff.renameLimit=1000 -c protocol.file.allow=always -c advice.detachedHead=false \
      -c commit.gpgsign=false -c core.hooksPath=/dev/null -c gc.auto=0 "$@"
}

# git diff -z --name-status → [{status, similarity, oldPath, newPath}]
name_status_json() { # name_status_json <repo> <git diff args...>
  local r="$1"; shift
  G -C "$r" diff -z --name-status "$@" | jq -R -s '
    def parse: if length == 0 then [] else
      .[0] as $s |
      if ($s | test("^[RC]")) then
        [{status: $s[0:1], similarity: ($s[1:] | tonumber), oldPath: .[1], newPath: .[2]}] + (.[3:] | parse)
      else
        [{status: $s, similarity: null,
          oldPath: (if $s == "A" then null else .[1] end),
          newPath: (if $s == "D" then null else .[1] end)}] + (.[2:] | parse)
      end end;
    split("\u0000") | map(select(length > 0)) | parse'
}

# git diff -z --numstat → [{additions, deletions, path, oldPath}] (null counts = binary)
numstat_json() { # numstat_json <repo> <git diff args...>
  local r="$1"; shift
  G -C "$r" diff -z --numstat "$@" | jq -R -s '
    def num: if . == "-" then null else tonumber end;
    def parse: if length == 0 then [] else
      (.[0] | split("\t")) as $p |
      if $p[2] == "" then
        [{additions: ($p[0] | num), deletions: ($p[1] | num), path: .[2], oldPath: .[1]}] + (.[3:] | parse)
      else
        [{additions: ($p[0] | num), deletions: ($p[1] | num), path: $p[2], oldPath: null}] + (.[1:] | parse)
      end end;
    split("\u0000") | map(select(length > 0)) | parse'
}

ls_tree_json() { # ls_tree_json <repo> <oid>
  G -C "$1" ls-tree -r "$2" | jq -R -s '
    split("\n") | map(select(length > 0)) | map(
      (split("\t")) as $t | ($t[0] | split(" ")) as $m |
      {mode: $m[0], type: $m[1], oid: $m[2], path: $t[1]})'
}

ls_files_json() {
  G -C "$1" ls-files -s | jq -R -s '
    split("\n") | map(select(length > 0)) | map(
      (split("\t")) as $t | ($t[0] | split(" ")) as $m |
      {mode: $m[0], oid: $m[1], stage: ($m[2] | tonumber), path: $t[1]})'
}

status_json() {
  G -C "$1" status --porcelain=v2 --untracked-files=all | jq -R -s '
    split("\n") | map(select(length > 0)) | map(
      split(" ") as $f |
      if $f[0] == "1" then {type: "1", xy: $f[1], sub: $f[2], mH: $f[3], mI: $f[4], mW: $f[5], hH: $f[6], hI: $f[7], path: ($f[8:] | join(" "))}
      elif $f[0] == "2" then (($f[9:] | join(" ")) | split("\t")) as $p |
        {type: "2", xy: $f[1], sub: $f[2], mH: $f[3], mI: $f[4], mW: $f[5], hH: $f[6], hI: $f[7], score: $f[8], path: $p[0], origPath: $p[1]}
      elif $f[0] == "u" then {type: "u", xy: $f[1], sub: $f[2], m1: $f[3], m2: $f[4], m3: $f[5], mW: $f[6], h1: $f[7], h2: $f[8], h3: $f[9], path: ($f[10:] | join(" "))}
      elif $f[0] == "?" then {type: "?", path: ($f[1:] | join(" "))}
      elif $f[0] == "!" then {type: "!", path: ($f[1:] | join(" "))}
      else {type: "#", raw: .} end)'
}

refs_json() {
  local r="$1" head originHead headOid
  head=$(G -C "$r" symbolic-ref -q HEAD || G -C "$r" rev-parse HEAD 2>/dev/null || echo "")
  originHead=$(G -C "$r" symbolic-ref -q refs/remotes/origin/HEAD 2>/dev/null || echo "")
  headOid=$(G -C "$r" rev-parse -q --verify HEAD 2>/dev/null || echo "")
  G -C "$r" for-each-ref --format='%(refname) %(objectname)' | jq -R -s \
    --arg head "$head" --arg originHead "$originHead" --arg headOid "$headOid" '
    {refs: (split("\n") | map(select(length > 0)) | map(split(" ") | {key: .[0], value: .[1]}) | from_entries),
     head: (if $head == "" then null else $head end),
     headOid: (if $headOid == "" then null else $headOid end),
     originHead: (if $originHead == "" then null else $originHead end)}'
}

check_ignore_json() { # check_ignore_json <repo> <paths...>
  local r="$1"; shift
  # exit status 1 = nothing ignored, which is fine; only >1 is an error
  local out; out=$(G -C "$r" check-ignore -v --no-index --non-matching "$@" || [ $? -eq 1 ])
  printf '%s\n' "$out" | jq -R -s '
    split("\n") | map(select(length > 0)) | map(
      split("\t") as $t | ($t[0] | split(":")) as $r |
      {path: $t[1], source: (if $r[0] == "" then null else $r[0] end),
       line: (if $r[1] == "" then null else ($r[1] | tonumber) end),
       pattern: (if $r[2] == "" then null else ($r[2:] | join(":")) end),
       ignored: ($r[2] != "" and ($r[2] | startswith("!") | not))})'
}

hash_object_json() { # hash_object_json <repo> <paths...>
  local r="$1"; shift
  local p
  { for p in "$@"; do [ -f "$r/$p" ] && printf '%s %s\n' "$p" "$(G -C "$r" hash-object "$p")"; done; } |
    jq -R -s 'split("\n") | map(select(length > 0)) | map(split(" ") | {key: .[0], value: .[1]}) | from_entries'
}

dump() { # dump <fixture-name>
  local name="$1" r="$FIX/$1" exp="$FIX/$1/expected"
  mkdir -p "$exp"
  # expected/ lives inside the worktree; exclude it in .git/info/exclude so neither git nor the
  # engine (which reads info/exclude) reports it as untracked. Idempotent.
  local excl; excl="$(G -C "$r" rev-parse --git-path info/exclude)"
  case "$excl" in /*) ;; *) excl="$r/$excl" ;; esac
  [ -f "$excl" ] || { mkdir -p "$(dirname "$excl")"; : > "$excl"; }
  grep -qx 'expected/' "$excl" 2>/dev/null || printf 'expected/\n' >> "$excl"
  refs_json "$r" > "$exp/refs.json"
  ls_files_json "$r" > "$exp/ls-files-s.json"
  status_json "$r" > "$exp/status-porcelain-v2.json"

  local default="" headBranch mb="" range=""
  if G -C "$r" rev-parse -q --verify refs/heads/main >/dev/null; then default=main
  elif G -C "$r" rev-parse -q --verify refs/heads/master >/dev/null; then default=master; fi
  headBranch=$(G -C "$r" symbolic-ref -q --short HEAD || echo "")
  local hasHead=1; G -C "$r" rev-parse -q --verify HEAD >/dev/null || hasHead=0
  local hasFeature=1; G -C "$r" rev-parse -q --verify refs/heads/feature >/dev/null || hasFeature=0

  if [ "$hasHead" = 1 ] && [ -n "$default" ] && [ "$hasFeature" = 1 ]; then
    mb=$(G -C "$r" merge-base "$default" feature 2>/dev/null || echo "")
    if [ -n "$mb" ]; then range="$mb feature"; else range="$default feature"; fi   # unrelated → two-dot
    jq -n --arg mb "$mb" '{feature: (if $mb == "" then null else $mb end)}' > "$exp/merge-base.json"
    (G -C "$r" merge-base --all "$default" feature 2>/dev/null || true) | jq -R -s 'split("\n") | map(select(length > 0))' > "$exp/merge-base-all.json"
    # shellcheck disable=SC2086
    name_status_json "$r" -M $range > "$exp/name-status-3dot.json"
    # shellcheck disable=SC2086
    name_status_json "$r" --no-renames $range > "$exp/name-status-3dot-no-renames.json"
    # shellcheck disable=SC2086
    numstat_json "$r" $range > "$exp/numstat.json"
    # shellcheck disable=SC2086
    numstat_json "$r" -w $range > "$exp/numstat-w.json"
    local defaultOid featureOid tmp
    defaultOid=$(G -C "$r" rev-parse "$default"); featureOid=$(G -C "$r" rev-parse feature)
    # Large trees (perf-5k) exceed the argv limit for --argjson: pass them through files instead.
    tmp=$(mktemp -d)
    if [ -n "$mb" ]; then ls_tree_json "$r" "$mb" > "$tmp/base.json"; else echo null > "$tmp/base.json"; fi
    ls_tree_json "$r" "$defaultOid" > "$tmp/default.json"
    ls_tree_json "$r" "$featureOid" > "$tmp/feature.json"
    jq -n --arg base "$mb" --arg d "$default" --arg dOid "$defaultOid" --arg fOid "$featureOid" \
      --slurpfile baseTree "$tmp/base.json" --slurpfile defaultTree "$tmp/default.json" --slurpfile featureTree "$tmp/feature.json" \
      '{base: (if $base == "" then null else $base end), default: $d, defaultOid: $dOid, featureOid: $fOid,
        trees: ({} | .[$dOid] = $defaultTree[0] | .[$fOid] = $featureTree[0] | if $base != "" then .[$base] = $baseTree[0] else . end)}' > "$exp/ls-tree.json"
    # working-tree layer: worktree vs merge-base, plus untracked paths
    local wtBase="$mb"; [ -z "$wtBase" ] && wtBase="$default"
    name_status_json "$r" --no-renames "$wtBase" > "$tmp/changes.json"
    jq '[.[] | select(.type == "?") | .path]' "$exp/status-porcelain-v2.json" > "$tmp/untracked.json"
    jq -n --arg base "$wtBase" --slurpfile changes "$tmp/changes.json" --slurpfile untracked "$tmp/untracked.json" \
      '{base: $base, changes: $changes[0], untracked: $untracked[0]}' > "$exp/worktree-layer.json"
    rm -rf "$tmp"
  fi
  jq -n --arg name "$name" --arg default "$default" --arg headBranch "$headBranch" --arg mb "$mb" --arg range "$range" \
    --argjson hasHead "$hasHead" --argjson hasFeature "$hasFeature" \
    '{name: $name, default: (if $default == "" then null else $default end), headBranch: (if $headBranch == "" then null else $headBranch end),
      unborn: ($hasHead == 0), hasFeature: ($hasFeature == 1), mergeBase: (if $mb == "" then null else $mb end),
      diffRange: (if $range == "" then null else $range end)}' > "$exp/meta.json"

  case "$name" in
    basic|packed) hash_object_json "$r" README.md src/a.txt src/c.txt docs/guide.md src/new.txt > "$exp/hash-object.json" ;;
    large) hash_object_json "$r" big-change.txt medium.txt huge.txt > "$exp/hash-object.json" ;;
    ignore) check_ignore_json "$r" build/x a.log src/keep.log src/other.log secret.txt node_modules/pkg/index.js \
              ignored-dir/tracked.txt ignored-dir/untracked.txt notes.txt src/main.txt README.md build/ node_modules/ > "$exp/check-ignore.json" ;;
  esac
}

# ----------------------------------------------------------------------------------------------
# v2 expectations (T10.0). Plain-text dumps of git's own answers, one file per command, under
# fixtures/<name>/expected/*.txt. Named in docs/v2-contracts.md § "Fixtures to add".

TAG_FMT='%(refname) %(objecttype) %(objectname) %(*objectname)'

rev_parse_txt() { # rev_parse_txt <repo> <expr...>   →  "<expr>\t<oid|<unresolved>>"
  local r="$1"; shift
  local e out
  for e in "$@"; do
    out=$(G -C "$r" rev-parse --verify --quiet "$e" 2>/dev/null || true)
    printf '%s\t%s\n' "$e" "${out:-<unresolved>}"
  done
}

# T10.1 range parity: one line per changed path, prefixed with the range label.
range_ns() { # range_ns <repo> <label> <git diff args...>
  local r="$1" label="$2"; shift 2
  G -C "$r" diff --name-status "$@" | awk -v l="$label" 'NF{print l "\t" $0}'
}
show_ns() { # show_ns <repo> <label> <rev>
  local r="$1" label="$2" rev="$3"
  G -C "$r" show --name-status --format= "$rev" | awk -v l="$label" 'NF{print l "\t" $0}'
}
EMPTY_TREE=4b825dc642cb6eb9a060e54bf8d69288fbee4904

# The midpoint sequence `git bisect` would visit, replaying "the midpoint is always good".
bisect_sequence() { # bisect_sequence <repo> <good> <bad>
  local r="$1" good="$2" bad="$3" i=0 mid remaining
  while :; do
    remaining=$(G -C "$r" rev-list --count "$bad" "^$good")
    mid=$(G -C "$r" rev-list --bisect "$bad" "^$good")
    printf 'step %d good %s bad %s remaining %s midpoint %s\n' "$i" "$good" "$bad" "$remaining" "$mid"
    if [ "$remaining" -le 1 ] || [ "$mid" = "$bad" ] || [ "$i" -gt 32 ]; then break; fi
    good="$mid"; i=$((i + 1))
  done
  return 0
}

state_files() { # state_files <dir> <file...>
  local d="$1"; shift
  local f
  for f in "$@"; do
    if [ -f "$d/$f" ]; then printf '%s\t%s\n' "$f" "$(tr -d '\n' < "$d/$f")"; else printf '%s\t<absent>\n' "$f"; fi
  done
}

# The real `git rebase` outcome for history's preflight/a, recorded on throwaway clones so the
# fixture itself is never touched (T10.11 grades its predictions against this).
record_preflight_outcome() {
  local src="$FIX/history" out="$FIX/history/expected/preflight-outcome.txt"
  local tmp="$FIX/_tmp-preflight" mb commits c rc guard orig
  rm -rf "$tmp"
  G clone -q --no-hardlinks --branch preflight/a "$src" "$tmp" 2>/dev/null
  G -C "$tmp" branch -q -f main origin/main
  mb=$(G -C "$tmp" merge-base main preflight/a)
  commits=$(G -C "$tmp" rev-list --reverse "$mb..preflight/a")
  {
    echo "# real 'git rebase' outcomes for preflight/a onto main, run on throwaway clones of fixtures/history"
    echo "branch preflight/a"
    echo "onto main"
    echo "merge-base $mb"
    echo "## git rebase main preflight/a"
  } > "$out"
  rc=0; guard=0
  G -C "$tmp" rebase main >/dev/null 2>&1 || rc=1
  while [ "$rc" != 0 ]; do
    guard=$((guard + 1))
    [ "$guard" -le 8 ] || { echo "preflight: rebase never finished" >&2; exit 1; }
    orig=$(G -C "$tmp" rev-parse REBASE_HEAD)
    printf 'stopped %s %s\n' "$orig" "$(G -C "$src" log -1 --format=%s "$orig")" >> "$out"
    G -C "$tmp" diff --name-only --diff-filter=U | sed 's/^/  conflicted /' >> "$out"
    rc=0; G -C "$tmp" rebase --skip >/dev/null 2>&1 || rc=1
  done
  printf 'completed %s\n' "$(G -C "$tmp" rev-list --count "main..HEAD")" >> "$out"
  rm -rf "$tmp"

  echo "## git rebase --onto main <commit>^ <commit>, one commit at a time" >> "$out"
  for c in $commits; do
    rm -rf "$tmp"
    G clone -q --no-hardlinks --branch preflight/a "$src" "$tmp" 2>/dev/null
    G -C "$tmp" branch -q -f main origin/main
    rc=0
    G -C "$tmp" rebase --onto main "$c^" "$c" >/dev/null 2>&1 || rc=1
    if [ "$rc" = 0 ]; then
      printf 'commit %s clean %s\n' "$c" "$(G -C "$src" log -1 --format=%s "$c")" >> "$out"
    else
      printf 'commit %s conflict %s\n' "$c" "$(G -C "$src" log -1 --format=%s "$c")" >> "$out"
      G -C "$tmp" diff --name-only --diff-filter=U | sed 's/^/  conflicted /' >> "$out"
      G -C "$tmp" rebase --abort >/dev/null 2>&1 || true
    fi
    rm -rf "$tmp"
  done
}

# T10.5: what the Branches table (Design §14.6) says per branch, in git's own words.
branch_table() { # branch_table <repo> <expected-dir>
  local r="$1" exp="$2" def=""
  G -C "$r" for-each-ref --format='%(refname)|%(upstream:short)|%(upstream:track,nobracket)' \
    refs/heads > "$exp/branch-upstream.txt"
  if G -C "$r" rev-parse -q --verify refs/heads/main >/dev/null; then def=main
  elif G -C "$r" rev-parse -q --verify refs/heads/master >/dev/null; then def=master; fi
  [ -n "$def" ] && G -C "$r" branch --merged "$def" --format='%(refname)' > "$exp/branch-merged.txt"
}

# T10.5: the three orderings the commit walker must reproduce, from HEAD so every fixture answers.
log_orders() { # log_orders <repo> <expected-dir>
  local r="$1" exp="$2"
  G -C "$r" log --date-order --format=%H --all > "$exp/log-all-date-order.txt"
  G -C "$r" log --date-order --format=%H HEAD > "$exp/log-head-date-order.txt"
  G -C "$r" log --date-order --first-parent --format=%H HEAD > "$exp/log-head-first-parent.txt"
}

dump_v2() { # dump_v2 <fixture-name>
  local name="$1" r="$FIX/$1" exp="$FIX/$1/expected" root
  case "$name" in
    tags|stash|reflog-orphan|history|secrets|hidden|octopus|merge-conflict|rebase-conflict|cherry-pick-conflict) ;;
    # T10.5 walker parity only: a criss-cross merge, a detached HEAD and the 5,000-file perf repo.
    crisscross|detached|perf-5k) log_orders "$r" "$exp"; return 0 ;;
    # T10.5 Branches table only: the three fixtures that configure an upstream.
    remote|remote-master|no-origin-head) branch_table "$r" "$exp"; return 0 ;;
    *) return 0 ;;
  esac
  G -C "$r" status --porcelain=v1 --branch --untracked-files=all > "$exp/status.txt"
  log_orders "$r" "$exp"
  branch_table "$r" "$exp"

  case "$name" in
    tags)
      G -C "$r" tag -l --format="$TAG_FMT" > "$exp/tag-list.txt"
      rev_parse_txt "$r" HEAD main main~1 main~2 release refs/heads/release \
        v0.1.0 v0.2.0 v1.0.0 'v1.0.0^{}' 'v1.0.0^{commit}' v1.1.0 refs/tags/v1.0.0 > "$exp/rev-parse.txt"
      { range_ns "$r" 'v0.1.0..v1.0.0' v0.1.0 v1.0.0
        range_ns "$r" 'v0.1.0...v1.0.0' v0.1.0...v1.0.0
        show_ns  "$r" 'show v1.0.0' 'v1.0.0^{}'
      } > "$exp/range-name-status.txt"
      ;;
    stash)
      G -C "$r" stash list --format='%gd %H %s' > "$exp/stash-list.txt"
      { G -C "$r" rev-list --parents -n 1 'stash@{0}'
        G -C "$r" rev-list --parents -n 1 'stash@{1}'; } > "$exp/stash-parents.txt"
      rev_parse_txt "$r" HEAD main 'stash@{0}' 'stash@{0}^' 'stash@{0}^2' 'stash@{0}^3' \
        'stash@{1}' 'stash@{1}^' 'stash@{1}^2' 'stash@{1}^3' > "$exp/rev-parse.txt"
      { range_ns "$r" 'HEAD..stash@{0}' HEAD 'stash@{0}'
        range_ns "$r" 'HEAD..stash@{0}^2' HEAD 'stash@{0}^2'
        range_ns "$r" 'HEAD..stash@{0}^3' HEAD 'stash@{0}^3'
        range_ns "$r" 'HEAD..stash@{1}' HEAD 'stash@{1}'
      } > "$exp/range-name-status.txt"
      ;;
    reflog-orphan)
      G -C "$r" reflog --format='%H %gs' > "$exp/reflog.txt"
      G -C "$r" reflog --format='%gd %H %gs' > "$exp/reflog-selectors.txt"
      comm -13 <(G -C "$r" rev-list --all | sort -u) <(G -C "$r" reflog --format=%H | sort -u) > "$exp/orphan.txt"
      ;;
    history)
      root=$(G -C "$r" rev-list --max-parents=0 main)
      G -C "$r" reflog --format='%H %gs' > "$exp/reflog.txt"   # T10.2 parity oracle
      G -C "$r" log --graph --oneline --date-order --all > "$exp/log-graph.txt"
      G -C "$r" log --date-order --format=%H main > "$exp/log-main-date-order.txt"
      G -C "$r" log --date-order --first-parent --format=%H main > "$exp/log-main-first-parent.txt"
      G -C "$r" log --format=%H main -- src/hot.txt > "$exp/log-path-hot.txt"
      G -C "$r" log --format=%H main -- src/renamed-to.txt > "$exp/log-path-renamed.txt"
      G -C "$r" log --follow --format=%H main -- src/renamed-to.txt > "$exp/log-follow-renamed.txt"
      G -C "$r" blame --porcelain main -- src/hot.txt > "$exp/blame-src-hot.txt"
      G -C "$r" blame -w --porcelain main -- src/hot.txt > "$exp/blame-src-hot-w.txt"
      G -C "$r" blame --porcelain main -- src/renamed-to.txt > "$exp/blame-src-renamed-to.txt"
      G -C "$r" blame -w --porcelain main -- src/renamed-to.txt > "$exp/blame-src-renamed-to-w.txt"
      G -C "$r" blame --porcelain main -- src/indent.txt > "$exp/blame-src-indent.txt"
      G -C "$r" blame -w --porcelain main -- src/indent.txt > "$exp/blame-src-indent-w.txt"
      { printf 'main...topic\t%s\n' "$(G -C "$r" rev-list --left-right --count main...topic)"
        printf 'main...preflight/a\t%s\n' "$(G -C "$r" rev-list --left-right --count main...preflight/a)"
        printf 'main...preflight/base\t%s\n' "$(G -C "$r" rev-list --left-right --count main...preflight/base)"
      } > "$exp/rev-list-left-right-count.txt"
      # T10.5: numstat of every commit against its first parent, which is what `commitStats` computes
      # (rename detection on, exactly as `git show` runs it by default).
      { for c in $(G -C "$r" rev-list --all); do
          printf 'commit %s\n' "$c"
          G -C "$r" show --format= --numstat --first-parent "$c"
        done; } | sed '/^$/d' > "$exp/commit-numstat.txt"
      G -C "$r" log -S'hot-main' --format=%H main > "$exp/log-S-hot-main.txt"
      G -C "$r" log -S'renamed payload marker' --format=%H main > "$exp/log-S-payload.txt"
      G -C "$r" shortlog -sn --no-merges main > "$exp/shortlog.txt"
      G -C "$r" shortlog -sne --no-merges main > "$exp/shortlog-email.txt"
      G -C "$r" tag -l --format="$TAG_FMT" > "$exp/tag-list.txt"
      G -C "$r" log --format= --name-only main | sed '/^$/d' | sort | uniq -c | sort -rn > "$exp/name-only-counts.txt"
      bisect_sequence "$r" "$root" "$(G -C "$r" rev-parse main)" > "$exp/rev-list-bisect.txt"
      rev_parse_txt "$r" HEAD main main~1 main~5 'main^' 'main^2' refs/heads/main topic \
        preflight/a 'preflight/a~2' preflight/base v0.1.0 v0.3.0 v1.0.0 'v1.0.0^{}' \
        "$root" "${root:0:7}" "${root}^" > "$exp/rev-parse.txt"
      { range_ns "$r" 'main~5..main' main~5 main
        range_ns "$r" 'main~5...main' main~5...main
        range_ns "$r" 'topic...main' topic...main
        range_ns "$r" 'empty..root' "$EMPTY_TREE" "$root"
        show_ns  "$r" 'show main' main
        show_ns  "$r" 'show root' "$root"
      } > "$exp/range-name-status.txt"
      record_preflight_outcome
      ;;
    secrets)
      G -C "$r" diff > "$exp/diff-unstaged.txt"
      G -C "$r" diff --cached > "$exp/diff-staged.txt"
      ;;
    hidden)
      G -C "$r" check-ignore -v --no-index --non-matching \
        dist dist/bundle.js dist/bundle.js.map dist/index.html .env.local .DS_Store \
        src/app.txt src/skipped.txt src/assumed.txt big.txt notes.txt README.md \
        > "$exp/check-ignore.txt" || [ $? -eq 1 ]
      G -C "$r" ls-files -v > "$exp/ls-files-v.txt"
      G -C "$r" status --porcelain=v1 --untracked-files=all --ignored=matching > "$exp/status-ignored.txt"
      ;;
    octopus)
      G -C "$r" log --graph --oneline --date-order --all > "$exp/log-graph.txt"
      G -C "$r" rev-list --parents -n 1 HEAD > "$exp/merge-parents.txt"
      { for c in $(G -C "$r" rev-list --all); do
          printf 'commit %s\n' "$c"
          G -C "$r" show --format= --numstat --first-parent "$c"
        done; } | sed '/^$/d' > "$exp/commit-numstat.txt"
      ;;
    merge-conflict)
      G -C "$r" ls-files -u > "$exp/ls-files-u.txt"
      G -C "$r" reflog --format='%H %gs' > "$exp/reflog.txt"
      state_files "$(G -C "$r" rev-parse --absolute-git-dir)" MERGE_HEAD MERGE_MODE ORIG_HEAD > "$exp/operation.txt"
      ;;
    cherry-pick-conflict)
      G -C "$r" ls-files -u > "$exp/ls-files-u.txt"
      G -C "$r" reflog --format='%H %gs' > "$exp/reflog.txt"
      state_files "$(G -C "$r" rev-parse --absolute-git-dir)" CHERRY_PICK_HEAD ORIG_HEAD > "$exp/operation.txt"
      ;;
    rebase-conflict)
      G -C "$r" ls-files -u > "$exp/ls-files-u.txt"
      G -C "$r" reflog --format='%H %gs' > "$exp/reflog.txt"
      { local d; d="$(G -C "$r" rev-parse --absolute-git-dir)/rebase-merge"
        state_files "$d" msgnum end onto head-name orig-head stopped-sha interactive
        echo "git-rebase-todo"; sed 's/^/  /' "$d/git-rebase-todo"
        echo "done"; sed 's/^/  /' "$d/done"
      } > "$exp/operation.txt"
      ;;
  esac
}

# Every recorded .txt must exist and carry something; an empty one is a silently broken expectation.
check_txt_non_empty() {
  local f bad=0
  for f in "$FIX"/*/expected/*.txt; do
    [ -e "$f" ] || continue
    if [ ! -s "$f" ]; then echo "EMPTY EXPECTATION: $f" >&2; bad=1; fi
  done
  [ "$bad" = 0 ] || exit 1
}

main() {
  local d name n=0
  for d in "$FIX"/*/; do
    name=$(basename "$d")
    case "$name" in _*) continue ;; esac
    [ -e "$d/.git" ] || continue
    dump "$name"; dump_v2 "$name"; n=$((n + 1))
  done
  check_txt_non_empty
  echo "expectations written for $n fixtures"
}
main "$@"
