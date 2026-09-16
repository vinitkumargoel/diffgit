import { expect, test } from "@playwright/test";
import {
  fixtureSnapshot,
  openFromHome,
  plainFolderSnapshot,
  primeShim,
  recordRequests,
} from "./helpers";

test("not-a-repo error, recents survive a reload, and no request ever leaves the origin", async ({
  page,
  baseURL,
}) => {
  const plain = plainFolderSnapshot();
  const repo = await fixtureSnapshot("remote");
  await primeShim(page, { snapshots: [plain, repo], pick: plain.id });
  const net = recordRequests(page);
  const origin = new URL(baseURL as string).origin;

  // production headers (served by vite preview from public/_headers)
  const response = await page.goto("/");
  expect(response?.headers()["content-security-policy"]).toContain("connect-src 'none'");

  // a folder without .git → error screen with a way out
  await page.getByRole("button", { name: "Open repository" }).click();
  await expect(page.getByText(/not a git repository|No \.git/i).first()).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole("button", { name: "Choose another folder" }).click();
  await expect(page.getByRole("button", { name: "Open repository" })).toBeVisible();

  // open the real repo, reload, reopen from recents (marker permission path)
  await openFromHome(page, repo.id);
  await page.reload();
  await page.getByRole("button", { name: `Open ${repo.name}` }).click();
  await expect(page.getByRole("complementary", { name: "Changed files" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator("#diff")).toHaveAttribute("data-count", "5");
  await page.waitForTimeout(1500); // let lazy chunks and workers settle

  // privacy: every request stayed on our origin and none happened after the repo was open
  const urls = net.urls();
  expect(urls.length).toBeGreaterThan(0);
  expect(urls.filter((u) => !u.startsWith(origin))).toEqual([]);
  net.clear();
  await page
    .getByRole("checkbox", { name: /Include uncommitted/ })
    .click({ force: true })
    .catch(() => {});
  await page.waitForTimeout(1500);
  expect(net.urls()).toEqual([]);
});
