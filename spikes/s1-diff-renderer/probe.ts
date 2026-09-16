// bun spikes/s1-diff-renderer/probe.ts — check DiffFile bundle round-trip outside the browser
import { DiffFile } from "@git-diff-view/core";
import { mockHunks } from "../../src/ui/mock/mockContents";
import { CASES } from "./cases";
import { hunkModelToDiffList } from "./hunkText";

const c = CASES[0];
if (!c) throw new Error("no case");
const diffList = hunkModelToDiffList(mockHunks(c.oldText, c.newText));
const f = new DiffFile(c.oldName, c.oldText, c.newName, c.newText, diffList, c.lang, c.lang);
f.initTheme("light");
f.initRaw();
f.buildSplitDiffLines();
f.buildUnifiedDiffLines();
console.log(
  "worker side: unified",
  f.unifiedLineLength,
  "split",
  f.splitLineLength,
  "hunks",
  diffList.length,
);
const bundle = f.getBundle();
console.log("bundle keys", Object.keys(bundle));
const g = DiffFile.createInstance(
  {
    oldFile: { fileName: c.oldName, fileLang: c.lang, content: c.oldText },
    newFile: { fileName: c.newName, fileLang: c.lang, content: c.newText },
    hunks: diffList,
  },
  bundle,
);
console.log(
  "main side after createInstance: unified",
  g.unifiedLineLength,
  "split",
  g.splitLineLength,
);
g.buildUnifiedDiffLines();
g.buildSplitDiffLines();
console.log("main side after build: unified", g.unifiedLineLength, "split", g.splitLineLength);
g.onAllExpand("unified");
console.log(
  "after onAllExpand unified",
  g.unifiedLineLength,
  "expected total ≈",
  c.newText.split("\n").length,
);
console.log("bundle JSON size", JSON.stringify(bundle).length);
const hidden = Array.from(
  { length: g.unifiedLineLength },
  (_, i) => g.getUnifiedLine(i)?.isHidden,
).filter(Boolean).length;
console.log("hidden", hidden, "add", g.additionLength, "del", g.deletionLength);
console.log(`first hunk text:\n${(diffList[0] ?? "").split("\n").slice(0, 6).join("\n")}`);
const joined = ["--- a/x", "+++ b/x", ...diffList].join("\n");
const h = new DiffFile(c.oldName, c.oldText, c.newName, c.newText, [joined], c.lang, c.lang);
h.initTheme("light");
h.initRaw();
h.buildUnifiedDiffLines();
console.log(
  "joined variant: hidden",
  Array.from({ length: h.unifiedLineLength }, (_, i) => h.getUnifiedLine(i)?.isHidden).filter(
    Boolean,
  ).length,
  "add",
  h.additionLength,
  "del",
  h.deletionLength,
  "len",
  h.unifiedLineLength,
);
