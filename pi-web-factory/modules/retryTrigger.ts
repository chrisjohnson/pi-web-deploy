/**
 * retryTrigger.ts: the reconciliation-loop wiring for M-103's retry
 * mechanism — ties `retryDecision.ts`'s evidence-stack/decision-Role
 * together with a ticket's `retries` budget, invoked from
 * `orchestrator/server.ts`'s reconciliation pass (M-100's `reconcileStuckRuns`
 * infrastructure) after a run is marked `status='fail'`.
 *
 * ── STOPPED SHORT of actually spawning a new job-runner process ──────────
 * The card's Plan §5 says the trigger should "kick off the next attempt
 * (spawning a job-runner invocation the same way anything else does today —
 * `docker exec pi-web bun cli.ts ...`)". Investigated directly (M-103's own
 * Decision log has the full trail): `orchestrator/server.ts` runs inside the
 * `pi-web-factory-orchestrator` container (renamed from
 * `pi-web-factory-visualizer`, M-105 item 9 — same container, same
 * constraints described below, name only), a SEPARATE container from
 * `pi-web` (the one `cli.ts` needs to run co-located inside, since a
 * Workflow Run's git worktree/`testCmd` shell-outs are LOCAL filesystem
 * operations — `cli.ts`'s own module doc comment). `docker/docker-compose.yml`
 * confirms `pi-web-factory-orchestrator`'s service definition explicitly does NOT mount
 * `/var/run/docker.sock` (its own comment: "no docker.sock, no SSH key,
 * nothing this read-only server needs") — so this process has NO transport
 * to actually invoke `docker exec pi-web bun cli.ts ...` from where it runs
 * today. pi-web's own HTTP API has no generic command-execution route
 * either (confirmed: it's a coding-agent session server, not a job runner).
 *
 * This is a real, concrete infrastructure gap, not a soft judgment call —
 * per the card's own safety instruction ("if this turns out to be broken or
 * behaves nonsensically, STOP this phase... but still land Phases 1 and 2
 * ... and the evidence-stack/decision-Role code itself, which could still be
 * invoked manually"): `planNextAttempt` below computes the FULL decision
 * (evidence stack, decision-Role call, retries-budget check, the exact next
 * `cli.ts` invocation that SHOULD run) and is fully real, tested,
 * independently invokable code — it just stops one step short of actually
 * executing that invocation across a container boundary this process cannot
 * reach. `triggerRetryIfNeeded` (the function `server.ts`'s reconciliation
 * loop actually calls) computes the plan and LOGS the command a human/future
 * infra change would run, rather than silently no-op'ing OR unsafely
 * fabricating an exec path that doesn't exist. A future card wiring an
 * actual spawn mechanism (e.g. giving the orchestrator container docker.sock
 * access, or a small HTTP trigger endpoint inside `pi-web` itself) can swap
 * `triggerRetryIfNeeded`'s logging for a real `Bun.spawn`/`docker exec` call
 * without touching `planNextAttempt`'s own logic at all.
 *
 * ── Tracking which failed runs have already been decided ─────────────────
 * The reconciliation loop runs on every sweep (M-100: startup + periodic) —
 * without a dedup marker, the SAME failed run would get a fresh decision
 * call every single sweep forever. `hasBeenDecided` checks for the
 * `retry_decision` log event `retryDecision.ts`'s `traceRetryDecision`
 * already writes on the failed run's own adwId — a real trace-db row, not a
 * separate in-memory Set (which wouldn't survive the orchestrator process
 * restarting), so a decision is made AT MOST ONCE per failed run,
 * durably, regardless of process restarts between sweeps.
 */

import type { Database } from "bun:sqlite";
import { assembleEvidence, decideRetry, RetryDecisionError, traceRetryDecision, type RetryDecisionResult } from "./retryDecision.ts";
import type { RolesConfig } from "./roles.ts";
import type { Workflow } from "./workflowDef.ts";
import type { Tracer } from "./tracer.ts";

export interface FailedRunRow {
  adwId: string;
  ticketId: string | null;
  adwName: string | null;
  projectCwd: string | null;
}

/** Every `sessions` row currently `status='fail'` that has NOT yet had a retry decision recorded for it (`hasBeenDecided`). This is the reconciliation loop's own candidate list — it does not itself decide whether each one NEEDS a decision (missing ticket_id, unknown Workflow, etc. — see `planNextAttempt`, which handles those cases explicitly rather than filtering them out silently here). */
export function undecidedFailedRuns(db: Database): FailedRunRow[] {
  const rows = db
    .query<{ adw_id: string; ticket_id: string | null; adw_name: string | null; project_cwd: string | null }, []>(
      `SELECT s.adw_id, s.ticket_id, s.adw_name, s.project_cwd
       FROM sessions s
       WHERE s.status = 'fail'
         AND NOT EXISTS (
           SELECT 1 FROM events e WHERE e.adw_id = s.adw_id AND e.type = 'log' AND e.name = 'retry_decision'
         )`,
    )
    .all();
  return rows.map((r) => ({ adwId: r.adw_id, ticketId: r.ticket_id, adwName: r.adw_name, projectCwd: r.project_cwd }));
}

export type NextAttemptPlan =
  | {
      outcome: "retry" | "new-run";
      decision: RetryDecisionResult;
      /** The exact `cli.ts` invocation the next attempt should run — computed but NOT executed (see module header). */
      command: string[];
    }
  | { outcome: "give-up"; decision: RetryDecisionResult }
  | { outcome: "skipped"; reason: string };

/**
 * Computes the full next-attempt plan for one failed run: checks the
 * ticket's `retries` budget, assembles evidence, calls the decision Role,
 * and — if the decision is `retry`/`new-run` AND budget remains — builds
 * the exact `cli.ts` command line the next attempt should run. Never
 * executes anything itself (module header). Fully real/testable in
 * isolation from the actual spawn question.
 *
 * `outcome: "skipped"` covers every reason this run isn't eligible for an
 * automated decision at all (no ticket_id — a pre-M-103 row; unknown
 * Workflow name — can't look up a retries budget; retries budget already
 * exhausted by prior attempts) — a real, named outcome rather than silently
 * doing nothing, so a caller/test can distinguish "decided to give up" (the
 * decision Role's own considered judgment) from "never even asked" (this
 * run wasn't eligible for a decision in the first place).
 */
export async function planNextAttempt(opts: {
  db: Database;
  config: RolesConfig;
  workflows: Workflow[];
  failedRun: FailedRunRow;
  baseUrl?: string;
}): Promise<NextAttemptPlan> {
  const { db, config, workflows, failedRun } = opts;

  if (!failedRun.ticketId) {
    return { outcome: "skipped", reason: `run ${failedRun.adwId} has no ticket_id (pre-M-103 row) — cannot look up attempt history` };
  }
  if (!failedRun.projectCwd) {
    return { outcome: "skipped", reason: `run ${failedRun.adwId} has no project_cwd recorded — cannot resume/retry against an unknown project` };
  }
  const workflow = failedRun.adwName ? workflows.find((w) => w.name === failedRun.adwName) : undefined;
  if (!workflow) {
    return { outcome: "skipped", reason: `run ${failedRun.adwId}'s Workflow ${JSON.stringify(failedRun.adwName)} is not a known YAML Workflow — cannot look up a retries budget` };
  }

  // Budget check BEFORE the (real, model-costing) decision call — no point
  // asking a model to decide "retry" if there's no budget left to act on
  // that decision anyway.
  const priorAttempts = db
    .query<{ n: number }, [string, string]>("SELECT COUNT(*) as n FROM sessions WHERE ticket_id = ? AND adw_id != ?")
    .get(failedRun.ticketId, failedRun.adwId)?.n ?? 0;
  if (priorAttempts >= workflow.retries) {
    return { outcome: "skipped", reason: `ticket ${failedRun.ticketId} has already used its full retries budget (${String(priorAttempts)}/${String(workflow.retries)} additional attempts) — leaving for a human` };
  }

  let evidence;
  try {
    evidence = assembleEvidence(db, failedRun.adwId);
  } catch (error) {
    const detail = error instanceof RetryDecisionError ? error.message : String(error);
    return { outcome: "skipped", reason: `could not assemble evidence for ${failedRun.adwId}: ${detail}` };
  }

  const decision = await decideRetry({ baseUrl: opts.baseUrl, config, evidence, cwd: failedRun.projectCwd });

  if (decision.decision === "give-up") {
    return { outcome: "give-up", decision };
  }

  // Both "retry" and "new-run" always mint a brand-new adwId (verified
  // directly against cli.ts/workflow.ts — M-103's card, Plan §5: neither
  // path reuses the old trace row). The two differ ONLY in whether
  // --session-id is passed: "retry" resumes the SAME pi-web session
  // (--session-id + --project set to the OLD WORKTREE path — the real,
  // easy-to-get-wrong usage detail the card flags); "new-run" omits
  // --session-id entirely, which makes runWorkflow mint a fresh session AND
  // a fresh worktree off the project's own main checkout.
  const command =
    decision.decision === "retry"
      ? ["bun", "cli.ts", "--project", failedRun.projectCwd, "--workflow", workflow.name, "--session-id", evidence.adwId, "--ticket-id", failedRun.ticketId, evidence.taskPrompt]
      : ["bun", "cli.ts", "--project", failedRun.projectCwd, "--workflow", workflow.name, "--ticket-id", failedRun.ticketId, evidence.taskPrompt];

  return { outcome: decision.decision, decision, command };
}

/**
 * The reconciliation loop's own entry point (called from
 * `orchestrator/server.ts` after each sweep) — for every currently-undecided
 * failed run, computes its plan, records the decision (always — `give-up`
 * and `skipped` both get a durable record so they're never re-asked), and
 * LOGS the command a real trigger would run for `retry`/`new-run` (see
 * module header for why this doesn't execute it). Errors from any single
 * run's plan are caught and logged, never allowed to take down the sweep
 * for every OTHER failed run.
 */
export async function triggerRetryIfNeeded(opts: {
  db: Database;
  tracer: Tracer;
  config: RolesConfig;
  workflows: Workflow[];
  baseUrl?: string;
  log?: (message: string) => void;
}): Promise<{ decided: number; skipped: number }> {
  const log = opts.log ?? ((message: string) => console.log(message));
  const candidates = undecidedFailedRuns(opts.db);
  let decided = 0;
  let skipped = 0;

  for (const failedRun of candidates) {
    let plan: NextAttemptPlan;
    try {
      plan = await planNextAttempt({ db: opts.db, config: opts.config, workflows: opts.workflows, failedRun, baseUrl: opts.baseUrl });
    } catch (error) {
      log(`[retry-trigger] plan failed for ${failedRun.adwId}: ${error instanceof Error ? error.message : String(error)}`);
      skipped += 1;
      continue;
    }

    if (plan.outcome === "skipped") {
      skipped += 1;
      log(`[retry-trigger] ${failedRun.adwId}: skipped — ${plan.reason}`);
      continue;
    }

    traceRetryDecision(opts.tracer, failedRun.adwId, plan.decision);
    decided += 1;

    if (plan.outcome === "give-up") {
      log(`[retry-trigger] ${failedRun.adwId}: decision=give-up — ${plan.decision.reasoning}`);
      continue;
    }

    log(
      `[retry-trigger] ${failedRun.adwId}: decision=${plan.outcome} — ${plan.decision.reasoning} — ` +
        `NOT auto-executed (no spawn transport from this container, see retryTrigger.ts module header) — would run: ${plan.command.join(" ")}`,
    );
  }

  return { decided, skipped };
}
