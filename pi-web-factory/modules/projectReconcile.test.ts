/**
 * Unit tests for projectReconcile.ts against a mocked `fetch` (matching
 * piwebProject.test.ts's own pattern) for the network half, and REAL scratch
 * directories (matching worktree.test.ts's own pattern) for the filesystem
 * half — staleness detection is genuinely filesystem-mechanical, not worth
 * mocking `node:fs` for.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { formatStaleProjectOutcome, planStaleProjects, reconcileStaleProjects } from "./projectReconcile.ts";

const BASE_URL = "http://fake-pi-web.test/api";

let originalFetch: typeof fetch;
let dir: string;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  dir = mkdtempSync(join(tmpdir(), "pi-web-factory-reconcile-test-"));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(dir, { recursive: true, force: true });
});

function initRepo(cwd: string): void {
  spawnSync("git", ["init", "-q"], { cwd });
}

function mockProjectsList(projects: unknown[]): void {
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/projects") && (init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify(projects), { status: 200 });
    }
    throw new Error(`unexpected fetch to ${url} (${init?.method ?? "GET"})`);
  }) as typeof fetch;
}

// ── planStaleProjects ────────────────────────────────────────────────────

describe("planStaleProjects", () => {
  test("flags a project whose path no longer exists at all — missing-path", async () => {
    mockProjectsList([{ id: "p1", name: "gone", path: join(dir, "does-not-exist"), createdAt: "2026-01-01T00:00:00Z" }]);

    const plan = await planStaleProjects(BASE_URL);
    expect(plan.scanned).toBe(1);
    expect(plan.stale).toHaveLength(1);
    expect(plan.stale[0]?.reason).toBe("missing-path");
  });

  test("flags a project whose path exists but has no .git of its own — not-a-repo-root", async () => {
    // Models /work: a real, existing directory that is NOT itself a repo
    // root, even if real repos live somewhere underneath it.
    const nested = join(dir, "some-real-project");
    mkdirSync(nested, { recursive: true });
    initRepo(nested);

    mockProjectsList([{ id: "p1", name: "work", path: dir, createdAt: "2026-01-01T00:00:00Z" }]);

    const plan = await planStaleProjects(BASE_URL);
    expect(plan.stale).toHaveLength(1);
    expect(plan.stale[0]?.reason).toBe("not-a-repo-root");
  });

  test("does not flag a project whose path exists and is a real repo root", async () => {
    initRepo(dir);
    mockProjectsList([{ id: "p1", name: "fine", path: dir, createdAt: "2026-01-01T00:00:00Z" }]);

    const plan = await planStaleProjects(BASE_URL);
    expect(plan.scanned).toBe(1);
    expect(plan.stale).toHaveLength(0);
  });

  test("scans every project independently — a mix of stale and healthy entries", async () => {
    initRepo(dir);
    const missing = join(dir, "..", "definitely-does-not-exist-m115");

    mockProjectsList([
      { id: "p1", name: "healthy", path: dir, createdAt: "2026-01-01T00:00:00Z" },
      { id: "p2", name: "gone", path: missing, createdAt: "2026-01-01T00:00:00Z" },
    ]);

    const plan = await planStaleProjects(BASE_URL);
    expect(plan.scanned).toBe(2);
    expect(plan.stale).toHaveLength(1);
    expect(plan.stale[0]?.project.id).toBe("p2");
  });
});

// ── reconcileStaleProjects ───────────────────────────────────────────────

describe("reconcileStaleProjects", () => {
  test("dryRun: true never calls DELETE — every stale entry comes back reported-only", async () => {
    let deleteCalled = false;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/projects") && (init?.method ?? "GET") === "GET") {
        return new Response(
          JSON.stringify([{ id: "p1", name: "gone", path: join(dir, "does-not-exist"), createdAt: "2026-01-01T00:00:00Z" }]),
          { status: 200 },
        );
      }
      if (init?.method === "DELETE") {
        deleteCalled = true;
        throw new Error("dryRun must never call DELETE");
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    const result = await reconcileStaleProjects(BASE_URL, { dryRun: true });
    expect(deleteCalled).toBe(false);
    expect(result.stale).toHaveLength(1);
    expect(result.stale[0]?.outcome).toBe("reported-only");
  });

  test("without dryRun, actually DELETEs each stale project by id and marks it deleted", async () => {
    const deletedIds: string[] = [];
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/projects") && (init?.method ?? "GET") === "GET") {
        return new Response(
          JSON.stringify([{ id: "p1", name: "gone", path: join(dir, "does-not-exist"), createdAt: "2026-01-01T00:00:00Z" }]),
          { status: 200 },
        );
      }
      if (init?.method === "DELETE") {
        deletedIds.push(url.split("/").pop()!);
        return new Response(JSON.stringify({ closed: true }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    const result = await reconcileStaleProjects(BASE_URL);
    expect(deletedIds).toEqual(["p1"]);
    expect(result.stale[0]?.outcome).toBe("deleted");
  });

  test("a healthy project's real repo root is never touched — no DELETE, not in the stale list", async () => {
    initRepo(dir);
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/projects") && (init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify([{ id: "p1", name: "fine", path: dir, createdAt: "2026-01-01T00:00:00Z" }]), { status: 200 });
      }
      if (init?.method === "DELETE") throw new Error("must not delete a healthy project");
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    const result = await reconcileStaleProjects(BASE_URL);
    expect(result.scanned).toBe(1);
    expect(result.stale).toHaveLength(0);
  });

  test("one project's DELETE failing is recorded as failed, not thrown, and does not block other entries", async () => {
    const otherMissing = join(dir, "other-missing-m115");
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/projects") && (init?.method ?? "GET") === "GET") {
        return new Response(
          JSON.stringify([
            { id: "p-fail", name: "fails", path: join(dir, "does-not-exist"), createdAt: "2026-01-01T00:00:00Z" },
            { id: "p-ok", name: "ok", path: otherMissing, createdAt: "2026-01-01T00:00:00Z" },
          ]),
          { status: 200 },
        );
      }
      if (init?.method === "DELETE") {
        if (url.endsWith("/p-fail")) {
          return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
        }
        return new Response(JSON.stringify({ closed: true }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    const result = await reconcileStaleProjects(BASE_URL);
    expect(result.stale).toHaveLength(2);
    const failEntry = result.stale.find((e) => e.project.id === "p-fail");
    const okEntry = result.stale.find((e) => e.project.id === "p-ok");
    expect(failEntry?.outcome).toBe("failed");
    expect(failEntry?.detail).toBeDefined();
    expect(okEntry?.outcome).toBe("deleted");
  });
});

// ── formatStaleProjectOutcome ────────────────────────────────────────────

describe("formatStaleProjectOutcome", () => {
  test("renders a human-readable line naming the project, path, and reason", () => {
    const line = formatStaleProjectOutcome({
      project: { id: "p1", name: "pi-web-perf-metrics", path: "/home/piweb/pi-web-perf-metrics", createdAt: "2026-08-07T00:00:00Z" },
      reason: "missing-path",
      outcome: "deleted",
    });
    expect(line).toContain("pi-web-perf-metrics");
    expect(line).toContain("/home/piweb/pi-web-perf-metrics");
    expect(line).toContain("missing-path");
    expect(line).toContain("deleted");
  });
});
