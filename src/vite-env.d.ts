/// <reference types="vite/client" />

/** Short git commit id of the build (vite `define`, see vite.config.ts `buildId`). */
declare const __BUILD_ID__: string;

interface ImportMetaEnv {
  /** "1" when the build targets the Playwright E2E suite (enables the memory-handle marker path). */
  readonly VITE_E2E?: string;
  /** "1" to run the UI against the recorded-JSON mock engine (T4.1). */
  readonly VITE_MOCK_ENGINE?: string;
}
