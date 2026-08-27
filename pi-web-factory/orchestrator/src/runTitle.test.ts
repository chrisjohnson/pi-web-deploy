/**
 * runTitle.test.ts: unit tests for the run-title display fallback chain
 * (spec section 2) — title -> request -> adwId.
 */

import { describe, expect, test } from "bun:test";
import { runTitle } from "./runTitle";

describe("runTitle", () => {
  test("prefers run.title when present", () => {
    expect(runTitle({ title: "My Title", request: "do the thing", adwId: "adw_123" })).toBe("My Title");
  });

  test("falls back to run.request when title is null", () => {
    expect(runTitle({ title: null, request: "do the thing", adwId: "adw_123" })).toBe("do the thing");
  });

  test("falls back to run.adwId when both title and request are null", () => {
    expect(runTitle({ title: null, request: null, adwId: "adw_123" })).toBe("adw_123");
  });

  test("falls back to run.request when title is an empty string", () => {
    expect(runTitle({ title: "", request: "do the thing", adwId: "adw_123" })).toBe("do the thing");
  });

  test("falls back to adwId when request is an empty string too", () => {
    expect(runTitle({ title: "", request: "", adwId: "adw_123" })).toBe("adw_123");
  });
});
