import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { previewHeaders } from "../../vite.config";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Spike S1 (T5.0): pages rendering the same three diff cases with the candidate renderers,
 * plus a Shiki cost page. Separate Vite root so the spike never enters the app bundle.
 * Preview serves the production CSP from public/_headers.
 *   bunx vite build --config spikes/s1-diff-renderer/vite.config.ts
 *   bunx vite preview --config spikes/s1-diff-renderer/vite.config.ts --port 4174
 *   S1_STUB_LOWLIGHT=1 bunx vite build ...   # experiment: alias away @git-diff-view's lowlight(all)
 */
export default defineConfig({
  root: here,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: process.env.S1_STUB_LOWLIGHT
      ? { "@git-diff-view/lowlight": resolve(here, "lowlightStub.ts") }
      : {},
  },
  worker: { format: "es" },
  build: {
    target: "es2022",
    outDir: resolve(here, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(here, "index.html"),
        gdv: resolve(here, "gdv.html"),
        rdv: resolve(here, "rdv.html"),
        hl: resolve(here, "hl.html"),
      },
    },
  },
  preview: { headers: previewHeaders(resolve(here, "../../public/_headers")) },
});
