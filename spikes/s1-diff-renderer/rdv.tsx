import { StrictMode, useCallback, useEffect, useMemo, useState } from "react";
import {
  Decoration,
  Diff,
  expandFromRawCode,
  getCollapsedLinesCountBetween,
  Hunk,
  type HunkData,
  markEdits,
  tokenize,
  type ViewType,
} from "react-diff-view";
import { createRoot } from "react-dom/client";
import "react-diff-view/style/index.css";
import { mockHunks } from "../../src/ui/mock/mockContents";
import { afterPaint, CASES, initMeasure, type SpikeCase } from "./cases";
import "./spike.css";

initMeasure();

/** Our HunkModel → react-diff-view hunks. */
function toRdvHunks(c: SpikeCase): HunkData[] {
  const model = mockHunks(c.oldText, c.newText);
  return model.hunks.map((h) => ({
    content: `@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`,
    oldStart: h.oldStart,
    oldLines: h.oldCount,
    newStart: h.newStart,
    newLines: h.newCount,
    changes: h.lines.map((l) =>
      l.type === "ctx"
        ? {
            type: "normal" as const,
            isNormal: true as const,
            oldLineNumber: l.old ?? 0,
            newLineNumber: l.new ?? 0,
            content: l.text,
          }
        : l.type === "add"
          ? {
              type: "insert" as const,
              isInsert: true as const,
              lineNumber: l.new ?? 0,
              content: l.text,
            }
          : {
              type: "delete" as const,
              isDelete: true as const,
              lineNumber: l.old ?? 0,
              content: l.text,
            },
    ),
  }));
}

function Card({ c, viewType, onDone }: { c: SpikeCase; viewType: ViewType; onDone: () => void }) {
  const [hunks, setHunks] = useState<HunkData[] | null>(null);
  const [computeMs, setComputeMs] = useState(0);
  const oldSource = c.oldText;
  useEffect(() => {
    const t0 = performance.now();
    const h = toRdvHunks(c);
    const ms = performance.now() - t0;
    setComputeMs(ms);
    const t1 = performance.now();
    setHunks(h);
    void afterPaint().then((t2) => {
      const rows = document.querySelectorAll(`[data-case="${c.id}"] tr`).length;
      window.__s1.measurements.push({ case: c.id, computeMs: ms, renderMs: t2 - t1, rows });
      if (window.__s1.measurements.length === CASES.length) window.__s1.done = true;
      onDone();
    });
  }, [c, onDone]);
  const tokens = useMemo(() => {
    if (!hunks || c.id === "big3000") return undefined;
    try {
      return tokenize(hunks, {
        highlight: false,
        enhancers: [markEdits(hunks, { type: "block" })],
      });
    } catch {
      return undefined;
    }
  }, [hunks, c.id]);

  function expandAll() {
    if (!hunks) return;
    let next = hunks;
    const totalOld = oldSource.split("\n").length;
    // expand every gap between hunks plus head/tail
    let start = 1;
    for (const h of next) {
      if (h.oldStart > start) next = expandFromRawCode(next, oldSource, start, h.oldStart);
      start = h.oldStart + h.oldLines;
    }
    if (start <= totalOld) next = expandFromRawCode(next, oldSource, start, totalOld + 1);
    setHunks(next);
  }

  return (
    <section className="spike-card rdv" data-case={c.id}>
      <header>
        {c.oldName === c.newName ? c.newName : `${c.oldName} → ${c.newName} (60%)`}
        <span style={{ color: "var(--muted)", fontWeight: 400 }}>
          compute {computeMs.toFixed(1)} ms
        </span>
        <button type="button" className="btn" onClick={expandAll}>
          ⇕ Expand all
        </button>
      </header>
      {hunks && (
        <Diff viewType={viewType} diffType="modify" hunks={hunks} tokens={tokens}>
          {(hs) =>
            hs.map((h, i) => {
              const prev = hs[i - 1];
              const gap = prev ? getCollapsedLinesCountBetween(prev, h) : h.oldStart - 1;
              return [
                gap > 0 ? (
                  <Decoration key={`d${h.content}`}>
                    <button
                      type="button"
                      className="btn"
                      onClick={() =>
                        setHunks(
                          expandFromRawCode(
                            hs,
                            oldSource,
                            prev ? prev.oldStart + prev.oldLines : 1,
                            h.oldStart,
                          ),
                        )
                      }
                    >
                      ↑ expand {gap} lines
                    </button>
                    <span style={{ marginLeft: 12 }}>{h.content}</span>
                  </Decoration>
                ) : null,
                <Hunk key={h.content} hunk={h} />,
              ];
            })
          }
        </Diff>
      )}
    </section>
  );
}

function App() {
  const [viewType, setViewType] = useState<ViewType>("unified");
  const [mounted, setMounted] = useState(1);
  const onDone = useCallback(() => setMounted((n) => n + 1), []);
  return (
    <StrictMode>
      <div style={{ padding: 16 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <strong>react-diff-view</strong>
          <button
            type="button"
            className="btn"
            id="toggle-mode"
            onClick={() => setViewType((v) => (v === "unified" ? "split" : "unified"))}
          >
            {viewType === "unified" ? "Unified" : "Split"}
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
          <Card key={c.id} c={c} viewType={viewType} onDone={onDone} />
        ))}
      </div>
    </StrictMode>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
