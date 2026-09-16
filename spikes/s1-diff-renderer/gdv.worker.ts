/**
 * Spike S1: compute a @git-diff-view DiffFile in a Web Worker (with Shiki JS-engine highlighting),
 * serialise it with getBundle(), and post it back for hydration on the main thread.
 */
import { DiffFile } from "@git-diff-view/core";
import { getDiffViewHighlighter } from "@git-diff-view/shiki";
import { mockHunks } from "../../src/ui/mock/mockContents";
import { hunkModelToDiffList } from "./hunkText";

export interface WorkerRequest {
  id: string;
  oldName: string;
  newName: string;
  lang: string;
  oldText: string;
  newText: string;
  highlight: boolean;
}
export interface WorkerResponse {
  id: string;
  data: Parameters<typeof DiffFile.createInstance>[0];
  bundle: ReturnType<DiffFile["getBundle"]>;
  computeMs: number;
  hunkCount: number;
}

let highlighterPromise: ReturnType<typeof getDiffViewHighlighter> | null = null;

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  const t0 = performance.now();
  const diffList = hunkModelToDiffList(mockHunks(req.oldText, req.newText));
  const file = new DiffFile(
    req.oldName,
    req.oldText,
    req.newName,
    req.newText,
    diffList,
    req.lang,
    req.lang,
  );
  file.initTheme("light");
  file.initRaw();
  if (req.highlight) {
    highlighterPromise ??= getDiffViewHighlighter();
    const hl = await highlighterPromise;
    file.initSyntax({ registerHighlighter: hl });
  }
  file.buildSplitDiffLines();
  file.buildUnifiedDiffLines();
  const res: WorkerResponse = {
    id: req.id,
    data: {
      oldFile: { fileName: req.oldName, fileLang: req.lang, content: req.oldText },
      newFile: { fileName: req.newName, fileLang: req.lang, content: req.newText },
      hunks: diffList,
    },
    bundle: file.getBundle(),
    computeMs: performance.now() - t0,
    hunkCount: diffList.length,
  };
  (self as unknown as Worker).postMessage(res);
};
