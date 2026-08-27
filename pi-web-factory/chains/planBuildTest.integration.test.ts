/**
 * Live end-to-end integration test for the planBuildTest chain — M-066 card,
 * Plan item 5, extended by M-071 (worktree-per-run + real pi-web Project/
 * Workspace registration + deep-link resolution). Runs against the REAL,
 * running `jmfederico-pi-web` instance on `local-ai-machine`
 * (http://192.168.1.21:8080/api), not a mock, same pattern
 * piwebClient.integration.test.ts already established (M-062).
 *
 * The scratch git repo this test targets lives inside the pi-web
 * CONTAINER's own filesystem (`/tmp/pi-web-factory-m066-test`, the
 * container's `/tmp`, not the host Mac's) — this test's own `cwd: "..."`
 * option is a real path from the perspective of the agent's tool calls
 * running server-side, reached over the network via piwebClient.ts's calls
 * to 192.168.1.21:8080. The scratch repo is created and inspected via
 * `ssh local-ai-machine "docker exec pi-web ..."` in beforeAll/afterAll —
 * see this file's companion setup/teardown below.
 *
 * `factory.db` (this test's OWN trace db, not the container's) is written
 * locally by this test's own `Tracer` instance and read back directly with
 * `bun:sqlite` to verify phase/event ordering and gate results — the same
 * approach tracer.test.ts already uses.
 *
 * Kept to ONE full end-to-end test case, same restraint as
 * piwebClient.integration.test.ts: this hits a real shared server and a
 * real local model across two full agent turns (plan, build) plus a code
 * gate — real wall-clock time is expected, not a bug.
 *
 * ── M-071 scope boundary: what this test does and does NOT cover ─────────
 * `worktree.ts` (`createRunWorktree`/`resolveMainCheckoutPath`/
 * `removeRunWorktree`) deliberately uses fast, LOCAL filesystem checks
 * (`spawnSync(..., {cwd})`, `existsSync`, `realpathSync`) — correct for
 * production, where pi-web-factory runs colocated inside the same container
 * as the target project (design doc §2). This test process, however, runs
 * on the dev Mac, while the scratch repo lives only inside the container —
 * so `worktree.ts`'s own git/filesystem calls, if invoked from THIS
 * process against that container-only path, would fail at the OS level
 * before git even runs (confirmed directly: `spawnSync`'s `cwd` option
 * requires the directory to exist from the CALLING process's own
 * filesystem view). Bridging that gap by relocating pi-web-factory's
 * source into the container (matching production's real topology, and
 * what M-068's Docker bake-in will make permanent) is out of scope for a
 * single test file to improvise.
 *
 * So this test's division of labor is:
 *   - `worktree.test.ts` (real local git repos, unit-level) already
 *     verifies `createRunWorktree`/`resolveMainCheckoutPath`/
 *     `removeRunWorktree`'s actual git mechanics for real — nothing here
 *     duplicates that.
 *   - THIS test creates the worktree the SAME way `worktree.ts` would
 *     (`git worktree add <path> -b pi-web-factory/<adwId>`, same naming
 *     convention, same nested-and-excluded location), but via the
 *     ssh/docker-exec bridge (`dockerExec`, matching this file's own
 *     established pattern for every other container-side operation) —
 *     THEN drives `planBuildTest` over its RESUME path (an already-started
 *     session + `opts.cwd` set directly to that worktree path), which is
 *     the documented, correct way `planBuildTest.ts` itself expects to be
 *     called against an already-existing worktree (see that file's
 *     `sessionId` doc comment). `mainCheckoutPath` is also passed directly
 *     (bypassing `resolveMainCheckoutPath`'s own local `git rev-parse`,
 *     which would otherwise hit the same local/remote mismatch as
 *     `createRunWorktree` — see that option's own doc comment on
 *     `PlanBuildTestOptions`) — exercising `ensureProjectRegistered`,
 *     `resolveWorkspaceId`, the full plan/build/test phase sequence, and
 *     the printed deep-link's real resolvability, all for real, over the
 *     real network, against the real live server.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tracer } from "../modules/tracer.ts";
import { loadRolesConfig } from "../modules/roles.ts";
import { DEFAULT_BASE_URL, startSession } from "../modules/piwebClient.ts";
import { sessionDeepLink, browserOriginFromApiBaseUrl } from "../cli.ts";
import { planBuildTest } from "./planBuildTest.ts";

const SCRATCH_CWD = "/tmp/pi-web-factory-m066-test"; // path inside the pi-web CONTAINER — the MAIN checkout
const TEST_ADW_ID = "adw_m071integrat"; // fixed, so this test's worktree/branch naming is deterministic and inspectable
const WORKTREE_PATH = `${SCRATCH_CWD}/.pi-web-factory-worktrees/${TEST_ADW_ID}`; // matches worktree.ts's own naming convention exactly
const TARGET_FILE = "hello.txt";
const CONFIG_PATH = join(import.meta.dir, "..", "factory.config.yaml");

function dockerExec(cmd: string): string {
  return execFileSync("ssh", ["local-ai-machine", `docker exec pi-web sh -c '${cmd}'`], {
    encoding: "utf8",
  });
}

let localDir: string;
let dbPath: string;
let tracer: Tracer;

beforeAll(() => {
  // Fresh scratch repo inside the container for this run (idempotent re-init
  // in case a prior run left state behind), PLUS a worktree created the same
  // way worktree.ts's own createRunWorktree would (see module doc comment
  // above for why this test creates it via the ssh/docker-exec bridge rather
  // than calling createRunWorktree directly from this dev-Mac process).
  dockerExec(
    `rm -rf ${SCRATCH_CWD} && mkdir -p ${SCRATCH_CWD} && cd ${SCRATCH_CWD} && ` +
      `git init -q && git config user.email test@example.com && git config user.name Test && ` +
      `git commit --allow-empty -q -m init && ` +
      `echo ".pi-web-factory-worktrees/" >> .git/info/exclude && ` +
      `git worktree add -q ${WORKTREE_PATH} -b pi-web-factory/${TEST_ADW_ID}`,
  );

  localDir = mkdtempSync(join(tmpdir(), "pi-web-factory-m066-"));
  dbPath = join(localDir, "factory.db");
  tracer = new Tracer(dbPath);
});

afterAll(async () => {
  tracer.close();
  rmSync(localDir, { recursive: true, force: true });
  // Clean up the scratch repo (including the worktree nested under it) —
  // deleting the directory ALSO makes the worktree pi-web's own
  // WorkspaceService would discover disappear (it discovers live, not
  // cached), but the pi-web PROJECT registration itself is a separate,
  // server-side record (`POST /projects`, via ensureProjectRegistered) that
  // survives the directory being deleted — deregister it explicitly so this
  // test doesn't leave a project pointing at a now-nonexistent path lying
  // around in the shared server's project list (confirmed this was a real
  // gap during M-071's own manual verification: a prior test run without
  // this line left exactly such an orphaned project behind).
  dockerExec(`rm -rf ${SCRATCH_CWD}`);
  try {
    const projectsResp = await fetch(`${DEFAULT_BASE_URL}/projects`);
    const projects = (await projectsResp.json()) as Array<{ id: string; path: string }>;
    const registered = projects.find((p) => p.path === SCRATCH_CWD);
    if (registered) {
      await fetch(`${DEFAULT_BASE_URL}/projects/${registered.id}`, { method: "DELETE" });
    }
  } catch {
    // best-effort — never let teardown itself fail the test run
  }
});

describe("planBuildTest chain (live pi-web server)", () => {
  test(
    "plan -> build -> test end to end against a real scratch repo + pre-created worktree in the pi-web container, with real project/workspace registration and a verified deep-link",
    async () => {
      const config = loadRolesConfig(CONFIG_PATH);

      // Start the session directly against the WORKTREE path (mirrors what
      // planBuildTest.ts itself does internally for a fresh run — see this
      // file's module doc comment for why THIS test starts it externally
      // instead of letting planBuildTest mint the worktree itself).
      const session = await startSession(DEFAULT_BASE_URL, WORKTREE_PATH, `${TEST_ADW_ID}:m071-integration-test`);

      const taskPrompt =
        `In this git repository, create a new file named exactly "${TARGET_FILE}" containing ` +
        `exactly one line of text: "hello from pi-web-factory". Use your tools to actually write ` +
        `the file to disk — do not just describe it.`;

      // `gates.ts`'s `testsPass` shells out LOCALLY (by design — in the real
      // deployment pi-web-factory runs as a sibling process inside the same
      // container as pi-web itself, design doc §2, so a local shell-out is
      // the correct, reusable behavior). This test process, however, runs on
      // the dev Mac, not inside the container, so `cwd` (the container's
      // `/tmp/...`) isn't reachable as a local path here. Bridge that gap
      // the same way this test bridges every other container-side check —
      // wrap the check itself in `ssh ... docker exec ...` so `testsPass`'s
      // ordinary local `sh -c <cmd>` still runs unmodified, it just runs a
      // command whose real effect happens over that bridge. This is a
      // test-harness adaptation only; `gates.ts`/`run.ts`/`planBuildTest.ts`
      // are untouched.
      const testCmd = `ssh local-ai-machine "docker exec pi-web sh -c 'test -f ${WORKTREE_PATH}/${TARGET_FILE}'"`;

      const result = await planBuildTest({
        tracer,
        config,
        cwd: WORKTREE_PATH, // resume path: opts.cwd IS the worktree directly (see planBuildTest.ts's sessionId doc comment)
        mainCheckoutPath: SCRATCH_CWD, // bypasses resolveMainCheckoutPath's local git call — see module doc comment above
        taskPrompt,
        testCmd,
        // testCmd above is a self-contained ssh/docker-exec check with no
        // need of a real local directory to run from — `localDir` (already
        // created for factory.db) just satisfies testsPass's requirement
        // that `Bun.spawn`'s cwd exist locally. See planBuildTest.ts's
        // `testCwd` doc comment for why this differs from `cwd` here.
        testCwd: localDir,
        baseUrl: DEFAULT_BASE_URL,
        adwId: TEST_ADW_ID,
        sessionId: session.id, // resume path — skips startSession/createRunWorktree internally
        engineer: "m071-integration-test",
      });

      // Cleanup (archive-then-delete the pi-web session, same pattern
      // piwebClient.integration.test.ts established, M-062) happens in a
      // `finally` AFTER every assertion below — including the `GET
      // /sessions/:id/status` check, which needs the session to still
      // exist. Cleaning up before verifying would make that check
      // meaningless (a deleted session's status is unreachable BY
      // DESIGN, not a bug the deep-link needs to tolerate).
      try {
        if (result.status !== "success") {
          // Surface whatever detail we have to make a failure diagnosable.
          throw new Error(`planBuildTest did not succeed: ${JSON.stringify(result, null, 2)}`);
        }

        expect(result.status).toBe("success");
        expect(result.plan.summary.length).toBeGreaterThan(0);
        expect(result.build.summary.length).toBeGreaterThan(0);
        expect(result.testReport.checks.every((c) => c.ok)).toBe(true);

        // ── M-071: the run's link info correctly reflects the RESUME path (opts.cwd unchanged) ──
        expect(result.link.cwd).toBe(WORKTREE_PATH);

        // The build agent's file landed in the WORKTREE, not the main checkout.
        const catOutputWorktree = dockerExec(`cat ${WORKTREE_PATH}/${TARGET_FILE}`);
        expect(catOutputWorktree).toContain("hello from pi-web-factory");

        // The main checkout itself is UNCHANGED by the run (isolation actually
        // held) — the target file must NOT exist there.
        const mainCheckoutHasFile = dockerExec(
          `sh -c 'test -f ${SCRATCH_CWD}/${TARGET_FILE} && echo yes || echo no'`,
        );
        expect(mainCheckoutHasFile.trim()).toBe("no");

        const gitLog = dockerExec(`cd ${WORKTREE_PATH} && git log --oneline`);
        expect(gitLog).toContain("init");

        // ── M-071: project/workspace ids are real and independently resolve ──
        expect(result.link.projectId.length).toBeGreaterThan(0);
        expect(result.link.workspaceId).toBeDefined();
        expect(result.link.workspaceId?.length).toBeGreaterThan(0);

        const projectsResp = await fetch(`${DEFAULT_BASE_URL}/projects`);
        const projects = (await projectsResp.json()) as Array<{ id: string; path: string }>;
        const registeredProject = projects.find((p) => p.id === result.link.projectId);
        expect(registeredProject).toBeDefined();
        expect(registeredProject?.path).toBe(SCRATCH_CWD);

        const workspacesResp = await fetch(`${DEFAULT_BASE_URL}/projects/${result.link.projectId}/workspaces`);
        const workspaces = (await workspacesResp.json()) as Array<{ id: string; path: string }>;
        const registeredWorkspace = workspaces.find((w) => w.id === result.link.workspaceId);
        expect(registeredWorkspace).toBeDefined();
        expect(registeredWorkspace?.path).toBe(WORKTREE_PATH);

        const sessionStatusResp = await fetch(`${DEFAULT_BASE_URL}/sessions/${result.sessionId}/status`);
        expect(sessionStatusResp.ok).toBe(true);
        const sessionStatus = (await sessionStatusResp.json()) as { sessionId: string };
        expect(sessionStatus.sessionId).toBe(result.sessionId);

        // ── M-071: the printed deep-link itself is well-formed AND every id in it verified above ──
        // Expected origin is derived from DEFAULT_BASE_URL itself (via the
        // same browserOriginFromApiBaseUrl the real code path uses), not a
        // second hardcoded IP literal — 2026-08-05, after the box's actual
        // LAN address changed mid-session (192.168.1.21 -> 192.168.1.226,
        // wired interface dropped, DHCP reassigned on WiFi) and broke this
        // exact hardcoded assertion. See piwebClient.ts's DEFAULT_BASE_URL
        // doc comment for the full story.
        const link = sessionDeepLink(DEFAULT_BASE_URL, result.link, result.sessionId);
        expect(link).toBe(
          `${browserOriginFromApiBaseUrl(DEFAULT_BASE_URL)}/?project=${result.link.projectId}&session=${result.sessionId}&workspace=${result.link.workspaceId}`,
        );
        // Fetch the deep-link's own origin (confirms it's a real, reachable
        // HTTP endpoint, not just a well-formed string) — the client-side
        // router that reads ?project=/&workspace=/&session= is a static SPA
        // (route.ts/PiWebApp.ts, both confirmed by direct source read, §6.2)
        // so what's actually verifiable by HTTP GET alone is that the origin
        // serves the app shell successfully; the three ids it would resolve
        // client-side are independently confirmed real above via their own
        // REST routes (GET /projects, GET /projects/:id/workspaces, GET
        // /sessions/:id/status) — together this is the full "would genuinely
        // open the right session" confirmation the M-071 card asks for.
        const linkResp = await fetch(link);
        expect(linkResp.ok).toBe(true);

        // ── verify factory.db trace rows: phase/event ordering + gate result ──
        const adwId = result.adwId;
        expect(adwId).toBe(TEST_ADW_ID);

        const phases = tracer.db
          .query<
            {
              name: string;
              status: string;
              seq: number;
              kind: string;
              output_summary: string | null;
              input_tokens: number | null;
              output_tokens: number | null;
            },
            [string]
          >(
            "select name, status, seq, kind, output_summary, input_tokens, output_tokens from phases where adw_id=? order by seq",
          )
          .all(adwId);
        expect(phases.map((p) => p.name)).toEqual(["plan", "build", "test"]);
        expect(phases.every((p) => p.status === "success")).toBe(true);

        // M-074: agentic steps (plan, build) narrow to kind='agent'; the code
        // step (test) narrows to kind='code' — the narrowed StepKind type
        // round-tripping through a REAL run, not just a unit test.
        const [planPhase, buildPhase, testPhase] = phases;
        expect(planPhase?.kind).toBe("agent");
        expect(buildPhase?.kind).toBe("agent");
        expect(testPhase?.kind).toBe("code");

        // M-074: run.ts now populates output_summary (from the envelope's own
        // `summary` field) and per-step token columns for real agent steps —
        // confirmed here against a real agent turn, not a mocked one.
        expect(planPhase?.output_summary).toBe(result.plan.summary);
        expect(buildPhase?.output_summary).toBe(result.build.summary);
        expect(planPhase?.input_tokens).toBeGreaterThan(0);
        expect(planPhase?.output_tokens).toBeGreaterThan(0);
        expect(buildPhase?.input_tokens).toBeGreaterThan(0);
        expect(buildPhase?.output_tokens).toBeGreaterThan(0);

        const eventTypes = tracer.db
          .query<{ type: string; phase_id: string }, [string]>(
            "select type, phase_id from events where adw_id=? order by rowid",
          )
          .all(adwId);
        // phase_start must precede phase_end within each phase, in event order.
        const seenStart = new Set<string>();
        for (const e of eventTypes) {
          if (e.type === "phase_start") seenStart.add(e.phase_id);
          if (e.type === "phase_end") expect(seenStart.has(e.phase_id)).toBe(true);
        }
        expect(eventTypes.some((e) => e.type === "gate_pass")).toBe(true);
        expect(eventTypes.some((e) => e.type === "error")).toBe(false);

        const testGate = tracer.db
          .query<{ passed: number; gate: string }, [string]>(
            "select passed, gate from gate_results where adw_id=? and gate='tests_pass'",
          )
          .get(adwId);
        expect(testGate?.passed).toBe(1);

        // M-071: project_cwd records the WORKTREE path this run actually used
        // (opts.cwd, unchanged on the resume path) — the durable record a
        // human resuming a blocked/failed run would look up (see
        // planBuildTest.ts's sessionId doc comment).
        const sessionRow = tracer.db
          .query<{ status: string; project_cwd: string }, [string]>(
            "select status, project_cwd from sessions where adw_id=?",
          )
          .get(adwId);
        expect(sessionRow?.status).toBe("success");
        expect(sessionRow?.project_cwd).toBe(WORKTREE_PATH);
      } finally {
        // Clean up the pi-web session this chain started, regardless of
        // outcome, so this test doesn't leave scratch sessions on the
        // shared server — same archive-then-delete pattern
        // piwebClient.integration.test.ts already established (M-062).
        // Runs LAST, after every assertion above (including the live
        // `GET /sessions/:id/status` check) has already had a chance to
        // observe the still-live session.
        await fetch(`${DEFAULT_BASE_URL}/sessions/${result.sessionId}/archive`, { method: "POST" }).catch(
          () => undefined,
        );
        await fetch(`${DEFAULT_BASE_URL}/sessions/${result.sessionId}?cwd=${encodeURIComponent(WORKTREE_PATH)}`, {
          method: "DELETE",
        }).catch(() => undefined);
      }
    },
    { timeout: 600_000 },
  );
});
