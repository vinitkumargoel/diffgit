// bun spikes/s1-diff-renderer/debug.ts — word-level / syntax highlight presence on both pages
import { chromium } from "@playwright/test";

const BASE = process.env.S1_BASE ?? "http://localhost:4174";
const browser = await chromium.launch();
for (const page of ["gdv.html", "rdv.html"]) {
  const p = await browser.newPage();
  await p.goto(`${BASE}/${page}`);
  await p.waitForFunction(() => window.__s1?.done === true, null, { timeout: 60_000 });
  const info = await p.evaluate(() => {
    const card = document.querySelector('[data-case="ts200"]');
    return {
      rdvWordMarks: card?.querySelectorAll(".diff-code-edit").length,
      gdvWordMarks: card?.querySelectorAll(
        ".diff-line-content-highlight, [data-diff-highlight], .diff-line-content-highlight-word",
      ).length,
      syntaxSpans: card?.querySelectorAll("span[style*='color']").length,
      sample: card?.querySelector("tbody tr:nth-child(5)")?.outerHTML.slice(0, 900),
    };
  });
  console.log(page, JSON.stringify(info, null, 2));
  await p.close();
}
await browser.close();
