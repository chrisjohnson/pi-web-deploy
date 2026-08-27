/**
 * runTitle.ts: display-layer title fallback (spec section 2).
 *
 * `sessions.title` is populated for every real run started since M-091
 * (`workflow.ts`/`planBuildTest.ts` call `tracer.sessionSetTitle(adwId,
 * deriveTitleFromPrompt(taskPrompt))` right after `sessionStart`) — a short,
 * human-readable title derived from the task prompt's first sentence/line,
 * capped at 72 chars. Runs recorded BEFORE that change still have `title:
 * null` in the db, so the fallback chain below still matters for old rows,
 * not just as defensive coding.
 *
 * Precedence: `run.title` if present, else `run.request` (the full task
 * prompt text, for pre-M-091 rows), else `run.adwId` as the last resort
 * (always present).
 *
 * Long text is truncated via CSS (`.run-title`'s `text-overflow: ellipsis`),
 * not here — more robust across different card widths than a JS string
 * truncation. Callers should also set the untruncated string as a native
 * `title=""` attribute for hover tooltips.
 */

export function runTitle(run: { title: string | null; request: string | null; adwId: string }): string {
  if (run.title) return run.title;
  if (run.request) return run.request;
  return run.adwId;
}
