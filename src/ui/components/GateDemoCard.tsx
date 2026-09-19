export function DemoLine({
  tone,
  num,
  text,
}: {
  tone: "ctx" | "add" | "del" | "hunk";
  num: string;
  text: string;
}) {
  const row =
    tone === "add"
      ? "bg-diff-add-bg"
      : tone === "del"
        ? "bg-diff-del-bg"
        : tone === "hunk"
          ? "bg-diff-hunk-bg text-muted"
          : "";
  const gutter =
    tone === "add"
      ? "bg-diff-add-num text-success"
      : tone === "del"
        ? "bg-diff-del-num text-danger"
        : "bg-surface-sunken text-muted/70";
  return (
    <div className={`grid grid-cols-[36px_1fr] font-mono text-[11.5px] leading-5 ${row}`}>
      <span className={`whitespace-pre px-2 text-right text-[10.5px] ${gutter}`}>{num}</span>
      <span className="whitespace-pre px-2">{text}</span>
    </div>
  );
}

/** The landing page's demo runs in every browser, so the gate shows a taste of it and links down. */
export function DemoCard({ onTry }: { onTry: () => void }) {
  return (
    <div className="hidden overflow-hidden rounded-xl border border-line bg-surface sm:block">
      <div className="flex justify-between border-b border-line-subtle px-3 py-2 font-mono text-[12px] text-muted">
        <span>
          {"demo · "}
          <b className="font-medium text-success">works here</b>
        </span>
        <span>sample repo</span>
      </div>
      <div className="flex h-6 items-center gap-[7px] bg-accent-subtle px-3 font-mono text-[11.5px] text-ink/80">
        <span className="inline-block h-4 w-4 flex-none rounded-[4px] bg-status-m-bg text-center text-[10px] font-bold leading-4 text-status-m-fg">
          M
        </span>
        <span className="overflow-hidden text-ellipsis">cart.ts</span>
        <span className="flex-none rounded-full border border-chip-staged-fg/45 bg-chip-staged-bg px-[5px] text-[9.5px] font-semibold leading-[15px] text-chip-staged-fg">
          staged
        </span>
        <span className="ml-auto text-[11px] text-muted">
          <b className="font-medium text-success">+41</b>{" "}
          <i className="not-italic text-danger">−9</i>
        </span>
      </div>
      <div className="flex h-6 items-center gap-[7px] px-3 font-mono text-[11.5px] text-ink/80">
        <span className="inline-block h-4 w-4 flex-none rounded-[4px] bg-status-a-bg text-center text-[10px] font-bold leading-4 text-status-a-fg">
          A
        </span>
        <span className="overflow-hidden text-ellipsis">coupon.ts</span>
        <span className="flex-none rounded-full border border-chip-untracked-fg/45 bg-chip-untracked-bg px-[5px] text-[9.5px] font-semibold leading-[15px] text-chip-untracked-fg">
          untracked
        </span>
        <span className="ml-auto text-[11px] text-muted">
          <b className="font-medium text-success">+96</b>
        </span>
      </div>
      <DemoLine tone="hunk" num="" text="@@ -12,6 +12,9 @@ export function total(cart)" />
      <DemoLine tone="ctx" num="12" text="  const sub = sum(cart.items);" />
      <DemoLine tone="del" num="13" text="- return sub;" />
      <DemoLine tone="add" num="13" text="+ const off = coupon(cart.code, sub);" />
      <DemoLine tone="add" num="14" text="+ return sub - off;" />
      <div className="flex items-center justify-between border-t border-line-subtle px-3 py-2.5 text-[13px]">
        <span>The interactive demo runs in any browser.</span>
        <button
          type="button"
          className="cursor-pointer font-medium text-accent hover:underline"
          onClick={onTry}
        >
          Try it ↓
        </button>
      </div>
    </div>
  );
}
