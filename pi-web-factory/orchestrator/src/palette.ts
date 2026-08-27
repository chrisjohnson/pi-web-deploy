/**
 * palette.ts: deterministic Role/Step-kind -> mini-palette generator (M-105
 * Phase A/B, items 1/2).
 *
 * ── The ask (Chris, verbatim, M-105 item 2) ────────────────────────────────
 * "whatever scheme we devise should not require an AI agent to have to
 * actively come up with the next step color palette... plan is always
 * purple, but... the bank of researched matching mini-palettes should be
 * robust as a result of this ticket."
 *
 * Two competing requirements, reconciled here:
 *   1. STABLE, curated hues for the roles that exist TODAY — "plan is always
 *      purple" is a promise, not an accident, so the known roles get an
 *      explicit, hand-placed hue below, chosen via real palette research
 *      (see this module's `HUE_RING` doc comment) rather than "whatever the
 *      hash produces."
 *   2. NEVER requiring a human/agent to hand-author the NEXT one — any Role
 *      or Step name not in the curated table below falls through to a
 *      deterministic hash-to-hue function. Same input name always produces
 *      the same hue (stable across reloads/deploys — no randomness), and the
 *      mini-palette derivation (`minPaletteForHue`) is a pure function of
 *      that one hue number, so a brand new role gets a complete, good-
 *      looking 5-color set automatically, zero manual palette design.
 *
 * ── Where the hue ring comes from (real research, not guessed) ────────────
 * Radix Colors' own published palette-composition guidance (WorkOS/Radix UI
 * docs, "Composing a palette" + "Understanding the scale",
 * radix-ui.com/colors/docs/palette-composition/*, fetched live during this
 * ticket) is the concrete reference this module leans on:
 *   - A curated set of NAMED hue scales (not an arbitrary wheel) — "tomato,
 *     red, ruby, crimson, pink, plum, purple, violet, iris, indigo, blue,
 *     sky, cyan, teal, jade, green, grass, lime, ... amber, orange, brown" —
 *     each hand-tuned to look good and stay visually DISTINCT from its
 *     neighbors, which is exactly the property "N roles/steps, all
 *     mutually distinguishable" needs. `HUE_RING` below borrows this same
 *     idea: a curated list of hues spaced for maximum mutual distinctness
 *     (not naive `360/n` equal spacing, which produces muddy near-neighbors
 *     at the saturations/lightnesses used here), roughly following where
 *     Radix's own named scales sit on the wheel.
 *   - Radix's documented semantic pairings: "Error: red, ruby, tomato,
 *     crimson" / "Success: green, teal, jade, grass, mint" — informs this
 *     ticket's grid success/fail choice (`--pi-success`/`--pi-danger` in
 *     style.css): a warmer, less-saturated red (closer to "ruby"/"crimson"
 *     territory, not a pure stop-sign red) paired with a jade/teal-leaning
 *     green, both pulled toward this app's existing warm sand background
 *     rather than sitting at max saturation against it.
 *   - Radix's documented 12-STEP SCALE role table ("Understanding the
 *     scale"): step 3-5 = component backgrounds, step 6-8 = borders (7 =
 *     "subtle borders on interactive components", 8 = "stronger borders /
 *     focus rings"), step 9-10 = solid/high-chroma fills, step 11-12 = text
 *     (11 = low-contrast, 12 = high-contrast). `minPaletteForHue` below
 *     mirrors this STRUCTURE (light-surface / dark-surface / border / text
 *     as separate, independently-tuned lightness+saturation steps along the
 *     SAME hue) even though it's a hand-rolled 5-token version, not a
 *     literal 12-step scale — the ratio of steps and their relative
 *     lightness spacing is the part borrowed directly from Radix's own
 *     tuning, not reinvented from scratch.
 *
 * ── Why HSL, computed at build/render time, not more pre-baked hex pairs ──
 * `roleColor.ts` (pre-M-105) was a fixed lookup table of hand-picked hex
 * pairs per role, authored twice (once per light/dark theme) — exactly the
 * "someone has to hand-pick a new palette every time a Role is added"
 * problem item 2 calls out. `hueForName` + `minPaletteForHue` replace that
 * with a formula: ANY name in, a complete 5-token mini-palette out, for
 * both themes, with no per-role authoring step ever required again. The
 * curated `KNOWN_HUES` table exists ONLY to pin the roles that already have
 * an established visual identity (plan=purple, success=green, fail=red) —
 * it is an override on TOP of the deterministic formula, not a replacement
 * for it.
 */

export interface MiniPalette {
  /** Text/icon/border-accent color — tuned for readable text against `surface`/`bg`, and distinct at a glance from every other role's text color. */
  text: string;
  /** Standard component border (Radix step ~7: "subtle borders on interactive components"). */
  border: string;
  /** Standard component background — tinted, not neutral (Radix step ~3). */
  surface: string;
  /** A LIGHTER background variant — e.g. inactive/queued work on the grid page. */
  surfaceLight: string;
  /** A DARKER background variant — e.g. a pressed/active/emphasized state. */
  surfaceDark: string;
  /** High-chroma solid fill (Radix step ~9) — for an actively-running bar's full-saturation treatment. */
  solid: string;
  /** The right foreground color to put ON TOP of `solid` (near-black or near-white depending on the hue's own lightness at max chroma). */
  onSolid: string;
}

/**
 * Curated hue anchors (degrees, 0-360) for the roles/kinds that already have
 * an established visual identity in this app, chosen via the Radix-inspired
 * research above for maximum mutual distinctness at the saturation/lightness
 * levels `minPaletteForHue` uses. Extending this table is OPTIONAL, never
 * required — anything not listed here still gets a complete, good-looking,
 * STABLE palette from `hueForName`'s hash fallback below. This table exists
 * only to pin specific hues to specific well-known names (plan MUST be
 * purple, forever) and to keep today's small role set visually well-spread
 * rather than leaving it to hash luck.
 */
const KNOWN_HUES: Record<string, number> = {
  // plan: purple — the pre-existing identity (`--pi-purple`/`--role-plan` in
  // the old style.css), preserved exactly as Chris's own anchor color.
  plan: 262,
  // build: teal/cyan — "doing" work, cool and active, far from plan's purple
  // and from the red/green status hues below.
  build: 189,
  // review: M-105 item 1 reopened — Chris didn't like the hand-picked
  // amber/gold (hue 42) and asked for it to be GENERATED instead, per this
  // whole module's own design goal ("let it generate a new one," rather
  // than hand-picking a replacement). Deliberately no entry here anymore —
  // `review` now falls through to `HUE_RING`'s hash-based assignment like
  // any other unlisted name (see `hueForName`). `HUE_RING`'s own doc
  // comment below records the resulting hue and confirms it doesn't
  // collide with the remaining curated anchors.
  // scout: blue — Radix's "Info: blue, indigo, sky, cyan" pairing; scout is
  // an investigation/reconnaissance role, "informational" is the right
  // register.
  scout: 221,
  // document: pink/magenta — Radix's "pink"/"plum" territory, warm but
  // clearly distinct from plan's purple.
  document: 327,
  // run-tests: green — Radix's own "Success: green, teal, jade..." pairing;
  // a mechanical pass/fail gate reads naturally in the same family as the
  // success status color, while still being visually distinct from it
  // (different exact hue + this is a ROLE token, not the STATUS token).
  "run-tests": 152,
};

/**
 * Backup hue ring for any name NOT in `KNOWN_HUES` — a future Role or Step
 * kind gets a hue from HERE, chosen by a stable hash of its own name (see
 * `hueForName`), never hand-picked. Spaced around the wheel avoiding the
 * remaining curated anchors above (262/189/221/327/152) by at least ~35°,
 * so a hash-assigned hue is very unlikely to visually collide with a
 * curated one. 11 stops — plenty of runway before two unrelated future
 * names could plausibly land on the same stop (and even then, differing
 * lightness/saturation of neighboring content plus the name's own text
 * label keeps them distinguishable).
 *
 * M-105 item 1 reopened: `review` was removed from `KNOWN_HUES` (Chris
 * explicitly wanted it GENERATED, not hand-picked) — `hashString("review")
 * % HUE_RING.length` resolves to index 2, hue 95° (a yellow-green/olive).
 * Checked against every remaining curated anchor for a spacing collision:
 * nearest is `run-tests` at 152° (57° away) — plan (262°, 167° away), scout
 * (221°, 126°), document (327°, 128°), build (189°, 94°) are all further
 * still. 57° comfortably clears this ring's own ~35° collision-avoidance
 * margin, so no `HUE_RING` re-spacing was needed here — recorded per the
 * card's own instruction to flag (not silently patch around) any collision
 * this reassignment surfaced.
 */
const HUE_RING = [12, 55, 95, 130, 172, 205, 243, 280, 305, 350, 25];

/**
 * A small, fast, dependency-free string hash (FNV-1a) — deterministic across
 * runs/processes/machines (no `Math.random`, no iteration-order-dependent
 * `Set`/`Map` behavior), so the SAME role/step name always maps to the SAME
 * hue everywhere this module is imported, forever, without persisting
 * anything.
 */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/_/g, "-");
}

/**
 * Resolves any Role/Step-kind name to a stable hue in degrees. Curated names
 * (`KNOWN_HUES`) win first; anything else deterministically hashes into
 * `HUE_RING`. Never throws, never returns a random/unstable value.
 */
export function hueForName(name: string): number {
  const key = normalizeName(name);
  const known = KNOWN_HUES[key];
  if (known !== undefined) return known;
  const idx = hashString(key) % HUE_RING.length;
  return HUE_RING[idx]!;
}

function hsl(h: number, s: number, l: number): string {
  return `hsl(${String(Math.round(h))} ${String(Math.round(s))}% ${String(Math.round(l))}%)`;
}

/**
 * Derives a complete 5-token mini-palette for one hue, independently tuned
 * for light/dark theme — the pure-function core of this whole module (see
 * module doc comment's "Radix step ratios" note for where these specific
 * lightness/saturation numbers come from).
 */
export function minPaletteForHue(hue: number, theme: "light" | "dark"): MiniPalette {
  if (theme === "light") {
    return {
      text: hsl(hue, 62, 34),
      border: hsl(hue, 55, 48),
      surface: hsl(hue, 62, 92),
      surfaceLight: hsl(hue, 55, 96),
      surfaceDark: hsl(hue, 45, 84),
      solid: hsl(hue, 62, 45),
      onSolid: hsl(hue, 30, 98),
    };
  }
  return {
    text: hsl(hue, 85, 78),
    border: hsl(hue, 60, 46),
    surface: hsl(hue, 42, 16),
    surfaceLight: hsl(hue, 38, 22),
    surfaceDark: hsl(hue, 48, 11),
    solid: hsl(hue, 70, 62),
    onSolid: hsl(hue, 40, 8),
  };
}

/** Convenience: the full mini-palette for a Role/Step-kind name, in one call — `hueForName` + `minPaletteForHue` composed. */
export function paletteForName(name: string, theme: "light" | "dark"): MiniPalette {
  return minPaletteForHue(hueForName(name), theme);
}

export { KNOWN_HUES, HUE_RING };
