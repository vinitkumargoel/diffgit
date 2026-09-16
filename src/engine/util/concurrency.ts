/** Minimal promise concurrency limiter (no dependency). */
export function pLimit(concurrency: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    active--;
    const run = queue.shift();
    if (run) run();
  };
  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = () => {
        active++;
        fn().then(resolve, reject).finally(next);
      };
      if (active < concurrency) run();
      else queue.push(run);
    });
}

/** Throws `EngineError("CANCELLED")` when the signal is aborted. */
export function throwIfAborted(signal: AbortSignal | undefined, what: string): void {
  if (signal?.aborted) {
    // lazy import avoided: errors.ts has no deps, import statically instead
    throw new CancelledError(what);
  }
}

import { EngineError } from "../errors";

export class CancelledError extends EngineError {
  constructor(what: string) {
    super("CANCELLED", `${what} was cancelled by a newer request`);
  }
}
