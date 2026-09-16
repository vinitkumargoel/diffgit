import { DiffFile, DiffModeEnum, DiffView } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view-pure.css";
import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { mockHunks } from "../../src/ui/mock/mockContents";
import { afterPaint, CASES, initMeasure, type SpikeCase } from "./cases";
import type { WorkerRequest, WorkerResponse } from "./gdv.worker";
import { hunkModelToDiffList } from "./hunkText";
import "./spike.css";

initMeasure();
const MAIN_ONLY = new URLSearchParams(location.search).has("main");
function mainThreadFile(c: SpikeCase): DiffFile {
  const diffList = hunkModelToDiffList(mockHunks(c.oldText, c.newText));
  const f = new DiffFile(c.oldName, c.oldText, c.newName, c.newText, diffList, c.lang, c.lang);
  f.initTheme("light");
  f.initRaw();
  f.buildSplitDiffLines();
  f.buildUnifiedDiffLines();
  return f;
}
const worker = new Worker(new URL("./gdv.worker.ts", import.meta.url), { type: "module" });

function compute(c: SpikeCase, highlight: boolean): Promise<WorkerResponse> {
  return new Promise((resolve) => {
    const onMsg = (ev: MessageEvent<WorkerResponse>) => {
      if (ev.data.id !== c.id) return;
      worker.removeEventListener("message", onMsg);
      resolve(ev.data);
    };
    worker.addEventListener("message", onMsg);
    const req: WorkerRequest = { ...c, id: c.id, highlight };
    worker.postMessage(req);
  });
}

function Card({ c, mode, onDone }: { c: SpikeCase; mode: DiffModeEnum; onDone: () => void }) {
  const [file, setFile] = useState<DiffFile | null>(null);
  const [computeMs, setComputeMs] = useState(0);
  useEffect(() => {
    let alive = true;
    void compute(c, c.id !== "big3000").then(async (res) => {
      if (!alive) return;
      const t0 = performance.now();
      const f = MAIN_ONLY ? mainThreadFile(c) : DiffFile.createInstance(res.data, res.bundle);
      (window as unknown as { __gdv: Record<string, DiffFile> }).__gdv ??= {};
      (window as unknown as { __gdv: Record<string, DiffFile> }).__gdv[c.id] = f;
      setComputeMs(res.computeMs);
      setFile(f);
      const t1 = await afterPaint();
      const rows = document.querySelectorAll(`[data-case="${c.id}"] tr`).length;
      window.__s1.measurements.push({
        case: c.id,
        computeMs: res.computeMs,
        renderMs: t1 - t0,
        rows,
      });
      if (window.__s1.measurements.length === CASES.length) window.__s1.done = true;
      onDone();
    });
    return () => {
      alive = false;
    };
  }, [c, onDone]);
  return (
    <section className="spike-card gdv" data-case={c.id}>
      <header>
        {c.oldName === c.newName ? c.newName : `${c.oldName} → ${c.newName} (60%)`}
        <span style={{ color: "var(--muted)", fontWeight: 400 }}>
          compute {computeMs.toFixed(1)} ms
        </span>
        <button
          type="button"
          className="btn"
          onClick={() => file?.onAllExpand(mode === DiffModeEnum.Split ? "split" : "unified")}
        >
          ⇕ Expand all
        </button>
      </header>
      {file && (
        <DiffView
          diffFile={file}
          diffViewMode={mode}
          diffViewHighlight={c.id !== "big3000"}
          diffViewWrap={false}
          diffViewTheme={document.documentElement.classList.contains("dark") ? "dark" : "light"}
          diffViewFontSize={12}
        />
      )}
    </section>
  );
}

function App() {
  const [mode, setMode] = useState<DiffModeEnum>(DiffModeEnum.Unified);
  const [mounted, setMounted] = useState(1);
  const onDone = useCallback(() => setMounted((n) => n + 1), []);
  return (
    <StrictMode>
      <div style={{ padding: 16 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <strong>@git-diff-view/react</strong>
          <button
            type="button"
            className="btn"
            id="toggle-mode"
            onClick={() =>
              setMode((m) =>
                m === DiffModeEnum.Unified ? DiffModeEnum.Split : DiffModeEnum.Unified,
              )
            }
          >
            {mode === DiffModeEnum.Unified ? "Unified" : "Split"}
          </button>
          <button
            type="button"
            className="btn"
            id="toggle-theme"
            onClick={() => document.documentElement.classList.toggle("dark")}
          >
            Theme
          </button>
        </div>
        {CASES.slice(0, mounted).map((c) => (
          <Card key={c.id} c={c} mode={mode} onDone={onDone} />
        ))}
      </div>
    </StrictMode>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
