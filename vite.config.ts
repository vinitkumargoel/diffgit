import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Parses `public/_headers` (Cloudflare Pages format) and returns the headers of the `/*` block
 * so that `vite preview` serves the exact production CSP. Single source of truth for headers.
 */
export function previewHeaders(file = resolve(here, "public/_headers")): Record<string, string> {
  const headers: Record<string, string> = {};
  let inWildcard = false;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (raw.trim() === "") continue;
    const indented = raw.startsWith(" ") || raw.startsWith("\t");
    if (!indented) {
      inWildcard = raw.trim() === "/*";
      continue;
    }
    if (!inWildcard) continue;
    const colon = raw.indexOf(":");
    if (colon === -1) continue;
    headers[raw.slice(0, colon).trim()] = raw.slice(colon + 1).trim();
  }
  return headers;
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    target: "es2022",
    sourcemap: false,
  },
  worker: {
    format: "es",
  },
  preview: {
    headers: previewHeaders(),
  },
  test: {
    include: ["src/ui/**/*.test.{ts,tsx}"],
    environment: "happy-dom",
    passWithNoTests: true,
  },
});
