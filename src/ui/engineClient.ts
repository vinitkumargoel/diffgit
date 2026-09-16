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
