/**
 * roleColor.test.ts: unit tests for the Role -> color mapping (see
 * roleColor.ts's own doc comment). Every known Role must map to its own
 * distinct, STABLE color; an unrecognized/future Role name must STILL get
 * a complete, real generated palette (never a bare neutral fallback —
 * that's the whole point of the "no hand-authoring the next palette"
 * requirement); only `null`/empty falls back to neutral.
 */

import { describe, expect, test } from "bun:test";
import { KNOWN_ROLES, roleColor, roleMiniPalette } from "./roleColor";

describe("roleColor", () => {
  test("every known Role maps to a real hsl() color pair", () => {
    for (const role of KNOWN_ROLES) {
      const tokens = roleColor(role);
      expect(tokens.color).toMatch(/^hsl\(/);
      expect(tokens.surface).toMatch(/^hsl\(/);
    }
  });

  test("all known Roles map to mutually distinct colors", () => {
    const colors = KNOWN_ROLES.map((r) => roleColor(r).color);
    expect(new Set(colors).size).toBe(KNOWN_ROLES.length);
  });

  test("is case-insensitive and tolerates surrounding whitespace", () => {
    expect(roleColor("Plan")).toEqual(roleColor("plan"));
    expect(roleColor("  REVIEW  ")).toEqual(roleColor("review"));
  });

  test("treats underscore and hyphen spellings of run-tests the same", () => {
    expect(roleColor("run_tests")).toEqual(roleColor("run-tests"));
  });

  test("null falls back to the neutral pair, does not throw", () => {
    const tokens = roleColor(null);
    expect(tokens.color).toMatch(/^hsl\(/);
  });

  test("undefined falls back to the neutral pair, does not throw", () => {
    expect(() => roleColor(undefined)).not.toThrow();
  });

  test("empty string falls back to the neutral pair", () => {
    expect(() => roleColor("")).not.toThrow();
  });

  test("the null fallback is never one of the real role colors", () => {
    const fallback = roleColor(null).color;
    const realColors = KNOWN_ROLES.map((r) => roleColor(r).color);
    expect(realColors).not.toContain(fallback);
  });

  // ── the core "no hand-authoring" requirement ─────────────────────────────
  test("an unrecognized future Role name gets a REAL generated color, not the neutral fallback", () => {
    const future = roleColor("some-future-role-not-yet-invented");
    const neutral = roleColor(null);
    expect(future.color).not.toBe(neutral.color);
  });

  test("an unrecognized Role name is STABLE — same name always produces the same color", () => {
    const a = roleColor("brand-new-role-xyz");
    const b = roleColor("brand-new-role-xyz");
    expect(a).toEqual(b);
  });

  test("two different unrecognized Role names usually produce different colors", () => {
    const a = roleColor("totally-new-role-one");
    const b = roleColor("totally-different-role-two");
    expect(a.color).not.toBe(b.color);
  });
});

describe("roleMiniPalette", () => {
  test("returns null for null/empty — callers own their own neutral treatment", () => {
    expect(roleMiniPalette(null)).toBeNull();
    expect(roleMiniPalette(undefined)).toBeNull();
    expect(roleMiniPalette("")).toBeNull();
  });

  test("returns a full 7-token mini-palette for a known role", () => {
    const palette = roleMiniPalette("plan");
    expect(palette).not.toBeNull();
    expect(palette).toMatchObject({
      text: expect.stringMatching(/^hsl\(/),
      border: expect.stringMatching(/^hsl\(/),
      surface: expect.stringMatching(/^hsl\(/),
      surfaceLight: expect.stringMatching(/^hsl\(/),
      surfaceDark: expect.stringMatching(/^hsl\(/),
      solid: expect.stringMatching(/^hsl\(/),
      onSolid: expect.stringMatching(/^hsl\(/),
    });
  });

  test("returns a full mini-palette for a brand new, never-seen role name too", () => {
    const palette = roleMiniPalette("setup");
    expect(palette).not.toBeNull();
    expect(palette?.text).toMatch(/^hsl\(/);
  });
});
