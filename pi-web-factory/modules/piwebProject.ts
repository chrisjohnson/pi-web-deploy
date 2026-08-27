/**
 * piwebProject: registers a target project with pi-web's own `Project`
 * primitive, purely to obtain a real `projectId` and, from there, a real
 * `workspaceId` for a given filesystem path — M-071 card, Plan items 1+3.
 *
 * ── Why this exists (and why it's NOT config, again) ────────────────────
 * `pi-web-adw-design.md` §6.2 already ruled pi-web's Project concept out as
 * a place to store pi-web-factory's OWN config (`<project>/.pi-web-
 * factory.yaml`, M-070, is the real answer to that). This module exists for
 * a completely different reason: pi-web-factory needs *some* `projectId` to
 * build a working session deep-link
 * (`?project=<id>&workspace=<id>&session=<id>`, confirmed §6.2/§6.3 — a bare
 * `session` id does nothing, the client router short-circuits before
 * reading it if `project` is absent) and to resolve a `workspaceId` for a
 * freshly `git worktree add`-created path via the real route this module
 * also wraps, `GET /projects/:projectId/workspaces` (confirmed live against
 * the running server 2026-08-04 — see this file's `resolveWorkspaceId` doc
 * comment for the full trail; `pi-web-adw-design.md` §6.2's "trace it" note
 * is now resolved).
 *
 * ── Idempotency ──────────────────────────────────────────────────────────
 * `POST /projects` is idempotent server-side by path in the SEQUENTIAL
 * case (confirmed live: re-POSTing the same `path` returns the existing
 * project unchanged, not a duplicate — see `ProjectStore`/
 * `ProjectService.add` in pi-web's own source,
 * `src/server/projects/projectService.ts`) — but this module still does its
 * own `GET /projects` + find-by-path lookup FIRST, per the card's explicit
 * ask, rather than relying solely on that server-side behavior — cheaper
 * (no write) in the overwhelmingly common case of an already-registered
 * project, and keeps this module correct even if that server-side dedup
 * behavior is ever tightened/loosened upstream.
 *
 * ── M-095: `POST /projects`'s response is NOT durable under concurrency ──
 * Confirmed live, 2026-08-06, by deliberately reproducing the race: pi-web's
 * own `ProjectStore` write path is a non-atomic read-modify-write. Under
 * concurrent `POST /projects` calls, EVERY caller gets back a 2xx response
 * with a real, valid-looking, unique `Project` record — but the underlying
 * store silently loses all but a handful of them (a 6-way concurrent burst:
 * only 2/6 persisted; a 10-way burst: only 4/10). This is NOT fixable from
 * this repo — pi-web ships as a prebuilt image here
 * (`ghcr.io/jmfederico/pi-web:latest`), no source mounted. So the flat
 * claim above ("POST /projects is already idempotent") is only true
 * SEQUENTIALLY — under real concurrency (which IS a normal, expected shape
 * for this system: concurrent Workflow Runs against pi-web), a `POST`'s own
 * response cannot be trusted as durable on its own. `ensureProjectRegistered`
 * below verifies its own write actually persisted (a fresh `GET /projects`
 * shows an entry for this exact `path`) and retries a bounded number of
 * times before giving up loudly — see that function's own doc comment.
 */

import { PiWebClientError } from "./piwebClient.ts";

export interface PiWebProject {
  id: string;
  name: string;
  path: string;
  createdAt: string;
}

export interface PiWebWorkspace {
  id: string;
  projectId: string;
  path: string;
  label: string;
  branch?: string;
  isMain: boolean;
  isGitRepo: boolean;
  isGitWorktree: boolean;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown;
  try {
    body = text === "" ? undefined : JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    const detail =
      typeof body === "object" && body !== null && !Array.isArray(body) && typeof (body as Record<string, unknown>)["error"] === "string"
        ? ((body as Record<string, unknown>)["error"] as string)
        : text || res.statusText;
    throw new PiWebClientError(`pi-web request failed (${String(res.status)}): ${detail}`, res.status);
  }
  return body as T;
}

/** `GET /projects` — every project pi-web currently knows about. */
export async function listProjects(baseUrl: string): Promise<PiWebProject[]> {
  return requestJson<PiWebProject[]>(`${baseUrl}/projects`);
}

/**
 * `DELETE /projects/:id` — deregisters a project from pi-web (M-115, Plan
 * item 2: the stale-project-registration reconciliation pass below needs a
 * real deletion mechanism). Confirmed to exist and behave as expected
 * against the live deployed server, 2026-08-18 (not assumed/speculative —
 * this card's own Plan explicitly called for confirming this before building
 * a delete-capable pass rather than a report-only one): `DELETE
 * /projects/:id` for a real, existing project id returns `200`; for an
 * unknown id it returns `404` with `{"error":"Project not found"}`. This
 * does NOT touch anything on disk (the project's own directory, `.git`,
 * worktrees) — it only removes pi-web's own registration entry, exactly the
 * "dead weight in pi-web's own project list" this card describes, nothing
 * more.
 */
export async function deleteProject(baseUrl: string, projectId: string): Promise<void> {
  await requestJson<unknown>(`${baseUrl}/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" });
}

/**
 * Thrown when `ensureProjectRegistered` exhausts its verify-after-write
 * retries (M-095) — a dedicated error type, not a generic network/
 * PiWebClientError, so a caller (or a human reading a stack trace) can tell
 * "pi-web's own server-side write race ate this registration" apart from an
 * ordinary network/HTTP failure.
 */
export class ProjectRegistrationRaceError extends Error {
  constructor(path: string, attempts: number) {
    super(
      `project registration for ${path} appears to have been lost under concurrent load after ${String(attempts)} attempts — ` +
        `this is a known pi-web server-side race (see M-095: POST /projects returns a valid-looking 2xx response to every ` +
        `concurrent caller, but the underlying ProjectStore's non-atomic write silently drops all but a handful of them), ` +
        `not a client bug — retry the whole Workflow Run`,
    );
    this.name = "ProjectRegistrationRaceError";
  }
}

const REGISTRATION_MAX_ATTEMPTS = 3;
const REGISTRATION_RETRY_DELAYS_MS = [50, 150, 400];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Idempotent project registration by absolute path: `GET /projects`, return
 * the existing entry if one already has this exact `path`; otherwise
 * `POST /projects {path}` and return the newly-created entry.
 *
 * `path` must already be the project's real, absolute, on-disk path (the
 * MAIN worktree — the checkout `git worktree list` is run against, not any
 * one linked worktree) — this module does no path normalization of its own
 * beyond what pi-web's own `POST /projects` does server-side (`realpath`,
 * confirmed in `projectService.ts`).
 *
 * ── M-095: verify-after-write, with a short bounded retry ─────────────────
 * A `POST /projects` response cannot be trusted as durable on its own under
 * concurrent load (see this module's own header comment for the confirmed
 * live repro) — so after POSTing, this function re-`GET`s `/projects` and
 * confirms an entry for this exact `path` now actually exists before
 * returning. Deliberately checks by `path`, not by the `id` the POST
 * response claimed: a concurrent OTHER caller's write may have won and
 * registered the SAME path under a DIFFERENT id — that's still a correctly-
 * registered project for this path, and using ITS id is correct (using the
 * POST response's own possibly-lost id would just reintroduce the bug).
 * If verification fails, retries the whole POST+verify cycle up to
 * `REGISTRATION_MAX_ATTEMPTS` times with a short fixed backoff
 * (`REGISTRATION_RETRY_DELAYS_MS`) — the race window demonstrated live is a
 * single event-loop tick wide, not a slow contention pattern, so no need
 * for anything more elaborate. Exhausting retries throws
 * `ProjectRegistrationRaceError` rather than silently proceeding with an
 * unverified projectId — a Workflow Run must never hand `resolveWorkspaceId`
 * an id already known to be unreliable (that's exactly the failure mode
 * this card was filed from: a 404 much later, `piwebProject.ts:134`, once
 * `resolveWorkspaceId` tried to use a project that was never really there).
 */
export async function ensureProjectRegistered(baseUrl: string, path: string): Promise<{ projectId: string }> {
  const existing = await listProjects(baseUrl);
  const found = existing.find((p) => p.path === path);
  if (found) return { projectId: found.id };

  for (let attempt = 1; attempt <= REGISTRATION_MAX_ATTEMPTS; attempt += 1) {
    const created = await requestJson<PiWebProject>(`${baseUrl}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });

    // Verify-after-write: the POST's own response is not trustworthy alone
    // under concurrency (module header comment) — confirm a fresh GET
    // actually shows an entry for this path before trusting any id.
    const afterWrite = await listProjects(baseUrl);
    const verified = afterWrite.find((p) => p.path === path);
    if (verified) return { projectId: verified.id };

    if (attempt < REGISTRATION_MAX_ATTEMPTS) {
      await sleep(REGISTRATION_RETRY_DELAYS_MS[attempt - 1] ?? REGISTRATION_RETRY_DELAYS_MS[REGISTRATION_RETRY_DELAYS_MS.length - 1]!);
    }
  }

  throw new ProjectRegistrationRaceError(path, REGISTRATION_MAX_ATTEMPTS);
}

/**
 * `GET /projects/:projectId/workspaces` — the real route (confirmed live
 * 2026-08-04 against `http://192.168.1.21:8080/api`, cross-checked against
 * `@jmfederico/pi-web@v1.202607.3` source: registered in
 * `src/server/app.ts`'s `registerLocalProjectRoutes`, backed by
 * `WorkspaceService.list()` in `src/server/workspaces/workspaceService.ts`).
 * Pi-web's own workspace `id` is a deterministic
 * `sha1("<projectId>:<worktreePath>").slice(0,12)` (see that file), so it's
 * technically computable client-side without a network call — this module
 * deliberately does NOT do that: hand-deriving pi-web's own internal id
 * function would silently break the moment that implementation detail
 * changes upstream, for a call that's already cheap (one GET, and only
 * needed once per Workflow Run). Resolving it via the real route, as this
 * function does, is both correct AND future-proof against that.
 *
 * `WorkspaceService.list()` discovers workspaces by running
 * `git worktree list --porcelain` against the PROJECT's own registered path
 * (the main checkout), not the queried path — so a `git worktree add`-created
 * path only shows up here once it's a real, live worktree of that same repo
 * (confirmed live: a fresh `git worktree add` inside a project's checkout is
 * visible via this route immediately, no extra registration step).
 *
 * Returns `undefined` if no workspace with exactly this `path` is found
 * (e.g. called before the worktree was actually created, or the project's
 * main path is wrong) — callers should treat that as a real error, not
 * silently proceed without a workspace id (a deep-link missing `workspace`
 * is not "close enough," per §6.2/§6.3).
 */
export async function resolveWorkspaceId(
  baseUrl: string,
  projectId: string,
  worktreePath: string,
): Promise<string | undefined> {
  // pi-web's `/projects/:id/workspaces` route now wraps the array in an
  // envelope object (`{status, projectId, ownerPluginId, workspaces: [...]}`)
  // rather than returning a bare array — confirmed live 2026-08-13 against
  // the currently-installed pi-web version. Previously typed as returning
  // `PiWebWorkspace[]` directly, which broke with `.find is not a function`
  // once the API drifted to this shape.
  const response = await requestJson<{ workspaces: PiWebWorkspace[] }>(
    `${baseUrl}/projects/${encodeURIComponent(projectId)}/workspaces`,
  );
  return response.workspaces.find((w) => w.path === worktreePath)?.id;
}
