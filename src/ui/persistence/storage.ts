/**
 * Shared failure handling for persistence (T4.3 amendment): storage problems never throw out of the
 * persistence modules; they surface once as `STORAGE_UNAVAILABLE` through `onStorageError`.
 */
let reported = false;
let listener: ((message: string) => void) | null = null;

export function onStorageError(cb: ((message: string) => void) | null): void {
  listener = cb;
  reported = false;
}

export function reportStorageError(e: unknown): void {
  if (reported) return;
  reported = true;
  const message = e instanceof Error ? e.message : String(e);
  console.warn("storage unavailable:", message);
  listener?.(message);
}

/** Runs a storage operation; on failure reports once and returns the fallback. */
export async function guarded<T>(op: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await op();
  } catch (e) {
    reportStorageError(e);
    return fallback;
  }
}

/** Test hook. */
export function resetStorageErrorState(): void {
  reported = false;
}
