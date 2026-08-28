#!/usr/bin/env bun
/**
 * orchestrator/server.ts: read-only HTTP server for pi-web-factory's trace db
 * (pi-web-adw-design.md §7.4).
 *
 * Serves both the JSON read API (`/api/...`) AND the bundled frontend
 * (`orchestrator/src/index.html` + its imported `.ts`/`.css`, bundled on the
 * fly by `Bun.serve`'s HTML-import routes — no separate build step, no
 * Vite/Vue dependency added to this project's `package.json`) from ONE
 * `Bun.serve` process — one process to run.
 *
 * ── Read-only, always (for the read API) ────────────────────────────────
 * Opens `factory.db` with `{ readonly: true }` (bun:sqlite) for every route
 * below — this process NEVER writes to the trace db through the read API,
 * confirmed live (see this file's own companion test):
 * `bun:sqlite` throws "attempt to write a readonly database"
 * on any write attempt against a readonly-opened handle, which is exactly
 * the safety property wanted here (the read API must never be able to
 * corrupt or race the real writer, `Tracer`, used by `cli.ts`/live Workflow
 * Runs).
 *
 * ── One deliberate exception, its own separate handle ─────────────────────
 * The reconciliation pass (below, `reconcileStuckRuns`) is a genuine,
 * intentional writer: it marks orphaned `phases`/`sessions` rows `'fail'`
 * when a job runner died without ever getting to write its own terminal
 * status (see that section's own doc comment for the full mechanism and
 * why Fix 1 alone can't cover it). Flipping the ONE readonly handle above
 * to read-write would silently weaken the safety property every other route
 * in this file relies on, so this pass opens a SECOND, separate read-write
 * `Database` handle (`reconcileDb`), used ONLY inside the reconciliation
 * section — every `/api/...` route continues to use the original readonly
 * `db` handle, unchanged.
 *
 * ── `rowid` on `events` despite its TEXT primary key ───────────────────
 * `events.event_id` is declared `TEXT PRIMARY KEY` (schema.ts), which does
 * NOT alias SQLite's implicit `rowid` (only an `INTEGER PRIMARY KEY` column
 * does that) — but `events` is still an ordinary rowid table, so the
 * implicit `rowid` column is still queryable/orderable on it regardless.
 * Confirmed directly against `bun:sqlite` before relying on it here (ad hoc
 * spike, not assumed): `SELECT rowid, event_id FROM events ORDER BY rowid`
 * returns monotonically increasing rowids in insertion order, exactly the
 * cursor `GET .../events?since=<rowid>` needs.
 *
 * ── Port ────────────────────────────────────────────────────────────────
 * Defaults to 8090 (pi-web itself owns 8080 on this box) — overridable via
 * `PI_WEB_FACTORY_ORCHESTRATOR_PORT`.
 *
 * ── DB path ─────────────────────────────────────────────────────────────
 * Defaults to the same path `cli.ts` writes to (`<repo>/factory.db`, next to
 * `cli.ts` — see that file's own `DEFAULT_DB_PATH`) — overridable via
 * `PI_WEB_FACTORY_ORCHESTRATOR_DB_PATH` for tests/dev against a scratch db.
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { ensureSchemaCurrent } from "../modules/schema.ts";
import { WORKTREE_SUBDIR } from "../modules/worktree.ts";
import { DEFAULT_BASE_URL, DEFAULT_WAIT_FOR_COMPLETION_TIMEOUT_MS } from "../modules/piwebClient.ts";
import { loadRolesConfig } from "../modules/roles.ts";
import { Tracer } from "../modules/tracer.ts";
import { triggerRetryIfNeeded } from "../modules/retryTrigger.ts";
import { loadedWorkflows } from "../chains/registry.ts";
import index from "./src/index.html";

/**
 * Every Workflow Run gets its OWN git worktree, so `sessions.
 * project_cwd` is actually `<projectRoot>/.pi-web-factory-worktrees/<adwId>`
 * — a value that's UNIQUE per run, never shared across runs against the
 * same project. Confirmed live (2026-08-05): filtering by the raw, unique
 * `projectCwd` made the "project" filter useless — it only ever matched
 * the one run whose worktree path was typed in exactly. Strips the
 * worktree suffix back to the real, shared project root so multiple runs
 * against the same project group together correctly, both for the
 * dropdown's distinct-project list and for the actual filter query below.
 */
function projectRootOf(cwd: string): string {
  const marker = `/${WORKTREE_SUBDIR}/`;
  const idx = cwd.indexOf(marker);
  return idx === -1 ? cwd : cwd.slice(0, idx);
}

const DEFAULT_DB_PATH = join(import.meta.dir, "..", "factory.db");
const DB_PATH = process.env["PI_WEB_FACTORY_ORCHESTRATOR_DB_PATH"] ?? DEFAULT_DB_PATH;
const PORT = Number(process.env["PI_WEB_FACTORY_ORCHESTRATOR_PORT"] ?? 8090);

// Confirmed 2026-08-17: ALWAYS open a brief writable connection and
// run `ensureSchemaCurrent` (schema.ts's `SCHEMA` + `runMigrations`) —
// unconditionally, not gated behind "does factory.db exist yet." A
// previous version only did this inside an `if (!existsSync(DB_PATH))`
// bootstrap-a-brand-new-db block, which is a no-op against the real
// production db (it already exists) — so `runMigrations` never ran for
// this process at all, and every route reading a column added after this
// db file's creation (e.g. `phases.artifact_json`) 500'd in
// production as a direct, confirmed-live result (`SQLiteError: no such
// column: artifact_json`). `ensureSchemaCurrent`'s `SCHEMA` half is already
// idempotent (`CREATE TABLE IF NOT EXISTS`) and its `runMigrations` half
// checks `PRAGMA table_info` before ever running `ALTER TABLE` — so running
// this unconditionally on every startup, against an existing db, a
// brand-new db, or anything in between, is always safe and always correct.
// This remains the ONLY writable handle this process opens outside
// `reconcileDb` (below) — opened, used for schema/migration only, and
// closed BEFORE the readonly `db` handle opens the same file (a readonly
// handle can't ALTER TABLE, so schema/migrations must be fully applied
// first).
{
  const bootstrap = new Database(DB_PATH, { create: true });
  ensureSchemaCurrent(bootstrap);
  bootstrap.close();
}

// The server's actual db handle: readonly, always — this process must never
// be able to write to the trace db (see module doc comment above).
const db = new Database(DB_PATH, { readonly: true });
db.run("PRAGMA busy_timeout=5000;");

// ── Reconciliation pass ─────────────────────────────────────────────────────
//
// The write-path catch-all (workflow.ts's `runWorkflow` catch-all) only
// covers a job runner process that gets the chance to unwind its own stack
// (an uncaught JS exception). It does NOT cover SIGKILL, OOM-kill, a
// container recreate killing the `docker exec` process mid-run, or a host
// reboot — none of which give JS a chance to run a `catch` block at all.
// Those leave a `phases`/`sessions` row stuck at `status='running'` forever,
// with nothing in the codebase ever revisiting it otherwise (confirmed: zero
// prior reconciliation/staleness logic anywhere). This pass is the general
// fix for that whole class: it runs OUTSIDE the (possibly dead) job-runner
// process, from the one long-lived process in this system that already owns
// the read path (`server.ts`).
//
// ── Why a SECOND db handle, read-write, scoped to just this ──────────────
// This module's whole design opens `db` (above) `{ readonly: true }`
// specifically so the orchestrator can never write to the trace db (module
// header comment) — that's a real safety property (bun:sqlite throws on any
// write attempt against a readonly handle), and this pass must not weaken
// it for the rest of the file. Marking terminal statuses is a genuine,
// intentional write, so it gets its OWN separate read-write connection,
// opened and used ONLY inside this section — every other route/query in
// this file keeps using the readonly `db` handle above, unchanged. This
// keeps "the read API literally cannot write" true for the read API, while
// still letting the one deliberate writer (reconciliation) do its job.
const reconcileDb = new Database(DB_PATH);
reconcileDb.run("PRAGMA busy_timeout=5000;");

/**
 * Staleness threshold for "no active runner" (condition 2 below) — reused
 * directly from `piwebClient.ts`'s `PI_WEB_FACTORY_STEP_TIMEOUT_MS`
 * (`DEFAULT_WAIT_FOR_COMPLETION_TIMEOUT_MS`, the same wait-loop timeout)
 * rather than inventing a second env var/constant for what's conceptually
 * the same question — "how long is too long for a Step to still genuinely
 * be in flight."
 */
const RECONCILE_STALE_MS = DEFAULT_WAIT_FOR_COMPLETION_TIMEOUT_MS;

/** How often the periodic reconciliation sweep runs, beyond the mandatory startup pass. Chosen as a few minutes: frequent enough that a genuinely dead run doesn't sit visibly "running" for long after it's gone stale, infrequent enough that this read-write connection (and the `GET /api/sessions?cwd=` round trip to pi-web per distinct project, per sweep) is negligible background load on a box that may also be running real GPU work. Overridable for tests via PI_WEB_FACTORY_ORCHESTRATOR_RECONCILE_INTERVAL_MS. */
const DEFAULT_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
const RECONCILE_INTERVAL_MS = (() => {
  const raw = process.env["PI_WEB_FACTORY_ORCHESTRATOR_RECONCILE_INTERVAL_MS"];
  if (!raw) return DEFAULT_RECONCILE_INTERVAL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RECONCILE_INTERVAL_MS;
})();

/** Base URL for the pi-web instance whose live session list this pass cross-checks against — same env var / default `piwebClient.ts` itself uses, so this pass talks to the same pi-web the job runner does. */
const PIWEB_BASE_URL = process.env["PI_WEB_FACTORY_BASE_URL"] ?? DEFAULT_BASE_URL;

// ── Retry-decision trigger ──────────────────────────────────────────────────
//
// Opt-in via PI_WEB_FACTORY_ORCHESTRATOR_RETRY_TRIGGER=1 — deliberately OFF by
// default. `retryTrigger.ts`'s own module header has the full story: the
// actual next-attempt COMMAND is computed and logged, never executed (this
// container has no docker.sock / spawn transport to `pi-web`, confirmed
// directly, not assumed). Running this by default on every deploy would mean
// every reconciliation sweep silently starts making REAL, costing decision-
// Role model calls against every failed run in the db, with no operator
// having asked for that — opt-in avoids that surprise until a real spawn
// mechanism exists and this becomes genuinely actionable.
const RETRY_TRIGGER_ENABLED = process.env["PI_WEB_FACTORY_ORCHESTRATOR_RETRY_TRIGGER"] === "1";
const FACTORY_CONFIG_PATH = process.env["PI_WEB_FACTORY_CONFIG"] ?? join(import.meta.dir, "..", "factory.config.yaml");

// ── Stale project-registration reconciliation is CLI-only, NOT wired ───────
// ── into this process's periodic sweep ──────────────────────────────────────
//
// Deliberately NOT run from here, even opt-in — this container
// (`pi-web-factory-orchestrator`, `docker-compose.yml`) only bind-mounts
// `~/.pi-web:/home/piweb/.pi-web`; it does NOT mount the durable project
// workspace (`/home/chris/turnstone-workspace:/work`, only present on the
// separate `jmfederico-pi-web`/`pi-web` container). `projectReconcile.ts`'s
// staleness check (`existsSync(project.path)`) runs against the CALLING
// process's own filesystem — from inside THIS container, every real,
// actively-in-use project registered under `/work/...` (which is every
// legitimate project, per the durable-mount guard) would resolve
// `existsSync('/work/...')` as `false` unconditionally, always, not as a rare
// race — flagging every real project stale and (with both opt-ins set)
// deleting it. That would reproduce exactly the "self-inflicted mass
// deletion" failure this whole mechanism exists to prevent, at the
// infrastructure level — found in review before this ever shipped enabled.
// `bun cli.ts --reconcile-projects` (cli.ts) is the only reconciliation
// entry point: it's always invoked via `docker exec pi-web bun cli.ts ...`
// (every other call site in this codebase — `retryTrigger.ts`'s own module
// header, `planBuildTest.integration.test.ts`, etc. — confirms this), i.e.
// inside the `jmfederico-pi-web` container, which DOES have `/work` mounted
// and can therefore make a real, non-vacuous existsSync check. A future
// change giving this container its own read-only `/work` mount could
// revisit wiring a periodic pass back in here — not done now, since it
// would need its own infra change and re-verification.

interface StaleCandidateRow {
  phase_id: string;
  adw_id: string;
  status: string;
  started_at: string | null;
  project_cwd: string | null;
  session_status: string | null;
  latest_event_at: string | null;
}

/**
 * `GET /sessions?cwd=<cwd>` against pi-web directly — the same manual check
 * used for live investigation (`curl
 * 'http://localhost:8080/api/sessions?cwd=<project>'`). No typed helper for
 * this exists yet in `piwebClient.ts` (every existing helper there operates
 * on an already-known session id, not a cwd-based lookup) — kept narrow and
 * local here rather than growing that module's surface for a single caller.
 * Returns `true` when pi-web reports at least one live session for `cwd`.
 * Network/parse failures are treated as "cannot confirm dead" (returns
 * `true`, i.e. does NOT mark failed on this signal alone) — a transient
 * pi-web hiccup must never itself be read as "no session," since that's one
 * of this pass's two independently-DEFINITIVE signals (module comment
 * below); condition 2 (staleness) still applies independently regardless of
 * whether this check succeeds.
 */
async function hasLiveSession(cwd: string): Promise<boolean> {
  try {
    const res = await fetch(`${PIWEB_BASE_URL}/sessions?cwd=${encodeURIComponent(cwd)}`);
    if (!res.ok) return true;
    const body = (await res.json()) as unknown;
    return Array.isArray(body) && body.length > 0;
  } catch {
    return true;
  }
}

/**
 * One reconciliation sweep: scans `phases` rows still `status='running'`
 * and marks the ones that meet either of two INDEPENDENT, individually-
 * definitive conditions as `'fail'` — a logical OR, not an AND (Chris
 * corrected an earlier AND-based draft to this OR-based version, 2026-08-07):
 *
 *   1. **No active session**: pi-web's own `GET /sessions?cwd=<project>`
 *      returns no live session for the row's project. Definitive on its
 *      own — the underlying agent conversation is provably gone — so this
 *      marks the row failed regardless of how fresh its timestamp looks.
 *   2. **No active runner (staleness proxy)**: the row's `started_at` (or
 *      its most recent associated `events` row, whichever is later) is
 *      older than `RECONCILE_STALE_MS`. Also definitive on its own, even if
 *      pi-web's session API still shows something live for that project —
 *      a live pi-web session does NOT prove the job-runner process driving
 *      it is still alive; the runner could have died while the session it
 *      opened sits idle indefinitely. Staleness is the only signal for "no
 *      job runner is present" available today: there's no first-class
 *      job-runner heartbeat/registration to check more directly anywhere in
 *      this codebase. A real heartbeat mechanism would be a strictly
 *      cleaner signal than this staleness proxy — flagged here as a
 *      natural follow-on, deliberately out of scope for this pass.
 *
 * Rows that are neither stale NOR session-dead are left completely
 * untouched — no false positives on real in-progress work.
 */
async function reconcileStuckRuns(): Promise<{ scanned: number; markedFailed: number }> {
  const staleCutoffIso = new Date(Date.now() - RECONCILE_STALE_MS).toISOString();

  const rows = reconcileDb
    .query<StaleCandidateRow, []>(
      `SELECT p.phase_id, p.adw_id, p.status, p.started_at, s.project_cwd,
              s.status AS session_status,
              (SELECT MAX(e.started_at) FROM events e WHERE e.adw_id = p.adw_id) AS latest_event_at
       FROM phases p
       LEFT JOIN sessions s ON s.adw_id = p.adw_id
       WHERE p.status = 'running'`,
    )
    .all();

  let markedFailed = 0;

  for (const row of rows) {
    // "Most recent of started_at / latest associated event" — schema.ts's
    // `events.started_at` is the only other queryable timestamp for a
    // phase's own activity (phases.ended_at is NULL by construction while
    // status='running').
    const candidates = [row.started_at, row.latest_event_at].filter((v): v is string => v !== null);
    const lastActivityIso = candidates.length > 0 ? candidates.sort().at(-1)! : null;
    const isStale = lastActivityIso === null ? true : lastActivityIso < staleCutoffIso;

    // Condition 2 checked first — purely local (no network round trip),
    // cheap short-circuit before condition 1's pi-web call.
    let reason: string | undefined;
    if (isStale) {
      reason = "reconciled: stale, no runner activity within timeout";
    } else if (row.project_cwd !== null && !(await hasLiveSession(row.project_cwd))) {
      reason = "reconciled: no live pi-web session found";
    }

    if (!reason) continue; // neither condition met — genuinely still running, leave untouched

    const nowIso = new Date().toISOString();
    reconcileDb.run(
      `UPDATE phases SET status='fail', error=?, ended_at=? WHERE phase_id=?`,
      [reason, nowIso, row.phase_id],
    );
    // Mirror tracer.ts's own sessionFinish(adwId, false) normalization
    // (status='fail', ended_at=now) — only for a session whose own status
    // is ALSO still 'running' (a session can have other, still-genuinely-
    // live Steps; this pass must not force-fail a session out from under
    // work that's actually fine).
    if (row.session_status === "running") {
      reconcileDb.run(`UPDATE sessions SET status='fail', ended_at=? WHERE adw_id=?`, [nowIso, row.adw_id]);
    }
    markedFailed += 1;
  }

  return { scanned: rows.length, markedFailed };
}

/**
 * After each reconciliation sweep, check every currently-
 * undecided `status='fail'` run for a retry decision. Runs on the SAME
 * `reconcileDb` read-write handle reconciliation already uses (both are the
 * one deliberate writer this process has — module header comment on
 * `reconcileDb` above) and its own fresh `Tracer` instance (needed for
 * `traceRetryDecision`'s event-write helper — `reconcileDb`'s raw SQL calls
 * above don't go through `Tracer` at all, but `retryTrigger.ts`'s functions
 * are shared with `cli.ts`'s own call sites, which DO use `Tracer`, so this
 * is the natural shared shape rather than a second event-write path).
 * `loadedWorkflows()`/`loadRolesConfig()` are cheap, already-loaded/cached
 * lookups (`chains/registry.ts` loads its YAML once at module-load time;
 * `loadRolesConfig` re-reads the config file — negligible cost on a
 * multi-minute sweep cadence, matches `cli.ts`'s own per-invocation load).
 */
async function runRetryTriggerPass(): Promise<void> {
  if (!RETRY_TRIGGER_ENABLED) return;
  try {
    const config = loadRolesConfig(FACTORY_CONFIG_PATH);
    const workflows = loadedWorkflows();
    const tracer = new Tracer(DB_PATH);
    try {
      const { decided, skipped } = await triggerRetryIfNeeded({
        db: reconcileDb,
        tracer,
        config,
        workflows,
        baseUrl: PIWEB_BASE_URL,
        log: (message) => console.log(`[orchestrator] ${message}`),
      });
      if (decided > 0 || skipped > 0) {
        console.log(`[orchestrator] retry-trigger: decided ${String(decided)}, skipped ${String(skipped)}`);
      }
    } finally {
      tracer.close();
    }
  } catch (error) {
    console.error("[orchestrator] retry-trigger pass failed:", error);
  }
}

async function runReconciliationSweep(label: string): Promise<void> {
  try {
    const { scanned, markedFailed } = await reconcileStuckRuns();
    if (markedFailed > 0) {
      console.log(`[orchestrator] reconciliation (${label}): scanned ${String(scanned)} running Step(s), marked ${String(markedFailed)} failed`);
    }
  } catch (error) {
    console.error(`[orchestrator] reconciliation (${label}) failed:`, error);
  }
  // Retry-trigger check runs AFTER reconciliation, in the same sweep —
  // a run reconciliation just marked failed is immediately eligible, no need
  // to wait for the next cadence.
  await runRetryTriggerPass();
  // Stale-project-registration reconciliation deliberately does NOT
  // run from here — see this file's own "stale project-registration
  // reconciliation is CLI-only" comment above (this container has no /work
  // mount, so a filesystem-existence check from here would be permanently
  // wrong, not just racy). `bun cli.ts --reconcile-projects` is the only
  // entry point.
}

// Runs once on startup, IN ADDITION TO periodic —
// fire-and-forget (top-level await would block the
// server from listening; this pass is allowed to finish after routes are
// already serving).
void runReconciliationSweep("startup");
// ...and periodically thereafter, every RECONCILE_INTERVAL_MS.
setInterval(() => {
  void runReconciliationSweep("periodic");
}, RECONCILE_INTERVAL_MS);

// ── row shapes (raw SQL column names — mapped to camelCase in the API) ────

interface SessionRow {
  adw_id: string;
  adw_name: string | null;
  project_cwd: string | null;
  title: string | null;
  request: string | null;
  status: string | null;
  engineer: string | null;
  started_at: string | null;
  ended_at: string | null;
  total_tokens: number;
  total_cost: number;
  archived: number;
  ticket_id: string | null;
}

/** One `tickets` row — the grid/detail ticket-level grouping anchor. */
interface TicketRow {
  ticket_id: string;
  file_path: string | null;
  created_at: string | null;
  title: string | null;
  latest_run_adw_id: string | null;
}

const SESSION_COLUMNS =
  `adw_id, adw_name, project_cwd, title, request, status, engineer,
   started_at, ended_at, total_tokens, total_cost, archived, ticket_id`;

interface PhaseRow {
  phase_id: string;
  adw_id: string;
  seq: number;
  name: string | null;
  kind: string | null;
  owner: string | null;
  description: string | null;
  status: string | null;
  attempt: number;
  retries: number;
  error: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  output_summary: string | null;
  artifact_json: string | null;
  started_at: string | null;
  ended_at: string | null;
}

/**
 * A completed Step's real output (branch/commit/PR) — see
 * schema.ts's own module header for the full "why". Parsed defensively
 * (`safeParseJson`, already used elsewhere in this file for event payloads)
 * since `artifact_json` is a plain TEXT column with no DB-level schema
 * enforcement; `null` for a Step that never reached success (nothing was
 * ever captured) or on any parse failure.
 */
interface StepArtifactApi {
  branch: string | null;
  commitSha: string | null;
  prUrl: string | null;
}

function stepArtifactToApi(json: string | null): StepArtifactApi | null {
  if (!json) return null;
  const parsed = safeParseJson(json);
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  return {
    branch: typeof obj["branch"] === "string" ? obj["branch"] : null,
    commitSha: typeof obj["commitSha"] === "string" ? obj["commitSha"] : null,
    prUrl: typeof obj["prUrl"] === "string" ? obj["prUrl"] : null,
  };
}

interface EventRow {
  rowid: number;
  event_id: string;
  adw_id: string;
  phase_id: string | null;
  parent_id: string | null;
  type: string | null;
  name: string | null;
  payload_json: string | null;
  tokens: number | null;
  started_at: string | null;
  ended_at: string | null;
}

/**
 * `steps` defaults to `[]` here — `runsToApi` (below, the ONLY real caller
 * for the list route) always overwrites it with the real, batched-fetched
 * Steps for that run. Kept as a real field (not optional) on the return
 * type so the frontend's `RunSummary` type can rely on it always being
 * present, matching the spec's "every card shows its mini-Gantt, not just
 * running ones" requirement (found missing in review) —
 * a card can't render anything without knowing its Steps up front, and a
 * dedicated per-card fetch for every non-running card would mean N extra
 * round trips just to paint the initial page, which is exactly the kind of
 * thing the "batch data streaming efficiently" performance requirement
 * rules out.
 */
function runToApi(r: SessionRow, steps: ReturnType<typeof stepToApi>[] = []) {
  return {
    adwId: r.adw_id,
    adwName: r.adw_name,
    projectCwd: r.project_cwd,
    /** The shared, worktree-suffix-stripped project root — what the `?project=` filter actually groups/matches on (see `projectRootOf` above). `projectCwd` itself is unique per run, never shared. */
    projectRoot: r.project_cwd === null ? null : projectRootOf(r.project_cwd),
    title: r.title,
    request: r.request,
    status: r.status,
    engineer: r.engineer,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    totalTokens: r.total_tokens,
    totalCost: r.total_cost,
    archived: Boolean(r.archived),
    /** The ticket this run belongs to — every run has exactly one, always (see modules/ticket.ts). */
    ticketId: r.ticket_id,
    steps,
  };
}

/**
 * Batches every returned run's Steps into ONE extra query (`WHERE adw_id IN
 * (...)`) rather than one query per run — the grid needs every card's Steps
 * up front (to render a mini-Gantt for ALL cards, not just running ones),
 * so this is the difference between 1 extra round trip and N. Groups by
 * `adw_id` in JS afterward (SQLite's `IN` doesn't preserve per-key
 * grouping on its own).
 */
function runsToApi(rows: SessionRow[]): ReturnType<typeof runToApi>[] {
  if (rows.length === 0) return [];
  const placeholders = rows.map(() => "?").join(",");
  const adwIds = rows.map((r) => r.adw_id);
  const allSteps = db
    .query<PhaseRow, string[]>(
      `SELECT phase_id, adw_id, seq, name, kind, owner, description, status,
              attempt, retries, error, input_tokens, output_tokens, cached_tokens,
              output_summary, artifact_json, started_at, ended_at
       FROM phases WHERE adw_id IN (${placeholders}) ORDER BY adw_id, seq`,
    )
    .all(...adwIds);
  const stepsByAdwId = new Map<string, ReturnType<typeof stepToApi>[]>();
  for (const row of allSteps) {
    const mapped = stepToApi(row);
    const bucket = stepsByAdwId.get(row.adw_id);
    if (bucket) bucket.push(mapped);
    else stepsByAdwId.set(row.adw_id, [mapped]);
  }
  return rows.map((r) => runToApi(r, stepsByAdwId.get(r.adw_id) ?? []));
}

function stepToApi(r: PhaseRow) {
  return {
    phaseId: r.phase_id,
    adwId: r.adw_id,
    seq: r.seq,
    name: r.name,
    kind: r.kind,
    role: r.owner,
    description: r.description,
    status: r.status,
    attempt: r.attempt,
    retries: r.retries,
    error: r.error,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cachedTokens: r.cached_tokens,
    outputSummary: r.output_summary,
    /** This Step's real output (branch/commit/PR) — null until the Step reaches success, per workflow.ts's runAgentStep. Survives a LATER Step's failure (the whole point of this field — see schema.ts's module header). */
    artifact: stepArtifactToApi(r.artifact_json),
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

/**
 * One ticket, ready for the grid — its own fields plus its LATEST
 * run's full summary (reusing `runToApi`'s shape unchanged, steps and all,
 * so the grid's ticket-level card can render the exact same mini-Gantt/
 * status-pill markup it already does for a bare run — see
 * `orchestrator/src/listView.ts`'s ticket-card rendering) and `runCount` (so
 * the grid knows whether to show the arrow-paging affordance at all — no
 * point rendering arrows for a ticket with exactly one attempt).
 */
function ticketToApi(t: TicketRow, latestRun: ReturnType<typeof runToApi> | null, runCount: number) {
  return {
    ticketId: t.ticket_id,
    filePath: t.file_path,
    createdAt: t.created_at,
    title: t.title,
    latestRun,
    runCount,
  };
}

/**
 * Batches every ticket's latest run (by `tickets.latest_run_adw_id`, the
 * denormalized fast-path column — `modules/ticket.ts`'s `setTicketLatestRun`)
 * plus a per-ticket run count, in TWO extra queries total (not one per
 * ticket) — same batching discipline `runsToApi` already established for a
 * run's Steps.
 */
function ticketsToApi(tickets: TicketRow[]): ReturnType<typeof ticketToApi>[] {
  if (tickets.length === 0) return [];
  const latestAdwIds = tickets.map((t) => t.latest_run_adw_id).filter((id): id is string => id !== null);
  const latestRunsByAdwId = new Map<string, SessionRow>();
  if (latestAdwIds.length > 0) {
    const placeholders = latestAdwIds.map(() => "?").join(",");
    const rows = db.query<SessionRow, string[]>(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE adw_id IN (${placeholders})`).all(...latestAdwIds);
    for (const row of rows) latestRunsByAdwId.set(row.adw_id, row);
  }
  const latestRunApiByAdwId = runsToApi([...latestRunsByAdwId.values()]);
  const latestRunApiIndex = new Map(latestRunApiByAdwId.map((r) => [r.adwId, r]));

  const ticketIds = tickets.map((t) => t.ticket_id);
  const placeholders = ticketIds.map(() => "?").join(",");
  const countRows = db
    .query<{ ticket_id: string; n: number }, string[]>(
      `SELECT ticket_id, COUNT(*) as n FROM sessions WHERE ticket_id IN (${placeholders}) GROUP BY ticket_id`,
    )
    .all(...ticketIds);
  const countByTicketId = new Map(countRows.map((r) => [r.ticket_id, r.n]));

  return tickets.map((t) => {
    const latestRun = t.latest_run_adw_id ? (latestRunApiIndex.get(t.latest_run_adw_id) ?? null) : null;
    return ticketToApi(t, latestRun, countByTicketId.get(t.ticket_id) ?? 0);
  });
}

function eventToApi(r: EventRow) {
  return {
    rowid: r.rowid,
    eventId: r.event_id,
    adwId: r.adw_id,
    phaseId: r.phase_id || null,
    parentId: r.parent_id || null,
    type: r.type,
    name: r.name,
    payload: safeParseJson(r.payload_json),
    tokens: r.tokens,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

function safeParseJson(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

/**
 * `title`/`summary` are authored ONCE in a Workflow's YAML
 * definition (`modules/workflowDef.ts`), never per-run — so they're NOT
 * trace-db columns (a `phases` row is per-RUN data). Instead, this endpoint
 * exposes every loaded Workflow's own step metadata (name/title/summary),
 * flattened (a loop's inner steps included at the top level — step names are
 * already required to be unique across a WHOLE workflow, including inside
 * loops, per `workflowDef.ts`'s own load-time validation, so this is a safe,
 * unambiguous flattening). The frontend (`detailView.ts`) resolves a given
 * Step's title/summary by `(run.adwName, step.name)` — `sessions.adw_name`
 * already records exactly which Workflow a run used (`workflow.ts`'s
 * `sessionStart` call), so this pairing is all that's needed, no new
 * trace-db column/migration required.
 */
interface WorkflowStepMeta {
  name: string;
  kind: string;
  title: string | null;
  summary: string | null;
}
interface WorkflowMeta {
  name: string;
  steps: WorkflowStepMeta[];
}

function flattenWorkflowSteps(steps: ReturnType<typeof loadedWorkflows>[number]["steps"]): WorkflowStepMeta[] {
  const out: WorkflowStepMeta[] = [];
  for (const step of steps) {
    out.push({ name: step.name, kind: step.kind, title: step.title ?? null, summary: step.summary ?? null });
    if (step.kind === "loop") out.push(...flattenWorkflowSteps(step.steps));
  }
  return out;
}

function workflowsToApi(): WorkflowMeta[] {
  return loadedWorkflows().map((w) => ({ name: w.name, steps: flattenWorkflowSteps(w.steps) }));
}

const server = Bun.serve({
  port: PORT,
  routes: {
    // ── static frontend (bundled by Bun.serve from the HTML import) ──────
    "/": index,

    // ── GET /api/runs?project=<root> — list, most recent first, optionally
    // filtered to runs whose NORMALIZED project root (projectRootOf, above —
    // strips the per-run worktree suffix) matches `project` ────────────────
    //
    // Filtered in JS, not SQL: `project_cwd` is a unique-per-run worktree
    // path, not a plain column value shared across a project's runs, so
    // there's no clean single-column SQL WHERE for "same project" — fetch
    // every row (already the unfiltered-case behavior, and this table is a
    // local trace db, not something needing a real query planner for this)
    // and filter by the normalized root computed per row.
    //
    // No dedicated `/api/projects` endpoint: `/api/runs` is already a single
    // unpaginated query over the whole `sessions` table (no pagination exists
    // anywhere in this API), so the frontend already has the full set of
    // `projectCwd` values in hand after its first unfiltered fetch — deriving
    // the distinct (normalized) project list client-side (see `listView.ts`)
    // is a plain `Set` over data already on the wire, not an extra round
    // trip's worth of DISTINCT query. A dedicated endpoint would only pay
    // for itself once this table is large enough to need pagination/limits
    // on `/api/runs` itself, which it isn't.
    "/api/runs": {
      GET(req) {
        const url = new URL(req.url);
        const project = url.searchParams.get("project");
        const allRows = db
          .query<SessionRow, []>(
            `SELECT ${SESSION_COLUMNS}
             FROM sessions
             ORDER BY started_at DESC, adw_id DESC`,
          )
          .all();
        const rows = project ? allRows.filter((r) => r.project_cwd !== null && projectRootOf(r.project_cwd) === project) : allRows;
        return json(runsToApi(rows));
      },
    },

    // ── GET /api/runs/:adwId — one run + its Steps ────────────────────────
    "/api/runs/:adwId": {
      GET(req) {
        const adwId = req.params.adwId;
        const run = db
          .query<SessionRow, [string]>(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE adw_id = ?`)
          .get(adwId);
        if (!run) return json({ error: `no such Workflow Run: ${adwId}` }, { status: 404 });

        const steps = db
          .query<PhaseRow, [string]>(
            `SELECT phase_id, adw_id, seq, name, kind, owner, description, status,
                    attempt, retries, error, input_tokens, output_tokens, cached_tokens,
                    output_summary, artifact_json, started_at, ended_at
             FROM phases WHERE adw_id = ? ORDER BY seq`,
          )
          .all(adwId);

        return json({ run: runToApi(run), steps: steps.map(stepToApi) });
      },
    },

    // ── GET /api/tickets — ticket-level grid data ───────────────────────────
    //
    // One row per ticket, each carrying its LATEST run's full summary
    // (`ticketsToApi`, above) — the grid's cards are ticket-level now (card
    // header/doc comment plan). Ordered by the latest linked run's
    // `started_at` (most recently active ticket first), falling back to the
    // ticket's own `created_at` for a ticket with no runs at all (shouldn't
    // happen in practice — `mintOrAttachTicket` always creates a ticket
    // alongside its first run — but a raw INSERT into `tickets` with no
    // session yet is not actively prevented at the SQL level, so this stays
    // defensive rather than assuming it can't occur).
    "/api/tickets": {
      GET(req) {
        const url = new URL(req.url);
        const project = url.searchParams.get("project");

        const allTickets = db
          .query<TicketRow, []>(
            `SELECT t.ticket_id, t.file_path, t.created_at, t.title, t.latest_run_adw_id
             FROM tickets t
             LEFT JOIN sessions s ON s.adw_id = t.latest_run_adw_id
             ORDER BY COALESCE(s.started_at, t.created_at) DESC, t.ticket_id DESC`,
          )
          .all();

        const apiTickets = ticketsToApi(allTickets);
        const rows = project ? apiTickets.filter((t) => t.latestRun !== null && t.latestRun.projectRoot === project) : apiTickets;
        return json(rows);
      },
    },

    // ── GET /api/tickets/:ticketId — one ticket + its FULL attempt history
    // (every linked run's summary, most recent first — the arrow-paging
    // affordance's data source, `orchestrator/src/listView.ts`/`detailView.ts`)
    "/api/tickets/:ticketId": {
      GET(req) {
        const ticketId = req.params.ticketId;
        const ticket = db
          .query<TicketRow, [string]>(
            "SELECT ticket_id, file_path, created_at, title, latest_run_adw_id FROM tickets WHERE ticket_id = ?",
          )
          .get(ticketId);
        if (!ticket) return json({ error: `no such ticket: ${ticketId}` }, { status: 404 });

        const runRows = db
          .query<SessionRow, [string]>(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE ticket_id = ? ORDER BY started_at DESC, adw_id DESC`)
          .all(ticketId);
        const runs = runsToApi(runRows);

        return json({
          ticketId: ticket.ticket_id,
          filePath: ticket.file_path,
          createdAt: ticket.created_at,
          title: ticket.title,
          runs,
        });
      },
    },

    // ── GET /api/workflows — every loaded Workflow's step title/summary
    // metadata, for the detail page to resolve a Step's
    // human-friendly title/summary by (run.adwName, step.name) — see
    // `workflowsToApi`'s own doc comment above for the full reasoning.
    "/api/workflows": {
      GET() {
        return json(workflowsToApi());
      },
    },

    // ── GET /api/runs/:adwId/events?since=<rowid> — cursor-poll ───────────
    "/api/runs/:adwId/events": {
      GET(req) {
        const adwId = req.params.adwId;
        const url = new URL(req.url);
        const sinceParam = url.searchParams.get("since");
        const since = sinceParam ? Number(sinceParam) : 0;
        const sinceValid = Number.isFinite(since) ? since : 0;

        const rows = db
          .query<EventRow, [string, number]>(
            `SELECT rowid, event_id, adw_id, phase_id, parent_id, type, name,
                    payload_json, tokens, started_at, ended_at
             FROM events WHERE adw_id = ? AND rowid > ? ORDER BY rowid`,
          )
          .all(adwId, sinceValid);

        return json(rows.map(eventToApi));
      },
    },
  },

  // Fallback for anything not matched above (shouldn't normally hit —
  // Bun.serve's HTML-import route already handles client-side asset paths
  // referenced from index.html).
  fetch() {
    return new Response("not found", { status: 404 });
  },

  error(error) {
    console.error("[orchestrator] request error:", error);
    return json({ error: "internal error" }, { status: 500 });
  },
});

console.log(`pi-web-factory orchestrator listening on ${server.url.href}`);
console.log(`  reading (readonly) trace db: ${DB_PATH}`);
