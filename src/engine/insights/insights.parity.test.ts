/**
 * T10.9 parity: every number `EngineApi.insights` reports on the `history` fixture, against git's
 * own answer for the same question, asserted for exact equality.
 *
 * The oracles are written by `scripts/fixture-expectations.sh` (the `history` case) and are all
 * `--first-parent`, because that is the walk the insights pass makes:
 *
 * | file                          | git command |
 * |-------------------------------|-------------|
 * | `insights-count.txt`          | `git rev-list --count --first-parent main` |
 * | `insights-authors.txt`        | `git log --first-parent --format='%aN <%aE>'` (mailmap applied) |
 * | `insights-authors-raw.txt`    | the same with `%an <%ae>` (mailmap **not** applied) |
 * | `insights-shortlog.txt`       | `git shortlog -sne --first-parent main` |
 * | `insights-name-only.txt`      | `git log --first-parent --no-renames --format= --name-only` |
 * | `insights-days.txt`           | `git log --first-parent --date=format-local:%Y-%m-%d --format=%ad` |
 * | `insights-ls-tree.txt`        | `git ls-tree -r -l main` (blob size at the tip) |
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  fixturePath,
  HISTORY_FIXTURE,
  loadExpectedBlobSizes,
  loadExpectedCounts,
  loadExpectedLines,
} from "../../test/fixtures";
import type { Progress, ProgressSink } from "../api";
import { NodeDirHandle } from "../fs/nodeDirHandle";
import { Mailmap } from "../git/mailmap";
import { RepoSession } from "../session";
import type { InsightsResult, RepoWarning } from "../types";
import { hotspotScore, isManifestPath, localMidnight } from "./insights";

const quietSink: ProgressSink = { onProgress() {}, onStats() {}, onWarning() {} };

function recordingSink(progress: Progress[], warnings: RepoWarning[]): ProgressSink {
  return {
    onProgress: (p) => void progress.push(p),
    onStats() {},
    onWarning: (w) => void warnings.push(w),
  };
}

async function openHistory(sink: ProgressSink = quietSink, id = "test-insights") {
  return RepoSession.open(await NodeDirHandle.open(fixturePath(HISTORY_FIXTURE.name)), sink, {
    id,
  });
}

/** `activity` flattened back to the `YYYY-MM-DD → commits` map `insights-days.txt` records. */
function activityDays(activity: InsightsResult["activity"]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const week of activity) {
    week.days.forEach((n, i) => {
      if (n === 0) return;
      const d = new Date(week.weekStart);
      d.setDate(d.getDate() + i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      out[key] = (out[key] ?? 0) + n;
    });
  }
  return out;
}

const EXPECTED_AUTHORS = loadExpectedCounts(HISTORY_FIXTURE.name, "insights-authors");
const EXPECTED_RAW = loadExpectedCounts(HISTORY_FIXTURE.name, "insights-authors-raw");
const EXPECTED_PATHS = loadExpectedCounts(HISTORY_FIXTURE.name, "insights-name-only");
const EXPECTED_DAYS = loadExpectedCounts(HISTORY_FIXTURE.name, "insights-days");
const EXPECTED_SIZES = loadExpectedBlobSizes(HISTORY_FIXTURE.name, "insights-ls-tree");
const EXPECTED_COUNT = Number(loadExpectedLines(HISTORY_FIXTURE.name, "insights-count")[0]);

describe("insights parity with git on the `history` fixture", () => {
  test("walks exactly `git rev-list --count --first-parent main`", async () => {
    const session = await openHistory();
    const out = await session.insights({ limit: 10 });
    expect(EXPECTED_COUNT).toBe(48);
    expect(out.walked).toBe(EXPECTED_COUNT);
    expect(out.commits).toBe(EXPECTED_COUNT);
    expect(out.capped).toBe(false);
    await session.close();
  });

  test("`.mailmap` reproduces git's `%aN <%aE>` from `%an <%ae>`, identity for identity", () => {
    // The contract's `authors` carries only names, so the (name, email) parity is asserted on the
    // mapping itself: git's unmapped recording put through `Mailmap` must equal git's mapped one.
    const mailmap = Mailmap.parse(
      readFileSync(join(fixturePath(HISTORY_FIXTURE.name), ".mailmap"), "utf8"),
    );
    const mapped: Record<string, number> = {};
    for (const [line, n] of Object.entries(EXPECTED_RAW)) {
      const m = /^(.*) <(.*)>$/.exec(line);
      expect(m).not.toBeNull();
      const id = mailmap.map(
        (m as RegExpExecArray)[1] as string,
        (m as RegExpExecArray)[2] as string,
      );
      const key = `${id.name} <${id.email}>`;
      mapped[key] = (mapped[key] ?? 0) + n;
    }
    expect(mapped).toEqual(EXPECTED_AUTHORS);
    // …and `git shortlog -sne --first-parent` is the same list.
    expect(
      Object.entries(EXPECTED_AUTHORS)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${n} ${k}`),
    ).toEqual(
      loadExpectedLines(HISTORY_FIXTURE.name, "insights-shortlog").map((l) =>
        l.replace(/^\s*(\d+)\t/, "$1 "),
      ),
    );
  });

  test(".mailmap actually folds Ada's two addresses (the raw oracle differs)", async () => {
    const alias = `${HISTORY_FIXTURE.mailmapAuthor.name} <${HISTORY_FIXTURE.mailmapAuthor.alias}>`;
    const proper = `${HISTORY_FIXTURE.mailmapAuthor.name} <${HISTORY_FIXTURE.mailmapAuthor.email}>`;
    // The fixture is only a mailmap test if git's own two recordings disagree.
    expect(EXPECTED_RAW[alias]).toBeGreaterThan(0);
    expect(EXPECTED_AUTHORS[alias]).toBeUndefined();
    expect(EXPECTED_AUTHORS[proper]).toBe(
      (EXPECTED_RAW[proper] as number) + (EXPECTED_RAW[alias] as number),
    );

    const session = await openHistory();
    const out = await session.insights({ limit: 10 });
    const ada = out.authors.find((a) => a.name === HISTORY_FIXTURE.mailmapAuthor.name);
    expect(ada?.commits).toBe(EXPECTED_AUTHORS[proper] as number);
    await session.close();
  });

  test("bots are counted, excluded from `authors`, and `authors + bots === commits`", async () => {
    const session = await openHistory();
    const out = await session.insights({ limit: 10 });
    const botLine = Object.entries(EXPECTED_AUTHORS).find(([k]) =>
      k.startsWith(HISTORY_FIXTURE.botAuthor),
    );
    expect(botLine).toBeDefined();
    expect(out.bots).toBe(botLine?.[1] as number);
    expect(out.authors.some((a) => a.name === HISTORY_FIXTURE.botAuthor)).toBe(false);
    // `authors` is `git shortlog -sn` (grouped by name) minus the bots, newest-heavy first.
    const byName: Record<string, number> = {};
    for (const [k, n] of Object.entries(EXPECTED_AUTHORS)) {
      const name = k.slice(0, k.lastIndexOf(" <"));
      if (name === HISTORY_FIXTURE.botAuthor) continue;
      byName[name] = (byName[name] ?? 0) + n;
    }
    expect(Object.fromEntries(out.authors.map((a) => [a.name, a.commits]))).toEqual(byName);
    expect(out.authors.map((a) => a.commits)).toEqual(
      [...out.authors.map((a) => a.commits)].sort((a, b) => b - a),
    );
    expect(out.authors.reduce((n, a) => n + a.commits, 0) + out.bots).toBe(out.commits);
    await session.close();
  });

  test("per-path commit counts equal `git log --first-parent --no-renames --name-only`", async () => {
    const session = await openHistory();
    // A limit above the number of touched paths makes `hotspots` the whole per-path tally.
    const out = await session.insights({ limit: 100 });
    expect(Object.fromEntries(out.hotspots.map((h) => [h.path, h.commits]))).toEqual(
      EXPECTED_PATHS,
    );
    // The rename is counted against both names, which is what `--no-renames` reports.
    const count = (p: string) => out.hotspots.find((h) => h.path === p)?.commits;
    expect(count(HISTORY_FIXTURE.renamedFrom)).toBe(3);
    expect(count(HISTORY_FIXTURE.renamedTo)).toBe(2);
    // A path that no longer exists at the tip has no size and scores its commit count.
    const gone = out.hotspots.find((h) => h.path === HISTORY_FIXTURE.renamedFrom);
    expect(gone?.size).toBe(0);
    expect(gone?.score).toBe(3);
    await session.close();
  });

  test("hotspots rank by `commits × log2(size)` with git's own counts and sizes", async () => {
    const session = await openHistory();
    const out = await session.insights({ limit: 3 });
    const real = out.hotspots.filter((h) => !h.manifest);
    const manifests = out.hotspots.filter((h) => h.manifest);
    expect(out.hotspots.map((h) => h.manifest)).toEqual([false, false, false, true]);

    for (const h of out.hotspots) {
      expect(h.commits).toBe(EXPECTED_PATHS[h.path] as number);
      expect(h.size).toBe(EXPECTED_SIZES[h.path] ?? 0);
      expect(h.score).toBe(hotspotScore(h.commits, h.size));
      expect(h.manifest).toBe(isManifestPath(h.path));
    }
    // The expected ranking, computed straight from git's two recordings.
    const ranked = Object.entries(EXPECTED_PATHS)
      .map(([path, commits]) => ({
        path,
        manifest: isManifestPath(path),
        score: hotspotScore(commits, EXPECTED_SIZES[path] ?? 0),
      }))
      .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1));
    expect(real.map((h) => h.path)).toEqual(
      ranked
        .filter((r) => !r.manifest)
        .slice(0, 3)
        .map((r) => r.path),
    );
    expect(manifests.map((h) => h.path)).toEqual([HISTORY_FIXTURE.manifestPath]);
    // Manifests are excluded from the ranking, not from the answer: `package.json` has more
    // commits than two of the three files above it.
    expect(manifests[0]?.commits).toBeGreaterThan(real.at(-1)?.commits as number);
    await session.close();
  });

  test("activity buckets `git log --date=format-local:%Y-%m-%d` and sums to `commits`", async () => {
    // `bun test` pins the process to UTC and `insights-days.txt` is recorded under `TZ=UTC` for
    // the same reason: "local midnight" has to mean the same thing on both sides.
    expect(new Date().getTimezoneOffset()).toBe(0);
    const session = await openHistory();
    const out = await session.insights({ limit: 10 });
    expect(activityDays(out.activity)).toEqual(EXPECTED_DAYS);
    const sum = out.activity.reduce((n, w) => n + w.days.reduce((a, b) => a + b, 0), 0);
    expect(sum).toBe(out.commits);
    for (const week of out.activity) {
      expect(week.days).toHaveLength(7);
      expect(new Date(week.weekStart).getDay()).toBe(0);
      expect(new Date(week.weekStart).getHours()).toBe(0);
    }
    // Oldest week first.
    expect(out.activity.map((w) => w.weekStart)).toEqual(
      [...out.activity.map((w) => w.weekStart)].sort((a, b) => a - b),
    );
    await session.close();
  });

  test("`sinceMs` filters on the author date and keeps `walked` at the full history", async () => {
    const session = await openHistory();
    const all = await session.insights({ limit: 10 });
    const days = Object.keys(EXPECTED_DAYS).sort();
    // Keep only the commits on or after the fixture's 20th distinct active day.
    const cutIso = days[19] as string;
    const [y, m, d] = cutIso.split("-").map(Number) as [number, number, number];
    const sinceMs = new Date(y, m - 1, d).getTime();
    const expectedCommits = Object.entries(EXPECTED_DAYS)
      .filter(([k]) => k >= cutIso)
      .reduce((n, [, v]) => n + v, 0);

    const out = await session.insights({ limit: 10, sinceMs });
    expect(out.walked).toBe(all.walked);
    expect(out.commits).toBe(expectedCommits);
    expect(out.commits).toBeLessThan(all.commits);
    expect(activityDays(out.activity)).toEqual(
      Object.fromEntries(Object.entries(EXPECTED_DAYS).filter(([k]) => k >= cutIso)),
    );
    expect(out.authors.reduce((n, a) => n + a.commits, 0) + out.bots).toBe(out.commits);
    // Every remaining bucket is inside the window.
    for (const week of out.activity)
      for (let i = 0; i < 7; i++)
        if ((week.days[i] as number) > 0)
          expect(week.weekStart + i * 86_400_000).toBeGreaterThanOrEqual(localMidnight(sinceMs));
    await session.close();
  });

  test("reports progress on the `insights` phase and one in flight at a time", async () => {
    const progress: Progress[] = [];
    const warnings: RepoWarning[] = [];
    const session = await openHistory(recordingSink(progress, warnings), "test-insights-progress");
    const superseded = session.insights({ limit: 10 });
    const winner = session.insights({ limit: 10 });
    await expect(superseded).rejects.toMatchObject({ code: "CANCELLED" });
    const out = await winner;
    expect(out.commits).toBe(EXPECTED_COUNT);
    const phases = progress.filter((p) => p.phase === "insights");
    expect(phases.length).toBeGreaterThan(0);
    expect(phases.at(-1)?.durationMs).toBeGreaterThanOrEqual(0);
    expect(phases.at(-1)?.done).toBe(EXPECTED_COUNT);
    // A 48-commit history is nowhere near the cap, so no INSIGHTS_CAPPED banner.
    expect(warnings.some((w) => w.code === "INSIGHTS_CAPPED")).toBe(false);
    await session.close();
  });

  test("rejects a limit that is not a positive integer", async () => {
    const session = await openHistory();
    for (const limit of [0, -1, 1.5, Number.NaN])
      await expect(session.insights({ limit })).rejects.toMatchObject({ code: "INTERNAL" });
    await session.close();
  });
});
