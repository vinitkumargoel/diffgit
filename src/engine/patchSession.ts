/**
 * Patch-only mode (T10.12, Design §14.6, atlas tab 17): the engine with no repository behind it.
 *
 * A `.patch` or `.diff` handed to the installed app by the operating system (`launchQueue`), or
 * dropped on the page, has no folder, no handle and no permission grant. `RepoSession.open` would
 * refuse it — correctly — so `parsePatch` is the one `EngineApi` method that must answer while
 * `workerApi`'s `need()` has nothing to hand over. This is what answers instead.
 *
 * It is deliberately tiny: the parsing itself is pure (`diff/parsePatch.ts`). What this adds is the
 * session contract the rest of `EngineApi` keeps — one call in flight at a time, the older one
 * rejected with `CANCELLED` when a newer patch is opened while the first is still parsing — plus
 * the `PATCH_ONLY` warning the result always carries, so the page can raise the info banner whether
 * the patch arrived with a repository open or without one.
 */
import type { PatchResult } from "./api";
import { parsePatch } from "./diff/parsePatch";
import { CancelledError } from "./util/concurrency";

export class PatchSession {
  private token: symbol | null = null;

  /**
   * Parse one unified diff. Rejects with `NOT_A_PATCH` when the text is not one, and with
   * `CANCELLED` when another `parse()` started before this one finished.
   */
  async parse(text: string): Promise<PatchResult> {
    const token = Symbol("parsePatch");
    this.token = token;
    // Yield once so a second call really does supersede the first, the way `single()` behaves for
    // every other method: a caller that opens two patches in a row sees one answer and one CANCELLED.
    const result = await Promise.resolve().then(() => parsePatch(text));
    if (this.token !== token) throw new CancelledError("parsePatch");
    this.token = null;
    return result;
  }
}
