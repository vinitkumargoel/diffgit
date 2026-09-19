import { Command } from "cmdk";
import { Check, ChevronDown, CircleX, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { RepoRef, ResolvedRevision, StashInfo, TagInfo } from "../../engine/types";
import type { UiError } from "../errors";
import { type BadgeKind, findRef, groupRefs, refBadges, revisionOfRef } from "../refGroups";
import { timeAgo } from "../timeAgo";
import { Badge } from "./Badge";

/** The two `Special` rows (Design §14.1); the compare picker only. */
export type SpecialSource = "worktree" | "staged";

export interface BranchPickerProps {
  /** "base" or "compare" — used for accessible names only; the engine calls them target/source. */
  label: string;
  /** Expression currently on this side: a full ref name, `HEAD`, `stash@{0}`, `v1.0.0`, a SHA. */
  value: string;
  /** What the trigger prints (`sourceLabels`). */
  display: string;
  refs: readonly RepoRef[];
  /** `null` until the store has listed them (T11.2: lazily, when a picker is first opened). */
  tags: readonly TagInfo[] | null;
  stashes: readonly StashInfo[] | null;
  /** Show the `Special` group — the compare picker only (Design §14.1). */
  special?: boolean;
  twoDot: boolean;
  onTwoDot: (on: boolean) => void;
  /** Fired the first time the popover opens, so tags and stashes can be fetched on demand. */
  onOpen?: () => void;
  onSelect: (rev: ResolvedRevision) => void;
  onSpecial?: (kind: SpecialSource) => void;
  /** Resolves the free-text row; rejects with `REV_NOT_FOUND` / `REV_AMBIGUOUS`. */
  onResolve: (expr: string) => Promise<ResolvedRevision>;
}

const STASH_RE = /^stash@\{\d+\}$/;

/** Which noun the trigger's accessible name uses, so a stash never reads as a "branch". */
export function nounOf(value: string, refs: readonly RepoRef[]): string {
  if (findRef(refs, value)) return "branch";
  if (value.startsWith("refs/tags/")) return "tag";
  if (STASH_RE.test(value)) return "stash";
  return "revision";
}

function triggerBadges(value: string, refs: readonly RepoRef[]): BadgeKind[] {
  const ref = findRef(refs, value);
  if (ref) return refBadges(ref);
  if (value.startsWith("refs/tags/")) return ["tag"];
  if (STASH_RE.test(value)) return ["stash"];
  return [];
}

/** A tag / stash / branch row turned into the revision the store puts on one side. */
export function revisionOfTag(tag: TagInfo): ResolvedRevision {
  const out: ResolvedRevision = {
    expr: tag.fullName,
    oid: tag.targetOid,
    kind: "tag",
    display: tag.name,
    fullRef: tag.fullName,
  };
  // `resolveRevision` reports the annotated tag object here and the commit in `oid`.
  if (tag.annotated && tag.oid !== tag.targetOid) out.peeledFrom = tag.oid;
  return out;
}

export function revisionOfStash(stash: StashInfo): ResolvedRevision {
  return { expr: stash.expr, oid: stash.oid, kind: "stash", display: stash.expr };
}

function RefRow({ entry: r, selected }: { entry: RepoRef; selected: boolean }) {
  return (
    <>
      <Tick on={selected} />
      <span className="truncate">{r.name}</span>
      {refBadges(r).map((b) => (
        <Badge key={b} kind={b} />
      ))}
    </>
  );
}

function Tick({ on }: { on: boolean }) {
  return on ? (
    <Check size={14} aria-label="current" className="shrink-0" />
  ) : (
    <span className="w-3.5 shrink-0" />
  );
}

/** `3 files · 1 h` under a stash message; `files` is null when the engine stopped counting. */
function stashMeta(s: StashInfo, now: number): string {
  const files = s.files === null ? "" : `${s.files} ${s.files === 1 ? "file" : "files"} · `;
  return `${files}${timeAgo(s.timestamp, now)}`;
}

/**
 * Searchable revision dropdown (Design §7.1 + §14.1): fixed-min-width trigger with badges, cmdk
 * popover with "Local" / "Remote: <name>" / "Tags" / "Stashes" / "Special" groups, a free-text
 * "Use `<text>`" row that resolves on Enter, the inline resolver error, and the
 * `three-dot … | two-dot ..` footer. ↑↓ Enter Esc throughout.
 */
export function BranchPicker({
  label,
  value,
  display,
  refs,
  tags,
  stashes,
  special = false,
  twoDot,
  onTwoDot,
  onOpen,
  onSelect,
  onSpecial,
  onResolve,
}: BranchPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<UiError | null>(null);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const groups = useMemo(() => groupRefs(refs), [refs]);
  const now = Date.now();

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    setQuery("");
    setError(null);
    if (refocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, close]);

  const choose = (rev: ResolvedRevision) => {
    onSelect(rev);
    close(true);
  };

  const resolve = async (expr: string) => {
    setBusy(true);
    setError(null);
    try {
      choose(await onResolve(expr));
    } catch (e) {
      setError(e as UiError);
    } finally {
      setBusy(false);
    }
  };

  const item = (r: RepoRef) => (
    <Command.Item
      key={r.fullName}
      value={r.fullName}
      keywords={[r.name]}
      onSelect={() => choose(revisionOfRef(r))}
      aria-selected={r.fullName === value}
    >
      <RefRow entry={r} selected={r.fullName === value} />
    </Command.Item>
  );

  // The free-text row is offered unless the query already names something in the list, so
  // "main" does not get a second, identical row (Design §14.1 "as a final Use `<text>` row").
  const typed = query.trim();
  const known = useMemo(() => {
    const names = new Set<string>();
    for (const r of refs) {
      names.add(r.name);
      names.add(r.fullName);
    }
    for (const t of tags ?? []) {
      names.add(t.name);
      names.add(t.fullName);
    }
    for (const s of stashes ?? []) names.add(s.expr);
    return names;
  }, [refs, tags, stashes]);
  const freeText = typed !== "" && !known.has(typed);
  const candidates = error?.detail ? error.detail.split(",").filter(Boolean).slice(0, 6) : [];

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        className="btn min-w-[170px] gap-1.5 bg-bg font-mono text-xs font-medium"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`${label} ${nounOf(value, refs)}: ${display}`}
        onClick={() => {
          setOpen((o) => {
            if (!o) onOpen?.();
            return !o;
          });
        }}
      >
        <span className="truncate">{display}</span>
        {triggerBadges(value, refs).map((b) => (
          <Badge key={b} kind={b} />
        ))}
        <ChevronDown size={10} aria-hidden className="ml-auto shrink-0 text-muted" />
      </button>
      {open && (
        <div className="popover absolute top-full left-0 z-20 mt-1 w-80">
          {/* cmdk calls this before its own handler, so ↑↓/Enter keep working. */}
          <Command
            label={`Find a ${label} revision`}
            loop
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                close(true);
              }
            }}
          >
            <Command.Input
              autoFocus
              value={query}
              onValueChange={setQuery}
              placeholder="Find a branch…"
            />
            {error && (
              <div
                role="alert"
                className="border-b border-banner-error-border bg-banner-error-bg px-2.5 py-1.5 text-[12px] leading-4 text-ink"
              >
                <span className="flex items-center gap-1.5">
                  <CircleX size={13} aria-hidden className="shrink-0 text-danger" />
                  {error.message}
                </span>
                {candidates.length > 0 && (
                  <ul className="mt-1 flex flex-wrap gap-1">
                    {candidates.map((oid) => (
                      <li key={oid}>
                        <button
                          type="button"
                          className="btn btn-sm font-mono"
                          onClick={() => void resolve(oid)}
                        >
                          {oid.slice(0, 10)}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <Command.List id={listId} className="max-h-80 overflow-y-auto p-1">
              {/* The free-text row is force-mounted, so it, not this, answers an unmatched query. */}
              {!freeText && <Command.Empty>No matching branches</Command.Empty>}
              {groups.pinned.length > 0 && <Command.Group>{groups.pinned.map(item)}</Command.Group>}
              {groups.local.length > 0 && (
                <Command.Group heading="Local">{groups.local.map(item)}</Command.Group>
              )}
              {groups.remotes.map((g) => (
                <Command.Group key={g.remote} heading={`Remote: ${g.remote}`}>
                  {g.refs.map(item)}
                </Command.Group>
              ))}
              {tags && tags.length > 0 && (
                <Command.Group heading={`Tags · ${tags.length}`}>
                  {tags.map((t) => (
                    <Command.Item
                      key={t.fullName}
                      value={t.fullName}
                      keywords={[t.name]}
                      onSelect={() => choose(revisionOfTag(t))}
                      aria-selected={t.fullName === value}
                    >
                      <Tick on={t.fullName === value} />
                      <span className="truncate">{t.name}</span>
                      <Badge kind="tag" />
                      {t.annotated && (
                        <span className="ml-auto shrink-0 font-sans text-[11px] text-muted">
                          annotated
                        </span>
                      )}
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {stashes && stashes.length > 0 && (
                <Command.Group heading={`Stashes · ${stashes.length}`}>
                  {stashes.map((s) => (
                    <Command.Item
                      key={s.expr}
                      value={s.expr}
                      keywords={[s.message]}
                      onSelect={() => choose(revisionOfStash(s))}
                      aria-selected={s.expr === value}
                      className="!h-auto !py-1"
                    >
                      <Tick on={s.expr === value} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="shrink-0">{s.expr}</span>
                          <span className="truncate font-sans text-[12px] text-ink/80">
                            {s.message}
                          </span>
                        </span>
                        <span className="block font-sans text-[11px] text-muted">
                          {stashMeta(s, now)}
                        </span>
                      </span>
                      <Badge kind="stash" />
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {special && (
                <Command.Group heading="Special">
                  <Command.Item
                    value="Working tree"
                    keywords={["uncommitted", "worktree", "dirty"]}
                    onSelect={() => {
                      onSpecial?.("worktree");
                      close(true);
                    }}
                  >
                    <Tick on={false} />
                    <span className="truncate">Working tree</span>
                    <span className="ml-auto shrink-0 font-sans text-[11px] text-muted">
                      uncommitted
                    </span>
                  </Command.Item>
                  <Command.Item
                    value="Staged only"
                    keywords={["index", "cached"]}
                    onSelect={() => {
                      onSpecial?.("staged");
                      close(true);
                    }}
                  >
                    <Tick on={false} />
                    <span className="truncate">Staged only</span>
                    <span className="ml-auto shrink-0 font-sans text-[11px] text-muted">index</span>
                  </Command.Item>
                </Command.Group>
              )}
              {freeText && (
                <Command.Group forceMount heading="Revision">
                  <Command.Item
                    forceMount
                    value={`use-${typed}`}
                    disabled={busy}
                    onSelect={() => void resolve(typed)}
                  >
                    {busy ? (
                      <LoaderCircle size={13} aria-hidden className="spin shrink-0" />
                    ) : (
                      <Tick on={false} />
                    )}
                    <span className="truncate">Use {typed}</span>
                    <span className="ml-auto shrink-0 font-sans text-[11px] text-muted">
                      SHA, tag, HEAD~n
                    </span>
                  </Command.Item>
                </Command.Group>
              )}
            </Command.List>
            <div className="flex items-center justify-between gap-2 border-t border-line px-2 py-1.5">
              <fieldset
                aria-label="Compare mode"
                className="inline-flex rounded-[6px] border border-line bg-surface-raised p-0"
              >
                <legend className="sr-only">Compare mode</legend>
                <button
                  type="button"
                  aria-pressed={!twoDot}
                  title="Three-dot: show what compare adds since the two sides last met (the merge base), like git base...compare"
                  className={`rounded-[6px] px-2 py-0.5 text-[11px] leading-4 font-medium ${
                    twoDot ? "text-muted hover:text-ink" : "pressed"
                  }`}
                  onClick={() => onTwoDot(false)}
                >
                  three-dot …
                </button>
                <button
                  type="button"
                  aria-pressed={twoDot}
                  title="Two-dot: compare the two trees directly, ignoring the merge base, like git base..compare"
                  className={`rounded-[6px] px-2 py-0.5 text-[11px] leading-4 font-medium ${
                    twoDot ? "pressed" : "text-muted hover:text-ink"
                  }`}
                  onClick={() => onTwoDot(true)}
                >
                  two-dot ..
                </button>
              </fieldset>
            </div>
          </Command>
        </div>
      )}
    </div>
  );
}
