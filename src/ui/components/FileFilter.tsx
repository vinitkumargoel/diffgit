import { Search, X } from "lucide-react";
import { useRef } from "react";
import { useShortcuts } from "../hooks/useShortcuts";

export interface FileFilterProps {
  value: string;
  onChange: (text: string) => void;
}

/**
 * Bordered 240 px input (Design §7.2): search icon, "Filter files…", `/` hint, clear ×.
 * `/` focuses it from anywhere outside a field; Esc clears and blurs. The sidebar header
 * shows "n of m files" while a filter is active (T5.2).
 */
export function FileFilter({ value, onChange }: FileFilterProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  useShortcuts({
    "/": () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    },
  });
  return (
    <div className="relative flex h-7 w-60 items-center rounded-[6px] border border-line bg-bg focus-within:outline-2 focus-within:outline-accent focus-within:outline-offset-1">
      <Search size={13} aria-hidden className="ml-2 shrink-0 text-muted" />
      <input
        ref={inputRef}
        type="search"
        value={value}
        placeholder="Filter files…"
        aria-label="Filter files"
        aria-keyshortcuts="/"
        className="h-full min-w-0 flex-1 bg-transparent px-2 text-[13px] outline-none placeholder:text-muted [&::-webkit-search-cancel-button]:hidden"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            onChange("");
            e.currentTarget.blur();
          }
        }}
      />
      {value ? (
        <button
          type="button"
          className="mr-1 flex size-5 items-center justify-center rounded-[4px] text-muted hover:bg-surface-raised hover:text-ink"
          aria-label="Clear filter"
          onClick={() => {
            onChange("");
            inputRef.current?.focus();
          }}
        >
          <X size={12} aria-hidden />
        </button>
      ) : (
        <kbd className="kbd mr-2" aria-hidden>
          /
        </kbd>
      )}
    </div>
  );
}
