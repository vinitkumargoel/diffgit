import { useEffect, useState } from "react";
import type { EngineMetrics } from "../../engine/api";
import { type ClientMetrics, useStore } from "../store";

/**
 * Hidden `/#debug` panel (T7.2): engine phase timings from the last compute, client/worker message
 * counts, payload sizes and the pack-memory estimate. Read-only; polls the engine every 2 s.
 */
export function DebugPanel() {
  const perf = useStore((s) => s.perf);
  const busy = useStore((s) => s.refresh.busy);
  const [engine, setEngine] = useState<EngineMetrics | null>(null);
  const [client, setClient] = useState<ClientMetrics | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const snap = await useStore.getState().debugMetrics();
      if (!alive) return;
      setEngine(snap.engine);
      setClient(snap.client);
    };
    void tick();
    const id = setInterval(() => void tick(), 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  const kb = (n: number | null | undefined) => (n == null ? "–" : `${(n / 1024).toFixed(0)} kB`);
  const ms = (n: number | null | undefined) => (n == null ? "–" : `${n.toFixed(0)} ms`);
  return (
    <aside
      aria-label="Debug metrics"
      className="fixed right-3 bottom-3 z-40 max-h-[70vh] w-[320px] overflow-auto rounded-md border border-line bg-surface p-3 font-mono text-[11px] leading-4 text-ink shadow-popover"
    >
      <div className="mb-2 flex items-center justify-between font-semibold">
        <span>debug · {busy ? "busy" : "idle"}</span>
        <span className="text-muted">gen {engine?.generation ?? "–"}</span>
      </div>
      <table className="w-full">
        <tbody>
          {Object.entries(perf.phases).map(([phase, d]) => (
            <tr key={phase}>
              <td className="text-muted">{phase}</td>
              <td className="text-right">{ms(d)}</td>
            </tr>
          ))}
          <tr>
            <td className="text-muted">compute → result</td>
            <td className="text-right">{ms(perf.lastComputeMs)}</td>
          </tr>
          <tr>
            <td className="text-muted">stats complete</td>
            <td className="text-right">{ms(engine?.lastCompute?.statsMs)}</td>
          </tr>
          <tr>
            <td className="text-muted">result payload</td>
            <td className="text-right">{kb(client?.lastResultBytes)}</td>
          </tr>
          <tr>
            <td className="text-muted">worker calls</td>
            <td className="text-right">
              {client ? Object.values(client.calls).reduce((a, b) => a + b, 0) : "–"}
            </td>
          </tr>
          <tr>
            <td className="text-muted">sink progress / stats / warn</td>
            <td className="text-right">
              {client
                ? `${client.sink.progress} / ${client.sink.stats} / ${client.sink.warnings}`
                : "–"}
            </td>
          </tr>
          <tr>
            <td className="text-muted">handle cache</td>
            <td className="text-right">{engine?.handleCache ?? "–"}</td>
          </tr>
          <tr>
            <td className="text-muted">pack bytes read</td>
            <td className="text-right">{kb(engine?.memoryEstimate)}</td>
          </tr>
          <tr>
            <td className="text-muted">fs reads</td>
            <td className="text-right">
              {engine ? `${engine.io.reads} (${kb(engine.io.bytes)})` : "–"}
            </td>
          </tr>
        </tbody>
      </table>
      <p className="mt-2 text-muted">performance.mark entries: diffgit:compute-*</p>
    </aside>
  );
}
