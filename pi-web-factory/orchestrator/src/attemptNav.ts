/**
 * attemptNav.ts: the small "page through a ticket's attempts" arrow control
 * (M-103) — shared markup/wiring between the grid card (`listView.ts`) and
 * the ticket detail page (`detailView.ts`), so the same subtle affordance
 * (Chris, explicit: "subtle arrow icons, not big fat buttons") looks and
 * behaves identically in both places rather than two independently-drifting
 * implementations.
 *
 * Deliberately just markup + a pure index-clamping helper — no polling/state
 * of its own. Each caller owns its own "which attempt am I currently
 * showing" index and re-renders via its own existing render path (a grid
 * card's per-card innerHTML write, or DetailView's whole-page render) when
 * the arrows are clicked; this module only needs to produce the right HTML
 * for a given `(runCount, currentIndex)` pair and expose `data-attempt-nav`
 * attributes callers wire a click listener onto.
 */

import { escapeHtml } from "./format";

export type AttemptNavDirection = "older" | "newer";

/**
 * Clamps a requested index move within `[0, runCount - 1]` — index 0 is
 * always the LATEST run (server.ts's `/api/tickets/:ticketId` returns runs
 * most-recent-first), so "older" increases the index and "newer" decreases
 * it. Never wraps around; moving past either end is a no-op (the button on
 * that end is also rendered `disabled` — see `attemptNavHtml` — so this is
 * a belt-and-suspenders guard against a stale/rapid double-click, not the
 * only thing preventing an out-of-range index).
 */
export function moveAttemptIndex(currentIndex: number, direction: AttemptNavDirection, runCount: number): number {
  if (runCount <= 0) return 0;
  const next = direction === "older" ? currentIndex + 1 : currentIndex - 1;
  return Math.max(0, Math.min(runCount - 1, next));
}

/**
 * Renders the arrow-nav control for a ticket with `runCount` total attempts,
 * currently showing `currentIndex` (0 = latest). Returns an empty string for
 * `runCount <= 1` — per the card's own scoping, there's nothing to page
 * through for a ticket with exactly one attempt, and showing a
 * permanently-disabled pair of arrows on every single-attempt ticket (the
 * overwhelming common case before automated retries exist) would be visual
 * noise, not a subtle affordance.
 *
 * `idPrefix` distinguishes multiple instances of this control on one page
 * (e.g. many grid cards at once) for the caller's own event delegation/
 * `querySelector` scoping — this module does not wire listeners itself.
 */
export function attemptNavHtml(idPrefix: string, currentIndex: number, runCount: number): string {
  if (runCount <= 1) return "";
  const atOldest = currentIndex >= runCount - 1;
  const atNewest = currentIndex <= 0;
  // Human-facing numbering: attempt 1 is the OLDEST, matching how a person
  // would describe "first attempt, second attempt, ..." — even though the
  // underlying index counts from the latest (0) per moveAttemptIndex's own
  // doc comment. attemptNumber = runCount - currentIndex.
  const attemptNumber = runCount - currentIndex;
  return `
    <span class="attempt-nav" data-attempt-nav="${escapeHtml(idPrefix)}">
      <button type="button" class="attempt-nav-btn" data-attempt-nav-dir="older" ${atOldest ? "disabled" : ""} title="older attempt" aria-label="older attempt">&#8249;</button>
      <span class="attempt-nav-label">attempt ${String(attemptNumber)}/${String(runCount)}</span>
      <button type="button" class="attempt-nav-btn" data-attempt-nav-dir="newer" ${atNewest ? "disabled" : ""} title="newer attempt" aria-label="newer attempt">&#8250;</button>
    </span>
  `;
}
