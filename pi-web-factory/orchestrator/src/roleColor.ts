/**
 * roleColor.ts: maps a Step's `role` string (`step.role`, from the API —
 * ultimately `phases.owner` in the trace db) to its full mini-palette
 * (`palette.ts`) — text/border/surface/surface-light/surface-dark/solid
 * colors, theme-aware (light/dark), used everywhere a Role is shown
 * visually: grid mini-Gantt, detail full Gantt, nested event lists, the
 * detail page's step-detail panel background (M-105 item 3).
 *
 * ── M-105 Phase A rewrite ──────────────────────────────────────────────────
 * Pre-M-105, this module was a fixed lookup table of hand-picked hex pairs,
 * authored twice (once per light/dark theme) — every new Role/Step kind
 * meant a human (or an agent) hand-picking 4 new hex values, twice. Now a
 * thin, theme-aware wrapper over `palette.ts`'s deterministic hue-generation
 * formula: ANY role name (curated or brand new) produces a complete,
 * good-looking mini-palette with zero hand-authoring — see that module's
 * own doc comment for the full reasoning and the real palette-theory
 * research (Radix Colors' published scale-composition guidance) behind the
 * specific numbers used.
 *
 * ── Why real `hsl(...)` strings, not `var(--role-*)` CSS custom properties
 * (the pre-M-105 approach) ─────────────────────────────────────────────────
 * A `--role-<name>` CSS custom property must be authored, by name, in
 * style.css before it can be referenced — which is exactly the "someone has
 * to hand-pick a new palette every time a Role is added" problem item 2
 * calls out. Computing the color in JS (this module) and emitting it as a
 * literal inline-style value sidesteps that entirely: no CSS authoring step
 * is possible to forget, for ANY future role/step-kind name. Theme
 * (light/dark) is read once via `matchMedia('(prefers-color-scheme: dark)')`
 * — mirroring the SAME signal style.css's own `@media` block already reacts
 * to, so this module's colors always agree with the CSS theme actually
 * showing, and a live theme change (OS light/dark toggle while the page is
 * open) is picked up correctly since callers re-invoke `roleColor`/
 * `roleMiniPalette` on every render anyway (this app's whole rendering model
 * — see `detailView.ts`/`miniGantt.ts` — is "re-render the innerHTML on
 * every poll tick / DOM event," never a one-time paint).
 *
 * The three STATUS colors (`--pi-success`/`--pi-warning`/`--pi-danger`,
 * style.css) remain real CSS custom properties, untouched — a small, FIXED
 * set of exactly three meanings that will never grow, so the "scalability"
 * problem this rewrite solves doesn't apply to them; role identity and
 * run/Step status stay deliberately separate visual systems (unchanged from
 * the pre-M-105 design).
 */

import { paletteForName, type MiniPalette } from "./palette";

export interface RoleColorTokens {
  /** Text/icon/border-accent color, e.g. "hsl(262 62% 34%)" */
  color: string;
  /** Light background tint (badge/pill fill), e.g. "hsl(262 62% 92%)" */
  surface: string;
}

const KNOWN_ROLES = ["plan", "build", "review", "scout", "document", "run-tests"] as const;

/** Neutral, low-chroma fallback — reserved for `null`/empty Role only (never for a real, unrecognized name — those get a full generated palette from `palette.ts`, per item 2's "no hand-authoring, ever" requirement). */
const NEUTRAL: RoleColorTokens = { color: "hsl(280 6% 40%)", surface: "hsl(280 6% 90%)" };
const NEUTRAL_DARK: RoleColorTokens = { color: "hsl(280 8% 65%)", surface: "hsl(280 10% 16%)" };

/**
 * Normalizes a raw Role string for lookup — case-insensitive, trims
 * whitespace, and treats underscores the same as hyphens (`run_tests` and
 * `run-tests` should color identically; both spellings have shown up across
 * this codebase's own Role vocabulary discussions).
 */
function normalize(role: string): string {
  return role.trim().toLowerCase().replace(/_/g, "-");
}

/**
 * Reads the CURRENT theme via the same media query style.css's own
 * `@media (prefers-color-scheme: dark)` block reacts to — kept as a plain
 * function (not cached at module load) since this app's rendering model is
 * "re-render on every tick," so a live OS theme change is naturally picked
 * up on the next render without any extra listener wiring.
 */
function currentTheme(): "light" | "dark" {
  if (typeof matchMedia !== "function") return "light";
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * Returns the full mini-palette (`palette.ts`'s `MiniPalette` — text,
 * border, surface, surfaceLight, surfaceDark, solid, onSolid) for a given
 * Role name, or `null` for `null`/empty (no Role assigned yet — callers fall
 * back to their own neutral treatment). Never throws.
 */
export function roleMiniPalette(role: string | null | undefined): MiniPalette | null {
  if (!role) return null;
  return paletteForName(normalize(role), currentTheme());
}

/**
 * Returns the `{color, surface}` pair for a given Role name, or the neutral
 * fallback for `null`/empty. Never throws. Kept as the primary export (the
 * shape most existing callers — badges, bar fills — actually need); use
 * `roleMiniPalette` directly when the fuller 5-token palette is needed
 * (e.g. the detail page's step-detail panel background, M-105 item 3).
 */
export function roleColor(role: string | null | undefined): RoleColorTokens {
  const palette = roleMiniPalette(role);
  if (!palette) return currentTheme() === "dark" ? NEUTRAL_DARK : NEUTRAL;
  return { color: palette.text, surface: palette.surface };
}

export { KNOWN_ROLES };
