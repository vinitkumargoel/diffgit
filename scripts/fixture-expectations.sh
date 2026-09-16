#!/usr/bin/env bash
# Dumps git's own answers for every fixture into fixtures/<name>/expected/*.json (T0.3).
# Engine parity tests compare against these files; they define "matches git".
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIX="$ROOT/fixtures"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 LC_ALL=C
command -v jq >/dev/null || { echo "jq is required (brew install jq / apt-get install jq)" >&2; exit 1; }

G() { git -c core.autocrlf=false -c core.untrackedCache=false -c core.fsmonitor=false -c diff.renameLimit=1000 "$@"; }

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

main() {
  local d name n=0
  for d in "$FIX"/*/; do
    name=$(basename "$d")
    case "$name" in _*) continue ;; esac
    [ -e "$d/.git" ] || continue
    dump "$name"; n=$((n + 1))
  done
  echo "expectations written for $n fixtures"
}
main "$@"
