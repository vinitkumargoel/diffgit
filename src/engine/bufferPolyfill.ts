// isomorphic-git's ESM build reads the global `Buffer`; workers have none. Imported first by worker.ts.
import { Buffer } from "buffer";

const g = globalThis as unknown as { Buffer?: typeof Buffer };
if (typeof g.Buffer === "undefined") g.Buffer = Buffer;
