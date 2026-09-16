import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;

/**
 * Chromium only (D3). The app is built with `VITE_E2E=1` so the worker accepts memory-handle
 * markers, and served by `vite preview`, which applies the production headers from public/_headers
 * (CSP with connect-src 'none'). Only the three smoke specs of T7.1 live in e2e/.
 */
export default defineConfig({
  testDir: "e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `VITE_E2E=1 bun run build && bun run preview -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
