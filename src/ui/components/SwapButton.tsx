import { ArrowLeftRight } from "lucide-react";

/** `⇄` (Design §7.1 item 3): 28 × 28 bordered; disabled at 50 % when base === compare. */
export function SwapButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className="btn btn-icon"
      aria-label="Swap base and compare"
      title={disabled ? "Base and compare are the same branch" : "Swap base and compare"}
      disabled={disabled}
      onClick={onClick}
    >
      <ArrowLeftRight size={14} aria-hidden />
    </button>
  );
}
