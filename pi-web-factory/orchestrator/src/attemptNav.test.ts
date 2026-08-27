import { describe, expect, test } from "bun:test";
import { attemptNavHtml, moveAttemptIndex } from "./attemptNav";

describe("moveAttemptIndex", () => {
  test("older moves toward higher indices (older attempts)", () => {
    expect(moveAttemptIndex(0, "older", 3)).toBe(1);
    expect(moveAttemptIndex(1, "older", 3)).toBe(2);
  });

  test("newer moves toward lower indices (index 0 = latest)", () => {
    expect(moveAttemptIndex(2, "newer", 3)).toBe(1);
    expect(moveAttemptIndex(1, "newer", 3)).toBe(0);
  });

  test("never moves past the oldest end (runCount - 1)", () => {
    expect(moveAttemptIndex(2, "older", 3)).toBe(2);
  });

  test("never moves past the newest end (0)", () => {
    expect(moveAttemptIndex(0, "newer", 3)).toBe(0);
  });

  test("a runCount of 0 always returns 0 — never throws or goes negative", () => {
    expect(moveAttemptIndex(0, "older", 0)).toBe(0);
    expect(moveAttemptIndex(0, "newer", 0)).toBe(0);
  });

  test("a single-run ticket (runCount 1) never moves", () => {
    expect(moveAttemptIndex(0, "older", 1)).toBe(0);
    expect(moveAttemptIndex(0, "newer", 1)).toBe(0);
  });
});

describe("attemptNavHtml", () => {
  test("renders nothing for a ticket with 0 or 1 runs — no arrows for a single attempt", () => {
    expect(attemptNavHtml("t1", 0, 0)).toBe("");
    expect(attemptNavHtml("t1", 0, 1)).toBe("");
  });

  test("renders both buttons enabled when in the middle of the attempt history", () => {
    const html = attemptNavHtml("t1", 1, 3);
    expect(html).toContain('data-attempt-nav-dir="older"');
    expect(html).toContain('data-attempt-nav-dir="newer"');
    // Neither button has `disabled` when in the middle.
    const olderBtn = /data-attempt-nav-dir="older"[^>]*/.exec(html)?.[0] ?? "";
    const newerBtn = /data-attempt-nav-dir="newer"[^>]*/.exec(html)?.[0] ?? "";
    expect(olderBtn).not.toContain("disabled");
    expect(newerBtn).not.toContain("disabled");
  });

  test("the 'newer' button is disabled at the latest attempt (index 0)", () => {
    const html = attemptNavHtml("t1", 0, 3);
    const newerBtn = /<button[^>]*data-attempt-nav-dir="newer"[^>]*>/.exec(html)?.[0] ?? "";
    expect(newerBtn).toContain("disabled");
    const olderBtn = /<button[^>]*data-attempt-nav-dir="older"[^>]*>/.exec(html)?.[0] ?? "";
    expect(olderBtn).not.toContain("disabled");
  });

  test("the 'older' button is disabled at the oldest attempt (index runCount - 1)", () => {
    const html = attemptNavHtml("t1", 2, 3);
    const olderBtn = /<button[^>]*data-attempt-nav-dir="older"[^>]*>/.exec(html)?.[0] ?? "";
    expect(olderBtn).toContain("disabled");
    const newerBtn = /<button[^>]*data-attempt-nav-dir="newer"[^>]*>/.exec(html)?.[0] ?? "";
    expect(newerBtn).not.toContain("disabled");
  });

  test("shows human-facing 'attempt N/total' — attempt 1 is the OLDEST, not index 0", () => {
    // index 0 = latest = attempt 3 of 3.
    expect(attemptNavHtml("t1", 0, 3)).toContain("attempt 3/3");
    // index 2 = oldest = attempt 1 of 3.
    expect(attemptNavHtml("t1", 2, 3)).toContain("attempt 1/3");
    // index 1 = middle = attempt 2 of 3.
    expect(attemptNavHtml("t1", 1, 3)).toContain("attempt 2/3");
  });

  test("the idPrefix is escaped and included for caller-side scoping", () => {
    const html = attemptNavHtml("adw_abc123", 0, 2);
    expect(html).toContain('data-attempt-nav="adw_abc123"');
  });
});
