/**
 * Chooses the worker client implementation (T4.1): the recorded-JSON mock when
 * `VITE_MOCK_ENGINE=1`, the real comlink worker otherwise. Only `store.ts` imports this.
 */
import { createWorkerClient, type WorkerClient } from "./workerClient";
import { createMockWorkerClient } from "./workerClient.mock";

let singleton: WorkerClient | null = null;

export function getWorkerClient(): WorkerClient {
  if (!singleton) {
    singleton =
      import.meta.env.VITE_MOCK_ENGINE === "1" ? createMockWorkerClient() : createWorkerClient();
  }
  return singleton;
}

/**
 * A second, short-lived client for the Home dashboard (T11.11): its own worker, its own session,
 * closed and terminated after one `summarise()`. It is deliberately **not** the singleton — the
 * open repository must keep its generation, its caches and its packs while the dashboard reads the
 * repositories beside it (contracts `<!-- T10.10 -->`), and the atlas's memory note is the same
 * rule from the other side ("summaries need refs and the index, not packs; close each session
 * after the summary").
 */
export function summaryClient(): WorkerClient {
  return import.meta.env.VITE_MOCK_ENGINE === "1" ? createMockWorkerClient() : createWorkerClient();
}
