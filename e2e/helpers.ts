/** Shared setup for the three T7.1 smoke specs: fixture snapshots + the FSA shim. */
import { expect, type Page, type Request } from "@playwright/test";
import { MemoryFs, type MemorySnapshot } from "../src/engine/fs/memoryDirHandle";
import { fixturePath } from "../src/test/fixtures";
import { snapshotFromDisk } from "../src/test/memorySnapshot";
import { installFsaShim, type ShimConfig } from "./fsaShim";

export async function fixtureSnapshot(name: string, id = name): Promise<MemorySnapshot> {
  return snapshotFromDisk(fixturePath(name), id, name, { exclude: (p) => p === "expected" });
}

export function plainFolderSnapshot(): MemorySnapshot {
  return MemoryFs.fromEntries({
    "README.md": "not a repository\n",
    "notes/todo.txt": "x\n",
  }).toSnapshot("plain", "plain");
}

export async function primeShim(page: Page, config: ShimConfig): Promise<void> {
  await page.addInitScript(installFsaShim, config);
}

/** Home → "Open repository" → repo screen with the file list rendered. */
export async function openFromHome(page: Page, pick?: string): Promise<void> {
  await page.goto("/");
  if (pick) await page.evaluate((id) => window.__diffgoel.setPick(id), pick);
  await page.getByRole("button", { name: "Open repository" }).click();
  await expect(page.getByRole("complementary", { name: "Changed files" })).toBeVisible({
    timeout: 20_000,
  });
}

export function fileRow(page: Page, path: string) {
  return page
    .getByRole("checkbox", { name: `Viewed: ${path}` })
    .locator("xpath=ancestor::*[@role='treeitem' or @role='option'][1]");
}

/** Records every request from now on; call `.urls()` to inspect. */
export function recordRequests(page: Page) {
  const requests: Request[] = [];
  page.on("request", (r) => requests.push(r));
  return {
    urls: () => requests.map((r) => r.url()),
    clear: () => requests.splice(0, requests.length),
  };
}
