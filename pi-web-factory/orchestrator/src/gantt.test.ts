/**
 * gantt.test.ts: unit tests for the compressed-gap Gantt layout (a
 * central, explicit requirement — idle/paused time between Steps must NOT
 * be drawn to scale) and the dynamic-width-fit scale (the whole track must
 * fit a caller-supplied `containerWidthPx`, never overflow it, by deriving
 * pixels-per-second instead of using a fixed constant).
 * Runs under plain `bun test` (no DOM needed — this module has none).
 */

import { describe, expect, test } from "bun:test";
import { computeGanttLayout, GAP_WIDTH_PX, MIN_BAR_WIDTH_PX, START_PADDING_PX } from "./gantt";
import type { Step } from "./api";

const CONTAINER_WIDTH_PX = 1000;

function mkStep(overrides: Partial<Step>): Step {
  return {
    phaseId: "p1",
    adwId: "adw1",
    seq: 1,
    name: "step",
    kind: "agent",
    role: "role",
    description: "",
    status: "success",
    attempt: 0,
    retries: 0,
    error: null,
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    outputSummary: null,
    startedAt: null,
    endedAt: null,
    ...overrides,
  };
}

describe("computeGanttLayout", () => {
  test("a single Step's bar width is proportional to its real duration, at the derived scale", () => {
    const steps = [
      mkStep({ startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:10.000Z" }), // 10s
    ];
    const { steps: layout, pixelsPerSecond } = computeGanttLayout(
      steps,
      Date.parse("2026-01-01T00:01:00.000Z"),
      CONTAINER_WIDTH_PX,
    );
    expect(layout).toHaveLength(1);
    expect(layout[0]!.durationMs).toBe(10_000);
    expect(layout[0]!.width).toBeCloseTo(10 * pixelsPerSecond, 5);
    expect(layout[0]!.x).toBe(START_PADDING_PX);
  });

  test("the whole track fits the supplied containerWidthPx — a long run no longer overflows into needing horizontal scroll", () => {
    const steps = [
      mkStep({ phaseId: "p1", seq: 1, startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:05:00.000Z" }), // 5 min
      mkStep({ phaseId: "p2", seq: 2, startedAt: "2026-01-01T00:05:00.000Z", endedAt: "2026-01-01T00:15:00.000Z" }), // 10 min
      mkStep({ phaseId: "p3", seq: 3, startedAt: "2026-01-01T00:15:00.000Z", endedAt: "2026-01-01T00:45:00.000Z" }), // 30 min
    ];
    const { totalWidth } = computeGanttLayout(steps, Date.parse("2026-01-01T01:00:00.000Z"), CONTAINER_WIDTH_PX);
    // The old fixed-8px/s scale would have produced a track thousands of px
    // wide for this run (45 real minutes of step time); the new derived
    // scale must keep it within (or acceptably close to) the container.
    expect(totalWidth).toBeLessThanOrEqual(CONTAINER_WIDTH_PX + 1);
  });

  test("a wider container produces a larger derived pixelsPerSecond for the same run", () => {
    const steps = [
      mkStep({ startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:01:00.000Z" }), // 1 min
    ];
    const narrow = computeGanttLayout(steps, Date.now(), 300);
    const wide = computeGanttLayout(steps, Date.now(), 1200);
    expect(wide.pixelsPerSecond).toBeGreaterThan(narrow.pixelsPerSecond);
  });

  test("a long idle gap between two Steps is compressed to the fixed GAP_WIDTH_PX, not drawn to scale", () => {
    const steps = [
      mkStep({ phaseId: "p1", seq: 1, startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:05.000Z" }), // 5s
      // huge gap: an HOUR between step 1 ending and step 2 starting
      mkStep({ phaseId: "p2", seq: 2, startedAt: "2026-01-01T01:00:05.000Z", endedAt: "2026-01-01T01:00:15.000Z" }), // 10s
    ];
    const { steps: layout, totalWidth, pixelsPerSecond } = computeGanttLayout(
      steps,
      Date.parse("2026-01-01T02:00:00.000Z"),
      CONTAINER_WIDTH_PX,
    );

    const step1 = layout[0]!;
    const step2 = layout[1]!;

    expect(step1.width).toBeCloseTo(5 * pixelsPerSecond, 5);
    // step2's x must be step1's end + the FIXED gap width, regardless of the
    // real 1-hour gap — this is the whole point of the requirement.
    expect(step2.x).toBe(step1.x + step1.width + GAP_WIDTH_PX);
    expect(step2.width).toBeCloseTo(10 * pixelsPerSecond, 5);

    // Total layout width still fits the container (proves nothing scaled
    // the hour-long gap up to real proportional size).
    expect(totalWidth).toBeLessThanOrEqual(CONTAINER_WIDTH_PX + 1);
  });

  test("a fast Step still gets a visible minimum bar width even when the derived scale is small (long run, narrow container)", () => {
    const steps = [
      // A near-instant Step sitting alongside a very long one, in a narrow
      // container — the derived pixelsPerSecond is small (most of the total
      // duration comes from the long step), so the fast step's proportional
      // width would round to a sliver without the MIN_BAR_WIDTH_PX floor.
      mkStep({ phaseId: "p1", seq: 1, startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:00.050Z" }), // 50ms
      mkStep({ phaseId: "p2", seq: 2, startedAt: "2026-01-01T00:00:00.050Z", endedAt: "2026-01-01T00:30:00.050Z" }), // 30 min
    ];
    const { steps: layout } = computeGanttLayout(steps, Date.now(), 300);
    expect(layout[0]!.width).toBe(MIN_BAR_WIDTH_PX);
  });

  test("a single, isolated fast Step still gets the true MIN_BAR_WIDTH_PX floor (a lone tiny-duration run has nothing else to derive a smaller scale from)", () => {
    const steps = [mkStep({ startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:00.050Z" })]; // 50ms
    const { steps: layout } = computeGanttLayout(steps, Date.now(), CONTAINER_WIDTH_PX);
    // With only one, near-instant step, the derived scale is enormous (tiny
    // total duration / large available width) — width is floored the other
    // direction too: MIN_BAR_WIDTH_PX is a floor, not a ceiling, so this
    // just confirms it's AT LEAST the floor, exactly like the multi-step case.
    expect(layout[0]!.width).toBeGreaterThanOrEqual(MIN_BAR_WIDTH_PX);
  });

  test("a still-running Step (no ended_at) is drawn up to `nowMs`, marked stillRunning, and grows on each recompute", () => {
    const steps = [mkStep({ startedAt: "2026-01-01T00:00:00.000Z", endedAt: null })];
    const nowMs1 = Date.parse("2026-01-01T00:00:05.000Z");
    const nowMs2 = Date.parse("2026-01-01T00:00:15.000Z");

    const layout1 = computeGanttLayout(steps, nowMs1, CONTAINER_WIDTH_PX).steps[0]!;
    const layout2 = computeGanttLayout(steps, nowMs2, CONTAINER_WIDTH_PX).steps[0]!;

    expect(layout1.stillRunning).toBe(true);
    expect(layout2.stillRunning).toBe(true);
    expect(layout1.durationMs).toBe(5_000);
    expect(layout2.durationMs).toBe(15_000);
    expect(layout2.width).toBeGreaterThanOrEqual(layout1.width);
  });

  test("a queued Step with no startedAt yet gets a minimal placeholder bar, not an error", () => {
    const steps = [mkStep({ startedAt: null, endedAt: null, status: "queued" })];
    const { steps: layout } = computeGanttLayout(steps, Date.now(), CONTAINER_WIDTH_PX);
    expect(layout[0]!.width).toBe(MIN_BAR_WIDTH_PX);
    expect(layout[0]!.durationMs).toBeNull();
    expect(layout[0]!.stillRunning).toBe(false);
  });

  test("three Steps with two gaps of very different real lengths (1 minute vs 2 hours) still produce two IDENTICAL fixed-width gaps", () => {
    const steps = [
      mkStep({ phaseId: "p1", seq: 1, startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:02.000Z" }),
      mkStep({ phaseId: "p2", seq: 2, startedAt: "2026-01-01T00:01:02.000Z", endedAt: "2026-01-01T00:01:04.000Z" }), // 1 min gap
      mkStep({ phaseId: "p3", seq: 3, startedAt: "2026-01-01T02:01:04.000Z", endedAt: "2026-01-01T02:01:06.000Z" }), // 2 hour gap
    ];
    const { steps: layout } = computeGanttLayout(steps, Date.parse("2026-01-01T03:00:00.000Z"), CONTAINER_WIDTH_PX);
    const gap1 = layout[1]!.x - (layout[0]!.x + layout[0]!.width);
    const gap2 = layout[2]!.x - (layout[1]!.x + layout[1]!.width);
    expect(gap1).toBe(GAP_WIDTH_PX);
    expect(gap2).toBe(GAP_WIDTH_PX);
    expect(gap1).toBe(gap2);
  });

  test("no Steps at all produces an empty layout without dividing by zero", () => {
    const { steps: layout, totalWidth, pixelsPerSecond } = computeGanttLayout([], Date.now(), CONTAINER_WIDTH_PX);
    expect(layout).toHaveLength(0);
    expect(totalWidth).toBe(START_PADDING_PX * 2);
    expect(Number.isFinite(pixelsPerSecond)).toBe(true);
  });
});
