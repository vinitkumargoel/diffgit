import type { RepoRef, ResolvedRevision } from "../engine/types";

/** `tag` / `stash` are T11.2's picker groups; Design §3.3 lends them the `M` and `T` palettes. */
export type BadgeKind = "head" | "default" | "remote" | "tag" | "stash";

export interface RemoteGroup {
  remote: string; // "origin"
  refs: RepoRef[];
}

export interface RefGroups {
  /** Synthetic `HEAD (detached @ sha)` / `HEAD (no commits)` entry, pinned first (T1.4 amendment). */
  pinned: RepoRef[];
  local: RepoRef[];
  remotes: RemoteGroup[];
}

/** "origin" for `refs/remotes/origin/feature`; falls back to the display-name prefix. */
export function remoteName(ref: RepoRef): string {
  const parts = ref.fullName.split("/");
  if (parts[0] === "refs" && parts[1] === "remotes" && parts[2]) return parts[2];
  const slash = ref.name.indexOf("/");
  return slash > 0 ? ref.name.slice(0, slash) : "remote";
}

/**
 * Groups refs for the picker, preserving the engine's T1.4 order inside each group
 * (checked-out first, default second, then A→Z; remotes grouped by remote name A→Z).
 */
export function groupRefs(refs: readonly RepoRef[]): RefGroups {
  const pinned: RepoRef[] = [];
  const local: RepoRef[] = [];
  const byRemote = new Map<string, RepoRef[]>();
  for (const ref of refs) {
    if (ref.synthetic) pinned.push(ref);
    else if (ref.kind === "remote") {
      const remote = remoteName(ref);
      const list = byRemote.get(remote);
      if (list) list.push(ref);
      else byRemote.set(remote, [ref]);
    } else local.push(ref);
  }
  const remotes = [...byRemote.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([remote, list]) => ({ remote, refs: list }));
  return { pinned, local, remotes };
}

/** Badges shown next to a branch name (Design §7.1): HEAD, default, remote. */
export function refBadges(ref: RepoRef): BadgeKind[] {
  const out: BadgeKind[] = [];
  if (ref.isCheckedOut) out.push("head");
  if (ref.isDefault) out.push("default");
  if (ref.kind === "remote") out.push("remote");
  return out;
}

/** Finds a ref by full name ("refs/heads/x", "refs/remotes/o/x" or "HEAD"). */
export function findRef(refs: readonly RepoRef[], fullName: string): RepoRef | undefined {
  return refs.find((r) => r.fullName === fullName);
}

/**
 * A branch row as a revision (T11.2), without asking the engine to re-resolve what `RefStore`
 * already read. `HEAD` is the synthetic detached entry; everything else is a branch or a remote.
 */
export function revisionOfRef(ref: RepoRef): ResolvedRevision {
  return {
    expr: ref.fullName,
    oid: ref.oid,
    kind: ref.fullName === "HEAD" ? "head" : ref.kind === "remote" ? "remote" : "branch",
    display: ref.name,
    fullRef: ref.fullName,
  };
}
