/**
 * planBuildTest: plan -> build -> test -> done. The smallest chain that
 * exercises every module end to end (client, envelopes, gates, permissions,
 * config) — M-066 card, Plan item 2.
 *
 * Deliberately thin, mirroring upstream SSSF's own `adw_*.py` restraint
 * (40-180 lines, "don't let chains/ accumulate logic that belongs in one of
 * the four modules" — M-066 card). Sequencing/wiring only:
 *   - phase 0 ("setup", not traced as its own phase — see below): register
 *     the target repo as a pi-web Project (idempotent), create this run's
 *     own git worktree, resolve its pi-web workspace id. Worktree creation
 *     is skipped when resuming an existing session (`opts.sessionId` set) —
 *     a resumed run reuses whatever worktree/session its FIRST run already
 *     created; see `PlanBuildTestOptions.sessionId`'s doc comment for why
 *     that path can't be re-derived automatically, and what the caller must
 *     pass instead.
 *   - phase 1 ("plan", agent phase): the `plan` agent produces a PlanOutput
 *     envelope for a target task.
 *   - phase 2 ("build", agent phase): the `build` agent, continuing the SAME
 *     session (design doc §3.2: thread (sessionId, cwd) from phase N into
 *     phase N+1, don't mint a fresh session per phase), implements the task
 *     and produces a BuildOutput envelope.
 *   - phase 3 ("test", code phase — not an agent call): runs `testsPass`
 *     against the project's configured test command.
 *
 * `sessionStart`/`sessionFinish` bracket the whole chain at the adwId level,
 * per the design doc's execution pseudocode.
 *
 * ── Worktree-per-run (M-071) ─────────────────────────────────────────────
 * `opts.cwd` may be EITHER the project's main checkout OR any existing
 * worktree of it — `modules/worktree.ts`'s `resolveMainCheckoutPath` (`git
 * rev-parse --git-common-dir`) normalizes to the main checkout before
 * registering a pi-web Project or creating a new worktree, so callers never
 * need to track "which path is the main one" separately. What `opts.cwd`
 * is NOT, automatically, is what the agent's session/`permissions.ts`
 * operate on: the actual session `cwd` (`sessionCwd` below) is the
 * freshly-created worktree path (`createRunWorktree`) on a fresh run, or
 * `opts.cwd` unchanged on a resume — threaded through to both `startSession`
 * and every `runAgentPhase` call's own `cwd` (which is what
 * `permissions.ts`'s `snapshotRepoState`/`enforceWrites` diff) — so
 * permissions enforcement runs against the ISOLATED worktree a run actually
 * writes into, not the shared main checkout other runs/humans may be
 * touching concurrently. This is the entire point of per-run isolation
 * (design doc §6.4/§7.5, M-071 card): without threading the worktree path
 * into `runAgentPhase`'s `cwd`, permissions enforcement would silently
 * diff the wrong directory.
 *
 * ── Cleanup policy (M-071 card, Plan item 6 / "item 7" in the brief) ──────
 * This chain deliberately does NOT call `modules/worktree.ts`'s
 * `removeRunWorktree` anywhere, on any outcome (success, failure,
 * blocked-on-human, or a thrown exception) — the worktree a run creates is
 * left in place after the chain returns. Decided over the alternative
 * (auto-remove after `permissions.ts`'s enforcement has run) for one
 * concrete reason: pi-web-factory today is manually triggered, low-volume,
 * and this system's whole design leans on post-hoc inspectability —
 * `factory.db`'s trace rows, `pi-web`'s own session transcript, and now
 * also the worktree's actual on-disk file state and its own git history
 * (`git log`, `git diff` against the main checkout) are ALL still available
 * after a run ends, for a human to look at a failed/blocked run and
 * understand exactly what happened, or to `git worktree` browse a
 * SUCCESSFUL run's result before deciding whether to merge/push its branch.
 * Auto-removal would throw that away the instant the chain function
 * returns — including for `blocked-on-human` outcomes, where the whole
 * point of the pause is that a human hasn't looked yet.
 *
 * The tradeoff accepted: worktrees accumulate under
 * `<project>/.pi-web-factory-worktrees/` with no automatic sweep. This is
 * bounded in practice by the current manual-trigger volume (not a
 * background scheduler running thousands of unattended runs — design doc
 * §1.5 confirms nothing in this system runs autonomously today), and
 * `removeRunWorktree`/`worktree.ts`'s naming convention (`adwId`-keyed,
 * `pi-web-factory/` branch namespace) are already shaped to make a FUTURE
 * explicit sweep tool (e.g. "remove any worktree whose Workflow Run
 * finished successfully more than N days ago, per `factory.db`") a small,
 * separate addition — not something this card needs to build now. Ordering
 * is moot for the option that WAS picked (nothing removes a worktree while
 * `permissions.ts`'s diff against it could still be in flight, because
 * nothing removes it at all) — flagged here explicitly since the card's own
 * brief calls out ordering as the one way this choice could go wrong.
 */

import { randomUUID } from "node:crypto";
import { PlanOutputSchema, BuildOutputSchema, type BuildOutput, type PlanOutput } from "../modules/envelopes.ts";
import { testsPass } from "../modules/gates.ts";
import { DEFAULT_BASE_URL, startSession, roleMarker } from "../modules/piwebClient.ts";
import { agentRoleFor, type RolesConfig } from "../modules/roles.ts";
import { Tracer, deriveTitleFromPrompt, type GateReport } from "../modules/tracer.ts";
import { runAgentPhase, type RunAgentPhaseResult } from "../modules/run.ts";
import type { PermissionsResult } from "../modules/permissions.ts";
import { ensureProjectRegistered, resolveWorkspaceId } from "../modules/piwebProject.ts";
import { assertDurableProjectPath, assertRealRepoRoot, createRunWorktree, resolveMainCheckoutPath } from "../modules/worktree.ts";

export interface PlanBuildTestOptions {
  tracer: Tracer;
  config: RolesConfig;
  /**
   * Absolute path to the target project's working tree — either the main
   * checkout or any existing worktree of it (normalized internally via
   * `resolveMainCheckoutPath`, M-071). This is deliberately NOT necessarily
   * what the agent's session/`permissions.ts` operate on — see this file's
   * module docstring ("Worktree-per-run") for the full reasoning.
   */
  cwd: string;
  /** The task description handed to the `plan` agent. */
  taskPrompt: string;
  /** Test command to gate on. Falls back to `projectConfigFor(cwd).test` when omitted — pass explicitly for a project without a `<project>/.pi-web-factory.yaml` (e.g. a scratch test repo). */
  testCmd?: string;
  /**
   * Local filesystem cwd for the `testsPass` gate's `sh -c` shell-out
   * (`gates.ts`'s `testsPass(cmd, cwd)` requires a real, LOCAL directory —
   * `Bun.spawn` refuses to spawn a shell at a nonexistent `cwd`). Defaults
   * to `sessionCwd` (M-071: the run's own worktree — the co-located-
   * deployment case, pi-web-factory runs as a sibling process inside the
   * same container as the target project, design doc §2, so the worktree is
   * already local, and it's where the build phase's changes actually
   * landed, not the project's main checkout). Only needs overriding when
   * the agent's `cwd` is on a different machine than the factory process
   * itself (e.g. driving a container's project over the network from a dev
   * machine) and `testCmd` is itself a self-contained remote check (ssh/
   * docker exec/etc) that doesn't need a real local directory to run from.
   */
  testCwd?: string;
  baseUrl?: string;
  /** adwId to use; a fresh one is minted when omitted. */
  adwId?: string;
  /**
   * Existing pi-web session to resume (design doc §3.4's `WorkItem.session_id?`
   * — the seam a future ticket-queue worker/CLI `--session-id` flag threads
   * through). When provided, `startSession` is skipped entirely and this id is
   * used directly for both phases — piwebClient.ts's session routes resolve a
   * `(id, cwd)` pair generically regardless of which process minted it, so
   * resuming a session started by an earlier run (or even a different
   * process) works the same as continuing one just started in this call. A
   * fresh session is minted, as before, when omitted.
   *
   * ── M-071: what this means for worktree-per-run ─────────────────────────
   * WORKTREE CREATION is skipped when `sessionId` is provided — a resumed
   * run reuses the SAME worktree its first run already created, it never
   * gets a second one. Since this run's own `adwId` (a fresh one, minted
   * independently of `sessionId` — see `cli.ts`) can't be used to re-derive
   * that original worktree's path (pi-web has no `sessionId -> cwd` lookup
   * route that doesn't already require knowing `cwd`, confirmed against
   * `sessionRoutes.ts`'s `GET /sessions` — it takes `cwd` as a REQUIRED
   * query param, not an optional filter), **`opts.cwd` IS the worktree path
   * directly when resuming** — not the project's main checkout in this one
   * case. The original run's worktree path is recoverable from
   * `factory.db`'s `sessions.project_cwd` column for the ORIGINAL `adwId`
   * (every run's `sessionStart` records whatever `cwd` it actually used,
   * worktree or not — see this file's main body), or from that original
   * run's own printed deep-link/log line.
   *
   * PROJECT REGISTRATION (`ensureProjectRegistered`/`resolveWorkspaceId`)
   * is NOT skipped on resume — it still runs every call (cheap, idempotent
   * — see piwebProject.ts's own doc comment), since the printed deep-link
   * needs a real `projectId`/`workspaceId` regardless of whether this is a
   * fresh or resumed run. It resolves `opts.cwd`'s main checkout via
   * `resolveMainCheckoutPath` (a local `git rev-parse`) unless
   * `mainCheckoutPath` (below) is supplied directly.
   */
  sessionId?: string;
  /**
   * Overrides `resolveMainCheckoutPath(opts.cwd)`'s own local `git
   * rev-parse --git-common-dir` call — skip it entirely and use this path
   * directly for project registration. Two real uses: (1) a caller that
   * already knows the main checkout path (e.g. from a prior run's own
   * trace-db record) shouldn't have to pay for a redundant local git
   * shell-out to re-derive it; (2) test harnesses where the CALLING
   * process and the target repo's filesystem are on different machines
   * (`resolveMainCheckoutPath`'s local `spawnSync`/`existsSync`/
   * `realpathSync` calls require the path to exist from the calling
   * process's own vantage point — not always true for a test process,
   * even when it's true in production's colocated deployment, design doc
   * §2) — see `chains/planBuildTest.integration.test.ts`'s own doc comment
   * for the concrete case this exists for.
   */
  mainCheckoutPath?: string;
  engineer?: string;
  /** M-103: the ticket this run belongs to — see modules/workflow.ts's `WorkflowRunOptions.ticketId` for the full doc comment (identical semantics, ported here so this chain's runs get a ticket the same way the generic interpreter's do). */
  ticketId?: string;
}

export interface PlanBuildTestLinkInfo {
  /** pi-web Project id for `opts.cwd`'s resolved main checkout (M-071). */
  projectId: string;
  /** pi-web Workspace id for the worktree/cwd this run actually used (M-071). */
  workspaceId: string | undefined;
  /** The real filesystem path used as this run's session `cwd` — the worktree on a fresh run, `opts.cwd` unchanged on a resume. */
  cwd: string;
}

export type PlanBuildTestResult =
  | {
      status: "success";
      adwId: string;
      sessionId: string;
      plan: PlanOutput;
      build: BuildOutput;
      testReport: GateReport;
      link: PlanBuildTestLinkInfo;
    }
  | {
      status: "blocked-on-human";
      adwId: string;
      sessionId: string;
      phase: "plan" | "build";
      pendingAsk: unknown;
      link: PlanBuildTestLinkInfo;
    }
  | {
      status: "failed";
      adwId: string;
      sessionId: string;
      phase: "plan" | "build" | "test";
      reason: string;
      link: PlanBuildTestLinkInfo;
    }
  | {
      status: "unparseable";
      adwId: string;
      sessionId: string;
      phase: "plan" | "build";
      lastReport: GateReport;
      /** The agent's actual last-attempt response text that failed to parse (capped — see run.ts's truncateRawResponse) — what lets a human see roughly what the agent said and judge why it didn't parse. */
      rawResponse: string;
      link: PlanBuildTestLinkInfo;
    }
  | {
      status: "permissions-violation";
      adwId: string;
      sessionId: string;
      phase: "plan" | "build";
      permissions: PermissionsResult;
      link: PlanBuildTestLinkInfo;
    };

function toChainOutcome<Phase extends "plan" | "build">(
  adwId: string,
  sessionId: string,
  phase: Phase,
  link: PlanBuildTestLinkInfo,
  result: RunAgentPhaseResult<typeof PlanOutputSchema | typeof BuildOutputSchema>,
): PlanBuildTestResult | undefined {
  if (result.status === "blocked-on-human") {
    return { status: "blocked-on-human", adwId, sessionId, phase, pendingAsk: result.pendingAsk, link };
  }
  if (result.status === "error") {
    return { status: "failed", adwId, sessionId, phase, reason: result.reason, link };
  }
  if (result.status === "unparseable") {
    return { status: "unparseable", adwId, sessionId, phase, lastReport: result.lastReport, rawResponse: result.rawResponse, link };
  }
  if (result.status === "permissions-violation") {
    return { status: "permissions-violation", adwId, sessionId, phase, permissions: result.permissions, link };
  }
  return undefined; // "success" — caller continues
}

export async function planBuildTest(opts: PlanBuildTestOptions): Promise<PlanBuildTestResult> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const adwId = opts.adwId ?? `adw_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const testCmd = opts.testCmd;

  // ── M-071: register the Project, create this run's worktree ────────────
  // Worktree creation is skipped entirely on resume (opts.sessionId set) —
  // see PlanBuildTestOptions.sessionId's doc comment for why re-deriving the
  // ORIGINAL run's worktree isn't possible from sessionId alone, and why
  // opts.cwd is treated as the worktree path directly in that case instead.
  // Project registration always targets the MAIN checkout path
  // (resolveMainCheckoutPath), never opts.cwd directly — on a resume,
  // opts.cwd is typically already a worktree path, and registering a
  // worktree's own path as a separate pi-web Project would be wrong (see
  // that function's doc comment).
  const mainCheckoutPath = opts.mainCheckoutPath ?? resolveMainCheckoutPath(opts.cwd);
  // M-115: validate BEFORE registering with pi-web — see workflow.ts's
  // runWorkflow, the identical fix, for the full "why" (closing the
  // register-before-validate ordering gap that let /work-shaped paths get
  // registered as a pi-web Project before any guard ran). createRunWorktree
  // below still runs its own copy of these same checks (defense in depth).
  assertDurableProjectPath(mainCheckoutPath);
  assertRealRepoRoot(mainCheckoutPath);
  const { projectId } = await ensureProjectRegistered(baseUrl, mainCheckoutPath);

  let sessionCwd = opts.cwd;
  if (!opts.sessionId) {
    const worktree = createRunWorktree(mainCheckoutPath, adwId);
    sessionCwd = worktree.path;
  }

  const workspaceId = await resolveWorkspaceId(baseUrl, projectId, sessionCwd);
  const link: PlanBuildTestLinkInfo = { projectId, workspaceId, cwd: sessionCwd };

  // project_cwd records whatever cwd THIS run actually used (the new
  // worktree on a fresh run, opts.cwd unchanged on a resume) — this is the
  // durable, queryable record a human resuming a blocked-on-human/failed
  // run later can look up (`select project_cwd from sessions where
  // adw_id=?`) to recover the exact worktree path to pass back in as
  // `--project` on a `--session-id` resume (see sessionId's doc comment).
  opts.tracer.sessionStart(adwId, {
    engineer: opts.engineer,
    projectCwd: sessionCwd,
    adwName: "planBuildTest",
    ticketId: opts.ticketId,
    taskPromptForTicket: opts.taskPrompt,
  });
  opts.tracer.sessionRequest(adwId, opts.taskPrompt);
  opts.tracer.sessionSetTitle(adwId, deriveTitleFromPrompt(opts.taskPrompt));

  const planAgent = agentRoleFor(opts.config, "plan");
  const buildAgent = agentRoleFor(opts.config, "build");
  const protectedFiles = opts.config.defaults.protectedFiles;

  const session = opts.sessionId
    ? { id: opts.sessionId }
    : await startSession(baseUrl, sessionCwd, `${adwId}:planBuildTest`);
  // Every phase's prompt carries a role marker (M-069) so
  // pi-web-factory-prompts' before_agent_start hook can inject the right
  // role's true system prompt for THAT turn — see piwebClient.ts's
  // roleMarker doc comment. before_agent_start fires on every user prompt,
  // not just a session's first (confirmed against the pi-coding-agent
  // extensions.md lifecycle diagram), so this applies uniformly whether the
  // session is freshly started here or resumed via opts.sessionId — a
  // resumed session's next phase still needs its own role's system prompt
  // re-injected for its own turn. Passed as runAgentPhase's promptPrefix
  // (not pre-concatenated into promptText) so it also rides on every
  // retry-on-parse-failure correction within a phase, not just that phase's
  // first prompt — run.ts's promptPrefix doc comment explains why that
  // distinction matters here.

  // ── phase 1: plan ──────────────────────────────────────────────────────
  const planPromptText = `Task: ${opts.taskPrompt}\n\n` +
    `Reply with ONLY a single valid JSON object matching this schema (no prose, no markdown fences):\n` +
    `{"status": "success"|"fail", "summary": string, "artifacts": string[], ` +
    `"notes_for_next_agent": string, "commit_message": string}`;
  const planResult = await runAgentPhase({
    tracer: opts.tracer,
    baseUrl,
    adwId,
    phaseId: `${adwId}_plan`,
    seq: 1,
    cwd: sessionCwd,
    agent: planAgent,
    sessionId: session.id,
    modelAlreadySet: false,
    // Role identity ("you are the plan agent...") now comes from a true
    // system prompt (M-069), delivered via the role marker prefix below —
    // promptText itself is just the task, no more prepended role paragraph.
    promptText: planPromptText,
    promptPrefix: roleMarker("plan"),
    envelopeSchema: PlanOutputSchema,
    outputTypeName: "plan",
    protectedFiles,
  });

  const planOutcome = toChainOutcome(adwId, session.id, "plan", link, planResult);
  if (planOutcome) {
    opts.tracer.sessionFinish(adwId, false);
    return planOutcome;
  }
  if (planResult.status !== "success") throw new Error("unreachable: non-success plan result without an outcome");

  // ── phase 2: build (same session — continuation, not a fresh session) ──
  // Still marked (M-069): before_agent_start fires on EVERY prompt, not just
  // a session's first, so the build phase's turn needs its own role marker
  // to swap the injected system prompt from "plan" to "build" even though
  // it's the same underlying pi-web session/model-continuation.
  const buildPromptText =
    `Continuing from the plan you just produced, using your available tools, actually implement ` +
    `the task now (write real files to disk). Plan summary: ${planResult.envelope.summary}\n\n` +
    `Once done, reply with ONLY a single valid JSON object matching this schema (no prose, no markdown fences):\n` +
    `{"status": "success"|"fail", "summary": string, "artifacts": string[], ` +
    `"notes_for_next_agent": string, "changed_files": string[], "commit_message": string}`;
  const buildResult = await runAgentPhase({
    tracer: opts.tracer,
    baseUrl,
    adwId,
    phaseId: `${adwId}_build`,
    seq: 2,
    cwd: sessionCwd,
    agent: buildAgent,
    sessionId: session.id,
    modelAlreadySet: false, // different agent identity => different model, must be (re-)set
    promptText: buildPromptText,
    promptPrefix: roleMarker("build"),
    envelopeSchema: BuildOutputSchema,
    outputTypeName: "build",
    protectedFiles,
  });

  const buildOutcome = toChainOutcome(adwId, session.id, "build", link, buildResult);
  if (buildOutcome) {
    opts.tracer.sessionFinish(adwId, false);
    return buildOutcome;
  }
  if (buildResult.status !== "success") throw new Error("unreachable: non-success build result without an outcome");

  // ── phase 3: test (code phase — no agent call) ──────────────────────────
  const testPhaseId = `${adwId}_test`;
  opts.tracer.event({
    adwId,
    phaseId: testPhaseId,
    type: "phase_start",
    name: "test",
    payload: { kind: "code", owner: "gates.testsPass", description: testCmd ?? "(no test command configured)" },
  });

  if (!testCmd) {
    const reason = "no test command configured for this project (pass testCmd or add it to factory.config.yaml)";
    opts.tracer.event({
      adwId,
      phaseId: testPhaseId,
      type: "phase_end",
      name: "test",
      payload: { status: "fail", error: reason },
    });
    opts.tracer.sessionFinish(adwId, false);
    return { status: "failed", adwId, sessionId: session.id, phase: "test", reason, link };
  }

  const testReport = await testsPass(testCmd, opts.testCwd ?? sessionCwd);
  const testPassed = testReport.checks.every((c) => c.ok);

  opts.tracer.event({
    adwId,
    phaseId: testPhaseId,
    type: testPassed ? "gate_pass" : "gate_fail",
    name: "tests_pass",
    payload: { attempt: 1, checks: testReport.checks },
  });
  opts.tracer.event({
    adwId,
    phaseId: testPhaseId,
    type: "phase_end",
    name: "test",
    payload: { status: testPassed ? "success" : "fail" },
  });

  opts.tracer.sessionFinish(adwId, testPassed);

  if (!testPassed) {
    return {
      status: "failed",
      adwId,
      sessionId: session.id,
      phase: "test",
      reason: testReport.checks.find((c) => !c.ok)?.note ?? "tests failed",
      link,
    };
  }

  return {
    status: "success",
    adwId,
    sessionId: session.id,
    plan: planResult.envelope,
    build: buildResult.envelope,
    testReport,
    link,
  };
}
