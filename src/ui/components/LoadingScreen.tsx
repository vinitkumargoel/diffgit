import { Circle, CircleCheck, LoaderCircle } from "lucide-react";
import { LOADING_LABELS, LOADING_STEPS, type LoadingState, useStore } from "../store";
import { CenteredColumn } from "./CenteredColumn";

const fmt = new Intl.NumberFormat("en-US");

export function stepStatus(loading: LoadingState, step: (typeof LOADING_STEPS)[number]) {
  if (loading.completed.includes(step)) return "done" as const;
  if (loading.step === step) return "current" as const;
  return "pending" as const;
}

/** Design §7.8 LoadingScreen: repo name, four phases with icons and counts, Cancel. */
export function LoadingScreen({ repoName }: { repoName: string }) {
  const loading = useStore((s) => s.loading);
  const closeRepo = useStore((s) => s.closeRepo);
  return (
    <CenteredColumn label="Opening repository">
      <h1 className="text-2xl font-semibold leading-8">{repoName}</h1>
      <ol className="w-full max-w-[320px] text-left" aria-live="polite">
        {LOADING_STEPS.map((step) => {
          const status = stepStatus(loading, step);
          const count =
            status === "current" && loading.total !== undefined
              ? ` ${fmt.format(loading.done ?? 0)} / ${fmt.format(loading.total)}`
              : "";
          return (
            <li
              key={step}
              className={`flex items-center gap-3 py-1.5 ${status === "pending" ? "text-muted" : ""}`}
              aria-current={status === "current" ? "step" : undefined}
            >
              {status === "done" && (
                <CircleCheck size={16} className="text-success" aria-label="done" />
              )}
              {status === "current" && (
                <LoaderCircle size={16} className="spin text-accent" aria-label="in progress" />
              )}
              {status === "pending" && (
                <Circle size={16} className="text-muted" aria-label="pending" />
              )}
              <span>
                {LOADING_LABELS[step]}
                <span className="tabular-nums text-muted">{count}</span>
              </span>
            </li>
          );
        })}
      </ol>
      <button type="button" className="btn" onClick={() => void closeRepo()}>
        Cancel
      </button>
    </CenteredColumn>
  );
}
