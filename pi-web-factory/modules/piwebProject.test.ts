/**
 * Unit tests for piwebProject.ts's pure request-shaping logic, against a
 * mocked `fetch` (same pattern as run.test.ts/piwebClient.test.ts) — no live
 * server needed. Live end-to-end coverage (a real project registered, a real
 * worktree's workspace id resolved) lives in
 * chains/planBuildTest.integration.test.ts (M-071).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { deleteProject, ensureProjectRegistered, listProjects, resolveWorkspaceId, ProjectRegistrationRaceError } from "./piwebProject.ts";
import { PiWebClientError } from "./piwebClient.ts";

const BASE_URL = "http://fake-pi-web.test/api";

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── ensureProjectRegistered ──────────────────────────────────────────────

describe("ensureProjectRegistered", () => {
  test("returns the existing project's id when GET /projects already has this path — never POSTs", async () => {
    let postCalled = false;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/projects") && (init?.method ?? "GET") === "GET") {
        return new Response(
          JSON.stringify([
            { id: "proj_existing", name: "existing", path: "/tmp/my-project", createdAt: "2026-01-01T00:00:00Z" },
          ]),
          { status: 200 },
        );
      }
      if (url.endsWith("/projects") && init?.method === "POST") {
        postCalled = true;
        throw new Error("should not POST when a matching project already exists");
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    const result = await ensureProjectRegistered(BASE_URL, "/tmp/my-project");
    expect(result.projectId).toBe("proj_existing");
    expect(postCalled).toBe(false);
  });

  test("POSTs a new project when no existing entry matches the path, verifies via a fresh GET, and returns its id", async () => {
    let postBody: unknown;
    let getCallCount = 0;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/projects") && (init?.method ?? "GET") === "GET") {
        getCallCount += 1;
        // First GET (pre-check): empty. Second GET (M-095 verify-after-write,
        // post-POST): the new project now shows up, confirming the write
        // actually persisted.
        if (getCallCount === 1) return new Response(JSON.stringify([]), { status: 200 });
        return new Response(
          JSON.stringify([{ id: "proj_new", name: "new", path: "/tmp/my-new-project", createdAt: "2026-01-01T00:00:00Z" }]),
          { status: 200 },
        );
      }
      if (url.endsWith("/projects") && init?.method === "POST") {
        postBody = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({ id: "proj_new", name: "new", path: "/tmp/my-new-project", createdAt: "2026-01-01T00:00:00Z" }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    const result = await ensureProjectRegistered(BASE_URL, "/tmp/my-new-project");
    expect(result.projectId).toBe("proj_new");
    expect(postBody).toEqual({ path: "/tmp/my-new-project" });
  });

  test("matches by EXACT path — a project at a different path is not treated as already-registered", async () => {
    let getCallCount = 0;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/projects") && (init?.method ?? "GET") === "GET") {
        getCallCount += 1;
        if (getCallCount === 1) {
          return new Response(
            JSON.stringify([{ id: "proj_other", name: "other", path: "/tmp/other-project", createdAt: "2026-01-01T00:00:00Z" }]),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify([
            { id: "proj_other", name: "other", path: "/tmp/other-project", createdAt: "2026-01-01T00:00:00Z" },
            { id: "proj_new", name: "new", path: "/tmp/my-project", createdAt: "2026-01-01T00:00:00Z" },
          ]),
          { status: 200 },
        );
      }
      if (url.endsWith("/projects") && init?.method === "POST") {
        return new Response(
          JSON.stringify({ id: "proj_new", name: "new", path: "/tmp/my-project", createdAt: "2026-01-01T00:00:00Z" }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    const result = await ensureProjectRegistered(BASE_URL, "/tmp/my-project");
    expect(result.projectId).toBe("proj_new");
  });

  test("a non-2xx response surfaces as PiWebClientError, not a swallowed failure", async () => {
    globalThis.fetch = (async (_input: string | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ error: "boom" }), { status: 500 })) as typeof fetch;
    await expect(ensureProjectRegistered(BASE_URL, "/tmp/x")).rejects.toThrow(PiWebClientError);
  });

  // ── M-095: verify-after-write retry against pi-web's confirmed lost-write race ──

  test("M-095: POST claims 2xx success but a fresh GET still doesn't show the path (lost write) -> retries and succeeds once a later GET does show it", async () => {
    let postCount = 0;
    let getCallCount = 0;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/projects") && (init?.method ?? "GET") === "GET") {
        getCallCount += 1;
        // GET #1: pre-check, empty. GET #2 (after 1st POST, verify): still
        // empty — the exact lost-write failure mode confirmed live (a 2xx
        // POST response whose write never actually persisted). GET #3
        // (after 2nd POST, verify): now shows the path — the retry's second
        // attempt won the race.
        if (getCallCount <= 2) return new Response(JSON.stringify([]), { status: 200 });
        return new Response(
          JSON.stringify([{ id: "proj_retry_2", name: "x", path: "/tmp/racy-project", createdAt: "2026-01-01T00:00:00Z" }]),
          { status: 200 },
        );
      }
      if (url.endsWith("/projects") && init?.method === "POST") {
        postCount += 1;
        // Every POST gets a 2xx with a valid-looking, unique id — exactly
        // what was observed live: the server claims success to EVERY
        // caller even though the underlying write is lossy.
        return new Response(
          JSON.stringify({ id: `proj_retry_${String(postCount)}`, name: "x", path: "/tmp/racy-project", createdAt: "2026-01-01T00:00:00Z" }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    const result = await ensureProjectRegistered(BASE_URL, "/tmp/racy-project");
    // Uses the id from the GET that actually verified the path exists —
    // NOT necessarily the first POST's own (possibly-lost) id.
    expect(result.projectId).toBe("proj_retry_2");
    expect(postCount).toBe(2);
  });

  test("M-095: a concurrent OTHER caller's write wins the SAME path under a DIFFERENT id -> verification accepts it, no infinite retry", async () => {
    let getCallCount = 0;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/projects") && (init?.method ?? "GET") === "GET") {
        getCallCount += 1;
        if (getCallCount === 1) return new Response(JSON.stringify([]), { status: 200 });
        // A DIFFERENT id than what this call's own POST will claim — a
        // concurrent other caller's write won for the same path. Still a
        // correctly-registered project for this path; using its id is
        // correct.
        return new Response(
          JSON.stringify([{ id: "proj_from_other_caller", name: "x", path: "/tmp/shared-path", createdAt: "2026-01-01T00:00:00Z" }]),
          { status: 200 },
        );
      }
      if (url.endsWith("/projects") && init?.method === "POST") {
        return new Response(
          JSON.stringify({ id: "proj_this_callers_own_id", name: "x", path: "/tmp/shared-path", createdAt: "2026-01-01T00:00:00Z" }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    const result = await ensureProjectRegistered(BASE_URL, "/tmp/shared-path");
    expect(result.projectId).toBe("proj_from_other_caller");
  });

  test("M-095: exhausting all retries throws ProjectRegistrationRaceError naming the path, not a generic/swallowed failure", async () => {
    let postCount = 0;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/projects") && (init?.method ?? "GET") === "GET") {
        // Never shows the path, no matter how many times it's checked —
        // every write for this path is lost, every attempt.
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.endsWith("/projects") && init?.method === "POST") {
        postCount += 1;
        return new Response(
          JSON.stringify({ id: `proj_lost_${String(postCount)}`, name: "x", path: "/tmp/always-lost", createdAt: "2026-01-01T00:00:00Z" }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    await expect(ensureProjectRegistered(BASE_URL, "/tmp/always-lost")).rejects.toThrow(ProjectRegistrationRaceError);
    await expect(ensureProjectRegistered(BASE_URL, "/tmp/always-lost")).rejects.toThrow(/always-lost/);
    // Exactly REGISTRATION_MAX_ATTEMPTS (3) POST attempts per call, not
    // unbounded retrying.
    expect(postCount).toBe(6); // two full ensureProjectRegistered calls above, 3 POSTs each
  });
});

// ── listProjects ─────────────────────────────────────────────────────────

describe("listProjects", () => {
  test("returns the parsed project array", async () => {
    globalThis.fetch = (async (_input: string | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify([{ id: "p1", name: "a", path: "/a", createdAt: "2026-01-01T00:00:00Z" }]),
        { status: 200 },
      )) as typeof fetch;
    const result = await listProjects(BASE_URL);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("p1");
  });
});

// ── deleteProject ────────────────────────────────────────────────────────

describe("deleteProject", () => {
  test("DELETEs /projects/:id and resolves — real deployed response shape is {closed:true}", async () => {
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe(`${BASE_URL}/projects/proj_1`);
      expect(init?.method).toBe("DELETE");
      return new Response(JSON.stringify({ closed: true }), { status: 200 });
    }) as typeof fetch;

    await expect(deleteProject(BASE_URL, "proj_1")).resolves.toBeUndefined();
  });

  test("a 404 (unknown project id) surfaces as PiWebClientError, not a swallowed failure", async () => {
    globalThis.fetch = (async (_input: string | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ error: "Project not found" }), { status: 404 })) as typeof fetch;

    await expect(deleteProject(BASE_URL, "unknown")).rejects.toThrow(PiWebClientError);
    await expect(deleteProject(BASE_URL, "unknown")).rejects.toThrow(/Project not found/);
  });

  test("URL-encodes the project id", async () => {
    globalThis.fetch = (async (input: string | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe(`${BASE_URL}/projects/proj%2Fwith%2Fslash`);
      return new Response(JSON.stringify({ closed: true }), { status: 200 });
    }) as typeof fetch;

    await deleteProject(BASE_URL, "proj/with/slash");
  });
});

// ── resolveWorkspaceId ───────────────────────────────────────────────────

describe("resolveWorkspaceId", () => {
  test("returns the workspace id whose path exactly matches", async () => {
    globalThis.fetch = (async (input: string | URL, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe(`${BASE_URL}/projects/proj_1/workspaces`);
      // Real pi-web response is an envelope object, not a bare array —
      // confirmed live 2026-08-13 (see resolveWorkspaceId's own comment).
      return new Response(
        JSON.stringify({
          status: "provider",
          projectId: "proj_1",
          ownerPluginId: "git",
          workspaces: [
            { id: "ws_main", projectId: "proj_1", path: "/tmp/proj", label: "master", isMain: true, isGitRepo: true, isGitWorktree: true },
            {
              id: "ws_run",
              projectId: "proj_1",
              path: "/tmp/proj/.pi-web-factory-worktrees/adw_abc123",
              label: "pi-web-factory/adw_abc123",
              isMain: false,
              isGitRepo: true,
              isGitWorktree: true,
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const id = await resolveWorkspaceId(BASE_URL, "proj_1", "/tmp/proj/.pi-web-factory-worktrees/adw_abc123");
    expect(id).toBe("ws_run");
  });

  test("returns undefined when no workspace matches the given path", async () => {
    globalThis.fetch = (async (_input: string | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          status: "provider",
          projectId: "proj_1",
          ownerPluginId: "git",
          workspaces: [
            { id: "ws_main", projectId: "proj_1", path: "/tmp/proj", label: "master", isMain: true, isGitRepo: true, isGitWorktree: true },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;

    const id = await resolveWorkspaceId(BASE_URL, "proj_1", "/tmp/proj/.pi-web-factory-worktrees/adw_nonexistent");
    expect(id).toBeUndefined();
  });
});
