/**
 * The interactive diff demo embedded in the "Precision" landing page (src/marketing/precision.html).
 * This is a faithful port of the mockup's inline <script>: the CSP forbids inline scripts
 * (`script-src 'self'`), so the same logic runs here as a bundled module instead. It drives the
 * sample repository shown in the `#demo` section and owns only the DOM inside the `root` it is
 * given — never the real app, which is React.
 */

type Kind = "ctx" | "add" | "del";
/** [kind, oldLineNo, newLineNo, htmlCode, layer?] — `layer` marks a line as uncommitted work. */
type Line = [Kind, number | null, number | null, string, string?];
type Hunk = { h: string; lines: Line[] };
type DemoFile = {
  id: string;
  st: string;
  dir: string;
  name: string;
  from?: string;
  sim?: number;
  layers: string[];
  viewed: boolean;
  hunks: Hunk[];
};

const FILES: DemoFile[] = [
  {
    id: "cart",
    st: "M",
    dir: "src/checkout/",
    name: "cart.ts",
    layers: ["staged", "unstaged"],
    viewed: false,
    hunks: [
      {
        h: "@@ -41,9 +41,14 @@ export function applyCoupon(cart: Cart, code: string)",
        lines: [
          [
            "ctx",
            41,
            41,
            '  <span class="k">const</span> coupon = <span class="f">findCoupon</span>(code);',
          ],
          ["ctx", 42, 42, '  <span class="k">if</span> (!coupon) {'],
          [
            "del",
            43,
            null,
            '    <span class="k">throw new</span> <span class="f">Error</span>(<span class="s">"Invalid coupon"</span>);',
          ],
          [
            "add",
            null,
            43,
            '    <span class="k">return</span> { ...cart, <span class="w">error: <span class="s">"INVALID_COUPON"</span></span> };',
          ],
          ["ctx", 44, 44, "  }"],
          [
            "del",
            45,
            null,
            '  <span class="k">const</span> discount = <span class="wd">cart.subtotal * coupon.pct</span>;',
          ],
          [
            "add",
            null,
            45,
            '  <span class="k">const</span> discount = <span class="w">Math.min(cart.subtotal * coupon.pct, coupon.maxOff ?? Infinity)</span>;',
          ],
          [
            "add",
            null,
            46,
            '  <span class="f">track</span>(<span class="s">"coupon.applied"</span>, { code, discount });',
            "unstaged",
          ],
          ["ctx", 46, 47, '  <span class="k">return</span> { ...cart, discount };'],
        ],
      },
      {
        h: "@@ -88,6 +93,9 @@ export function total(cart: Cart)",
        lines: [
          [
            "ctx",
            88,
            93,
            '  <span class="k">const</span> tax = <span class="f">round</span>(cart.subtotal * TAX);',
          ],
          [
            "add",
            null,
            94,
            '  <span class="k">const</span> shipping = cart.items.length ? SHIPPING : <span class="s">0</span>;',
          ],
          [
            "add",
            null,
            95,
            '  <span class="k">const</span> discount = cart.discount ?? <span class="s">0</span>;',
          ],
          [
            "ctx",
            89,
            96,
            '  <span class="k">return</span> <span class="f">round</span>(cart.subtotal + tax + shipping - discount);',
          ],
        ],
      },
    ],
  },
  {
    id: "coupon",
    st: "A",
    dir: "src/checkout/",
    name: "coupon.ts",
    layers: ["untracked"],
    viewed: false,
    hunks: [
      {
        h: "@@ -0,0 +1,9 @@",
        lines: [
          ["add", null, 1, '<span class="k">export interface</span> Coupon {', "untracked"],
          ["add", null, 2, '  code: <span class="k">string</span>;', "untracked"],
          ["add", null, 3, '  pct: <span class="k">number</span>;', "untracked"],
          ["add", null, 4, '  maxOff?: <span class="k">number</span>;', "untracked"],
          ["add", null, 5, "}", "untracked"],
          ["add", null, 6, "", "untracked"],
          [
            "add",
            null,
            7,
            '<span class="k">export function</span> <span class="f">findCoupon</span>(code: <span class="k">string</span>): Coupon | <span class="k">undefined</span> {',
            "untracked",
          ],
          [
            "add",
            null,
            8,
            '  <span class="k">return</span> COUPONS.find(c => c.code === code.toUpperCase());',
            "untracked",
          ],
          ["add", null, 9, "}", "untracked"],
        ],
      },
    ],
  },
  {
    id: "orders",
    st: "M",
    dir: "src/api/",
    name: "orders.ts",
    layers: [],
    viewed: true,
    hunks: [
      {
        h: "@@ -12,7 +12,8 @@ export async function createOrder(cart: Cart)",
        lines: [
          [
            "ctx",
            12,
            12,
            '  <span class="k">const</span> total = <span class="f">totalOf</span>(cart);',
          ],
          [
            "del",
            13,
            null,
            '  <span class="k">return</span> db.orders.<span class="f">insert</span>({ items: cart.items, total });',
          ],
          [
            "add",
            null,
            13,
            '  <span class="k">return</span> db.orders.<span class="f">insert</span>({ items: cart.items, total, <span class="w">discount: cart.discount</span> });',
          ],
          ["ctx", 14, 14, "}"],
        ],
      },
    ],
  },
  {
    id: "money",
    st: "R",
    dir: "src/lib/",
    name: "money.ts",
    from: "src/util/money.ts",
    sim: 96,
    layers: ["staged"],
    viewed: true,
    hunks: [
      {
        h: "@@ -1,4 +1,4 @@",
        lines: [
          [
            "del",
            1,
            null,
            '<span class="k">export const</span> <span class="f">round</span> = (n: <span class="k">number</span>) => Math.round(n * <span class="wd">100</span>) / <span class="wd">100</span>;',
          ],
          [
            "add",
            null,
            1,
            '<span class="k">export const</span> <span class="f">round</span> = (n: <span class="k">number</span>) => Math.round(n * <span class="w">CENTS</span>) / <span class="w">CENTS</span>;',
          ],
          [
            "ctx",
            2,
            2,
            '<span class="k">export const</span> <span class="f">format</span> = (n: <span class="k">number</span>) => n.toFixed(2);',
          ],
        ],
      },
    ],
  },
  {
    id: "legacy",
    st: "D",
    dir: "src/checkout/",
    name: "legacy.ts",
    layers: ["staged"],
    viewed: false,
    hunks: [
      {
        h: "@@ -1,4 +0,0 @@",
        lines: [
          [
            "del",
            1,
            null,
            '<span class="k">export function</span> <span class="f">legacyDiscount</span>(cart) {',
          ],
          [
            "del",
            2,
            null,
            '  <span class="k">return</span> cart.subtotal * <span class="s">0.1</span>;',
          ],
          ["del", 3, null, "}"],
        ],
      },
    ],
  },
  {
    id: "readme",
    st: "M",
    dir: "",
    name: "README.md",
    layers: ["unstaged"],
    viewed: false,
    hunks: [
      {
        h: "@@ -8,3 +8,6 @@",
        lines: [
          ["ctx", 8, 8, "## Checkout"],
          ["add", null, 9, "", "unstaged"],
          [
            "add",
            null,
            10,
            "Coupons are applied with `applyCoupon(cart, code)`. Invalid codes",
            "unstaged",
          ],
          ["add", null, 11, "return an error on the cart instead of throwing.", "unstaged"],
        ],
      },
    ],
  },
];

type State = { sel: string | null; mode: "unified" | "split"; inc: boolean; filter: string };

function visibleLines(f: DemoFile, state: State): Hunk[] {
  return f.hunks
    .map((h) => ({ h: h.h, lines: h.lines.filter((l) => state.inc || !l[4]) }))
    .filter((h) => h.lines.length);
}

function visibleFiles(state: State): DemoFile[] {
  return FILES.filter((f) => {
    if (!state.inc && f.layers.length && f.layers.every((l) => l !== "staged")) return false;
    if (state.filter && !(f.dir + f.name).toLowerCase().includes(state.filter.toLowerCase()))
      return false;
    return true;
  });
}

function counts(f: DemoFile, state: State): { p: number; m: number } {
  let p = 0;
  let m = 0;
  for (const h of visibleLines(f, state)) {
    for (const l of h.lines) {
      if (l[0] === "add") p++;
      else if (l[0] === "del") m++;
    }
  }
  return { p, m };
}

function line(l: Line, side?: "left" | "right"): string {
  const [t, a, b, code] = l;
  if (side === "left") {
    if (t === "add")
      return '<div class="l empty"><span class="g"></span><span class="c"></span></div>';
    return `<div class="l ${t}"><span class="g">${a ?? ""}</span><span class="c">${code}</span></div>`;
  }
  if (side === "right") {
    if (t === "del")
      return '<div class="l empty"><span class="g"></span><span class="c"></span></div>';
    return `<div class="l ${t}"><span class="g">${b ?? ""}</span><span class="c">${code}</span></div>`;
  }
  return `<div class="l ${t}"><span class="g">${a ?? ""}</span><span class="g">${b ?? ""}</span><span class="c">${code}</span></div>`;
}

/** Align del/add pairs so split view shows removals on the left and additions on the right. */
function pairUp(lines: Line[]): [Line, Line][] {
  const out: [Line, Line][] = [];
  let i = 0;
  const blankAdd: Line = ["add", null, null, ""];
  const blankDel: Line = ["del", null, null, ""];
  while (i < lines.length) {
    if (lines[i][0] === "del") {
      const dels: Line[] = [];
      while (i < lines.length && lines[i][0] === "del") dels.push(lines[i++]);
      const adds: Line[] = [];
      while (i < lines.length && lines[i][0] === "add") adds.push(lines[i++]);
      for (let k = 0; k < Math.max(dels.length, adds.length); k++)
        out.push([dels[k] ?? blankAdd, adds[k] ?? blankDel]);
    } else if (lines[i][0] === "add") {
      out.push([blankAdd, lines[i++]]);
    } else {
      out.push([lines[i], lines[i]]);
      i++;
    }
  }
  return out;
}

/**
 * Boots the demo inside `root` and returns a cleanup that detaches its listeners. Every element is
 * looked up under `root`, so the demo never reaches outside the landing page.
 */
export function initPrecisionDemo(root: HTMLElement): () => void {
  const tree = root.querySelector<HTMLElement>("#tree");
  const pane = root.querySelector<HTMLElement>("#pane");
  const app = root.querySelector<HTMLElement>("#app");
  const inc = root.querySelector<HTMLInputElement>("#inc");
  const filterEl = root.querySelector<HTMLInputElement>("#filter");
  const seg = root.querySelector<HTMLElement>("#seg");
  if (!tree || !pane || !app || !inc || !filterEl || !seg) return () => {};

  const state: State = { sel: "cart", mode: "unified", inc: true, filter: "" };
  const set = (sel: string, text: string) => {
    const el = root.querySelector<HTMLElement>(sel);
    if (el) el.textContent = text;
  };

  function renderPane(): void {
    const f = FILES.find((x) => x.id === state.sel);
    if (!f || !pane) {
      if (pane) pane.innerHTML = '<div class="empty-state">Select a file.</div>';
      return;
    }
    const c = counts(f, state);
    const hunks = visibleLines(f, state);
    const chips = (state.inc ? f.layers : f.layers.filter((l) => l === "staged"))
      .map((l) => `<span class="chip ${l}">${l}</span>`)
      .join("");
    const title = f.st === "R" ? `${f.from} → ${f.dir}${f.name}` : f.dir + f.name;
    let body: string;
    if (state.mode === "unified") {
      body = hunks
        .map(
          (h) =>
            `<div class="l hunk"><span></span><span></span><span>${h.h}</span></div>` +
            h.lines.map((l) => line(l)).join(""),
        )
        .join("");
    } else {
      const left = hunks
        .map(
          (h) =>
            `<div class="l hunk"><span></span><span>${h.h}</span></div>` +
            pairUp(h.lines)
              .map(([L]) => line(L, "left"))
              .join(""),
        )
        .join("");
      const right = hunks
        .map(
          (h) =>
            '<div class="l hunk"><span></span><span>&nbsp;</span></div>' +
            pairUp(h.lines)
              .map(([, R]) => line(R, "right"))
              .join(""),
        )
        .join("");
      body = `<div class="split"><div class="side">${left}</div><div class="side">${right}</div></div>`;
    }
    const stats = `${c.p ? `<b>+${c.p}</b>` : ""} ${c.m ? `<i>−${c.m}</i>` : ""}`;
    const note =
      (state.mode === "unified"
        ? "Unified view. Press <kbd>s</kbd> for split."
        : "Split view. Press <kbd>s</kbd> for unified.") +
      (state.inc
        ? ""
        : " Uncommitted layers hidden: unstaged and untracked changes are not shown.");
    pane.innerHTML = `<div class="card"><div class="fh"><span class="st ${f.st}">${f.st}</span>${title}<span class="n">${stats}</span>${chips}<label><input type="checkbox" id="viewed" ${f.viewed ? "checked" : ""}> Viewed</label></div>${body}</div>
  <p class="mode-note">${note}</p>`;
    const viewed = root.querySelector<HTMLInputElement>("#viewed");
    viewed?.addEventListener("change", (e) => {
      f.viewed = (e.target as HTMLInputElement).checked;
      render();
    });
  }

  function render(): void {
    const files = visibleFiles(state);
    if (!files.find((f) => f.id === state.sel)) state.sel = files[0]?.id ?? null;
    let tp = 0;
    let tm = 0;
    let tv = 0;
    const rows = files
      .map((f) => {
        const c = counts(f, state);
        tp += c.p;
        tm += c.m;
        if (f.viewed) tv++;
        const chips = (state.inc ? f.layers : f.layers.filter((l) => l === "staged"))
          .map((l) => `<span class="chip ${l}">${l}</span>`)
          .join("");
        const n =
          f.st === "R"
            ? `<span class="n" style="color:var(--blue)">${f.sim}%</span>`
            : `<span class="n">${c.p ? `<b>+${c.p}</b>` : ""} ${c.m ? `<i>−${c.m}</i>` : ""}</span>`;
        return `<button class="row ${f.id === state.sel ? "on" : ""}" data-id="${f.id}"><span class="st ${f.st}">${f.st}</span><span class="p"><span class="dir">${f.dir}</span>${f.name}</span>${chips}${n}<span class="tick ${f.viewed ? "on" : ""}" data-tick="${f.id}" title="Viewed"></span></button>`;
      })
      .join("");
    if (tree)
      tree.innerHTML =
        '<div class="h">Files changed</div>' +
        rows +
        (files.length ? "" : '<div class="empty-state">No files match.</div>');
    set("#nfiles", String(files.length));
    set("#nfiles2", String(files.length));
    set("#tplus", `+${tp}`);
    set("#tminus", `−${tm}`);
    set("#nviewed", String(tv));
    renderPane();
  }

  const onTreeClick = (e: Event) => {
    const target = e.target as HTMLElement | null;
    const tick = target?.closest<HTMLElement>("[data-tick]");
    if (tick) {
      const f = FILES.find((x) => x.id === tick.dataset.tick);
      if (f) f.viewed = !f.viewed;
      render();
      e.stopPropagation();
      return;
    }
    const row = target?.closest<HTMLElement>(".row");
    if (row?.dataset.id) {
      state.sel = row.dataset.id;
      render();
    }
  };
  const onIncChange = (e: Event) => {
    state.inc = (e.target as HTMLInputElement).checked;
    render();
  };
  const onFilterInput = (e: Event) => {
    state.filter = (e.target as HTMLInputElement).value;
    render();
  };
  const onSegClick = (e: Event) => {
    const b = (e.target as HTMLElement | null)?.closest<HTMLElement>("button");
    if (!b?.dataset.m) return;
    state.mode = b.dataset.m as State["mode"];
    for (const x of Array.from(seg.children)) x.classList.toggle("on", x === b);
    renderPane();
  };
  const onAppKey = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (target?.tagName === "INPUT" && e.key !== "Escape") return;
    const files = visibleFiles(state);
    const i = files.findIndex((f) => f.id === state.sel);
    if (e.key === "j") {
      state.sel = files[Math.min(i + 1, files.length - 1)]?.id ?? state.sel;
      render();
    } else if (e.key === "k") {
      state.sel = files[Math.max(i - 1, 0)]?.id ?? state.sel;
      render();
    } else if (e.key === "s") {
      state.mode = state.mode === "unified" ? "split" : "unified";
      for (const x of Array.from(seg.children))
        x.classList.toggle("on", (x as HTMLElement).dataset.m === state.mode);
      renderPane();
    } else if (e.key === "v") {
      const f = FILES.find((x) => x.id === state.sel);
      if (f) {
        f.viewed = !f.viewed;
        render();
      }
    } else if (e.key === "/") {
      e.preventDefault();
      filterEl.focus();
    } else if (e.key === "Escape") {
      filterEl.value = "";
      state.filter = "";
      render();
      app.focus();
    } else {
      return;
    }
    e.preventDefault();
  };

  tree.addEventListener("click", onTreeClick);
  inc.addEventListener("change", onIncChange);
  filterEl.addEventListener("input", onFilterInput);
  seg.addEventListener("click", onSegClick);
  app.addEventListener("keydown", onAppKey);
  render();

  return () => {
    tree.removeEventListener("click", onTreeClick);
    inc.removeEventListener("change", onIncChange);
    filterEl.removeEventListener("input", onFilterInput);
    seg.removeEventListener("click", onSegClick);
    app.removeEventListener("keydown", onAppKey);
  };
}
