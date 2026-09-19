import type { PublicError } from "../api";
import { type EngineErrorJSON, errorCode, isPublicCode } from "../errors";

/** Translate anything thrown inside the engine into the plain object that crosses the worker boundary. */
export function toPublicError(e: unknown): PublicError {
  const code = errorCode(e);
  const message =
    e instanceof Error ? e.message : typeof e === "string" ? e : "Unknown engine error";
  const hint = (e as { hint?: unknown } | null)?.hint;
  const out = (c: PublicError["code"], msg = message, h?: string): PublicError => {
    const json: PublicError = { name: "EngineError", code: c, message: msg };
    const finalHint = h ?? (typeof hint === "string" ? hint : undefined);
    if (finalHint !== undefined) json.hint = finalHint;
    const path = (e as { path?: unknown } | null)?.path;
    if (typeof path === "string") (json as EngineErrorJSON).path = path;
    const detail = (e as { detail?: unknown } | null)?.detail;
    if (typeof detail === "string") (json as EngineErrorJSON).detail = detail;
    return json;
  };
  if (code !== undefined && isPublicCode(code)) return out(code);
  switch (code) {
    case "EACCES":
      return out("PERMISSION", message, "Grant read access to the folder and try again.");
    case "ENOENT":
      return out("IO_ERROR"); // a vanished root is detected earlier by RepoSession.withRootCheck
    case "EIO":
    case "EISDIR":
    case "ENOTDIR":
    case "EINVAL":
      return out("IO_ERROR");
    default:
      break;
  }
  if (e instanceof DOMException || (e as { name?: string } | null)?.name?.endsWith("Error")) {
    const name = (e as { name: string }).name;
    if (name === "NotAllowedError" || name === "SecurityError")
      return out("PERMISSION", message, "Grant read access to the folder and try again.");
    if (name === "NotFoundError")
      return out(
        "HANDLE_GONE",
        "The repository folder is no longer reachable.",
        "Re-open the folder.",
      );
  }
  return out("INTERNAL");
}
