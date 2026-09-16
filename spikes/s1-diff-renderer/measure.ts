/**
 * Spike S1 measurement runner (not an E2E spec): drives the spike pages in headless Chromium
 * under `vite preview` (production CSP), records compute/render timings, DOM rows, network
 * requests, CSP violations, and whether expand-all and split mode work.
 *
 *   bunx vite build --config spikes/s1-diff-renderer/vite.config.ts
 *   bunx vite preview --config spikes/s1-diff-renderer/vite.config.ts --port 4174 &
 *   bun spikes/s1-diff-renderer/measure.ts
 */
import { chromium } from "@playwright/test";

const BASE = process.env.S1_BASE ?? "http://localhost:4174";

async function run(page: string) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  const requests: string[] = [];
  const cspViolations: string[] = [];
  const errors: string[] = [];
  p.on("request", (r) => requests.push(r.url()));
  p.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
    if (/Content Security Policy/i.test(m.text())) cspViolations.push(m.text());
  });
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${BASE}/${page}`);
  await p.waitForFunction(() => window.__s1?.done === true, null, { timeout: 60_000 });
  const measurements = await p.evaluate(() => window.__s1.measurements);
  const loadRequests = requests.length;

  // expand all on the first card
  const rowsBefore = await p.locator('[data-case="ts200"] tbody tr').count();
  await p.locator('[data-case="ts200"] button', { hasText: "Expand all" }).click();
  await p.waitForTimeout(300);
  const rowsAfterExpand = await p.locator('[data-case="ts200"] tbody tr').count();

  // split mode (whole page: all three cards re-render)
  const t0 = Date.now();
  await p.locator("#toggle-mode").click();
  await p.waitForFunction(() => document.querySelectorAll("tbody tr").length > 0);
  const splitMs = Date.now() - t0;
  const splitCells = await p.locator('[data-case="ts200"] tbody tr').nth(1).locator("td").count();

  // dark theme toggle
  await p.locator("#toggle-theme").click();
  await p.waitForTimeout(100);
  const requestsAfterInteractions = requests.length - loadRequests;
  const mem = await p.evaluate(
    () =>
      (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ??
      null,
  );
  await browser.close();
  return {
    page,
    measurements,
    loadRequests,
    requestsAfterInteractions,
    cspViolations,
    errors,
    rowsBefore,
    rowsAfterExpand,
    splitMs,
    splitCells,
    heapMB: mem ? +(mem / 1048576).toFixed(1) : null,
    requestHosts: [...new Set(requests.map((u) => new URL(u).host))],
  };
}

async function runHl() {
  const browser = await chromium.launch();
  const p = await browser.newPage();
  const requests: string[] = [];
  p.on("request", (r) => requests.push(r.url()));
  await p.goto(`${BASE}/hl.html`);
  await p.waitForFunction(
    () => (window as unknown as { __hl?: unknown }).__hl !== undefined,
    null,
    {
      timeout: 60_000,
    },
  );
  const result = await p.evaluate(() => (window as unknown as { __hl: unknown }).__hl);
  await browser.close();
  return { page: "hl.html", result, loadRequests: requests.length };
}

const pages = process.argv.slice(2);
const results: unknown[] = [];
for (const page of pages.length ? pages : ["gdv.html", "rdv.html"]) results.push(await run(page));
if (!pages.length) results.push(await runHl());
console.log(JSON.stringify(results, null, 2));
