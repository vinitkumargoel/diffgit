import { CircleX } from "lucide-react";
import { describeError } from "../errors";
import { useStore } from "../store";
import { CenteredColumn } from "./CenteredColumn";

/** Minimal error screen (completed in T5.5 with actions per describeError). Default export: lazy chunk. */
export default function ErrorScreen() {
  const error = useStore((s) => s.error);
  const closeRepo = useStore((s) => s.closeRepo);
  const d = describeError(error?.code);
  return (
    <CenteredColumn label="Error">
      <CircleX size={32} className="text-danger" aria-hidden="true" />
      <h1 className="text-2xl font-semibold leading-8">{d.title}</h1>
      <p className="text-muted">{d.message}</p>
      {error?.hint && <p className="text-muted">{error.hint}</p>}
      <button type="button" className="btn btn-primary" onClick={() => void closeRepo()}>
        Choose another folder
      </button>
    </CenteredColumn>
  );
}
