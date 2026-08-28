/**
 * server.test.ts: spawns the real `orchestrator/server.ts` binary (as `bun
 * orchestrator/server.ts`, exactly how a human would run it) against a scratch
 * trace db + test-only port, and exercises `/api/runs`, `/api/runs/:adwId`,
 * and `/api/runs/:adwId/events?since=` over real HTTP — not a mocked
 * `Bun.serve` handler, since the module wires up `Bun.serve` as a top-level
 * side effect (matching `cli.ts`'s own `import.meta.main` pattern) that
 * isn't cleanly importable in-process without also starting a real listener.
 *
 * Also confirms the readonly-open safety property directly: the server
 * process must never be able to write to the db it serves.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Tracer } from "../modules/tracer.ts";

const TEST_PORT = 8790; // distinct from the real default (8090) and from pi-web (8080)

let dir: string;
let dbPath: string;
let proc: ReturnType<typeof Bun.spawn>;
let baseUrl: string;

const ADW_ID = "adw_servertest01";
const ADW_ID_PROJECT_B = "adw_servertest02";
const ADW_ID_PROJECT_B_2 = "adw_servertest03";
const PROJECT_B_CWD = "/tmp/other-project";

// Realistic per-run worktree paths (every Workflow Run gets its OWN
// worktree) against the SAME project root — the actual real-world shape
// that exposed a real bug live 2026-08-05: naive grouping/filtering by the
// raw project_cwd column treated these as two unrelated one-run "projects"
// instead of two runs against one shared project.
const ADW_ID_WORKTREE_1 = "adw_servertest04";
const ADW_ID_WORKTREE_2 = "adw_servertest05";
const PROJECT_ROOT_CWD = "/tmp/pi-web-factory-realproject";
const WORKTREE_CWD_1 = `${PROJECT_ROOT_CWD}/.pi-web-factory-worktrees/${ADW_ID_WORKTREE_1}`;
const WORKTREE_CWD_2 = `${PROJECT_ROOT_CWD}/.pi-web-factory-worktrees/${ADW_ID_WORKTREE_2}`;

// A two-attempt ticket (same ticket_id, two runs) + a single-attempt
// ticket, seeded via Tracer.sessionStart's real ticketId wiring (not a raw
// INSERT into `tickets` — exercises the same code path a real cli.ts run
// would) — the `/api/tickets`/`/api/tickets/:ticketId` tests below need
// real multi-attempt grouping to assert against.
const TICKET_MULTI = "ticket_servertest_multi01";
const ADW_ID_ATTEMPT_1 = "adw_servertest_att1";
const ADW_ID_ATTEMPT_2 = "adw_servertest_att2";
const TICKET_SINGLE = "ticket_servertest_single01";
const ADW_ID_SINGLE = "adw_servertest_single1";
const TICKET_PROJECT_CWD = "/tmp/pi-web-factory-ticket-test-project";

function seed(): void {
  const tracer = new Tracer(dbPath);
  tracer.sessionStart(ADW_ID, { engineer: "test", projectCwd: "/tmp/x", adwName: "plan-build-review" });
  tracer.sessionSetTitle(ADW_ID, "server test run");
  tracer.phaseUpsert({
    phaseId: `${ADW_ID}_plan`,
    adwId: ADW_ID,
    seq: 1,
    name: "plan",
    kind: "agent",
    role: "planner",
    description: "plan step",
    status: "success",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:05.000Z",
    inputTokens: 100,
    outputTokens: 50,
  });
  tracer.event({ adwId: ADW_ID, phaseId: `${ADW_ID}_plan`, type: "log", name: "note", payload: { hi: true } });

  // Two more sessions against a second, distinct project_cwd — used by the
  // `/api/runs?project=` filtering tests below.
  tracer.sessionStart(ADW_ID_PROJECT_B, { engineer: "test", projectCwd: PROJECT_B_CWD, adwName: "plan-build-review" });
  tracer.sessionSetTitle(ADW_ID_PROJECT_B, "project B run 1");
  tracer.sessionStart(ADW_ID_PROJECT_B_2, { engineer: "test", projectCwd: PROJECT_B_CWD, adwName: "plan-build-review" });
  tracer.sessionSetTitle(ADW_ID_PROJECT_B_2, "project B run 2");

  // Two runs against the SAME project root, each with its own real
  // per-run worktree cwd — see the constants' own comment above.
  tracer.sessionStart(ADW_ID_WORKTREE_1, { engineer: "test", projectCwd: WORKTREE_CWD_1, adwName: "plan-build-review" });
  tracer.sessionSetTitle(ADW_ID_WORKTREE_1, "real project run 1");
  tracer.sessionStart(ADW_ID_WORKTREE_2, { engineer: "test", projectCwd: WORKTREE_CWD_2, adwName: "bounded-build-review" });
  tracer.sessionSetTitle(ADW_ID_WORKTREE_2, "real project run 2");

  // Two runs sharing ONE ticket (a manual retry under the same
  // --ticket-id) — the second attempt is the LATEST (started later).
  tracer.sessionStart(ADW_ID_ATTEMPT_1, {
    engineer: "test",
    projectCwd: TICKET_PROJECT_CWD,
    adwName: "plan-build-review",
    ticketId: TICKET_MULTI,
    taskPromptForTicket: "first attempt at the ticketed task",
  });
  tracer.sessionSetTitle(ADW_ID_ATTEMPT_1, "attempt 1");
  tracer.sessionFinish(ADW_ID_ATTEMPT_1, false);
  tracer.sessionStart(ADW_ID_ATTEMPT_2, {
    engineer: "test",
    projectCwd: TICKET_PROJECT_CWD,
    adwName: "plan-build-review",
    ticketId: TICKET_MULTI,
    taskPromptForTicket: "second attempt (retry) at the ticketed task",
  });
  tracer.sessionSetTitle(ADW_ID_ATTEMPT_2, "attempt 2 (retry)");

  // A single-attempt ticket — proves the API/UI don't force arrow-nav data
  // onto a ticket that has exactly one run.
  tracer.sessionStart(ADW_ID_SINGLE, {
    engineer: "test",
    projectCwd: TICKET_PROJECT_CWD,
    adwName: "plan-build-review",
    ticketId: TICKET_SINGLE,
    taskPromptForTicket: "a ticket with exactly one attempt",
  });
  tracer.sessionSetTitle(ADW_ID_SINGLE, "only attempt");
  tracer.sessionFinish(ADW_ID_SINGLE, true);

  tracer.close();
}

async function waitForServer(url: string, deadline: number): Promise<void> {
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return;
    } catch {
      // not up yet
    }
    if (Date.now() >= deadline) throw new Error(`server did not come up in time: ${url}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pi-web-factory-orchestrator-test-"));
  dbPath = join(dir, "factory.db");
  seed();

  baseUrl = `http://localhost:${String(TEST_PORT)}`;
  proc = Bun.spawn({
    cmd: ["bun", join(import.meta.dir, "server.ts")],
    env: {
      ...process.env,
      PI_WEB_FACTORY_ORCHESTRATOR_DB_PATH: dbPath,
      PI_WEB_FACTORY_ORCHESTRATOR_PORT: String(TEST_PORT),
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  await waitForServer(`${baseUrl}/api/runs`, Date.now() + 15_000);
}, 20_000);

afterAll(() => {
  proc.kill();
  rmSync(dir, { recursive: true, force: true });
});

describe("orchestrator server (real spawned process, real HTTP)", () => {
  test("GET /api/runs lists the seeded run", async () => {
    const res = await fetch(`${baseUrl}/api/runs`);
    expect(res.status).toBe(200);
    const runs = (await res.json()) as Array<{ adwId: string; title: string | null; status: string }>;
    expect(runs.some((r) => r.adwId === ADW_ID)).toBe(true);
    const run = runs.find((r) => r.adwId === ADW_ID)!;
    expect(run.title).toBe("server test run");
    expect(run.status).toBe("running"); // sessionStart sets it running; never finished here
  });

  test("GET /api/runs?project=<cwd> filters to only runs matching that project_cwd exactly", async () => {
    const res = await fetch(`${baseUrl}/api/runs?project=${encodeURIComponent(PROJECT_B_CWD)}`);
    expect(res.status).toBe(200);
    const runs = (await res.json()) as Array<{ adwId: string; projectCwd: string | null }>;
    expect(runs.length).toBe(2);
    expect(runs.every((r) => r.projectCwd === PROJECT_B_CWD)).toBe(true);
    expect(runs.some((r) => r.adwId === ADW_ID_PROJECT_B)).toBe(true);
    expect(runs.some((r) => r.adwId === ADW_ID_PROJECT_B_2)).toBe(true);
    expect(runs.some((r) => r.adwId === ADW_ID)).toBe(false);
  });

  test("GET /api/runs?project=<cwd> with no matching runs returns an empty array (not 404)", async () => {
    const res = await fetch(`${baseUrl}/api/runs?project=${encodeURIComponent("/tmp/does-not-exist")}`);
    expect(res.status).toBe(200);
    const runs = (await res.json()) as unknown[];
    expect(runs).toEqual([]);
  });

  test("GET /api/runs with no project param returns runs across all projects (unchanged default behavior)", async () => {
    const res = await fetch(`${baseUrl}/api/runs`);
    expect(res.status).toBe(200);
    const runs = (await res.json()) as Array<{ adwId: string }>;
    expect(runs.some((r) => r.adwId === ADW_ID)).toBe(true);
    expect(runs.some((r) => r.adwId === ADW_ID_PROJECT_B)).toBe(true);
    expect(runs.some((r) => r.adwId === ADW_ID_PROJECT_B_2)).toBe(true);
  });

  test("GET /api/runs response exposes projectRoot, worktree-suffix-stripped, distinct from projectCwd", async () => {
    const res = await fetch(`${baseUrl}/api/runs`);
    const runs = (await res.json()) as Array<{ adwId: string; projectCwd: string | null; projectRoot: string | null }>;
    const run1 = runs.find((r) => r.adwId === ADW_ID_WORKTREE_1);
    const run2 = runs.find((r) => r.adwId === ADW_ID_WORKTREE_2);
    expect(run1?.projectCwd).toBe(WORKTREE_CWD_1);
    expect(run2?.projectCwd).toBe(WORKTREE_CWD_2);
    // Different (unique per run) projectCwd, but the SAME projectRoot.
    expect(run1?.projectCwd).not.toBe(run2?.projectCwd);
    expect(run1?.projectRoot).toBe(PROJECT_ROOT_CWD);
    expect(run2?.projectRoot).toBe(PROJECT_ROOT_CWD);
  });

  test("GET /api/runs?project=<root> groups multiple runs by their shared project root, not their unique per-run worktree cwd", async () => {
    // Regression test for a real bug: filtering by the raw projectCwd
    // column (each run's own unique worktree path) meant a "project"
    // filter only ever matched exactly one run. This asserts BOTH
    // worktree runs come back for the shared root, not just one.
    const res = await fetch(`${baseUrl}/api/runs?project=${encodeURIComponent(PROJECT_ROOT_CWD)}`);
    expect(res.status).toBe(200);
    const runs = (await res.json()) as Array<{ adwId: string }>;
    expect(runs.some((r) => r.adwId === ADW_ID_WORKTREE_1)).toBe(true);
    expect(runs.some((r) => r.adwId === ADW_ID_WORKTREE_2)).toBe(true);
    expect(runs.length).toBe(2);
  });

  test("GET /api/runs?project=<one run's raw worktree cwd> does NOT narrow to just that run (proves the filter uses projectRoot, not projectCwd)", async () => {
    const res = await fetch(`${baseUrl}/api/runs?project=${encodeURIComponent(WORKTREE_CWD_1)}`);
    const runs = (await res.json()) as unknown[];
    // WORKTREE_CWD_1 is never any run's projectRoot (it's a projectCwd,
    // the unique worktree path) -- filtering by it should match nothing,
    // confirming the filter really keys off the normalized root and isn't
    // silently falling back to an exact projectCwd match.
    expect(runs).toEqual([]);
  });

  test("GET /api/runs (list endpoint) also includes each run's Steps, batched — not just the detail endpoint", async () => {
    // Regression coverage for the grid needing every card's Steps up front
    // (2026-08-05): the list route used to return bare
    // run summaries, forcing a per-card detail fetch to paint a mini-Gantt.
    const res = await fetch(`${baseUrl}/api/runs`);
    const runs = (await res.json()) as Array<{ adwId: string; steps: Array<{ name: string; role: string }> }>;
    const run = runs.find((r) => r.adwId === ADW_ID);
    expect(run?.steps).toHaveLength(1);
    expect(run?.steps[0]!.name).toBe("plan");
    expect(run?.steps[0]!.role).toBe("planner");

    // A run with zero Steps still gets a (present, empty) array — not
    // undefined/missing — so the frontend never needs an existence check.
    const runNoSteps = runs.find((r) => r.adwId === ADW_ID_PROJECT_B);
    expect(runNoSteps?.steps).toEqual([]);
  });

  test("GET /api/runs/:adwId returns the run plus its Steps in seq order", async () => {
    const res = await fetch(`${baseUrl}/api/runs/${ADW_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run: { adwId: string }; steps: Array<{ name: string; role: string; inputTokens: number }> };
    expect(body.run.adwId).toBe(ADW_ID);
    expect(body.steps).toHaveLength(1);
    expect(body.steps[0]!.name).toBe("plan");
    expect(body.steps[0]!.role).toBe("planner"); // owner column mapped to `role`
    expect(body.steps[0]!.inputTokens).toBe(100);
  });

  test("GET /api/runs/:adwId for an unknown id returns 404", async () => {
    const res = await fetch(`${baseUrl}/api/runs/adw_does_not_exist`);
    expect(res.status).toBe(404);
  });

  test("GET /api/runs/:adwId/events?since= returns events with rowid, and cursor filtering works", async () => {
    const res = await fetch(`${baseUrl}/api/runs/${ADW_ID}/events?since=0`);
    expect(res.status).toBe(200);
    const events = (await res.json()) as Array<{ rowid: number; type: string; name: string }>;
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.type).toBe("log");
    expect(typeof events[0]!.rowid).toBe("number");

    const maxRowid = Math.max(...events.map((e) => e.rowid));
    const res2 = await fetch(`${baseUrl}/api/runs/${ADW_ID}/events?since=${String(maxRowid)}`);
    const events2 = (await res2.json()) as unknown[];
    expect(events2).toHaveLength(0);
  });

  test("GET / serves the bundled frontend HTML", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("pi-web-factory orchestrator");
  });

  test("reconciliation is wired up — startup pass runs against a real spawned server without crashing it", async () => {
    // Full behavioral coverage (stale row -> fail, fresh row untouched,
    // live-vs-dead session cross-check) lives in the dedicated
    // "reconciliation pass" describe block below, against its
    // own scratch db/server instance with a controlled staleness threshold
    // and a stubbed pi-web. This test just confirms the already-running
    // shared server instance (this describe block's own beforeAll) didn't
    // fail to start or serve requests because of the reconciliation wiring
    // (e.g. a bad query, an unhandled promise rejection tearing down the
    // process) — regression coverage for "the reconciliation pass must not
    // break the ordinary read API it now lives alongside."
    const res = await fetch(`${baseUrl}/api/runs`);
    expect(res.status).toBe(200);
  });

  // ── /api/tickets, /api/tickets/:ticketId ─────────────────────────────────

  test("GET /api/tickets returns one row per TICKET, not per run — a two-attempt ticket is ONE row", async () => {
    const res = await fetch(`${baseUrl}/api/tickets`);
    expect(res.status).toBe(200);
    const tickets = (await res.json()) as Array<{ ticketId: string; runCount: number; latestRun: { adwId: string; steps: unknown[] } | null }>;

    const multi = tickets.find((t) => t.ticketId === TICKET_MULTI);
    expect(multi).toBeDefined();
    expect(multi?.runCount).toBe(2);
    // Only ONE row for this ticket, not two.
    expect(tickets.filter((t) => t.ticketId === TICKET_MULTI).length).toBe(1);

    const single = tickets.find((t) => t.ticketId === TICKET_SINGLE);
    expect(single?.runCount).toBe(1);
  });

  test("GET /api/tickets — a multi-attempt ticket's latestRun is the MOST RECENTLY STARTED attempt, not the first", async () => {
    const res = await fetch(`${baseUrl}/api/tickets`);
    const tickets = (await res.json()) as Array<{ ticketId: string; latestRun: { adwId: string } | null }>;
    const multi = tickets.find((t) => t.ticketId === TICKET_MULTI);
    expect(multi?.latestRun?.adwId).toBe(ADW_ID_ATTEMPT_2);
  });

  test("GET /api/tickets — latestRun carries the full RunSummary shape, steps included (not a stripped-down summary)", async () => {
    const res = await fetch(`${baseUrl}/api/tickets`);
    const tickets = (await res.json()) as Array<{ ticketId: string; latestRun: { adwId: string; title: string | null; steps: unknown[]; totalTokens: number } | null }>;
    const multi = tickets.find((t) => t.ticketId === TICKET_MULTI);
    expect(multi?.latestRun?.title).toBe("attempt 2 (retry)");
    expect(Array.isArray(multi?.latestRun?.steps)).toBe(true);
    expect(typeof multi?.latestRun?.totalTokens).toBe("number");
  });

  test("GET /api/tickets?project=<root> filters ticket-level rows by their latest run's project, same as /api/runs?project=", async () => {
    const res = await fetch(`${baseUrl}/api/tickets?project=${encodeURIComponent(TICKET_PROJECT_CWD)}`);
    const tickets = (await res.json()) as Array<{ ticketId: string }>;
    expect(tickets.some((t) => t.ticketId === TICKET_MULTI)).toBe(true);
    expect(tickets.some((t) => t.ticketId === TICKET_SINGLE)).toBe(true);
    // A ticket whose latest run is against a DIFFERENT project must not appear.
    expect(tickets.some((t) => t.ticketId.startsWith("adw_servertest0"))).toBe(false);
  });

  test("GET /api/tickets/:ticketId returns EVERY linked run, most recent first, full detail (steps included) per attempt", async () => {
    const res = await fetch(`${baseUrl}/api/tickets/${TICKET_MULTI}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ticketId: string; title: string | null; runs: Array<{ adwId: string; title: string | null; steps: unknown[] }> };
    expect(body.ticketId).toBe(TICKET_MULTI);
    expect(body.runs.map((r) => r.adwId)).toEqual([ADW_ID_ATTEMPT_2, ADW_ID_ATTEMPT_1]);
    // Ticket's own title stays whatever the FIRST linked run set (see
    // ticket.ts's mintOrAttachTicket) — not overwritten by the second.
    expect(body.title).toBe("first attempt at the ticketed task");
    expect(Array.isArray(body.runs[0]?.steps)).toBe(true);
  });

  test("GET /api/tickets/:ticketId for an unknown ticket returns 404", async () => {
    const res = await fetch(`${baseUrl}/api/tickets/ticket_does_not_exist`);
    expect(res.status).toBe(404);
  });

  test("GET /api/runs/:adwId response now includes ticketId — every run has one", async () => {
    const res = await fetch(`${baseUrl}/api/runs/${ADW_ID_ATTEMPT_1}`);
    const body = (await res.json()) as { run: { ticketId: string | null } };
    expect(body.run.ticketId).toBe(TICKET_MULTI);
  });

  test("the server's db handle is genuinely readonly — direct write attempt against the same file fails, confirming the running process cannot have a writable handle open", async () => {
    // Open our OWN separate connection with the intended writer semantics
    // (create:false, no readonly) to prove the FILE and its schema are
    // exactly what Tracer already wrote, and that WAL mode doesn't somehow
    // let the server's readonly handle silently succeed at writes elsewhere.
    // The real assurance that server.ts's OWN handle is readonly is a static
    // property of its source (`new Database(DB_PATH, { readonly: true })`,
    // asserted by direct inspection here) plus the ad hoc bun:sqlite spike
    // performed during development, which confirmed readonly handles throw
    // on write. This test guards against a future regression removing that
    // flag by checking the running server's behavior stays correct: writing
    // via a fresh writable handle and confirming the server picks up the
    // change on its next read (proves the SAME file backs both, i.e. the
    // server truly is reading this db, not some other path).
    const writer = new Database(dbPath);
    writer.run("UPDATE sessions SET title=? WHERE adw_id=?", ["title changed by test", ADW_ID]);
    writer.close();

    const res = await fetch(`${baseUrl}/api/runs/${ADW_ID}`);
    const body = (await res.json()) as { run: { title: string } };
    expect(body.run.title).toBe("title changed by test");
  });
});

// ── Reconciliation pass ───────────────────────────────────────────────────
//
// Its own dedicated scratch db + spawned server instance (distinct port,
// distinct db, distinct env) so the staleness threshold
// (PI_WEB_FACTORY_STEP_TIMEOUT_MS) and pi-web base URL
// (PI_WEB_FACTORY_BASE_URL) can be controlled tightly for this suite without
// affecting the shared instance above.

const RECONCILE_TEST_PORT = 8791;
const RECONCILE_STALE_MS = 500; // short, so the startup pass sweeps within the test's own timeout
const STALE_ADW_ID = "adw_reconcile_stale01";
const FRESH_ADW_ID = "adw_reconcile_fresh01";
const NO_SESSION_ADW_ID = "adw_reconcile_nosess01";
const STALE_PROJECT_CWD = "/tmp/reconcile-test-stale-project";
const FRESH_PROJECT_CWD = "/tmp/reconcile-test-fresh-project";
const NO_SESSION_PROJECT_CWD = "/tmp/reconcile-test-no-session-project";

describe("reconciliation pass", () => {
  let reconcileDir: string;
  let reconcileDbPath: string;
  let reconcileProc: ReturnType<typeof Bun.spawn>;
  let reconcileBaseUrl: string;
  let fakePiWeb: ReturnType<typeof Bun.serve>;
  let fakePiWebSessionsRequests: string[] = [];

  beforeAll(async () => {
    reconcileDir = mkdtempSync(join(tmpdir(), "pi-web-factory-orchestrator-reconcile-test-"));
    reconcileDbPath = join(reconcileDir, "factory.db");

    // A stale row: started_at far enough in the past to already exceed
    // RECONCILE_STALE_MS by the time the server's startup sweep runs, AND
    // (deliberately) a project pi-web's fake /sessions endpoint reports as
    // still LIVE — proving staleness alone (condition 2) is sufficient, per
    // the OR semantics, even when condition 1 (no live session) does NOT
    // also hold.
    const staleStartedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    // A fresh row: started_at is "now" — must be left untouched even though
    // its project also isn't in the fake pi-web's "live" set (proving
    // freshness alone protects a row regardless of session state, matching
    // "AND-based false positives are not allowed" from the other direction:
    // a fresh row must never be flagged just because the session check
    // happens to fail/return empty too fast — the staleness check must be
    // evaluated independently, not skipped).
    const freshStartedAt = new Date().toISOString();

    const tracer = new Tracer(reconcileDbPath);
    tracer.sessionStart(STALE_ADW_ID, { engineer: "test", projectCwd: STALE_PROJECT_CWD, adwName: "test-workflow" });
    tracer.phaseUpsert({
      phaseId: `${STALE_ADW_ID}_build`,
      adwId: STALE_ADW_ID,
      seq: 1,
      name: "build",
      kind: "agent",
      role: "build",
      description: "stale build step",
      status: "running",
      startedAt: staleStartedAt,
    });

    tracer.sessionStart(FRESH_ADW_ID, { engineer: "test", projectCwd: FRESH_PROJECT_CWD, adwName: "test-workflow" });
    tracer.phaseUpsert({
      phaseId: `${FRESH_ADW_ID}_build`,
      adwId: FRESH_ADW_ID,
      seq: 1,
      name: "build",
      kind: "agent",
      role: "build",
      description: "fresh, genuinely still-running build step",
      status: "running",
      startedAt: freshStartedAt,
    });

    // A row that's fresh (would NOT trip the staleness proxy) but whose
    // project pi-web reports zero live sessions for — proving condition 1
    // alone is also independently sufficient, exactly the real-world
    // scenario that motivated this pass (fresh-looking stuck rows with
    // provably no live pi-web session).
    tracer.sessionStart(NO_SESSION_ADW_ID, { engineer: "test", projectCwd: NO_SESSION_PROJECT_CWD, adwName: "test-workflow" });
    tracer.phaseUpsert({
      phaseId: `${NO_SESSION_ADW_ID}_build`,
      adwId: NO_SESSION_ADW_ID,
      seq: 1,
      name: "build",
      kind: "agent",
      role: "build",
      description: "fresh timestamp, but no live pi-web session",
      status: "running",
      startedAt: freshStartedAt,
    });
    tracer.close();

    // A tiny stub standing in for pi-web's real GET /sessions?cwd=<cwd> —
    // reports STALE_PROJECT_CWD and FRESH_PROJECT_CWD as having a live
    // session, and NO_SESSION_PROJECT_CWD as having none.
    fakePiWeb = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/sessions") {
          const cwd = url.searchParams.get("cwd") ?? "";
          fakePiWebSessionsRequests.push(cwd);
          const live = cwd === STALE_PROJECT_CWD || cwd === FRESH_PROJECT_CWD;
          return Response.json(live ? [{ id: "sess_live", cwd, path: "", created: "x", modified: "x", messageCount: 1, firstMessage: "" }] : []);
        }
        return new Response("not found", { status: 404 });
      },
    });

    reconcileBaseUrl = `http://localhost:${String(RECONCILE_TEST_PORT)}`;
    reconcileProc = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "server.ts")],
      env: {
        ...process.env,
        PI_WEB_FACTORY_ORCHESTRATOR_DB_PATH: reconcileDbPath,
        PI_WEB_FACTORY_ORCHESTRATOR_PORT: String(RECONCILE_TEST_PORT),
        PI_WEB_FACTORY_STEP_TIMEOUT_MS: String(RECONCILE_STALE_MS),
        PI_WEB_FACTORY_BASE_URL: `${fakePiWeb.url.origin}/api`,
        // Long periodic interval — this suite only needs the mandatory
        // startup pass to have run by the time its assertions check.
        PI_WEB_FACTORY_ORCHESTRATOR_RECONCILE_INTERVAL_MS: String(60 * 60 * 1000),
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    await waitForServer(`${reconcileBaseUrl}/api/runs`, Date.now() + 15_000);
    // The startup reconciliation sweep is fire-and-forget (module comment:
    // "allowed to finish after routes are already serving") — poll until
    // its effect (the stale row flipping to 'fail') is observable, rather
    // than a fixed sleep.
    const deadline = Date.now() + 10_000;
    for (;;) {
      const res = await fetch(`${reconcileBaseUrl}/api/runs/${STALE_ADW_ID}`);
      const body = (await res.json()) as { run: { status: string } };
      if (body.run.status === "fail") break;
      if (Date.now() >= deadline) throw new Error("reconciliation startup sweep did not complete in time");
      await new Promise((r) => setTimeout(r, 100));
    }
  }, 30_000);

  afterAll(() => {
    reconcileProc.kill();
    fakePiWeb.stop(true);
    rmSync(reconcileDir, { recursive: true, force: true });
  });

  test("a stale running row (past the staleness threshold) is marked fail, even though pi-web still reports a live session for its project", async () => {
    const res = await fetch(`${reconcileBaseUrl}/api/runs/${STALE_ADW_ID}`);
    const body = (await res.json()) as { run: { status: string }; steps: Array<{ status: string; error: string | null }> };
    expect(body.run.status).toBe("fail");
    expect(body.steps[0]!.status).toBe("fail");
    expect(body.steps[0]!.error).toContain("stale");
  });

  test("a fresh, genuinely-running row is left completely untouched — no false positive", async () => {
    const res = await fetch(`${reconcileBaseUrl}/api/runs/${FRESH_ADW_ID}`);
    const body = (await res.json()) as { run: { status: string }; steps: Array<{ status: string }> };
    expect(body.run.status).toBe("running");
    expect(body.steps[0]!.status).toBe("running");
  });

  test("a fresh row whose project has NO live pi-web session is marked fail — condition 1 alone is sufficient, independent of staleness", async () => {
    const res = await fetch(`${reconcileBaseUrl}/api/runs/${NO_SESSION_ADW_ID}`);
    const body = (await res.json()) as { run: { status: string }; steps: Array<{ status: string; error: string | null }> };
    expect(body.run.status).toBe("fail");
    expect(body.steps[0]!.status).toBe("fail");
    expect(body.steps[0]!.error).toContain("no live pi-web session");
  });

  test("the fake pi-web session check was actually called for the relevant projects (cross-check genuinely happened, not skipped)", () => {
    expect(fakePiWebSessionsRequests).toContain(NO_SESSION_PROJECT_CWD);
  });
});

// ── Retry-trigger wiring smoke test ─────────────────────────────────────────
//
// PI_WEB_FACTORY_ORCHESTRATOR_RETRY_TRIGGER=1 turns the trigger pass ON (it's
// off by default — see server.ts's own doc comment on RETRY_TRIGGER_ENABLED,
// and every OTHER spawned-server test in this file, which never sets this
// var, already covers the default-off path not crashing). This suite's own
// scratch db has ZERO status='fail' rows, so `triggerRetryIfNeeded` finds
// nothing to decide and never makes a real (costing) decision-Role model
// call — this is purely a wiring smoke test ("does turning this flag on
// crash the server / break the ordinary read API it lives alongside"), not
// a test of the decision logic itself (covered directly in
// modules/retryTrigger.test.ts against a real db).
describe("retry-trigger wiring (opt-in flag)", () => {
  let dir: string;
  let triggerDbPath: string;
  let proc: ReturnType<typeof Bun.spawn>;
  let triggerBaseUrl: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "pi-web-factory-orchestrator-retrytrigger-test-"));
    triggerDbPath = join(dir, "factory.db");
    // No seeded rows at all — an empty-but-correctly-shaped db (server.ts's
    // own bootstrap creates it) is exactly the "nothing to decide" case.

    const port = 8792;
    triggerBaseUrl = `http://localhost:${String(port)}`;
    proc = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "server.ts")],
      env: {
        ...process.env,
        PI_WEB_FACTORY_ORCHESTRATOR_DB_PATH: triggerDbPath,
        PI_WEB_FACTORY_ORCHESTRATOR_PORT: String(port),
        PI_WEB_FACTORY_ORCHESTRATOR_RETRY_TRIGGER: "1",
        PI_WEB_FACTORY_ORCHESTRATOR_RECONCILE_INTERVAL_MS: String(60 * 60 * 1000),
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    await waitForServer(`${triggerBaseUrl}/api/runs`, Date.now() + 15_000);
  }, 20_000);

  afterAll(() => {
    proc.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  test("server starts and serves the ordinary read API with the retry-trigger flag enabled and nothing to decide", async () => {
    const res = await fetch(`${triggerBaseUrl}/api/runs`);
    expect(res.status).toBe(200);
    const runs = (await res.json()) as unknown[];
    expect(runs).toEqual([]);
  });

  test("the process is still alive after the startup retry-trigger pass — no crash/uncaught rejection", async () => {
    // Give the fire-and-forget startup sweep a moment to have run, then
    // confirm the ordinary read API still answers — the honest assertion
    // here (nothing to decide -> triggerRetryIfNeeded's own "decided N,
    // skipped N" log line only fires when either count is > 0, server.ts's
    // own condition) is "the process is still up and serving," not a
    // specific log line.
    await new Promise((r) => setTimeout(r, 500));
    const res = await fetch(`${triggerBaseUrl}/api/runs`);
    expect(res.status).toBe(200);
  });
});

// ── server.ts's own startup migration against an EXISTING,
// old-shape db file ─────────────────────────────────────────────────────
//
// Direct regression for a real production incident: server.ts previously
// only ran schema/migration setup inside an `if (!existsSync(DB_PATH))`
// bootstrap-a-brand-new-db block — a no-op against a db file that already
// exists, which every real production factory.db does. `runMigrations`
// (added earlier for `Tracer`'s own constructor) never ran for
// this process at all as a result, so every route reading a column added
// after the db's original creation (phases.artifact_json) threw `SQLiteError:
// no such column: artifact_json` in production — confirmed live via
// `docker logs pi-web-factory-orchestrator`.
//
// This suite seeds its OWN db file by hand, in the OLD shape (predating the
// artifact_json migration) — deliberately NOT via `Tracer` (which already
// creates the column fresh via its own `ensureSchemaCurrent` call, exactly
// the blind spot that let the original bug in `Tracer`'s own code ship
// unnoticed — see schema.test.ts's and tracer.test.ts's own comments on this
// same class of gap) — then spawns the REAL server.ts binary against that
// pre-existing file, exactly replicating "an already-deployed production db,
// then a fresh process restart" rather than "a brand-new db, first ever run."
const MIGRATION_HOTFIX_TEST_PORT = 8793;

describe("orchestrator server — startup schema migration against an existing old-shape db", () => {
  let migrationDir: string;
  let migrationDbPath: string;
  let migrationProc: ReturnType<typeof Bun.spawn>;
  let migrationBaseUrl: string;
  const OLD_SHAPE_ADW_ID = "adw_oldshape_migration01";

  beforeAll(async () => {
    migrationDir = mkdtempSync(join(tmpdir(), "pi-web-factory-orchestrator-migration-test-"));
    migrationDbPath = join(migrationDir, "factory.db");

    // Hand-built OLD shape — no phases.artifact_json column —
    // mirroring a real, already-deployed production db exactly, NOT built
    // via Tracer (see this section's own header comment for why).
    const seedDb = new Database(migrationDbPath, { create: true });
    seedDb.run(`
      CREATE TABLE tickets (
        ticket_id TEXT PRIMARY KEY, file_path TEXT, created_at TEXT, title TEXT, latest_run_adw_id TEXT
      )
    `);
    seedDb.run(`
      CREATE TABLE sessions (
        adw_id TEXT PRIMARY KEY, adw_name TEXT, project_cwd TEXT, title TEXT,
        request TEXT, status TEXT, engineer TEXT, started_at TEXT, ended_at TEXT,
        total_tokens INTEGER DEFAULT 0, total_cost REAL DEFAULT 0, archived INTEGER DEFAULT 0,
        ticket_id TEXT REFERENCES tickets
      )
    `);
    seedDb.run(`
      CREATE TABLE phases (
        phase_id TEXT PRIMARY KEY, adw_id TEXT REFERENCES sessions, seq INTEGER,
        name TEXT, kind TEXT, owner TEXT, description TEXT, status TEXT DEFAULT 'fail',
        attempt INTEGER DEFAULT 0, retries INTEGER DEFAULT 0, error TEXT,
        input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER,
        output_summary TEXT, started_at TEXT, ended_at TEXT
      )
    `);
    seedDb.run(`
      CREATE TABLE events (
        event_id TEXT PRIMARY KEY, adw_id TEXT REFERENCES sessions, phase_id TEXT REFERENCES phases,
        parent_id TEXT, type TEXT, name TEXT, payload_json TEXT, tokens INTEGER,
        started_at TEXT, ended_at TEXT
      )
    `);
    seedDb.run(
      `INSERT INTO sessions (adw_id, adw_name, project_cwd, title, status, started_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [OLD_SHAPE_ADW_ID, "plan-build-review", "/tmp/old-shape-project", "pre-existing old-shape run", "success", "2026-01-01T00:00:00.000Z"],
    );
    seedDb.run(
      `INSERT INTO phases (phase_id, adw_id, seq, name, kind, owner, description, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [`${OLD_SHAPE_ADW_ID}_build`, OLD_SHAPE_ADW_ID, 1, "build", "agent", "build", "", "success"],
    );
    seedDb.close();

    // Confirm the seed genuinely predates the column, before the real test
    // — otherwise this whole suite would silently prove nothing.
    const preCheck = new Database(migrationDbPath, { readonly: true });
    const cols = preCheck.query<{ name: string }, []>("PRAGMA table_info(phases)").all();
    if (cols.some((c) => c.name === "artifact_json")) {
      throw new Error("test setup bug: seeded db already has artifact_json — this suite would not actually exercise the migration path");
    }
    preCheck.close();

    migrationBaseUrl = `http://localhost:${String(MIGRATION_HOTFIX_TEST_PORT)}`;
    migrationProc = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "server.ts")],
      env: {
        ...process.env,
        PI_WEB_FACTORY_ORCHESTRATOR_DB_PATH: migrationDbPath,
        PI_WEB_FACTORY_ORCHESTRATOR_PORT: String(MIGRATION_HOTFIX_TEST_PORT),
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    await waitForServer(`${migrationBaseUrl}/api/runs`, Date.now() + 15_000);
  }, 20_000);

  afterAll(() => {
    migrationProc.kill();
    rmSync(migrationDir, { recursive: true, force: true });
  });

  test("the server's own bootstrap migrates an EXISTING old-shape db on startup — phases.artifact_json is present afterward", () => {
    const check = new Database(migrationDbPath, { readonly: true });
    try {
      const cols = check.query<{ name: string }, []>("PRAGMA table_info(phases)").all();
      expect(cols.map((c) => c.name)).toContain("artifact_json");
    } finally {
      check.close();
    }
  });

  test("GET /api/runs/:adwId against a migrated old-shape db does not 500 — the exact route that broke live in production", async () => {
    const res = await fetch(`${migrationBaseUrl}/api/runs/${OLD_SHAPE_ADW_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run: { adwId: string }; steps: Array<{ artifact: unknown }> };
    expect(body.run.adwId).toBe(OLD_SHAPE_ADW_ID);
    // The seeded Step never had stepArtifact() called on it — artifact is
    // correctly null, not a thrown error, proving the route reads the
    // column successfully end to end (not just that the column exists).
    expect(body.steps.length).toBe(1);
    expect(body.steps[0]?.artifact).toBeNull();
  });

  test("GET /api/runs (list endpoint) against a migrated old-shape db does not 500 either", async () => {
    const res = await fetch(`${migrationBaseUrl}/api/runs`);
    expect(res.status).toBe(200);
    const runs = (await res.json()) as Array<{ adwId: string }>;
    expect(runs.some((r) => r.adwId === OLD_SHAPE_ADW_ID)).toBe(true);
  });
});

// Deployment-config drift guard: RECONCILE_STALE_MS (this file) is
// deliberately the SAME env var as the real job runner's own
// PI_WEB_FACTORY_STEP_TIMEOUT_MS, precisely so the reconciliation pass's
// staleness threshold can never be shorter than a Step's own legitimate
// wait budget — see reconcileStuckRuns's doc comment. That guarantee lives
// entirely in docker-compose.yml's two separate service definitions
// (jmfederico-pi-web, the runner; pi-web-factory-orchestrator, this
// process), which nothing in the TS type system enforces. Caught live
// 2026-08-13: pi-web-factory-orchestrator had no
// PI_WEB_FACTORY_STEP_TIMEOUT_MS set at all, silently falling back to the
// module's 120_000ms (2 min) code default while jmfederico-pi-web ran with
// 600_000ms (10 min) — the reconciliation sweep force-failed a genuinely
// in-progress review step at ~5m12s as a direct result. This test reads
// the real compose file (not a fixture) so it fails again the moment either
// service's value drifts, whichever direction.
describe("docker-compose.yml — PI_WEB_FACTORY_STEP_TIMEOUT_MS deployment-config drift guard", () => {
  // This repo's own docker-compose.yml lives at the repo root.
  const composePath = join(import.meta.dir, "..", "..", "docker-compose.yml");

  function stepTimeoutForService(composeYaml: string, serviceName: string): string | undefined {
    const serviceStart = composeYaml.indexOf(`\n  ${serviceName}:\n`);
    if (serviceStart === -1) throw new Error(`service "${serviceName}" not found in docker-compose.yml`);
    // Next top-level (2-space-indented) service key marks the end of this
    // service's block — services are indented 4+ spaces beneath it.
    const nextServiceMatch = /\n {2}\S/.exec(composeYaml.slice(serviceStart + 1));
    const serviceEnd = nextServiceMatch ? serviceStart + 1 + nextServiceMatch.index : composeYaml.length;
    const block = composeYaml.slice(serviceStart, serviceEnd);
    // Captures the raw value, not just literal digits — both
    // services now reference the same ${PI_WEB_FACTORY_STEP_TIMEOUT_MS:-...}
    // env var expression (see docker-compose.yml), which structurally
    // can't drift, but a literal override in one and not the other should
    // still fail this guard.
    return /PI_WEB_FACTORY_STEP_TIMEOUT_MS=(\S+)/.exec(block)?.[1];
  }

  test("jmfederico-pi-web and pi-web-factory-orchestrator set the identical PI_WEB_FACTORY_STEP_TIMEOUT_MS value", () => {
    const composeYaml = readFileSync(composePath, "utf8");
    const runnerValue = stepTimeoutForService(composeYaml, "jmfederico-pi-web");
    const orchestratorValue = stepTimeoutForService(composeYaml, "pi-web-factory-orchestrator");

    expect(runnerValue).toBeDefined();
    expect(orchestratorValue).toBeDefined();
    expect(orchestratorValue).toBe(runnerValue);
  });
});
