import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { fixtureSnapshot, openFromHome, primeShim } from "./helpers";

test("open a repo, read the diff, switch views, change the target", async ({ page }) => {
  const snap = await fixtureSnapshot("remote");
  await primeShim(page, { snapshots: [snap], pick: snap.id });
  await openFromHome(page);

  // source = checked-out branch, target = origin/main (Plan D8), five files like git
  await expect(page.getByRole("button", { name: "compare branch: feature" })).toBeVisible();
  await expect(page.getByRole("button", { name: "base branch: origin/main" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Changed files" })).toContainText(
    "Files changed (5)",
  );
  await expect(page.locator("#diff")).toHaveAttribute("data-count", "5");

  // the first text card renders hunks with highlighted tokens
  const firstDiff = page.locator('section[aria-label^="Diff of "]').first();
  await expect(firstDiff).toBeVisible();
  await expect(firstDiff.locator("table")).not.toHaveCount(0);
  await expect
    .poll(async () => firstDiff.locator("[data-sh]").count(), { timeout: 15_000 })
    .toBeGreaterThan(0);

  // unified → split changes the layout (react-diff-view renders table.diff-unified / table.diff-split)
  await expect(page.locator("#diff table.diff-unified").first()).toBeVisible();
  await expect(page.locator("#diff table.diff-split")).toHaveCount(0);
  await page.getByRole("button", { name: "Split" }).click();
  await expect(page.getByRole("button", { name: "Split" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#diff table.diff-split").first()).toBeVisible();
  await expect(page.locator("#diff table.diff-unified")).toHaveCount(0);

  // axe on the repo screen with a rendered diff (Design §9)
  const axe = await new AxeBuilder({ page }).disableRules(["color-contrast"]).analyze();
  const serious = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(
    serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
  ).toEqual([]);

  // a different target recomputes and changes the list (origin/feature == feature → nothing left)
  await page.getByRole("button", { name: "base branch: origin/main" }).click();
  await page.getByPlaceholder("Find a branch…").fill("origin/feature");
  await page
    .getByRole("option", { name: /origin\/feature/ })
    .first()
    .click();
  await expect(page.getByRole("button", { name: "base branch: origin/feature" })).toBeVisible();
  await expect(page.getByText(/No changes between/)).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#diff")).toHaveCount(0);

  // target = source → empty state
  await page.getByRole("button", { name: /^base branch: / }).click();
  await page.getByPlaceholder("Find a branch…").fill("feature");
  await page
    .getByRole("option", { name: /^feature/ })
    .first()
    .click();
  await expect(page.getByText("is compared with itself")).toBeVisible({ timeout: 15_000 });
});
