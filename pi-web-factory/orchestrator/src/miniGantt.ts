/**
 * miniGantt.ts: condensed rendering of a Workflow Run's Step timeline for
 * the main grid's cards (spec section 3) — reuses `gantt.ts`'s
 * `computeGanttLayout` layout math UNCHANGED (same compressed-gap algorithm
 * the full detail-page Gantt uses), only the RENDERING is adapted to a
 * small fixed-height strip: layout pixel coordinates are converted to
 * PERCENTAGES of the computed total width, so the same bars scale to
 * whatever width a given card ends up at (grid cards are responsive,
 * `auto-fill`/`minmax` — a fixed-px mini timeline would either overflow
 * narrow cards or look tiny in wide ones).
 *
 * Bar color is Role identity, not status (found missing in review, M-090
 * follow-up, 2026-08-05 — see `stepBarStyle.ts`'s doc comment for the full
 * story): every bar's fill is that Step's Role color in some form, in every
 * state, so the same Role reads identically here and on the detail page's
 * full Gantt. A separate per-Step "role dot" used to carry this instead —
 * removed now that the bar itself does, which also means fewer DOM nodes
 * per card (point 7's performance ask).
 */

import type { Step } from "./api";
import { computeGanttLayout } from "./gantt";
import { stepBarStyle } from "./stepBarStyle";
import { escapeHtml } from "./format";

/**
 * Reference width (px) fed to `computeGanttLayout` for the mini-Gantt's own
 * scale derivation (M-105 item 11 made the scale a function of container
 * width). This is NOT the actual rendered width — since this module
 * immediately converts every coordinate to a PERCENTAGE of the computed
 * `totalWidth` (see below), only the resulting *proportions* matter here,
 * not the absolute px value, so a fixed representative width is fine; a
 * real per-card `clientWidth` would work identically for the final
 * percentages but isn't available at layout-compute time (grid cards render
 * many of these per page, before layout/paint has happened for any of
 * them).
 */
const REFERENCE_WIDTH_PX = 320;

/**
 * Renders a condensed, percentage-scaled Gantt strip for one run's Steps.
 * `nowMs` is injected (not read internally) for the same testability reason
 * `computeGanttLayout` itself takes it — deterministic output, and a
 * "still running" Step's bar grows naturally as the caller re-invokes this
 * with a fresh timestamp on each poll tick.
 */
export function miniGanttHtml(steps: Step[], nowMs: number): string {
  if (steps.length === 0) {
    return `<div class="mini-gantt-empty">no Steps yet</div>`;
  }

  const layout = computeGanttLayout(steps, nowMs, REFERENCE_WIDTH_PX);
  const totalWidth = Math.max(1, layout.totalWidth);

  const bars = layout.steps
    .map((sl) => {
      const leftPct = (sl.x / totalWidth) * 100;
      const widthPct = Math.max(0.6, (sl.width / totalWidth) * 100);
      const bar = stepBarStyle(sl.step.role, sl.step.status);
      const label = sl.step.name ?? sl.step.phaseId;
      const title = `${label}${sl.step.role ? ` · ${sl.step.role}` : ""} — ${sl.step.status ?? "unknown"}`;
      const activeClass = bar.isActive ? " step-active" : "";
      return `
        <div class="mini-step-bar${activeClass}"
             style="left:${leftPct.toFixed(2)}%; width:${widthPct.toFixed(2)}%; ${bar.style}"
             title="${escapeHtml(title)}"></div>
      `;
    })
    .join("");

  return `<div class="mini-gantt-track">${bars}</div>`;
}
