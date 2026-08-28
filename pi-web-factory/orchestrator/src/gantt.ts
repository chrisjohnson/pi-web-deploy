/**
 * gantt.ts: lays out a Workflow Run's Steps as a horizontal timeline where
 * each Step's own duration is drawn to scale, but idle/paused gaps BETWEEN
 * Steps are compressed to a small fixed width regardless of their real
 * duration — a Step sequence that sat blocked-on-human for an hour must
 * not produce an hour-long blank stretch.
 *
 * This module only computes layout (x positions + widths in pixels); it has
 * no DOM/rendering code, so it's cheap to reason about / test independently.
 *
 * The px-per-second scale is DERIVED per-render from the caller-supplied
 * `containerWidthPx` (the real available width, e.g. `.timeline-wrap`'s own
 * `clientWidth` — see `detailView.ts`'s call site) rather than a fixed
 * constant, so the whole run's track always fits the visible page width —
 * no horizontal scroll ever needed even for a sufficiently long run.
 * `MIN_BAR_WIDTH_PX` is still a floor UNDER that derived scale (a very short
 * run's steps stay comfortably readable rather than shrinking to slivers),
 * so a short/simple run may end up narrower than the full container width —
 * that's fine, only "wider than the container" was the actual problem.
 */

import type { Step } from "./api";

export const MIN_BAR_WIDTH_PX = 24;
/** Fixed visual width standing in for ANY gap between one Step's end and the next Step's start, no matter how long that gap really was. */
export const GAP_WIDTH_PX = 28;
/** Leading padding before the first Step's bar. */
export const START_PADDING_PX = 12;
/**
 * Floor for the derived pixels-per-second scale — guards ONLY against a
 * genuinely degenerate (near-zero) total step duration producing a
 * divide-by-near-zero blowup into an absurdly large scale. Deliberately NOT
 * used to guarantee a "readable minimum" scale for long runs — that's
 * `MIN_BAR_WIDTH_PX`'s job (a true per-bar floor, applied after this scale,
 * which is allowed to compress a long run's bars arbitrarily thin before
 * that floor kicks in). A real minimum-scale floor here would defeat the
 * actual point of deriving the scale at all: fit the container, never
 * overflow it.
 */
const MIN_PIXELS_PER_SECOND = 0.001;

export interface StepLayout {
  step: Step;
  /** left edge, in px, within the timeline's own coordinate space */
  x: number;
  /** bar width, in px — proportional to the Step's own real duration, floored at MIN_BAR_WIDTH_PX */
  width: number;
  /** real duration in ms, if both started_at/ended_at (or "now" for a running step) are known */
  durationMs: number | null;
  /** true when this Step has no ended_at and is presumed still in progress */
  stillRunning: boolean;
}

export interface GanttLayout {
  steps: StepLayout[];
  /** total width of the timeline, in px — for setting the scroll container's content width */
  totalWidth: number;
  /** the derived pixels-per-second scale actually used for this layout — exposed so callers/tests can display or assert on it */
  pixelsPerSecond: number;
}

function parseMs(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function widthForDuration(durationMs: number, pixelsPerSecond: number): number {
  const raw = (durationMs / 1000) * pixelsPerSecond;
  return Math.max(MIN_BAR_WIDTH_PX, raw);
}

/**
 * Sums each Step's own real duration (the same `durationMs` computation
 * `computeGanttLayout` does per-step) — the basis for deriving a
 * fits-the-container pixels-per-second scale. Idle/paused GAP time between
 * Steps is deliberately excluded (gaps are always drawn at the fixed
 * `GAP_WIDTH_PX`, never part of the scaled budget).
 */
function totalStepDurationMs(steps: Step[], nowMs: number): number {
  let total = 0;
  for (const step of steps) {
    const startedMs = parseMs(step.startedAt);
    if (startedMs === null) continue;
    const endedMs = parseMs(step.endedAt);
    const effectiveEndMs = endedMs ?? nowMs;
    total += Math.max(0, effectiveEndMs - startedMs);
  }
  return total;
}

/**
 * Computes the compressed-gap layout for a Workflow Run's Steps (already
 * ordered by `seq` — same order the `/api/runs/:adwId` route returns them
 * in). `nowMs` is injected (rather than read via `Date.now()` internally) so
 * a "still running" Step's in-progress width is deterministic/testable and
 * updates naturally on each re-render as the caller re-invokes this with a
 * fresh timestamp.
 *
 * `containerWidthPx` is the real available width the whole track must fit
 * within — the pixels-per-second scale is derived as
 * `(containerWidthPx - fixed gap/padding budget) / totalStepDurationMs`, so
 * `totalWidth` always comes out at or under `containerWidthPx` (modulo the
 * `MIN_BAR_WIDTH_PX` floor on genuinely tiny per-step durations, which can
 * push a pathological many-tiny-steps run slightly over — an intentional,
 * documented tradeoff favoring readability over a hard width guarantee).
 */
export function computeGanttLayout(steps: Step[], nowMs: number, containerWidthPx: number): GanttLayout {
  const layouts: StepLayout[] = [];

  // Fixed budget this render will consume regardless of scale: leading/
  // trailing padding plus one GAP_WIDTH_PX per real gap between steps.
  let gapCount = 0;
  let prevEndMsForGapCount: number | null = null;
  for (const step of steps) {
    const startedMs = parseMs(step.startedAt);
    if (prevEndMsForGapCount !== null && startedMs !== null) gapCount += 1;
    const endedMs = parseMs(step.endedAt);
    const stillRunning = startedMs !== null && endedMs === null;
    prevEndMsForGapCount = endedMs ?? (stillRunning ? nowMs : startedMs);
  }
  const fixedBudgetPx = START_PADDING_PX * 2 + gapCount * GAP_WIDTH_PX;
  const availableForStepsPx = Math.max(0, containerWidthPx - fixedBudgetPx);
  const totalDurationMs = totalStepDurationMs(steps, nowMs);
  const pixelsPerSecond =
    totalDurationMs > 0
      ? Math.max(MIN_PIXELS_PER_SECOND, availableForStepsPx / (totalDurationMs / 1000))
      : MIN_PIXELS_PER_SECOND;

  let cursorX = START_PADDING_PX;
  let prevEndMs: number | null = null;

  for (const step of steps) {
    const startedMs = parseMs(step.startedAt);
    const endedMs = parseMs(step.endedAt);
    const stillRunning = startedMs !== null && endedMs === null;

    // Compressed gap: any space between the previous Step's end and this
    // Step's start becomes a small FIXED width, never proportional to the
    // real elapsed time — this is the core M-077 requirement.
    if (prevEndMs !== null && startedMs !== null) {
      cursorX += GAP_WIDTH_PX;
    }

    let durationMs: number | null = null;
    let width: number;
    if (startedMs !== null) {
      const effectiveEndMs = endedMs ?? (stillRunning ? nowMs : startedMs);
      durationMs = Math.max(0, effectiveEndMs - startedMs);
      width = widthForDuration(durationMs, pixelsPerSecond);
    } else {
      // No started_at at all (e.g. a queued Step never begun) — render a
      // minimal placeholder bar so it's still visible in sequence.
      width = MIN_BAR_WIDTH_PX;
    }

    layouts.push({ step, x: cursorX, width, durationMs, stillRunning });
    cursorX += width;
    prevEndMs = endedMs ?? (stillRunning ? nowMs : startedMs);
  }

  return { steps: layouts, totalWidth: cursorX + START_PADDING_PX, pixelsPerSecond };
}
