/**
 * sortRuns.ts: the main grid's two-tier sort order (display-layer only —
 * `/api/runs`'s own `ORDER BY started_at DESC` stays as the API's default
 * for other future consumers; this is UI-specific ordering applied AFTER
 * fetch, in plain JS/TS, not SQL).
 *
 * Exact algorithm:
 *   1. All `status === "running"` runs first, sorted by `startedAt` ASCENDING
 *      (oldest-started-and-still-running at the very top).
 *   2. Then all other runs (success/fail/anything else), sorted by `endedAt`
 *      DESCENDING (most recently completed first, working down to the
 *      oldest completed at the bottom). If `endedAt` is null on a
 *      non-running run (shouldn't normally happen, but defensive), falls
 *      back to `startedAt` for that row's sort key rather than crashing or
 *      landing in an arbitrary position.
 *
 * End result, top to bottom: oldest-still-running -> ... ->
 * newest-still-running -> most-recently-completed -> ... ->
 * oldest-completed.
 */

import type { RunSummary, TicketSummary } from "./api";

/** Parses an ISO timestamp to epoch ms; `null`/unparseable sorts as `0` (oldest) rather than `NaN` (which would corrupt comparator ordering). */
function toMs(iso: string | null): number {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

export function sortRuns(runs: readonly RunSummary[]): RunSummary[] {
  const running = runs.filter((r) => r.status === "running");
  const other = runs.filter((r) => r.status !== "running");

  running.sort((a, b) => toMs(a.startedAt) - toMs(b.startedAt));
  other.sort((a, b) => {
    // Defensive fallback: a non-running run should always have endedAt, but
    // if it's somehow null, sort by startedAt instead of crashing/NaN-ing.
    const aKey = a.endedAt ? toMs(a.endedAt) : toMs(a.startedAt);
    const bKey = b.endedAt ? toMs(b.endedAt) : toMs(b.startedAt);
    return bKey - aKey;
  });

  return [...running, ...other];
}

/**
 * M-103: the grid is ticket-level now — sorts tickets by the EXACT SAME
 * rule `sortRuns` already applies to bare runs, keyed off each ticket's
 * `latestRun` (the attempt the grid shows by default). A ticket with no
 * `latestRun` at all (the defensive edge case server.ts's own doc comment
 * flags — shouldn't happen in practice) sorts last, stably, rather than
 * crashing on a missing `status`/`startedAt`.
 */
export function sortTickets(tickets: readonly TicketSummary[]): TicketSummary[] {
  const withRun = tickets.filter((t): t is TicketSummary & { latestRun: RunSummary } => t.latestRun !== null);
  const withoutRun = tickets.filter((t) => t.latestRun === null);

  const sortedRuns = sortRuns(withRun.map((t) => t.latestRun));
  const byAdwId = new Map(withRun.map((t) => [t.latestRun.adwId, t]));
  const ordered = sortedRuns.map((run) => byAdwId.get(run.adwId)!);

  return [...ordered, ...withoutRun];
}
