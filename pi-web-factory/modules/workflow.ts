/**
 * workflow.ts: the generic Workflow interpreter — replaces
 * "one hand-written TS file per chain shape" (`chains/planBuildTest.ts`,
 * left in place as a historical/independent third option) with ONE runner
 * that walks any `Workflow` definition (`workflowDef.ts`) against the Roles
 * registry (`roles.ts`), generically.
 *
 * Does, generically, exactly what `planBuildTest.ts` does by hand:
 *   - registers the target repo as a pi-web Project, creates this run's own
 *     worktree (skipped on resume — `worktree.ts`/`piwebProject.ts` reused
 *     directly, not reimplemented, same as planBuildTest.ts).
 *   - starts (or resumes) ONE session, threaded through every Step in order.
 *   - for an `agent` Step: resolves the Role, builds the real prompt (task
 *     text + `{{stepName.field}}` interpolation from prior steps' envelopes +
 *     the role marker), calls `run.ts`'s `runAgentPhase`, and branches
 *     on its discriminated result exactly like `planBuildTest.ts`'s
 *     `toChainOutcome` does (ported/generalized here as `toRunOutcome`).
 *   - for a `code` Step: resolves the Role, calls `role.run(project, cwd)`,
 *     traces the GateReport as `gate_pass`/`gate_fail` (same pattern
 *     `planBuildTest.ts`'s hand-written test phase already established), and
 *     treats a failing gate as a distinct, real Workflow Run outcome — never
 *     silently continuing past it.
 *   - for a `loop` Step: runs its inner steps in order, up to `max_rounds`
 *     times, checking `until` against the named inner step's most-recently-
 *     parsed envelope after each full round. Satisfied -> continue past the
 *     loop. Exhausted -> a genuinely distinct outcome, `"loop-exhausted"`
 *     (never silently folded into "success" or a generic "failed" — same
 *     discipline `run.ts`'s own bounded parse-retry loop already
 *     established).
 *
 * ── {{stepName.field}} interpolation ─────────────────────────────────────
 * Deliberately narrow: a flat `Record<string, string>` built up as steps
 * complete (`"<stepName>.<envelopeField>" -> stringified value`), substituted
 * via one `String.replace` pass over `{{...}}` tokens — NOT a general
 * template engine (no conditionals, no loops, no expressions, no nested
 * paths beyond one field). An unresolved token (unknown step, unknown field,
 * or a step that hasn't run yet — e.g. referencing a LATER step, or a step
 * inside a loop from OUTSIDE that loop on a round that hasn't happened)
 * throws a clear `WorkflowError` naming the token, rather than silently
 * leaving `{{...}}` literal text in a live prompt sent to a real model.
 *
 * ── Session continuation ──────────────────────────────────────────────────
 * One pi-web session per Workflow Run, threaded through every Step exactly
 * as `planBuildTest.ts` does (design doc §3.2) — including every round of a
 * loop's repeated inner steps (a loop step is NOT a fresh session per round,
 * it's the same session getting corrected and re-prompted, same spirit as
 * `run.ts`'s own retry-on-parse-failure loop operating within one session).
 *
 * ── Per-step tracing ─────────────────────────────────────────────
 * Agent steps: `run.ts`'s `runAgentPhase` already writes phase_start/
 * agent_start/agent_end/gate_pass|fail/phase_end, including per-step
 * token/output_summary columns — nothing extra needed here beyond calling it
 * (confirmed by reading run.ts in full, module header there). Code steps:
 * THIS module is responsible for tracing (`phase_start`/`gate_pass|fail`/
 * `phase_end`, `output_summary` built from the GateReport's checks), since a
 * code Role's `run()` returns a bare `GateReport` with no tracing of its own.
 */

import { randomUUID } from "node:crypto";
import type { ReviewOutput } from "./envelopes.ts";
import { DEFAULT_BASE_URL, startSession, roleMarker, getStatus } from "./piwebClient.ts";
import { agentRoleFor, codeRoleFor, type RolesConfig } from "./roles.ts";
import { Tracer, deriveTitleFromPrompt, type GateReport } from "./tracer.ts";
import { runAgentPhase, type RunAgentPhaseResult, type RunAgentPhaseOptions } from "./run.ts";
import type { ZodType } from "zod";
import type { PermissionsResult } from "./permissions.ts";
import { ensureProjectRegistered, resolveWorkspaceId } from "./piwebProject.ts";
import { assertDurableProjectPath, assertRealRepoRoot, createRunWorktree, resolveMainCheckoutPath } from "./worktree.ts";
import { envelopeSchemas, type AgentIdentity } from "./envelopes.ts";
import { projectConfigFor } from "./config.ts";
import { currentHeadSha, currentBranchName } from "./stepArtifact.ts";
import type { Step, Workflow, AgentStep, CodeStep, LoopStep } from "./workflowDef.ts";

export class WorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowError";
  }
}

// ── Options / result shapes (generalizes PlanBuildTestOptions/Result) ─────

export interface WorkflowRunOptions {
  tracer: Tracer;
  config: RolesConfig;
  workflow: Workflow;
  /** Absolute path to the target project's working tree — main checkout or an existing worktree of it (see chains/planBuildTest.ts's identical option for full reasoning, ported verbatim here). */
  cwd: string;
  /** The task description handed to the FIRST agent step (subsequent agent steps get their own step-authored `prompt`, with interpolation applied). */
  taskPrompt: string;
  /** Local filesystem cwd for a code step's shell-out gate, when it must differ from the session cwd. Defaults to sessionCwd. See planBuildTest.ts's identical `testCwd` option. */
  testCwd?: string;
  baseUrl?: string;
  /** adwId to use; a fresh one is minted when omitted. */
  adwId?: string;
  /** Existing pi-web session to resume — worktree creation is skipped, exactly as planBuildTest.ts's sessionId option documents. */
  sessionId?: string;
  /** Overrides resolveMainCheckoutPath(opts.cwd) — see planBuildTest.ts's identical option. */
  mainCheckoutPath?: string;
  engineer?: string;
  /**
   * The ticket this run belongs to. Omitted -> a fresh internal
   * ticket is minted (`ticket.ts`'s `mintOrAttachTicket`, via
   * `Tracer.sessionStart`). Passed -> this run attaches to that ticket
   * (creating its row if the id is novel — e.g. an external `.fleet` id
   * seen for the first time). Every run belongs to exactly one ticket,
   * always — see schema.ts's module header and ticket.ts.
   */
  ticketId?: string;
  /** Forwarded verbatim to every agent Step's `runAgentPhase` call (run.ts's own `waitOptions`) — mainly for tests, so a Step's `waitForCompletion` timeout can be exercised without a real multi-minute wait. */
  waitOptions?: { timeoutMs?: number; pollIntervalMs?: number; forcePollOnly?: boolean };
  /** Overrides for the circuit-breaker retry (max retries / backoff) — mainly for tests, so a real 15-minute backoff is never exercised in the test suite. Omitted in production, where the documented defaults (DEFAULT_MAX_STEP_RETRIES / STEP_RETRY_BACKOFF_MS) apply. */
  circuitBreaker?: CircuitBreakerOptions;
}

export interface WorkflowRunLinkInfo {
  projectId: string;
  workspaceId: string | undefined;
  cwd: string;
}

export type WorkflowRunResult =
  | {
      status: "success";
      adwId: string;
      sessionId: string;
      link: WorkflowRunLinkInfo;
      /** Every completed step's parsed envelope / gate report, by step name — the final state of the interpolation map's underlying data. */
      steps: Record<string, unknown>;
    }
  | {
      status: "blocked-on-human";
      adwId: string;
      sessionId: string;
      step: string;
      pendingAsk: unknown;
      link: WorkflowRunLinkInfo;
    }
  | {
      status: "failed";
      adwId: string;
      sessionId: string;
      step: string;
      reason: string;
      link: WorkflowRunLinkInfo;
    }
  | {
      status: "unparseable";
      adwId: string;
      sessionId: string;
      step: string;
      lastReport: GateReport;
      /** The agent's actual last-attempt response text that failed to parse (capped — see run.ts's truncateRawResponse) — what lets a human see roughly what the agent said and judge why it didn't parse. */
      rawResponse: string;
      link: WorkflowRunLinkInfo;
    }
  | {
      status: "permissions-violation";
      adwId: string;
      sessionId: string;
      step: string;
      permissions: PermissionsResult;
      link: WorkflowRunLinkInfo;
    }
  | {
      status: "gate-failed";
      adwId: string;
      sessionId: string;
      step: string;
      report: GateReport;
      link: WorkflowRunLinkInfo;
    }
  | {
      status: "loop-exhausted";
      adwId: string;
      sessionId: string;
      /** The loop step's own name. */
      step: string;
      rounds: number;
      link: WorkflowRunLinkInfo;
    }
  | {
      status: "review-rejected";
      adwId: string;
      sessionId: string;
      /** The rejected review step's own name (first one found, in step-definition order — see the check that produces this in runWorkflow). */
      step: string;
      review: ReviewOutput;
      link: WorkflowRunLinkInfo;
    };

// ── {{stepName.field}} interpolation ────────────────────────────────────

const INTERPOLATION_TOKEN = /\{\{\s*([\w-]+)\.([\w-]+)\s*\}\}/g;

/**
 * Flat `"<stepName>.<field>" -> stringified value` map, built up as agent
 * steps complete. Deliberately flat/string-only (module header's "narrow,
 * NOT a general template engine" note) — an envelope field that's itself an
 * array/object stringifies via `JSON.stringify` rather than being excluded,
 * so referencing e.g. `{{review.blocking}}` still produces SOMETHING
 * readable in a corrective prompt, not a silent drop.
 */
export type InterpolationContext = Map<string, string>;

/** Records one completed step's envelope fields into the interpolation context, flattened one level deep. */
export function recordStepEnvelope(ctx: InterpolationContext, stepName: string, envelope: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(envelope)) {
    const rendered = typeof value === "string" ? value : JSON.stringify(value);
    ctx.set(`${stepName}.${field}`, rendered);
  }
}

/**
 * Substitutes every `{{stepName.field}}` token in `text` against `ctx`.
 * Throws `WorkflowError` naming the exact unresolved token on any miss —
 * never silently leaves `{{...}}` literal text in a prompt sent to a real
 * model (module header comment).
 */
export function interpolate(text: string, ctx: InterpolationContext): string {
  return text.replace(INTERPOLATION_TOKEN, (full, stepName: string, field: string) => {
    const key = `${stepName}.${field}`;
    const value = ctx.get(key);
    if (value === undefined) {
      throw new WorkflowError(
        `unresolved interpolation token ${full} — no completed step named ${JSON.stringify(stepName)} ` +
          `has produced a ${JSON.stringify(field)} field yet (steps run in order; a token can only ` +
          `reference an EARLIER step, never a later one or itself)`,
      );
    }
    return value;
  });
}

// ── correction message for a loop's rejected round ─────────────────────

/**
 * Builds a correction message for the NEXT round of a loop, naming exactly
 * what the review found wrong — same "name exactly what was wrong"
 * discipline `run.ts`'s `buildCorrectionMessage` established for parse
 * failures, adapted here for a chain-level (Step-sequence) rejection rather
 * than a single phase's parse failure (module header comment: this is a
 * genuinely different mechanism, not a reuse of that one).
 */
export function buildLoopCorrectionMessage(reviewEnvelope: ReviewOutput, nextStepPrompt: string): string {
  const blocking = reviewEnvelope.blocking.length > 0 ? reviewEnvelope.blocking : ["(no specific blocking items listed)"];
  const unmetFindings = reviewEnvelope.findings.filter((f) => !f.met);
  const findingsText =
    unmetFindings.length > 0
      ? unmetFindings.map((f) => `- ${f.requirement}: ${f.evidence || "not met"}`).join("\n")
      : "(no specific unmet requirements listed)";
  return (
    `Your previous attempt was reviewed and NOT approved. Specifically:\n\n` +
    `Blocking:\n${blocking.map((b) => `- ${b}`).join("\n")}\n\n` +
    `Unmet requirements:\n${findingsText}\n\n` +
    `Address every item above, then continue with the task:\n\n${nextStepPrompt}`
  );
}

// ── outcome mapping (generalizes planBuildTest.ts's toChainOutcome) ───────

function toRunOutcome(
  adwId: string,
  sessionId: string,
  stepName: string,
  link: WorkflowRunLinkInfo,
  result: RunAgentPhaseResult<(typeof envelopeSchemas)[AgentIdentity]>,
): WorkflowRunResult | undefined {
  if (result.status === "blocked-on-human") {
    return { status: "blocked-on-human", adwId, sessionId, step: stepName, pendingAsk: result.pendingAsk, link };
  }
  if (result.status === "error") {
    return { status: "failed", adwId, sessionId, step: stepName, reason: result.reason, link };
  }
  if (result.status === "unparseable") {
    return { status: "unparseable", adwId, sessionId, step: stepName, lastReport: result.lastReport, rawResponse: result.rawResponse, link };
  }
  if (result.status === "permissions-violation") {
    return { status: "permissions-violation", adwId, sessionId, step: stepName, permissions: result.permissions, link };
  }
  return undefined; // "success" — caller continues
}

/** Resolves an agent step's envelope schema — every agent Role name in this codebase's shipped config also names an envelopeSchemas key (plan/build/review/scout/document); a step naming any other role fails clearly rather than guessing a schema. */
function envelopeSchemaForRole(roleName: string): (typeof envelopeSchemas)[AgentIdentity] {
  const schema = (envelopeSchemas as Record<string, (typeof envelopeSchemas)[AgentIdentity] | undefined>)[roleName];
  if (!schema) {
    throw new WorkflowError(
      `agent step names role ${JSON.stringify(roleName)}, which has no matching envelope schema in envelopes.ts's ` +
        `registry (available: ${Object.keys(envelopeSchemas).join(", ")}) — every agent Role's name must also be an ` +
        `envelopeSchemas key so the interpreter knows which schema to parse its output against`,
    );
  }
  return schema;
}

/**
 * Structural check for "does this envelope look like a ReviewOutput" —
 * shared by `runLoopStep` (deciding whether a not-satisfied `until` envelope
 * is a review it can build a correction message from) and `runWorkflow`'s
 * final review-rejected check. Deliberately structural (`approved`
 * boolean + `findings`/`blocking` arrays present), not a role-name check —
 * a `review` Step's role is always named "review" in every shipped Workflow,
 * but this keeps the interpreter correct for a future Workflow that names
 * its review-shaped step something else.
 */
function isReviewEnvelope(envelope: unknown): envelope is ReviewOutput {
  if (!envelope || typeof envelope !== "object") return false;
  const e = envelope as Record<string, unknown>;
  return typeof e["approved"] === "boolean" && Array.isArray(e["findings"]) && Array.isArray(e["blocking"]);
}

/** Builds a short output_summary for a code step's phase_end from its GateReport — "N/M checks passed" on success, the first failing check's note on failure. */
function summarizeGateReport(report: GateReport): string {
  const total = report.checks.length;
  const passed = report.checks.filter((c) => c.ok).length;
  if (passed === total) return `${String(passed)}/${String(total)} checks passed`;
  const firstFailure = report.checks.find((c) => !c.ok);
  return firstFailure ? `${firstFailure.item}: ${firstFailure.note ?? "failed"}` : `${String(passed)}/${String(total)} checks passed`;
}

// ── the interpreter ──────────────────────────────────────────────────────

interface RunContext {
  tracer: Tracer;
  config: RolesConfig;
  baseUrl: string;
  adwId: string;
  sessionId: string;
  sessionCwd: string;
  testCwd: string;
  link: WorkflowRunLinkInfo;
  interpolation: InterpolationContext;
  /** Every completed step's raw envelope/report, by step name — becomes WorkflowRunResult.steps on success. */
  stepResults: Record<string, unknown>;
  /** Tracks whether setModel has been called on this session yet (planBuildTest.ts's modelAlreadySet semantics, generalized: only the FIRST step to touch the session needs to set its model — every step after re-sets it too, since different steps commonly use different Roles/models; see runStepSeq below). */
  seq: number;
  /** The Workflow Run's original top-level task prompt — see taskPromptInjected below. */
  taskPrompt: string;
  /**
   * Whether `taskPrompt` has already been prefixed onto some agent step's
   * prompt yet. Lives on `ctx` (not a closure-local in `runSteps`, and NOT
   * re-derived per call site) specifically because `runAgentStep` is called
   * from TWO places — the top-level `runSteps` loop AND `runLoopStep`'s inner
   * loop — and the very first agent step of a Workflow could, in principle,
   * be inside a loop (neither of today's two shipped Workflows happens to
   * start that way, but the interpreter has to be correct for one that does,
   * not just for the two it ships with). Checked/set inside `runAgentStep`
   * itself so both call sites go through the exact same logic — see that
   * function, not here, for where the prefixing actually happens.
   */
  taskPromptInjected: boolean;
  /**
   * The phaseId of whatever Step is CURRENTLY open (a `phase_start` has been
   * traced but its terminal `phase_end` has not yet been written), or
   * `undefined` when no Step is open (between steps, or before the first
   * step has started). `runAgentStep`/`runCodeStep` both know
   * their own phaseId transiently, but a top-level catch-all around the
   * whole run (see `runWorkflow`'s try/catch) needs to know it too, to close
   * out whichever Step was open at the moment an uncaught exception hit —
   * e.g. a `PiWebClientError` thrown by `setModel`/`sendPrompt` BEFORE
   * `waitForCompletion` resolves, which would otherwise leave the row
   * `status: 'running'` forever.
   * Set right before a Step's `phase_start` is traced, cleared right after
   * its `phase_end` is traced — so it's accurate at every point in between,
   * including inside `runLoopStep`'s inner steps.
   */
  openPhase: { phaseId: string; stepName: string } | undefined;
  /** Forwarded to every agent Step's runAgentPhase call — see WorkflowRunOptions.waitOptions's own doc comment. */
  waitOptions: { timeoutMs?: number; pollIntervalMs?: number; forcePollOnly?: boolean } | undefined;
  /** Circuit-breaker retry overrides — see WorkflowRunOptions.circuitBreaker's own doc comment. */
  circuitBreaker: CircuitBreakerOptions | undefined;
}

// ── Circuit-breaker retry on a timeout-class Step error ───────────────────
//
// Chris's decision, verbatim: "I would be inclined to starting the timeout
// at 30m and then retrying with a 15m backoff and max retry count before
// eventually failing the workflow/session." The 30-minute timeout itself
// lives in piwebClient.ts's DEFAULT_WAIT_FOR_COMPLETION_TIMEOUT_MS — what
// lives HERE is the circuit breaker for the case a Step is genuinely stuck
// (not just slow), layered on top of that patience rather than replacing it.
//
// Scope: only `status: "error"` results from runAgentPhase (a waitForCompletion
// timeout, or any other error that wait-loop can return — e.g. a connection
// failure; both are already lumped into one "error" status upstream, see
// run.ts's RunAgentPhaseResult, so there is no finer-grained signal to retry
// on selectively). `blocked-on-human` is explicitly excluded — it stays
// always-terminal, unrelated to this mechanism — and so are
// unparseable/permissions-violation (already have their OWN bounded
// retry/rejection handling, must keep working exactly as today).

/** Bound on circuit-breaker retries after an initial `status: "error"` Step result, before the run fails for real. A tuning knob, not a design question — 2 additional attempts (3 total) is a sane default: enough to ride out one or two truly transient blips without turning a genuinely dead backend into a multi-hour hang (2 retries * 15min backoff + up to 2 extra 30min waits ~= 2 hours worst case). Overridable for tests. */
export const DEFAULT_MAX_STEP_RETRIES = 2;

/** Backoff before a circuit-breaker retry attempt — Chris's explicit number ("retrying with a 15m backoff"). Overridable for tests (real 15-minute waits are never exercised in the test suite). */
export const STEP_RETRY_BACKOFF_MS = 15 * 60 * 1000;

/**
 * The reasonable default is to check whether the original session/generation
 * is still reachable/in-flight before starting a new one: best-effort check
 * via `getStatus` — reachable (the call succeeds at all) is read as "the
 * session is still alive," regardless of whether it's still streaming or
 * has already settled, since either way the SAME session can be re-prompted
 * safely (re-prompting a settled session is exactly what run.ts's own
 * retry-on-parse-failure loop already does routinely). Only an outright
 * failure to reach pi-web at all (network error, session genuinely gone —
 * a 404/expired session) is read as "dead," per the rule of falling back to
 * a fresh attempt only if the original session is confirmed dead/unreachable.
 * Never throws.
 */
async function sessionIsReachable(baseUrl: string, sessionId: string, cwd: string): Promise<boolean> {
  try {
    await getStatus(baseUrl, sessionId, cwd);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface CircuitBreakerOptions {
  maxRetries?: number;
  backoffMs?: number;
  /** Test hook — skips the real backoff sleep, still exercises every other branch. */
  skipBackoffSleep?: boolean;
}

/**
 * Wraps one `runAgentPhase` call with the circuit breaker: on a
 * `status: "error"` result (only), waits `backoffMs` (Chris's 15-minute
 * default), checks whether the original session is still reachable
 * (`sessionIsReachable` — same session/worktree/branch, no wasted work),
 * re-sends the SAME prompt against that session
 * (a fresh `adwId`/worktree is deliberately NOT minted here — this is a
 * WITHIN-run Step retry, a different mechanism from the BETWEEN-runs
 * `retries` budget, which mints a brand new adwId; conflating the two would
 * silently change what "resume" means for this codebase's one-worktree-per-
 * run model), and repeats up to `maxRetries` additional attempts. Every
 * retry attempt (including the reachability check's own outcome) is traced
 * as a `log` event — both for human visibility and, concretely, to keep
 * this Step's `phases` row looking recently-active to the orchestrator's
 * reconciliation sweep (`RECONCILE_STALE_MS` staleness proxy) across
 * the backoff window, so a Step legitimately waiting out a 15-minute
 * backoff is never mistaken for an abandoned run and force-failed out from
 * under itself. Any non-"error" result (success, blocked-on-human,
 * unparseable, permissions-violation) is returned immediately on the FIRST
 * attempt, unaffected — this wrapper only ever changes behavior for the
 * `status: "error"` case.
 */
async function runAgentPhaseWithCircuitBreaker<Schema extends ZodType>(
  ctx: RunContext,
  step: AgentStep,
  phaseArgs: Omit<RunAgentPhaseOptions<Schema>, "seq">,
  opts: CircuitBreakerOptions = {},
): Promise<RunAgentPhaseResult<Schema>> {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_STEP_RETRIES;
  const backoffMs = opts.backoffMs ?? STEP_RETRY_BACKOFF_MS;

  let attempt = 0;
  for (;;) {
    ctx.seq += 1;
    const result = await runAgentPhase({ ...phaseArgs, seq: ctx.seq });
    if (result.status !== "error") return result;

    if (attempt >= maxRetries) {
      ctx.tracer.event({
        adwId: ctx.adwId,
        phaseId: phaseArgs.phaseId,
        type: "log",
        name: "circuit_breaker_exhausted",
        payload: { attempt, maxRetries, reason: result.reason },
      });
      return result;
    }

    attempt += 1;
    ctx.tracer.event({
      adwId: ctx.adwId,
      phaseId: phaseArgs.phaseId,
      type: "log",
      name: "circuit_breaker_retry_scheduled",
      payload: { attempt, maxRetries, backoffMs, reason: result.reason, step: step.name },
    });

    if (!opts.skipBackoffSleep) await sleep(backoffMs);

    const reachable = await sessionIsReachable(ctx.baseUrl, ctx.sessionId, ctx.sessionCwd);
    ctx.tracer.event({
      adwId: ctx.adwId,
      phaseId: phaseArgs.phaseId,
      type: "log",
      name: "circuit_breaker_retry_starting",
      payload: { attempt, maxRetries, sameSession: reachable, step: step.name },
    });
    // `sessionIsReachable`'s doc comment: reachable -> re-prompt the SAME
    // session (avoid wasting whatever's still in flight, per the card's own
    // observed incident — the original request eventually succeeded).
    // Unreachable -> the session is confirmed dead; there's no separate
    // "mint a fresh session" fallback implemented here today, since
    // `run.ts`'s prompt/waitForCompletion pair is always addressed at a
    // specific sessionId supplied by the caller (workflow.ts's ctx.sessionId
    // — the one pi-web session threaded through this whole Workflow Run,
    // module header comment). Retrying the same call is still the correct
    // action even when unreachable: pi-web itself will surface the real
    // "session gone" error on the retry attempt (traced as its own `error`
    // event by run.ts), which is a clearer, more honest failure than this
    // wrapper silently fabricating a recovery path pi-web's own session
    // model doesn't support. Flagged here, not swallowed.
  }
}

/**
 * Runs one `agent` Step. Returns either the next interpolation-ready prompt
 * outcome (envelope recorded, caller continues) or a terminal
 * `WorkflowRunResult` to return immediately.
 */
async function runAgentStep(
  ctx: RunContext,
  step: AgentStep,
  promptTextOverride?: string,
): Promise<{ envelope: Record<string, unknown> } | WorkflowRunResult> {
  const role = agentRoleFor(ctx.config, step.role);
  const schema = envelopeSchemaForRole(step.role);
  const protectedFiles = ctx.config.defaults.protectedFiles;

  let rawPrompt = promptTextOverride ?? step.prompt;
  // The very first agent step of the WHOLE Workflow Run (top-level or nested
  // inside a loop — see ctx.taskPromptInjected's doc comment) is seeded with
  // the run's original task prompt, mirroring planBuildTest.ts's plan phase
  // (the only phase there seeded directly from opts.taskPrompt). Checked here
  // rather than by the caller so both call sites (runSteps, runLoopStep) are
  // correct without either needing to know about the other.
  if (!ctx.taskPromptInjected) {
    rawPrompt = `Task: ${ctx.taskPrompt}\n\n${rawPrompt}`;
    ctx.taskPromptInjected = true;
  }
  const promptText = interpolate(rawPrompt, ctx.interpolation);

  const phaseId = `${ctx.adwId}_${step.name}`;
  // Mark this Step "open" BEFORE runAgentPhase's own
  // phase_start write (it happens inside runAgentPhase, first thing) —
  // openPhase must already be accurate for the whole duration of this call,
  // including the window before phase_start lands, since runWorkflow's
  // catch-all needs to know which row to close out even if the very first
  // await inside runAgentPhase (setModel/sendPrompt) throws.
  //
  // Deliberately NOT cleared in a `finally` here: a `finally` in THIS
  // function would run (and clear ctx.openPhase) BEFORE an exception
  // propagates up to runWorkflow's own try/catch (inner finally always
  // finishes before an outer catch runs, per ordinary JS unwind order) —
  // which would blank out openPhase right before the one place that needs
  // to read it. Instead: cleared explicitly on every NON-throwing return
  // path below (both the terminal-outcome branch and the success branch),
  // so it's still accurate at the moment of a throw, and still correctly
  // reset to "nothing open" once this function returns normally.
  ctx.openPhase = { phaseId, stepName: step.name };
  // runAgentPhaseWithCircuitBreaker wraps the plain runAgentPhase
  // call with a bounded backoff-and-retry loop on a `status: "error"`
  // result only (a waitForCompletion timeout or similar) — see that
  // function's own doc comment for the full reasoning. It owns `ctx.seq`
  // incrementing itself (one increment per underlying runAgentPhase call,
  // including retries), so `seq` is intentionally omitted from phaseArgs
  // here.
  const result = await runAgentPhaseWithCircuitBreaker(
    ctx,
    step,
    {
      tracer: ctx.tracer,
      baseUrl: ctx.baseUrl,
      adwId: ctx.adwId,
      phaseId,
      cwd: ctx.sessionCwd,
      agent: role,
      sessionId: ctx.sessionId,
      // Every step re-sets the model explicitly: unlike planBuildTest.ts's
      // fixed two-agent shape, a generic Workflow's steps commonly alternate
      // between DIFFERENT Roles/models (e.g. bounded-build-review's
      // build/review/build alternation) — always setting it is correct and,
      // per run.ts's own doc comment, only wasteful (never incorrect) on the
      // rare step that happens to reuse the same model as its predecessor.
      modelAlreadySet: false,
      promptText,
      promptPrefix: roleMarker(step.role),
      envelopeSchema: schema,
      outputTypeName: step.role,
      protectedFiles,
      waitOptions: ctx.waitOptions,
    },
    ctx.circuitBreaker,
  );
  ctx.openPhase = undefined;

  const outcome = toRunOutcome(ctx.adwId, ctx.sessionId, step.name, ctx.link, result);
  if (outcome) return outcome;
  if (result.status !== "success") throw new WorkflowError(`unreachable: non-success agent step result without an outcome (step=${step.name})`);

  const envelope = result.envelope as Record<string, unknown>;
  recordStepEnvelope(ctx.interpolation, step.name, envelope);
  ctx.stepResults[step.name] = envelope;

  // Capture this Step's real output (branch/commit/PR) the moment it
  // succeeds — not just at run end — so a LATER Step's failure can never
  // erase visibility into what THIS Step actually accomplished. `branch` is
  // constant across the whole run (one worktree/branch per Workflow Run,
  // worktree.ts's own model); `commitSha` is read fresh per Step since an
  // agent Step commonly commits its own work before returning. `prUrl` is
  // always null today — no auto-PR Step exists yet in this codebase (see
  // stepArtifact.ts's own doc comment; forward-compatible with a future one).
  // Best-effort: currentBranchName/currentHeadSha never throw, so this
  // can't turn an otherwise-successful Step into a failure.
  ctx.tracer.stepArtifact(phaseId, {
    branch: currentBranchName(ctx.sessionCwd),
    commitSha: currentHeadSha(ctx.sessionCwd),
    prUrl: null,
  });

  return { envelope };
}

/** Runs one `code` Step. Returns either its GateReport (caller decides pass/fail) or a terminal result if the Role/config itself is unusable. */
async function runCodeStep(ctx: RunContext, step: CodeStep): Promise<{ report: GateReport } | WorkflowRunResult> {
  const role = codeRoleFor(ctx.config, step.role);
  const phaseId = `${ctx.adwId}_${step.name}`;
  ctx.seq += 1;

  ctx.tracer.event({
    adwId: ctx.adwId,
    phaseId,
    type: "phase_start",
    name: step.name,
    payload: { kind: "code", owner: role.name, description: `code role: ${role.function}`, seq: ctx.seq },
  });
  // This Step is now open (phase_start just traced) — see
  // ctx.openPhase's doc comment. Deliberately NOT cleared via `finally`
  // here — same reasoning as runAgentStep above: an inner `finally` would
  // run (and blank ctx.openPhase) before an exception ever reaches
  // runWorkflow's own catch. Cleared explicitly on every non-throwing
  // return path below instead.
  ctx.openPhase = { phaseId, stepName: step.name };

  // A code Role's own function (e.g. run-tests) is what pulls testCmd out
  // of the project's config (see roles.ts's CODE_ROLE_REGISTRY:
  // `testsPass(project.test ?? "", cwd)`), so this interpreter only needs
  // to supply the ProjectConfig itself, via the SAME project-local lookup
  // cli.ts/planBuildTest.ts's own testCmd derivation already established —
  // reused directly, not re-derived.
  const projectConfig = projectConfigFor(ctx.sessionCwd);

  // `run-tests`' own registered function computes
  // `project.test ?? ""` and hands THAT straight to `testsPass`, which
  // shells out via `sh -c ""` — an empty command that exits 0 and reads as
  // a silent "pass" rather than "not configured". A `.pi-web-factory.yaml`
  // that exists but omits `test:` must fail loudly here, exactly like
  // `planBuildTest.ts`'s own hand-written `if (!testCmd)` guard on its
  // equivalent code phase — not silently no-op through to a green gate.
  if (role.function === "run-tests" && !projectConfig.test) {
    const reason = "no test command configured for this project (add `test:` to .pi-web-factory.yaml)";
    ctx.tracer.event({
      adwId: ctx.adwId,
      phaseId,
      type: "phase_end",
      name: step.name,
      payload: { status: "fail", error: reason },
    });
    ctx.openPhase = undefined;
    return { status: "failed", adwId: ctx.adwId, sessionId: ctx.sessionId, step: step.name, reason, link: ctx.link };
  }

  const report = await role.run(projectConfig, ctx.testCwd);
  const passed = report.checks.every((c) => c.ok);
  const summary = summarizeGateReport(report);

  ctx.tracer.event({
    adwId: ctx.adwId,
    phaseId,
    type: passed ? "gate_pass" : "gate_fail",
    name: role.function,
    payload: { attempt: 1, checks: report.checks },
  });
  ctx.tracer.event({
    adwId: ctx.adwId,
    phaseId,
    type: "phase_end",
    name: step.name,
    payload: { status: passed ? "success" : "fail", outputSummary: summary, error: passed ? undefined : summary },
  });

  ctx.stepResults[step.name] = report;
  ctx.openPhase = undefined;

  if (!passed) {
    return {
      status: "gate-failed",
      adwId: ctx.adwId,
      sessionId: ctx.sessionId,
      step: step.name,
      report,
      link: ctx.link,
    };
  }
  return { report };
}

/**
 * Runs one `loop` Step. Returns undefined when the `until` condition was
 * satisfied (caller continues past the loop) or a terminal
 * `WorkflowRunResult` otherwise (loop-exhausted, or any inner step's own
 * terminal outcome).
 *
 * ── Condition check timing: after `until.step` runs, not only at round-end ──
 * The card's brief says "checking after each round" — this implementation
 * checks the moment `until.step` itself completes within a round (still
 * exactly ONE check per round, since `until.step` runs exactly once per
 * round) and, if satisfied, stops the round THERE rather than running the
 * rest of that round's steps pointlessly. Concretely, for
 * bounded-build-review's `[review, build-retry]` loop: if `review` approves
 * on round 1, `build-retry` never runs that round — re-implementing already-
 * approved work would be actively wrong, not merely wasteful. This is a
 * strictly more correct reading of "checking after each round," not a
 * looser one: the round's OUTCOME is still decided by `until.step`'s result
 * for that round, exactly once, in round order.
 *
 * ── Correction folding ────────────────────────────────────────────────────
 * Any agent step that runs AFTER `until.step` within a round, on a round
 * where the condition was NOT satisfied, gets `until.step`'s
 * blocking/unmet findings folded into its prompt as a correction (this
 * loop's own equivalent of run.ts's buildCorrectionMessage — see
 * buildLoopCorrectionMessage's doc comment for why it's a distinct
 * mechanism). Steps that run BEFORE `until.step` in a round (i.e. `until.step`
 * hasn't produced this round's verdict yet) never get a correction from a
 * round that hasn't happened yet — only from a PRIOR round's rejection.
 */
async function runLoopStep(ctx: RunContext, loop: LoopStep): Promise<WorkflowRunResult | undefined> {
  let pendingCorrection: ReviewOutput | undefined;

  for (let round = 1; round <= loop.max_rounds; round += 1) {
    let satisfiedThisRound = false;

    for (const inner of loop.steps) {
      if (inner.kind === "agent") {
        let promptOverride: string | undefined;
        if (pendingCorrection) {
          promptOverride = buildLoopCorrectionMessage(pendingCorrection, interpolate(inner.prompt, ctx.interpolation));
        }
        const result = await runAgentStep(ctx, inner, promptOverride);
        if ("status" in result) return result;
        // Once used, a correction only applies to the FIRST agent step that
        // runs after the rejection (e.g. bounded-build-review's
        // `build-retry`, immediately after `review`) — not re-applied to
        // every later step in the same round.
        pendingCorrection = undefined;
      } else {
        const result = await runCodeStep(ctx, inner);
        if ("status" in result) return result;
      }

      if (inner.name === loop.until.step) {
        const envelope = ctx.stepResults[loop.until.step] as Record<string, unknown> | undefined;
        const satisfied = envelope !== undefined && envelope[loop.until.field] === loop.until.equals;
        if (satisfied) {
          satisfiedThisRound = true;
          break; // stop this round's remaining steps — condition met
        }
        // Not satisfied: stash the until-step's envelope as the correction
        // source for whichever agent step runs next (this round or, if
        // until.step is the LAST inner step, the next round's first agent
        // step — same map either way, since pendingCorrection persists
        // across the round boundary until consumed).
        if (isReviewEnvelope(envelope)) {
          pendingCorrection = envelope;
        }
      }
    }

    if (satisfiedThisRound) return undefined; // caller continues past the loop
  }

  return {
    status: "loop-exhausted",
    adwId: ctx.adwId,
    sessionId: ctx.sessionId,
    step: loop.name,
    rounds: loop.max_rounds,
    link: ctx.link,
  };
}

/**
 * Runs one Workflow end to end — the generic replacement for
 * `chains/planBuildTest.ts`'s hand-written sequencing (module header
 * comment has the full breakdown). `sessionStart`/`sessionFinish` bracket
 * the whole run at the adwId level, same as planBuildTest.ts.
 *
 * ── Write-path catch-all ────────────────────────────────────────────────
 * `cli.ts` invokes this once per Workflow Run as a one-shot OS process (the
 * **job runner**, in this codebase's terminology — one job-runner process
 * per Workflow Run, no daemon/worker holds these runs once started). Without
 * this, ANY uncaught exception thrown before `runSteps` returns a
 * terminal result (e.g. a `PiWebClientError` 404 — a bad `--session-id`
 * makes `setModel`/`sendPrompt` throw before `waitForCompletion` is even
 * reached) propagates all the way up to `cli.ts`'s top-level
 * `main().catch()`, which only logs and exits non-zero — no
 * `phase_end`/`sessionFinish` write anywhere in that chain. Since
 * `tracer.ts` writes status incrementally (`phase_start` sets
 * `phases.status='running'`; only a LATER `phase_end` resolves it), a killed
 * mid-flight run would leave its `phases`/`sessions` rows stuck at
 * `'running'` forever.
 *
 * The `try/catch` below wraps this function's entire body from the moment
 * `ctx` (and therefore `ctx.openPhase`, threaded through `runAgentStep`/
 * `runCodeStep` — see `RunContext`'s doc comment) exists. On any uncaught
 * exception it writes a terminal `phase_end` (status `fail`) for whichever
 * Step was open at that moment, calls `tracer.sessionFinish(adwId, false)`
 * for the run, then RE-THROWS — `cli.ts`'s `main().catch()` still needs to
 * see the real error and exit non-zero (this is a write-path completeness
 * fix, not an error-swallowing one).
 *
 * This does NOT cover every way a process can die (SIGKILL, OOM-kill, a
 * container recreate killing the `docker exec` process, host reboot — none
 * of which give JS a chance to run a `catch` block at all). That class of
 * failure is covered separately by `orchestrator/server.ts`'s reconciliation
 * pass, which catches orphaned `running` rows from OUTSIDE the dead
 * process, on a timer, independent of whether any code here ever got to run.
 */
export async function runWorkflow(opts: WorkflowRunOptions): Promise<WorkflowRunResult> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const adwId = opts.adwId ?? `adw_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

  const mainCheckoutPath = opts.mainCheckoutPath ?? resolveMainCheckoutPath(opts.cwd);
  // Validate the resolved main checkout path BEFORE registering it as
  // a pi-web Project (a real, durable-side-effect POST) — not just before
  // `createRunWorktree` further down. Without this, a project path outside
  // every durable mount, or one that isn't a real single-repo root (e.g.
  // `/work` itself), would get REGISTERED with pi-web before either guard
  // ever ran — closing this ordering gap prevents a bad path from leaving
  // even a registration artifact behind, not just from getting as far as a
  // real worktree/branch.
  // `createRunWorktree` below still runs its own copy of these same checks
  // (defense in depth — cheap, idempotent, and the only guard that fires at
  // all on a resume path where worktree creation is skipped entirely).
  assertDurableProjectPath(mainCheckoutPath);
  assertRealRepoRoot(mainCheckoutPath);
  const { projectId } = await ensureProjectRegistered(baseUrl, mainCheckoutPath);

  let sessionCwd = opts.cwd;
  if (!opts.sessionId) {
    const worktree = createRunWorktree(mainCheckoutPath, adwId);
    sessionCwd = worktree.path;
  }

  const workspaceId = await resolveWorkspaceId(baseUrl, projectId, sessionCwd);
  const link: WorkflowRunLinkInfo = { projectId, workspaceId, cwd: sessionCwd };

  opts.tracer.sessionStart(adwId, {
    engineer: opts.engineer,
    projectCwd: sessionCwd,
    adwName: opts.workflow.name,
    ticketId: opts.ticketId,
    taskPromptForTicket: opts.taskPrompt,
  });
  opts.tracer.sessionRequest(adwId, opts.taskPrompt);
  opts.tracer.sessionSetTitle(adwId, deriveTitleFromPrompt(opts.taskPrompt));

  const ctx: RunContext = {
    tracer: opts.tracer,
    config: opts.config,
    baseUrl,
    adwId,
    // Placeholder until the real session exists below — overwritten before
    // any Step can run (nothing in this window can throw an error whose
    // catch-all handling depends on sessionId being real: openPhase is still
    // undefined here). Typed as a real `string` (not optional) because every
    // later reader of ctx.sessionId legitimately expects one.
    sessionId: opts.sessionId ?? "",
    sessionCwd,
    testCwd: opts.testCwd ?? sessionCwd,
    link,
    interpolation: new Map(),
    stepResults: {},
    seq: 0,
    taskPrompt: opts.taskPrompt,
    taskPromptInjected: false,
    openPhase: undefined,
    waitOptions: opts.waitOptions,
    circuitBreaker: opts.circuitBreaker,
  };

  try {
    const session = opts.sessionId
      ? { id: opts.sessionId }
      : await startSession(baseUrl, sessionCwd, `${adwId}:${opts.workflow.name}`);
    ctx.sessionId = session.id;

    // Task-prompt seeding for the Workflow's first agent step (top-level or
    // loop-nested) is handled inside runAgentStep itself via
    // ctx.taskPromptInjected — see that function and the field's own doc
    // comment. Every step after it uses its own authored `prompt`.
    const runSteps = async (steps: Step[]): Promise<WorkflowRunResult | undefined> => {
      for (const step of steps) {
        if (step.kind === "agent") {
          const result = await runAgentStep(ctx, step);
          if ("status" in result) return result;
        } else if (step.kind === "code") {
          const result = await runCodeStep(ctx, step);
          if ("status" in result) return result;
        } else {
          const result = await runLoopStep(ctx, step);
          if (result) return result;
        }
      }
      return undefined;
    };

    const terminal = await runSteps(opts.workflow.steps);
    if (terminal) {
      const ok = terminal.status === "success";
      opts.tracer.sessionFinish(adwId, ok);
      return terminal;
    }

    // Every step's agent phase parsed successfully and no other
    // terminal outcome fired (gate-failed/loop-exhausted/etc.) — but that
    // alone doesn't mean the run should report SUCCESS. Any review-shaped
    // step OUTSIDE a gating loop that came back approved: false must still
    // flip the run to a distinct failure-shaped status: a no-loop Workflow
    // (today just plan-build-review.yaml) has nothing else that reads
    // `approved`, so without this check a run whose last real signal was
    // "review rejected this" would silently report SUCCESS. Loop-internal
    // rejections never reach here — they already
    // returned "loop-exhausted" (satisfied) or got corrected mid-loop, see
    // runLoopStep. Scans stepResults in step-definition order (Object.entries
    // preserves insertion order) and flips on the FIRST rejected review
    // found — moot for today's single-review plan-build-review, but this is
    // the documented behavior for a future multi-review Workflow.
    for (const [name, envelope] of Object.entries(ctx.stepResults)) {
      if (isReviewEnvelope(envelope) && !envelope.approved) {
        const result: WorkflowRunResult = { status: "review-rejected", adwId, sessionId: ctx.sessionId, step: name, review: envelope, link };
        opts.tracer.sessionFinish(adwId, false);
        return result;
      }
    }

    opts.tracer.sessionFinish(adwId, true);
    return { status: "success", adwId, sessionId: ctx.sessionId, link, steps: ctx.stepResults };
  } catch (error) {
    // See this function's own doc comment above ("Write-path catch-all").
    const message = error instanceof Error ? error.message : String(error);
    if (ctx.openPhase) {
      opts.tracer.event({
        adwId,
        phaseId: ctx.openPhase.phaseId,
        type: "phase_end",
        name: ctx.openPhase.stepName,
        payload: { status: "fail", error: message, outputSummary: message },
      });
    }
    opts.tracer.sessionFinish(adwId, false);
    throw error;
  }
}
