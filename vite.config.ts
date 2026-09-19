import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Parses `public/_headers` (Cloudflare Pages format) and returns the headers of one block — `/*` by
 * default, so that `vite preview` serves the exact production CSP, and `/sw.js` for the service
 * worker's own policy (T11.14). Single source of truth for headers. Comment lines and the `!`
 * detach lines carry no colon and are ignored.
 */
export function previewHeaders(
  file = resolve(here, "public/_headers"),
  block = "/*",
): Record<string, string> {
  const headers: Record<string, string> = {};
  let inWildcard = false;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (raw.trim() === "") continue;
    const indented = raw.startsWith(" ") || raw.startsWith("\t");
    if (!indented) {
      inWildcard = raw.trim() === block;
      continue;
    }
    if (!inWildcard) continue;
    const colon = raw.indexOf(":");
    if (colon === -1) continue;
    headers[raw.slice(0, colon).trim()] = raw.slice(colon + 1).trim();
  }
  return headers;
}

/** Short commit id baked into the bundle (help dialog footer; `scripts/check-prod.sh <url> <id>`). */
export function buildId(): string {
  if (process.env.BUILD_ID) return process.env.BUILD_ID;
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "dev";
  }
}

const BUILD_ID = buildId();

/**
 * T11.14: what `public/sw.js` precaches — every built file the installed app needs offline, in a
 * stable order. Cloudflare's own files (`_headers`, `_redirects`) are not assets and the icons are
 * only used by the OS, so both stay out; `scripts/check-dist.sh` asserts this list against `dist/`.
 */
export function precacheList(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at).sort()) {
      const full = join(at, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      const path = `/${relative(dir, full).split(/[\\/]/).join("/")}`;
      if (path === "/sw.js" || path.startsWith("/_")) continue;
      if (/\.(js|css|html|svg|woff2?)$/.test(path)) out.push(path);
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Rewrites the two placeholders of `public/sw.js` in `dist/` once everything else is written, and
 * makes `vite preview` serve `/sw.js` with its own `_headers` policy — `preview.headers` is global,
 * and a worker served the page's `connect-src 'none'` cannot fetch at all (T11.14).
 */
function swPrecachePlugin() {
  const swHeaders = previewHeaders(resolve(here, "public/_headers"), "/sw.js");
  return {
    name: "diffgit-sw-precache",
    configurePreviewServer(server: {
      middlewares: {
        use(fn: (req: { url?: string }, res: ServerResponse, next: () => void) => void): void;
      };
    }) {
      server.middlewares.use((req, res, next) => {
        if ((req.url ?? "").split("?")[0] === "/sw.js") {
          // `preview.headers` is applied by a middleware that runs after this one and would put the
          // page's policy back, so the setter itself is pinned for this one response.
          const set = res.setHeader.bind(res);
          res.setHeader = ((name: string, value: string | number | readonly string[]) =>
            set(
              name,
              name.toLowerCase() === "content-security-policy"
                ? (swHeaders["Content-Security-Policy"] ?? value)
                : value,
            )) as typeof res.setHeader;
          for (const [name, value] of Object.entries(swHeaders)) res.setHeader(name, value);
        }
        next();
      });
    },
    // `closeBundle` runs after Vite has copied `publicDir`, so `dist/sw.js` is already there.
    closeBundle() {
      const dir = resolve(here, "dist");
      const file = resolve(dir, "sw.js");
      let source: string;
      try {
        source = readFileSync(file, "utf8");
      } catch {
        return; // no dist/sw.js (a library build or a test run): nothing to stamp
      }
      const list = precacheList(dir);
      const version = `${BUILD_ID}-${createHash("sha256").update(list.join("\n")).digest("hex").slice(0, 8)}`;
      writeFileSync(
        file,
        source
          .replace('"__SW_VERSION__"', JSON.stringify(version))
          .replace('["__SW_PRECACHE__"]', JSON.stringify(list, null, 2)),
      );
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      // `<meta name="build-id">` lets scripts/check-prod.sh verify which commit a host serves.
      name: "diffgit-build-id-meta",
      transformIndexHtml(html) {
        return html.replace(
          "</head>",
          `  <meta name="build-id" content="${BUILD_ID}" />\n  </head>`,
        );
      },
    },
    swPrecachePlugin(),
  ],
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
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
