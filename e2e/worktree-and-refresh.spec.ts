import { expect, test } from "@playwright/test";
import { fileRow, fixtureSnapshot, openFromHome, primeShim } from "./helpers";

test("working-tree layers, live refresh through the observer, viewed marks and filter", async ({
  page,
}) => {
  const snap = await fixtureSnapshot("worktree");
  await primeShim(page, { snapshots: [snap], pick: snap.id });
  await openFromHome(page);
  const sidebar = page.getByRole("complementary", { name: "Changed files" });
  await expect(sidebar).toContainText("Files changed (10)");

  // layer chips
  await expect(sidebar.getByLabel("Staged change").first()).toBeVisible();
  await expect(sidebar.getByLabel("Unstaged change").first()).toBeVisible();
  await expect(sidebar.getByLabel("Untracked file").first()).toBeVisible();

  // "include uncommitted" off → committed layer only, chips gone; on → back
  const toggle = page.getByRole("checkbox", { name: /Include uncommitted/ });
  await toggle.uncheck();
  // committed layer only: feature-only.txt plus reverted.txt (its worktree revert no longer counts)
  await expect(sidebar).toContainText("Files changed (2)", { timeout: 15_000 });
  await expect(sidebar.getByLabel("Unstaged change")).toHaveCount(0);
  await toggle.check();
  await expect(sidebar).toContainText("Files changed (10)", { timeout: 15_000 });
  await expect(sidebar.getByLabel("Unstaged change").first()).toBeVisible();

  // live refresh: mutate a tracked file through the channel, emit an observer record → +/- change
  const row = fileRow(page, "unstaged-mod.txt");
  await expect(row).toContainText(/\+1\s*−1/, { timeout: 15_000 });
  await page.evaluate(async () => {
    await window.__diffgoel.mutate([
      {
        op: "write",
        path: "unstaged-mod.txt",
        text: "unstaged 1\nfresh line a\nfresh line b\nfresh line c\n",
        mtime: Date.now() + 5000,
      },
    ]);
    window.__diffgoel.emitObserverRecords([
      { type: "modified", relativePathComponents: ["unstaged-mod.txt"], changedHandleKind: "file" },
    ]);
  });
  await expect(row).toContainText(/\+3\s*−4/, { timeout: 5000 });
  await expect(page.getByRole("button", { name: /^Refresh \(Live\)/ })).toBeVisible();

  // a new untracked file appears
  await page.evaluate(async () => {
    await window.__diffgoel.mutate([
      { op: "write", path: "brand-new.txt", text: "hello\n", mtime: Date.now() + 6000 },
    ]);
    window.__diffgoel.emitObserverRecords([
      { type: "appeared", relativePathComponents: ["brand-new.txt"], changedHandleKind: "file" },
    ]);
  });
  await expect(sidebar).toContainText("Files changed (11)", { timeout: 5000 });
  await expect(fileRow(page, "brand-new.txt")).toBeVisible();

  // viewed: collapses the card and moves the counter
  const counter = page.getByRole("progressbar", { name: "Files viewed" });
  await expect(counter).toHaveAttribute("aria-valuenow", "0");
  await page.getByRole("checkbox", { name: "Viewed: both.txt" }).check();
  await expect(counter).toHaveAttribute("aria-valuenow", "1");
  // the pane is virtualised: bring the first card back into view, then check it is collapsed
  await page.locator("#diff").evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(page.getByRole("button", { name: "Expand both.txt" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Diff of both.txt" })).toHaveCount(0);

  // filter narrows the list
  await page.getByPlaceholder("Filter files…").fill("staged");
  await expect(sidebar).toContainText(/[0-9]+ of 11 files/);
  const shown = Number((await sidebar.textContent())?.match(/(\d+) of 11 files/)?.[1] ?? "99");
  expect(shown).toBeLessThan(11);
  expect(shown).toBeGreaterThan(0);
});
