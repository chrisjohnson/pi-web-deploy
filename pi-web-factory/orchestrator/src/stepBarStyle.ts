/**
 * stepBarStyle.ts: combines a Step's Role color (`roleColor.ts`) with its
 * status (running/success/fail/queued) into the actual inline CSS a Step
 * bar renders with — used by BOTH `miniGantt.ts` (grid cards) and
 * `detailView.ts` (the full per-run timeline), so a Role reads identically
 * everywhere it appears.
 *
 * Found missing in review (M-090 follow-up, 2026-08-05): the first cut of
 * this redesign gave Role BADGES their own color but left the actual Step
 * BARS colored by status only (`--pi-success`/`--pi-danger`/`--pi-accent`),
 * so e.g. a `build` bar and a `review` bar both rendered the same green —
 * Role identity was invisible on the one element (the bar itself) it
 * mattered most on. Chris's own ask (point 6): "each role had an
 * in-progress color and a matching completed (success or failed) color."
 *
 * Design: Role identity is ALWAYS the bar's base hue, in every state —
 * - running: full-saturation Role color fill, bright text, a pulsing
 *   accent-colored glow (the SAME glow language the card-level "this is
 *   live" indicator already uses, so "live" reads consistently everywhere,
 *   while the FILL still carries Role identity).
 * - success / fail: a DIMMED/muted tint of that SAME Role color (via
 *   `color-mix`, not a second hardcoded palette — "matching" per Chris's
 *   own wording) as the fill, with a colored border (green/red) carrying
 *   the actual status, and Role-colored text for continued identity at a
 *   glance.
 * - queued (not yet started): neutral/muted, no Role tint yet — nothing to
 *   show a Role "as" until the Step actually starts.
 */

import { roleMiniPalette } from "./roleColor";

export interface StepBarStyle {
  /** Full inline `style` attribute VALUE (no surrounding quotes) for the bar element itself. */
  style: string;
  /** `true` for a `running` Step — callers add the pulsing-glow CSS class (`step-bar-active`) themselves, kept separate so class-based `@keyframes` still does the actual animating (CSS, not JS, per the performance requirement). */
  isActive: boolean;
}

export function stepBarStyle(role: string | null, status: string | null): StepBarStyle {
  // `role` can be null (a Step with no Role assigned) — fall back to the
  // page's own neutral/dim tokens rather than a generated palette in that
  // one case; every REAL role name (known or brand new) always gets a full
  // mini-palette from `palette.ts`, never a hand-authored one (M-105 item 2).
  const palette = roleMiniPalette(role);

  if (status === "running") {
    // `palette.solid`/`palette.onSolid` are `palette.ts`'s own high-chroma
    // fill + matching contrasting foreground (computed per-hue, not a
    // shared `--pi-bg` anchor) — same visual intent the pre-M-105 version
    // achieved via `--pi-bg` (a solid role-colored fill needs a foreground
    // that reads against THAT fill specifically, not the page background),
    // just computed directly per-hue now instead of relying on one shared
    // page-level anchor color.
    if (palette) {
      return {
        style: `background:${palette.solid}; border-color: var(--pi-accent); color: ${palette.onSolid};`,
        isActive: true,
      };
    }
    return {
      style: `background: var(--pi-dim); border-color: var(--pi-accent); color: var(--pi-bg);`,
      isActive: true,
    };
  }

  if (status === "success" || status === "fail") {
    const statusColor = status === "success" ? "var(--pi-success)" : "var(--pi-danger)";
    if (palette) {
      // `surfaceDark` reads as "this role's work, now dimmed/completed" —
      // the mini-palette's own darker background variant (item 2's own
      // example: "another lighter and darker variation of the background,
      // such as on the grid page for inactive work"), with the actual
      // pass/fail verdict carried by the border color, and the role's own
      // text color kept for continued at-a-glance identity.
      return {
        style: `background:${palette.surfaceDark}; border-color:${statusColor}; color:${palette.text};`,
        isActive: false,
      };
    }
    return {
      style: `background: var(--pi-surface-hover); border-color:${statusColor}; color: var(--pi-dim);`,
      isActive: false,
    };
  }

  // queued / unknown — no Role tint yet, nothing has actually run.
  return {
    style: `background: var(--pi-dim); opacity: 0.5; border-color: transparent; color: var(--pi-bg);`,
    isActive: false,
  };
}
