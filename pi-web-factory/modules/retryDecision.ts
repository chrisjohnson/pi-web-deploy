/**
 * retryDecision.ts: the evidence-stack assembly + retry-vs-new-run-vs-
 * give-up decision (M-103, Plan §4/§5).
 *
 * ── Who calls this, and when ─────────────────────────────────────────────
 * Invoked AFTER a Workflow Run is already marked terminal `status='fail'` in
 * `factory.db` (either the normal write path — `run.ts`'s `failPhase`/
 * `workflow.ts`'s catch-all — or M-100's reconciliation pass). This module
 * reads that already-written state back OUT of the trace db via a plain
 * `bun:sqlite` handle — it does not itself run a Workflow or hold any
 * in-memory `WorkflowRunResult`, since the real caller (the orchestrator's
 * reconciliation loop, a separate process from whatever job-runner produced
 * the failure) only ever has the db to go on.
 *
 * ── Evidence stack: compact, NOT raw trace events ─────────────────────────
 * Per the card's explicit instruction ("NOT raw trace events — too noisy/
 * expensive to hand a model wholesale"), `assembleEvidence` builds a small,
 * purpose-built summary: the original task prompt, the terminal failure
 * reason, each Step's name/kind/status/one-line summary (never full
 * transcripts), and the ticket's full prior-attempt history (status + end
 * time per attempt, not full detail) — enough for the deciding model to
 * reasonably judge "is this attempt #2 or #5" without paying for (or being
 * distracted by) a full replay of every tool call.
 *
 * ── Decision Role: small/cheap model, narrow classification ──────────────
 * `decideRetry` calls a `kind: "agent"` Role (factory.config.yaml's
 * `decide-retry` entry) with the assembled evidence, parses its envelope
 * (`RetryDecisionOutputSchema`, envelopes.ts) into `{decision, reasoning}`.
 * This is DELIBERATELY not a hardcoded rule engine — the starting heuristics
 * from the card's Plan §5 live in the Role's own system prompt
 * (`prompts/decide-retry.md`) as guidance for the model to reason from, not
 * as branches in this TS code.
 */

import { Database } from "bun:sqlite";
import { RetryDecisionOutputSchema, type RetryDecisionOutput } from "./envelopes.ts";
import { jsonParses } from "./gates.ts";
import { runsForTicket, type TicketRunRow } from "./ticket.ts";
import type { AgentRole, RolesConfig } from "./roles.ts";
import { DEFAULT_BASE_URL, lastAssistantText, prompt as sendPrompt, roleMarker, setModel, startSession, waitForCompletion } from "./piwebClient.ts";
import type { Tracer } from "./tracer.ts";

// ── row shapes read directly from factory.db ────────────────────────────

interface SessionEvidenceRow {
  adw_id: string;
  request: string | null;
  status: string | null;
  ticket_id: string | null;
  project_cwd: string | null;
}

interface PhaseEvidenceRow {
  name: string | null;
  kind: string | null;
  status: string | null;
  error: string | null;
  output_summary: string | null;
  seq: number;
}

/** One Step's compact evidence — name/kind/status/one-line summary, never a full transcript. */
export interface StepEvidence {
  name: string;
  kind: string;
  status: string;
  /** The Step's own output_summary if it has one, else its error (both already short, human-written strings — never raw envelope/event payloads). */
  summary: string | null;
}

/** One PRIOR attempt's compact history entry — status + end time only, not full detail (the current failed run's OWN full evidence is `FailedRunEvidence` itself; this is what the deciding model uses to judge "is this attempt #2 or #5"). */
export interface AttemptHistoryEntry {
  adwId: string;
  status: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

export interface FailedRunEvidence {
  adwId: string;
  ticketId: string;
  taskPrompt: string;
  /** The terminal failure reason — whichever WorkflowRunResult status applies (failed/unparseable/permissions-violation/gate-failed/loop-exhausted/reconciled-per-M-100), read back from the LAST (highest-seq) Step's own error/output_summary, since that's what actually ended up in the trace db regardless of which in-memory result type produced it. */
  failureReason: string;
  steps: StepEvidence[];
  /** Every OTHER run linked to this ticket (the current failed run excluded), most recent first — the ticket's full attempt history so far. */
  priorAttempts: AttemptHistoryEntry[];
}

export class RetryDecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryDecisionError";
  }
}

/**
 * Reads back a failed run's compact evidence stack from `factory.db`.
 * Throws `RetryDecisionError` if the run isn't found, has no ticket (every
 * run minted since M-103 always has one — a pre-M-103 row could lack one),
 * or isn't actually in a terminal-fail state — this function is meant to be
 * called only once a caller already knows the run failed (the
 * reconciliation-loop trigger checks `status='fail'` before ever getting
 * here), not as a general-purpose "is this run failed" check.
 */
export function assembleEvidence(db: Database, adwId: string): FailedRunEvidence {
  const session = db
    .query<SessionEvidenceRow, [string]>(
      "SELECT adw_id, request, status, ticket_id, project_cwd FROM sessions WHERE adw_id = ?",
    )
    .get(adwId);
  if (!session) throw new RetryDecisionError(`no such Workflow Run: ${adwId}`);
  if (session.status !== "fail") {
    throw new RetryDecisionError(`assembleEvidence called on a run that is not status='fail' (adwId=${adwId}, status=${String(session.status)}) — only call this after a run is already confirmed terminal-failed`);
  }
  if (!session.ticket_id) {
    throw new RetryDecisionError(`run ${adwId} has no ticket_id — cannot assemble ticket attempt history (pre-M-103 run?)`);
  }

  const phaseRows = db
    .query<PhaseEvidenceRow, [string]>(
      "SELECT name, kind, status, error, output_summary, seq FROM phases WHERE adw_id = ? ORDER BY seq",
    )
    .all(adwId);

  const steps: StepEvidence[] = phaseRows.map((p) => ({
    name: p.name ?? "(unnamed)",
    kind: p.kind ?? "unknown",
    status: p.status ?? "unknown",
    summary: p.output_summary ?? p.error ?? null,
  }));

  // The failure reason is whatever the LAST (highest-seq) Step actually
  // recorded — this is what's really in the db regardless of which
  // WorkflowRunResult variant (failed/unparseable/permissions-violation/
  // gate-failed/loop-exhausted/M-100-reconciled) produced it; every one of
  // those branches writes a real phase_end with an error/output_summary
  // (run.ts's failPhase, workflow.ts's runCodeStep/catch-all, or M-100's
  // reconcileStuckRuns), so reading it back from the last Step is a single,
  // uniform path rather than special-casing five result shapes here.
  const lastStep = phaseRows.at(-1);
  const failureReason = lastStep?.error ?? lastStep?.output_summary ?? "(no failure reason recorded)";

  const allTicketRuns: TicketRunRow[] = runsForTicket(db, session.ticket_id);
  const priorAttempts: AttemptHistoryEntry[] = allTicketRuns
    .filter((r) => r.adwId !== adwId)
    .map((r) => ({ adwId: r.adwId, status: r.status, startedAt: r.startedAt, endedAt: r.endedAt }));

  return {
    adwId,
    ticketId: session.ticket_id,
    taskPrompt: session.request ?? "",
    failureReason,
    steps,
    priorAttempts,
  };
}

/** Renders the evidence stack into the plain-text prompt handed to the decision Role — compact, human-readable, no raw JSON dumps of trace events. */
export function renderEvidencePrompt(evidence: FailedRunEvidence): string {
  const stepsText = evidence.steps.length
    ? evidence.steps.map((s) => `  - ${s.name} (${s.kind}): ${s.status}${s.summary ? ` — ${s.summary}` : ""}`).join("\n")
    : "  (no Steps recorded)";

  const historyText = evidence.priorAttempts.length
    ? evidence.priorAttempts
        .map((a, i) => `  ${String(i + 1)}. ${a.adwId} — ${a.status ?? "unknown"} (started ${a.startedAt ?? "?"}, ended ${a.endedAt ?? "?"})`)
        .join("\n")
    : "  (this is the first attempt on this ticket)";

  return (
    `A Workflow Run has failed and needs a retry/new-run/give-up decision.\n\n` +
    `Original task prompt:\n${evidence.taskPrompt}\n\n` +
    `Terminal failure reason:\n${evidence.failureReason}\n\n` +
    `Steps in this failed run:\n${stepsText}\n\n` +
    `This ticket's prior attempt history (${String(evidence.priorAttempts.length)} earlier attempt(s), not counting this one):\n${historyText}\n\n` +
    `Decide whether to: retry this SAME session (resume, same worktree/branch — appropriate when the agent's own reasoning wasn't at fault), ` +
    `start a genuinely NEW run (fresh session/worktree — appropriate when resuming risks repeating confused reasoning), ` +
    `or give up (this ticket has failed enough times that a human should look at it).\n\n` +
    `Reply with ONLY a single valid JSON object matching the required envelope schema (no prose, no markdown fences).`
  );
}

export interface RetryDecisionResult {
  decision: RetryDecisionOutput["decision"];
  reasoning: string;
  /** Wall-clock time this decision call itself took, ms — tracked per the card's note that a model call is exactly the kind of thing that shouldn't be silent runner glue (see decideRetry's own doc comment for where this gets traced). */
  elapsedMs: number;
}

/**
 * Calls the decision Role (a small/cheap `kind: "agent"` Role,
 * `factory.config.yaml`'s `decide-retry` entry) with the evidence stack,
 * parses its `{decision, reasoning}` envelope. This is its own tiny,
 * one-shot pi-web session (NOT the failed run's own session — the decision
 * is deliberately made from a clean context, not one that's already seen
 * the failure unfold turn-by-turn, so it judges the COMPACT evidence
 * summary on its own merits) — started and torn down entirely within this
 * one call.
 *
 * ── Tracking the decision call's own cost/time ────────────────────────────
 * Per the card's note ("a model call is exactly the kind of thing that
 * shouldn't be silent runner glue"): the caller (the reconciliation-loop
 * trigger, not this function itself — see that code for the actual trace
 * write) records this as its own lightweight `log` event on the ORIGINAL
 * failed run's adwId, carrying `elapsedMs` and the decision/reasoning —
 * chosen over minting a whole separate 1-step Workflow Run for it, since a
 * decision call has no worktree/Steps of its own and would be an awkward
 * fit for the `sessions`/`phases` shape; a plain event is honest about what
 * it actually is (see RetryDecisionResult.elapsedMs's own doc comment).
 */
export async function decideRetry(opts: {
  baseUrl?: string;
  config: RolesConfig;
  evidence: FailedRunEvidence;
  /** cwd for the decision session — the failed run's own worktree (read-only inspection, the decision Role has no writes anyway per its Role config), so a real project path exists for pi-web's session machinery even though nothing is written. */
  cwd: string;
}): Promise<RetryDecisionResult> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const role = decideRetryRoleFor(opts.config);

  const startedAt = Date.now();
  const session = await startSession(baseUrl, opts.cwd, `retry-decision:${opts.evidence.adwId}`);
  await setModel(baseUrl, session.id, role.modelRef.provider, role.modelRef.modelId, opts.cwd);
  await sendPrompt(baseUrl, session.id, roleMarker("decide-retry") + "\n" + renderEvidencePrompt(opts.evidence), opts.cwd);
  const result = await waitForCompletion(baseUrl, session.id, {}, opts.cwd);

  if (result.status !== "done") {
    const detail = result.status === "blocked-on-human" ? "decision Role asked a question instead of deciding" : result.detail;
    throw new RetryDecisionError(`decision Role call did not complete cleanly for ${opts.evidence.adwId}: ${result.status} — ${detail}`);
  }

  const text = lastAssistantText(result.messages) ?? "";
  const parseReport = jsonParses(text, RetryDecisionOutputSchema);
  if (!parseReport.checks.every((c) => c.ok)) {
    throw new RetryDecisionError(
      `decision Role's response for ${opts.evidence.adwId} did not parse as a valid retry-decision envelope: ${parseReport.checks
        .filter((c) => !c.ok)
        .map((c) => c.note)
        .join("; ")}`,
    );
  }
  const envelope = RetryDecisionOutputSchema.parse(JSON.parse(text));

  return { decision: envelope.decision, reasoning: envelope.reasoning, elapsedMs: Date.now() - startedAt };
}

/** Resolves the `decide-retry` agent Role from config — a dedicated lookup (rather than reusing `roles.ts`'s generic `agentRoleFor`) so a missing/misconfigured Role fails with a message specific to this feature, not a generic "role not found." */
function decideRetryRoleFor(config: RolesConfig): AgentRole {
  const role = config.roles.find((r) => r.name === "decide-retry");
  if (!role) {
    throw new RetryDecisionError(
      `no "decide-retry" Role configured in factory.config.yaml — the retry-decision mechanism requires a kind: agent Role named "decide-retry" (see prompts/decide-retry.md)`,
    );
  }
  if (role.kind !== "agent") {
    throw new RetryDecisionError(`the "decide-retry" Role is configured as kind: code — it must be kind: agent`);
  }
  return role;
}

/** Records the decision call's own cost/time as a lightweight trace-db event on the ORIGINAL failed run's adwId — see decideRetry's own doc comment for why this shape (a plain event, not a separate Workflow Run) was chosen. */
export function traceRetryDecision(tracer: Tracer, adwId: string, result: RetryDecisionResult): void {
  tracer.event({
    adwId,
    type: "log",
    name: "retry_decision",
    payload: { decision: result.decision, reasoning: result.reasoning, elapsedMs: result.elapsedMs },
  });
}
