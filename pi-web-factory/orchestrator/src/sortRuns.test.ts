/**
 * sortRuns.test.ts: unit tests for the main grid's two-tier sort order
 * (spec section 4) — running runs first (oldest-started first), then
 * completed runs (most-recently-ended first), with edge cases (ties,
 * missing endedAt, empty list) covered explicitly.
 */

import { describe, expect, test } from "bun:test";
import { sortRuns, sortTickets } from "./sortRuns";
import type { RunSummary, TicketSummary } from "./api";

function mkRun(overrides: Partial<RunSummary>): RunSummary {
  return {
    adwId: "adw1",
    adwName: null,
    projectCwd: null,
    projectRoot: null,
    title: null,
    request: null,
    status: "success",
    engineer: null,
    startedAt: null,
    endedAt: null,
    totalTokens: 0,
    totalCost: 0,
    archived: false,
    ticketId: null,
    steps: [],
    ...overrides,
  };
}

function mkTicket(overrides: Partial<TicketSummary> & { latestRun: RunSummary | null }): TicketSummary {
  return {
    ticketId: overrides.latestRun?.adwId ? `ticket_${overrides.latestRun.adwId}` : "ticket_none",
    filePath: null,
    createdAt: null,
    title: null,
    runCount: 1,
    ...overrides,
  };
}

describe("sortRuns", () => {
  test("empty list returns empty list", () => {
    expect(sortRuns([])).toEqual([]);
  });

  test("running runs sort oldest-started first (ascending startedAt)", () => {
    const newer = mkRun({ adwId: "newer", status: "running", startedAt: "2026-01-01T00:10:00.000Z" });
    const older = mkRun({ adwId: "older", status: "running", startedAt: "2026-01-01T00:00:00.000Z" });
    const middle = mkRun({ adwId: "middle", status: "running", startedAt: "2026-01-01T00:05:00.000Z" });

    const sorted = sortRuns([newer, older, middle]);
    expect(sorted.map((r) => r.adwId)).toEqual(["older", "middle", "newer"]);
  });

  test("non-running runs sort most-recently-ended first (descending endedAt)", () => {
    const oldest = mkRun({ adwId: "oldest", status: "success", endedAt: "2026-01-01T00:00:00.000Z" });
    const newest = mkRun({ adwId: "newest", status: "fail", endedAt: "2026-01-01T02:00:00.000Z" });
    const middle = mkRun({ adwId: "middle", status: "success", endedAt: "2026-01-01T01:00:00.000Z" });

    const sorted = sortRuns([oldest, newest, middle]);
    expect(sorted.map((r) => r.adwId)).toEqual(["newest", "middle", "oldest"]);
  });

  test("ALL running runs come before ALL non-running runs, regardless of timestamps", () => {
    // A running run that started very recently must still sort above a
    // completed run that ended just now — the two-tier split is absolute,
    // not a single merged timestamp sort.
    const runningRecent = mkRun({ adwId: "running-recent", status: "running", startedAt: "2026-01-01T05:00:00.000Z" });
    const completedJustNow = mkRun({ adwId: "completed-just-now", status: "success", endedAt: "2026-01-01T05:00:01.000Z" });

    const sorted = sortRuns([completedJustNow, runningRecent]);
    expect(sorted.map((r) => r.adwId)).toEqual(["running-recent", "completed-just-now"]);
  });

  test("a non-running run with a null endedAt falls back to startedAt for its sort key, instead of crashing or landing arbitrarily", () => {
    const withEnded = mkRun({ adwId: "with-ended", status: "success", startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T03:00:00.000Z" });
    const noEndedButLaterStart = mkRun({
      adwId: "no-ended-later-start",
      status: "fail",
      startedAt: "2026-01-01T04:00:00.000Z",
      endedAt: null,
    });
    const noEndedEarlierStart = mkRun({
      adwId: "no-ended-earlier-start",
      status: "fail",
      startedAt: "2026-01-01T01:00:00.000Z",
      endedAt: null,
    });

    const sorted = sortRuns([withEnded, noEndedButLaterStart, noEndedEarlierStart]);
    // Sort key per row: with-ended -> endedAt (03:00), no-ended-later-start
    // -> startedAt (04:00), no-ended-earlier-start -> startedAt (01:00).
    // Descending: 04:00, 03:00, 01:00.
    expect(sorted.map((r) => r.adwId)).toEqual(["no-ended-later-start", "with-ended", "no-ended-earlier-start"]);
  });

  test("end-to-end ordering: oldest-still-running -> newest-still-running -> most-recently-completed -> oldest-completed", () => {
    const runs = [
      mkRun({ adwId: "completed-old", status: "success", endedAt: "2026-01-01T00:00:00.000Z" }),
      mkRun({ adwId: "running-new", status: "running", startedAt: "2026-01-01T05:00:00.000Z" }),
      mkRun({ adwId: "completed-new", status: "fail", endedAt: "2026-01-01T06:00:00.000Z" }),
      mkRun({ adwId: "running-old", status: "running", startedAt: "2026-01-01T02:00:00.000Z" }),
    ];
    const sorted = sortRuns(runs);
    expect(sorted.map((r) => r.adwId)).toEqual(["running-old", "running-new", "completed-new", "completed-old"]);
  });

  test("does not mutate the input array", () => {
    const runs = [mkRun({ adwId: "a", status: "running", startedAt: "2026-01-01T00:10:00.000Z" }), mkRun({ adwId: "b", status: "running", startedAt: "2026-01-01T00:00:00.000Z" })];
    const original = [...runs];
    sortRuns(runs);
    expect(runs).toEqual(original);
  });
});

describe("sortTickets (M-103)", () => {
  test("orders tickets by the SAME rule sortRuns applies to their latestRun", () => {
    const t1 = mkTicket({ ticketId: "t1", latestRun: mkRun({ adwId: "a", status: "success", endedAt: "2026-01-01T00:00:00.000Z" }) });
    const t2 = mkTicket({ ticketId: "t2", latestRun: mkRun({ adwId: "b", status: "running", startedAt: "2026-01-01T05:00:00.000Z" }) });
    const t3 = mkTicket({ ticketId: "t3", latestRun: mkRun({ adwId: "c", status: "fail", endedAt: "2026-01-01T02:00:00.000Z" }) });

    const sorted = sortTickets([t1, t2, t3]);
    // running first, then most-recently-ended first.
    expect(sorted.map((t) => t.ticketId)).toEqual(["t2", "t3", "t1"]);
  });

  test("a ticket with no latestRun (defensive edge case) sorts last, without crashing", () => {
    const withRun = mkTicket({ ticketId: "has-run", latestRun: mkRun({ adwId: "a", status: "success", endedAt: "2026-01-01T00:00:00.000Z" }) });
    const withoutRun = mkTicket({ ticketId: "no-run", latestRun: null });

    const sorted = sortTickets([withoutRun, withRun]);
    expect(sorted.map((t) => t.ticketId)).toEqual(["has-run", "no-run"]);
  });

  test("preserves each ticket's own runCount/title fields through the sort", () => {
    const ticket = mkTicket({ ticketId: "t1", title: "my ticket", runCount: 3, latestRun: mkRun({ adwId: "a", status: "success" }) });
    const sorted = sortTickets([ticket]);
    expect(sorted[0]?.title).toBe("my ticket");
    expect(sorted[0]?.runCount).toBe(3);
  });

  test("does not mutate the input array", () => {
    const tickets = [
      mkTicket({ ticketId: "t1", latestRun: mkRun({ adwId: "a", status: "running", startedAt: "2026-01-01T00:10:00.000Z" }) }),
      mkTicket({ ticketId: "t2", latestRun: mkRun({ adwId: "b", status: "running", startedAt: "2026-01-01T00:00:00.000Z" }) }),
    ];
    const original = [...tickets];
    sortTickets(tickets);
    expect(tickets).toEqual(original);
  });
});
