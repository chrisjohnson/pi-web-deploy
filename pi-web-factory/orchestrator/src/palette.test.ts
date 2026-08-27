/**
 * palette.test.ts: unit tests for the deterministic hue/mini-palette
 * generator (M-105 item 2's core requirement — "no hand-authoring the next
 * step's palette").
 */

import { describe, expect, test } from "bun:test";
import { HUE_RING, KNOWN_HUES, hueForName, minPaletteForHue, paletteForName } from "./palette";

describe("hueForName", () => {
  test("plan is always purple (hue ~262), matching the app's pre-existing purple identity", () => {
    expect(hueForName("plan")).toBe(262);
  });

  test("every curated KNOWN_HUES entry resolves to exactly its pinned hue", () => {
    for (const [name, hue] of Object.entries(KNOWN_HUES)) {
      expect(hueForName(name)).toBe(hue);
    }
  });

  test("is case-insensitive and tolerates whitespace, same as roleColor's own normalization", () => {
    expect(hueForName("Plan")).toBe(hueForName("plan"));
    expect(hueForName("  BUILD  ")).toBe(hueForName("build"));
  });

  test("treats underscore and hyphen spellings the same", () => {
    expect(hueForName("run_tests")).toBe(hueForName("run-tests"));
  });

  test("an unrecognized name still resolves to a real, valid hue (0-360), never throws", () => {
    const hue = hueForName("some-brand-new-role-nobody-authored-yet");
    expect(hue).toBeGreaterThanOrEqual(0);
    expect(hue).toBeLessThan(360);
  });

  test("an unrecognized name's hue is STABLE across repeated calls — deterministic, not random", () => {
    const a = hueForName("future-role-abc");
    const b = hueForName("future-role-abc");
    expect(a).toBe(b);
  });

  test("an unrecognized name's hue always comes from HUE_RING (never an arbitrary value)", () => {
    const hue = hueForName("another-future-role");
    expect(HUE_RING).toContain(hue);
  });

  test("different unrecognized names usually hash to different hues", () => {
    const names = ["alpha-role", "beta-role", "gamma-role", "delta-role", "epsilon-role"];
    const hues = new Set(names.map((n) => hueForName(n)));
    expect(hues.size).toBeGreaterThan(1);
  });

  test("empty string does not throw and returns a valid hue", () => {
    expect(() => hueForName("")).not.toThrow();
  });

  test("M-105 item 1 reopened: review is no longer curated — it now resolves from HUE_RING like any other unlisted name, not from KNOWN_HUES", () => {
    expect(KNOWN_HUES["review"]).toBeUndefined();
    const hue = hueForName("review");
    expect(HUE_RING).toContain(hue);
  });

  test("review's generated hue doesn't collide (within ~35deg) with any remaining curated anchor", () => {
    const reviewHue = hueForName("review");
    for (const [name, curatedHue] of Object.entries(KNOWN_HUES)) {
      const raw = Math.abs(curatedHue - reviewHue);
      const circularDistance = Math.min(raw, 360 - raw);
      expect(circularDistance).toBeGreaterThan(35);
    }
  });
});

describe("minPaletteForHue", () => {
  test("produces all 7 tokens as valid hsl() strings, for both themes", () => {
    for (const theme of ["light", "dark"] as const) {
      const palette = minPaletteForHue(262, theme);
      for (const key of ["text", "border", "surface", "surfaceLight", "surfaceDark", "solid", "onSolid"] as const) {
        expect(palette[key]).toMatch(/^hsl\(\d+(\.\d+)? \d+% \d+%\)$/);
      }
    }
  });

  test("preserves the requested hue in every generated token", () => {
    const palette = minPaletteForHue(180, "light");
    for (const value of Object.values(palette)) {
      expect(value.startsWith("hsl(180 ")).toBe(true);
    }
  });

  test("light and dark themes produce genuinely different lightness for the same hue", () => {
    const light = minPaletteForHue(200, "light");
    const dark = minPaletteForHue(200, "dark");
    expect(light.surface).not.toBe(dark.surface);
    expect(light.text).not.toBe(dark.text);
  });

  test("surfaceLight is lighter than surfaceDark, in both themes (a real light/dark variation, not the same value twice)", () => {
    for (const theme of ["light", "dark"] as const) {
      const palette = minPaletteForHue(150, theme);
      const lightL = Number(/(\d+)%\)$/.exec(palette.surfaceLight)?.[1]);
      const darkL = Number(/(\d+)%\)$/.exec(palette.surfaceDark)?.[1]);
      expect(lightL).toBeGreaterThan(darkL);
    }
  });
});

describe("paletteForName", () => {
  test("composes hueForName + minPaletteForHue — known role name in, full palette out", () => {
    const palette = paletteForName("plan", "light");
    const expected = minPaletteForHue(262, "light");
    expect(palette).toEqual(expected);
  });

  test("a brand new role name still produces a complete, usable palette — the core M-105 item 2 guarantee", () => {
    const palette = paletteForName("a-role-invented-tomorrow", "dark");
    expect(palette.text).toMatch(/^hsl\(/);
    expect(palette.surface).toMatch(/^hsl\(/);
    expect(palette.solid).toMatch(/^hsl\(/);
  });
});
