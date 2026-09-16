/**
 * README screenshots (T8.1): builds the E2E bundle, serves it with `vite preview`, opens the
 * `worktree` fixture through the FSA shim and captures the repo screen in light and dark.
 * Usage: `bun scripts/screenshots.ts` → docs/screenshots/{light,dark}.png
 */
import { spawn, spawnSync } from "node:child_process";
import { chromium } from "@playwright/test";
import { installFsaShim } from "../e2e/fsaShim";
import { fixtureSnapshot } from "../e2e/helpers";

const PORT = 4174;
const URL = `http://localhost:${PORT}`;

async function waitFor(url: string, ms = 30_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* server not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`preview server did not answer at ${url}`);
}

const build = spawnSync("bun", ["run", "build"], {
  stdio: "inherit",
  env: { ...process.env, VITE_E2E: "1" },
});
if (build.status !== 0) process.exit(build.status ?? 1);
const server = spawn("bun", ["run", "preview", "--", "--port", String(PORT), "--strictPort"], {
  stdio: "ignore",
});
try {
  await waitFor(URL);
  const snap = await fixtureSnapshot("worktree");
  const browser = await chromium.launch();
  for (const scheme of ["light", "dark"] as const) {
    const context = await browser.newContext({
      colorScheme: scheme,
      viewport: { width: 1360, height: 860 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await page.addInitScript(installFsaShim, { snapshots: [snap], pick: snap.id });
    await page.goto(URL);
    await page.getByRole("button", { name: "Open repository" }).click();
    await page
      .getByRole("complementary", { name: "Changed files" })
      .waitFor({ state: "visible", timeout: 20_000 });
    await page.getByText("Files changed (").waitFor();
    await page.locator("table.diff-unified, table.diff-split").first().waitFor({ timeout: 20_000 });
    await page.waitForTimeout(400); // highlight tokens land asynchronously
    await page.screenshot({ path: `docs/screenshots/${scheme}.png` });
    await context.close();
    console.log(`wrote docs/screenshots/${scheme}.png`);
  }
  await browser.close();
} finally {
  server.kill();
}
