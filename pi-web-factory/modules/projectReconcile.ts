/**
 * projectReconcile.ts: reconciliation pass for STALE pi-web project
 * registrations.
 *
 * ── The problem this closes ───────────────────────────────────────────────
 * `piwebProject.ts`'s `ensureProjectRegistered` matches/creates by exact
 * path string, and nothing ever prunes an entry once its underlying
 * directory stops existing (a project root that moved, e.g. a
 * `pi-web-perf-metrics` incident: registered at the old, now-gone
 * `/home/piweb/pi-web-perf-metrics`, re-registered correctly at
 * `/work/pi-web-perf-metrics`, but the OLD entry just sits in `GET
 * /projects` forever — real, permanent dead weight found live on the
 * deployed server, not speculative). This module scans every registered
 * project and flags/removes the ones whose path no longer looks like a real
 * project root.
 *
 * ── Two distinct staleness reasons ────────────────────────────────────────
 * A registered project is flagged stale for either of two reasons, checked
 * in this order:
 *   1. `missing-path` — the directory no longer exists at all (the
 *      project moved/was recreated elsewhere).
 *   2. `not-a-repo-root` — the directory exists but has no `.git` directly
 *      inside it (the `/work`-registered-as-a-project shape: `/work` itself
 *      is real, readable, and exists, but is the whole bind mount, not a
 *      single repo — mirrors `worktree.ts`'s `assertRealRepoRoot`, applied
 *      here to the registry side rather than the pre-flight-check side).
 * A project passing neither check is left completely untouched.
 *
 * ── Deletion IS supported, confirmed live (not assumed) ───────────────────
 * Confirmed directly against the live deployed server, 2026-08-18:
 * `DELETE /projects/:id` exists and
 * behaves as expected — `200` for a real, existing project id (response
 * body `{"closed":true}`), `404` with `{"error":"Project not found"}` for an
 * unknown one. `piwebProject.ts`'s `deleteProject` wraps this route. So this
 * pass is NOT report-only — `reconcileStaleProjects` below actually deletes
 * (unless `dryRun` is set), while still returning the full, itemized report
 * either way so a caller/log always shows exactly what was found and what
 * happened to it.
 *
 * ── Style: mirrors retryTrigger.ts's own reconciliation-pass shape ────────
 * Same split this codebase already established for its other
 * reconciliation pass (`retryTrigger.ts`): a pure "compute the plan" half
 * (`planStaleProjects`, network reads only, no writes) and a separate
 * "execute the plan" half (`reconcileStaleProjects`, does the actual
 * `DELETE` calls) — so the decision logic is testable against a mocked
 * `fetch` without needing to also verify delete side effects in the same
 * test, and a caller that only wants a dry-run report can call
 * `planStaleProjects` alone.
 *
 * ── CLI-only, deliberately NOT wired into orchestrator/server.ts's sweep ──
 * Found in review before this ever shipped: `orchestrator/server.ts` runs
 * inside the `pi-web-factory-orchestrator` container, which (per
 * `docker-compose.yml`) does NOT bind-mount the durable project workspace
 * (`/home/chris/turnstone-workspace:/work` — only the separate
 * `jmfederico-pi-web`/`pi-web` container has that mount). `existsSync`
 * checks below run against the CALLING process's own filesystem — from
 * inside the orchestrator container, `existsSync('/work/...')` would be
 * `false` UNCONDITIONALLY for every real, currently-registered, actively-in-
 * use project (every legitimate project lives under `/work`, per the
 * durable-mount guard), not as a rare race. That would flag and (with
 * deletion enabled) delete every real project the moment this ran there —
 * exactly the mass-deletion failure mode this module exists to prevent.
 * `bun cli.ts --reconcile-projects` (`cli.ts`) is therefore the ONLY
 * reconciliation entry point — it always runs via `docker exec pi-web bun
 * cli.ts ...`, i.e. inside the container that DOES have `/work` mounted
 * (same container every other `cli.ts` invocation already runs in — see
 * `retryTrigger.ts`'s own module header for the general container-topology
 * background). A future container-level change (e.g. a read-only `/work`
 * mount added to the orchestrator service) could revisit wiring a periodic
 * pass back in — not done here, since that needs its own infra change and
 * re-verification.
 *
 * ── No minimum-age/repeat-sweep threshold (accepted, single point-in-time check) ──
 * This pass makes its stale/not-stale call from ONE snapshot read (one
 * `GET /projects` plus one `existsSync` per entry), with no minimum-age or
 * repeat-observation requirement before something is eligible for deletion.
 * That is a real, accepted gap — flagged in review as worth hardening (e.g.
 * only delete an entry once it's been seen stale across more than one
 * sweep) — deliberately left as a fast-follow rather than built into this
 * card: this pass is CLI-only and dry-run-by-default (`cli.ts`'s own
 * `--delete` flag), invoked by a human on demand, not run unattended on a
 * timer — the two structural changes in this same review pass (CLI-only
 * wiring, dry-run default) already remove the specific "mid-restart mount
 * hiccup silently deletes something real, unattended" scenario this
 * threshold would guard against. Worth adding if/when this pass is ever
 * wired into any unattended/periodic caller again.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { deleteProject, listProjects, type PiWebProject } from "./piwebProject.ts";

export type StaleReason = "missing-path" | "not-a-repo-root";

export interface StaleProjectEntry {
  project: PiWebProject;
  reason: StaleReason;
}

export interface StaleProjectsPlan {
  /** Every registered project, in the order `GET /projects` returned them. */
  scanned: number;
  /** Projects flagged stale, each with why. */
  stale: StaleProjectEntry[];
}

/**
 * Pure decision function: given `baseUrl`, lists every registered project
 * and flags each one whose path no longer looks like a real, current
 * project root (see module doc for the two staleness reasons). Does no
 * writes — safe to call as a dry-run/report-only pass on its own, and is
 * exactly what `reconcileStaleProjects` calls before acting on the result.
 *
 * Filesystem checks (`existsSync`/`.git` presence) run against THIS
 * process's own local filesystem — correct in production, where this runs
 * co-located with pi-web inside the same container/mount pi-web itself sees
 * (same assumption `cli.ts`/`worktree.ts` already make throughout this
 * codebase; there is no remote-filesystem-check alternative available via
 * pi-web's own API).
 */
export async function planStaleProjects(baseUrl: string): Promise<StaleProjectsPlan> {
  const projects = await listProjects(baseUrl);
  const stale: StaleProjectEntry[] = [];

  for (const project of projects) {
    if (!existsSync(project.path)) {
      stale.push({ project, reason: "missing-path" });
      continue;
    }
    if (!existsSync(join(project.path, ".git"))) {
      stale.push({ project, reason: "not-a-repo-root" });
    }
  }

  return { scanned: projects.length, stale };
}

export interface StaleProjectOutcome extends StaleProjectEntry {
  /** `"deleted"` on a successful DELETE; `"failed"` with `detail` if the DELETE itself errored (never thrown — see reconcileStaleProjects doc). */
  outcome: "deleted" | "failed" | "reported-only";
  detail?: string;
}

export interface ReconcileStaleProjectsResult {
  scanned: number;
  stale: StaleProjectOutcome[];
}

/**
 * Runs `planStaleProjects`, then — unless `dryRun` is set — actually
 * `DELETE`s every flagged entry via `deleteProject` (confirmed-live route,
 * see module doc). `dryRun: true` (the default the CLI passes unless
 * `--delete` is given — see `cli.ts`) skips the delete calls entirely and
 * returns every stale entry tagged `"reported-only"` instead.
 *
 * A single project's DELETE failing (e.g. a transient network error, or a
 * race where it was already removed by a concurrent sweep) is caught and
 * recorded as `"failed"` in that entry's own outcome — never thrown, and
 * never allowed to abort the rest of the sweep for every OTHER stale
 * project, matching `retryTrigger.ts`'s own per-item error isolation.
 */
export async function reconcileStaleProjects(baseUrl: string, opts: { dryRun?: boolean } = {}): Promise<ReconcileStaleProjectsResult> {
  const plan = await planStaleProjects(baseUrl);
  const dryRun = opts.dryRun ?? false;

  const outcomes: StaleProjectOutcome[] = [];
  for (const entry of plan.stale) {
    if (dryRun) {
      outcomes.push({ ...entry, outcome: "reported-only" });
      continue;
    }
    try {
      await deleteProject(baseUrl, entry.project.id);
      outcomes.push({ ...entry, outcome: "deleted" });
    } catch (error) {
      outcomes.push({ ...entry, outcome: "failed", detail: error instanceof Error ? error.message : String(error) });
    }
  }

  return { scanned: plan.scanned, stale: outcomes };
}

/** One human-readable line per stale entry, for CLI/log output — e.g. `"deleted  pi-web-perf-metrics (/home/piweb/pi-web-perf-metrics) — missing-path"`. */
export function formatStaleProjectOutcome(entry: StaleProjectOutcome): string {
  const label = entry.outcome === "reported-only" ? "stale  " : entry.outcome === "deleted" ? "deleted" : "FAILED ";
  const detail = entry.outcome === "failed" && entry.detail ? ` — delete failed: ${entry.detail}` : "";
  return `${label}  ${entry.project.name} (${entry.project.path}) — ${entry.reason}${detail}`;
}
