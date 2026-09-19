/**
 * RefStore (T1.4, Plan §5.3, D8, D9): HEAD state, branch list (local + every remote in config),
 * default branch, sort order, and the synthetic `HEAD` entry for detached/unborn repos.
 * All ref resolution goes through ObjectDb; only `HEAD` is read raw (via `readSymref`).
 */
import type { Oid, RefSnapshot, RepoRef } from "../types";
import type { GitConfig } from "./config";
import type { ObjectDb } from "./objectDb";

export type { RefSnapshot };

function byName(a: RepoRef, b: RepoRef): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function sortRefs(refs: RepoRef[]): RepoRef[] {
  const synthetic = refs.filter((r) => r.synthetic);
  const checkedOut = refs.filter((r) => !r.synthetic && r.isCheckedOut);
  const def = refs.filter((r) => !r.synthetic && !r.isCheckedOut && r.isDefault);
  const locals = refs
    .filter((r) => !r.synthetic && !r.isCheckedOut && !r.isDefault && r.kind === "local")
    .sort(byName);
  const remotes = refs
    .filter((r) => !r.synthetic && !r.isCheckedOut && !r.isDefault && r.kind === "remote")
    .sort((a, b) => {
      const ra = a.fullName.split("/")[2] ?? "";
      const rb = b.fullName.split("/")[2] ?? "";
      return ra < rb ? -1 : ra > rb ? 1 : byName(a, b);
    });
  return [...synthetic, ...checkedOut, ...def, ...locals, ...remotes];
}

/** What `loadRefs` needs to know about the repository beyond its config (T10.12). */
export interface RefLoadOptions {
  /**
   * A colocated jujutsu workspace (`.jj/` beside `.git/`). jj checks its working-copy commit out
   * with a detached git HEAD as a matter of course, so calling that "detached" would put a scary
   * label on every jj repository. `RefSnapshot.detached` stays true — it is a fact about `.git/HEAD`
   * that every other reader depends on — but `headDisplay` reads `jj working copy @ <sha7>`, and
   * nothing raises an information banner about the detachment (atlas tab 19).
   */
  jj?: boolean;
}

export async function loadRefs(
  db: ObjectDb,
  config: GitConfig,
  opts: RefLoadOptions = {},
): Promise<RefSnapshot> {
  // ---- HEAD ----
  const headTarget = await db.readSymref("HEAD");
  let headBranch: string | null = null;
  let headOid: Oid | null = null;
  let detached = false;
  let unborn = false;
  if (headTarget !== null) {
    headBranch = headTarget.startsWith("refs/heads/")
      ? headTarget.slice("refs/heads/".length)
      : headTarget;
    headOid = await db.tryResolveRef(headTarget);
    if (headOid === null) unborn = true;
  } else {
    detached = true;
    headOid = await db.tryResolveRef("HEAD");
  }

  // ---- branches ----
  const refs: RepoRef[] = [];
  for (const name of await db.listLocalBranches()) {
    const fullName = `refs/heads/${name}`;
    const oid = await db.tryResolveRef(fullName);
    if (oid === null) continue; // dangling ref file: git would complain; we skip it
    refs.push({
      name,
      fullName,
      kind: "local",
      oid,
      isDefault: false,
      isCheckedOut: !detached && !unborn && headBranch === name,
    });
  }
  for (const remote of config.remotes) {
    for (const branch of await db.listRemoteBranches(remote)) {
      const fullName = `refs/remotes/${remote}/${branch}`;
      const oid = await db.tryResolveRef(fullName);
      if (oid === null) continue;
      refs.push({
        name: `${remote}/${branch}`,
        fullName,
        kind: "remote",
        oid,
        isDefault: false,
        isCheckedOut: false,
      });
    }
  }

  // ---- default branch (D8) ----
  const find = (fullName: string) => refs.find((r) => r.fullName === fullName);
  let defaultRef: RepoRef | undefined;
  const originHead = await db.readSymref("refs/remotes/origin/HEAD");
  if (originHead?.startsWith("refs/remotes/origin/")) {
    const x = originHead.slice("refs/remotes/origin/".length);
    defaultRef = find(`refs/remotes/origin/${x}`) ?? find(`refs/heads/${x}`);
  }
  defaultRef ??= find("refs/heads/main");
  defaultRef ??= find("refs/heads/master");
  if (!defaultRef && headBranch !== null && !unborn) defaultRef = find(`refs/heads/${headBranch}`);
  if (defaultRef) defaultRef.isDefault = true;

  // ---- synthetic HEAD entry (detached / unborn) ----
  const headDisplay = detached
    ? opts.jj === true
      ? `jj working copy @ ${(headOid ?? "").slice(0, 7)}`
      : `HEAD (detached @ ${(headOid ?? "").slice(0, 7)})`
    : unborn
      ? "HEAD (no commits)"
      : (headBranch as string);
  if (detached || unborn) {
    refs.push({
      name: headDisplay,
      fullName: "HEAD",
      kind: "local",
      oid: headOid ?? "",
      isDefault: false,
      isCheckedOut: true,
      synthetic: true,
    });
  }

  return {
    headBranch: detached ? null : headBranch,
    headOid,
    detached,
    unborn,
    headDisplay,
    refs: sortRefs(refs),
    defaultRef: defaultRef ?? null,
  };
}
