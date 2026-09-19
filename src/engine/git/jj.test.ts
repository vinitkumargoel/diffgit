/**
 * T10.12 — a colocated jujutsu repository (atlas tab 19).
 *
 * jj writes an ordinary `.git`, so everything is readable; what changes is how the reading is
 * *labelled*. jj checks its working-copy commit out with a **detached git HEAD** as a matter of
 * course, so the generic `HEAD (detached @ ab12cd3)` display and any "you are in a detached HEAD"
 * notice would fire on every jj repository and mean nothing. `fixtures/jj` is a repository in
 * exactly that state, with an empty `.jj/` beside `.git/`.
 *
 * `RefSnapshot.detached` itself stays true — it is a fact about `.git/HEAD` that the revision
 * resolver, the operation detector and the branch table all depend on. Only `headDisplay` changes.
 */
import { describe, expect, test } from "bun:test";
import { fixturePath, loadExpectedText } from "../../test/fixtures";
import type { ProgressSink } from "../api";
import { NodeDirHandle } from "../fs/nodeDirHandle";
import { RepoSession } from "../session";
import type { RepoWarning } from "../types";

function recordingSink(): ProgressSink & { warnings: RepoWarning[] } {
  const warnings: RepoWarning[] = [];
  return { warnings, onProgress() {}, onStats() {}, onWarning() {} };
}

async function open(name: string, id: string) {
  const sink = recordingSink();
  const session = await RepoSession.open(await NodeDirHandle.open(fixturePath(name)), sink, { id });
  return { session, sink };
}

/** `git rev-parse HEAD` in the fixture, recorded by `scripts/fixture-expectations.sh`. */
const JJ_HEAD = loadExpectedText("jj", "rev-parse-head").trim();

describe("a colocated jj repository", () => {
  test("`headDisplay` is the jj working copy, not a detached HEAD", async () => {
    const { session } = await open("jj", "t10-12-jj");
    const info = await session.info();
    expect(info.jj).toBe(true);
    expect(info.detached).toBe(true);
    expect(info.headOid).toBe(JJ_HEAD);
    expect(info.headDisplay).toBe(`jj working copy @ ${JJ_HEAD.slice(0, 7)}`);
    expect(info.headDisplay).not.toContain("detached");
    // git agrees there is no branch: `symbolic-ref HEAD` failed when the oracle was recorded.
    expect(loadExpectedText("jj", "symbolic-ref-head").trim()).toBe("<detached>");
    expect(info.headBranch).toBeNull();
    await session.close();
  });

  test("the synthetic HEAD ref carries the same label", async () => {
    const { session } = await open("jj", "t10-12-jj-ref");
    const info = await session.info();
    const synthetic = info.refs.find((r) => r.synthetic);
    expect(synthetic?.name).toBe(`jj working copy @ ${JJ_HEAD.slice(0, 7)}`);
    expect(synthetic?.fullName).toBe("HEAD");
    expect(synthetic?.isCheckedOut).toBe(true);
    await session.close();
  });

  test("JJ_COLOCATED is raised exactly once, and no warning mentions detachment", async () => {
    const { session } = await open("jj", "t10-12-jj-warn");
    const info = await session.info();
    expect(info.warnings.filter((w) => w.code === "JJ_COLOCATED")).toHaveLength(1);
    // The engine has never emitted a detached-HEAD notice (there is no such warning code in
    // `errors.ts`); this pins that down so a future one cannot start firing on jj repositories.
    expect(info.warnings.some((w) => /detach/i.test(`${w.code} ${w.message}`))).toBe(false);
    // `reloadRefs` keeps the label and does not raise the banner a second time.
    const again = await session.reloadRefs();
    expect(again.headDisplay).toBe(info.headDisplay);
    expect(again.warnings.filter((w) => w.code === "JJ_COLOCATED")).toHaveLength(1);
    await session.close();
  });

  test("the summary card uses the jj label too", async () => {
    const { session } = await open("jj", "t10-12-jj-summary");
    const summary = await session.summarise();
    expect(summary.headDisplay).toBe(`jj working copy @ ${JJ_HEAD.slice(0, 7)}`);
    expect(summary.headBranch).toBeNull();
    await session.close();
  });

  test("a plain detached repository is unaffected", async () => {
    const { session } = await open("detached", "t10-12-not-jj");
    const info = await session.info();
    expect(info.jj).toBe(false);
    expect(info.detached).toBe(true);
    expect(info.headDisplay).toStartWith("HEAD (detached @ ");
    expect(info.warnings.some((w) => w.code === "JJ_COLOCATED")).toBe(false);
    await session.close();
  });

  test("a jj repository still diffs like any other", async () => {
    const { session } = await open("jj", "t10-12-jj-diff");
    const result = await session.computeDiff({
      kind: "branches",
      source: "feature",
      target: "HEAD",
      sourceRef: "refs/heads/feature",
      targetRef: "HEAD",
      includeWorktree: false,
    });
    expect(result.files.map((f) => f.id)).toEqual(["src/b.txt"]);
    await session.close();
  });
});
