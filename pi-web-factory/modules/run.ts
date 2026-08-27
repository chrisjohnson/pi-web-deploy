/**
 * run.ts: the shared phase-running helper every chain calls — SSSF's own
 * `run.phase()`-shaped context manager (pi-web-adw-design.md §3.2's
 * pseudocode; M-066 card, Plan item 1), reimplemented as one async function
 * rather than a Python context manager since TS has no equivalent primitive
 * that reads as cleanly.
 *
 * `runAgentPhase` wires together, in order:
 *   1. trace `phase_start`
 *   2. `setModel` (only once per session — a resumed session doesn't need
 *      re-pinning every phase)
 *   3. `snapshotRepoState` BEFORE prompting (permissions.ts needs a
 *      before/after pair to detect what an agent touched)
 *   4. `prompt()` + `waitForCompletion()`
 *   5. branch on the wait-loop's discriminated result:
 *        "blocked-on-human" -> distinct phase outcome, traced as its own
 *          event type, never folded into "error"
 *        "error"            -> traced as `error`, phase fails
 *        "done"             -> the retry-on-parse-failure loop (§1.1 of the
 *          design doc: a parse failure re-prompts the SAME session with a
 *          correction built from the failing GateReport, never a cold
 *          restart), bounded to a small number of attempts
 *   6. once parsed: `enforceWrites` against the snapshot from (3)
 *   7. trace `agent_end` / `gate_pass` or `gate_fail` / `phase_end`
 *
 * Deliberately generic: no `plan`/`build`-specific assumptions anywhere in
 * here. Every phase in every future chain calls this same function — the
 * envelope schema, prompt text, and protected-files list are all supplied by
 * the caller, never guessed here (see M-066 card: "don't let chains/
 * accumulate logic that belongs in one of the four modules" — the
 * corollary is this module must be the one place that logic lives, not
 * chain-specific either).
 */

import { extractJson, jsonParses, type GateReport } from "./gates.ts";
import {
  getStatus,
  lastAssistantText,
  prompt as sendPrompt,
  setModel,
  waitForCompletion,
  type PendingAskUser,
  type SessionMessage,
} from "./piwebClient.ts";
import { enforceWrites, snapshotRepoState, type PermissionsResult } from "./permissions.ts";
import type { Tracer } from "./tracer.ts";
import type { AgentRole } from "./roles.ts";
import type { ZodType, z } from "zod";

const DEFAULT_MAX_PARSE_ATTEMPTS = 3;

/** Cap applied to the raw failed-response text captured on an `unparseable` result — long enough to show a human the actual shape of the problem (markdown fences, leading prose, wrong field names, truncated output), short enough to stay a one-glance trace-db column / CLI line rather than a full transcript dump. */
const RAW_RESPONSE_CAP = 500;

/**
 * Truncates `text` to `RAW_RESPONSE_CAP` chars, appending a note of exactly
 * how much was cut so a reader never mistakes a truncated snippet for the
 * agent's complete response.
 */
export function truncateRawResponse(text: string, cap: number = RAW_RESPONSE_CAP): string {
  if (text.length <= cap) return text;
  const omitted = text.length - cap;
  return `${text.slice(0, cap)}… [truncated, ${String(omitted)} more chars]`;
}

export interface RunAgentPhaseOptions<Schema extends ZodType> {
  tracer: Tracer;
  baseUrl: string;
  adwId: string;
  phaseId: string;
  seq: number;
  /** Absolute path to the target project's working tree. */
  cwd: string;
  agent: AgentRole;
  /** Existing session to resume, or a freshly-minted one — caller decides (chain owns continuation policy). */
  sessionId: string;
  /**
   * Whether `setModel` has already been called on this session (e.g. a
   * session reused from a prior phase in the same chain). Only the FIRST
   * phase to touch a given session needs to set its model.
   */
   modelAlreadySet: boolean;
  promptText: string;
  /**
   * Optional text prepended to EVERY prompt this phase sends to pi-web,
   * including retry-on-parse-failure corrections — not just the first one.
   * Added for M-069's role marker (`piwebClient.ts`'s `roleMarker`/
   * `roleMarkerPrompt`): `before_agent_start` (the hook
   * `pi-web-factory-prompts` uses to inject a true system prompt) fires on
   * EVERY prompt submission, not just a session's first, so a marker that
   * only rides on the initial `promptText` would silently lose the injected
   * system prompt on any retry attempt. `run.ts` stays otherwise agnostic to
   * what this prefix means (chain code owns that) — it just guarantees it's
   * never dropped mid-phase.
   */
  promptPrefix?: string;
  envelopeSchema: Schema;
  /** Human-readable name of the envelope's output type, for tracing/db columns (e.g. "plan", "build"). */
  outputTypeName: string;
  /** Repo-wide protected paths (factory.config.yaml's defaults.protected_files), merged with the agent's own writes allowlist by permissions.ts's precedence rules. */
  protectedFiles: string[];
  /** Bound on parse-failure retries before the phase fails outright. Default 3. */
  maxParseAttempts?: number;
  /** Forwarded to waitForCompletion — mainly for tests. */
  waitOptions?: { timeoutMs?: number; pollIntervalMs?: number; forcePollOnly?: boolean };
}

export type RunAgentPhaseResult<Schema extends ZodType> =
  | { status: "success"; envelope: z.infer<Schema>; permissions: PermissionsResult; attempts: number }
  | { status: "permissions-violation"; envelope: z.infer<Schema>; permissions: PermissionsResult; attempts: number }
  | { status: "blocked-on-human"; pendingAsk: PendingAskUser; attempts: number }
  | { status: "error"; reason: string; attempts: number }
  | { status: "unparseable"; lastReport: GateReport; attempts: number; rawResponse: string };

/**
 * Builds a correction message from a failed `jsonParses` GateReport — names
 * exactly what was wrong (each failed check's `item`/`note`), per the
 * design doc's "asked again until it does" requirement. Never a generic
 * "try again."
 */
export function buildCorrectionMessage(report: GateReport, outputTypeName: string): string {
  const problems = report.checks
    .filter((c) => !c.ok)
    .map((c) => `- ${c.item}: ${c.note ?? "failed"}`)
    .join("\n");
  return (
    `Your last response did not parse as valid JSON matching the required "${outputTypeName}" ` +
    `envelope schema. Specifically:\n${problems}\n\n` +
    `Reply again with ONLY a single valid JSON object matching the "${outputTypeName}" envelope schema — ` +
    `no prose before or after it, no markdown code fences.`
  );
}

/**
 * Runs one agent-driven phase end to end. See module docstring for the
 * exact sequencing. Returns a discriminated result — never throws for an
 * expected outcome (blocked-on-human, error, unparseable-after-retries);
 * only throws for something genuinely unexpected (e.g. the tracer itself
 * failing), which is intentionally left unhandled here since there's no
 * meaningful fallback for that case.
 */
export async function runAgentPhase<Schema extends ZodType>(
  opts: RunAgentPhaseOptions<Schema>,
): Promise<RunAgentPhaseResult<Schema>> {
  const {
    tracer,
    baseUrl,
    adwId,
    phaseId,
    seq,
    cwd,
    agent,
    sessionId,
    modelAlreadySet,
    promptText,
    promptPrefix,
    envelopeSchema,
    outputTypeName,
    protectedFiles,
    waitOptions,
  } = opts;
  const maxParseAttempts = opts.maxParseAttempts ?? DEFAULT_MAX_PARSE_ATTEMPTS;

  const phaseStartId = tracer.event({
    adwId,
    phaseId,
    type: "phase_start",
    name: outputTypeName,
    payload: { kind: "agent", owner: agent.name, description: promptText.slice(0, 200), seq },
  });

  // M-074: failure paths get a short, real `output_summary` rather than a
  // perpetually-null column — `reason` is whatever short string the caller
  // already has in hand at each failure site (blocked-on-human, error,
  // unparseable-after-N-attempts, permissions violation list).
  const failPhase = (error: string, outputSummary?: string): void => {
    tracer.event({
      adwId,
      phaseId,
      type: "phase_end",
      name: outputTypeName,
      payload: { status: "fail", error, outputSummary: outputSummary ?? error },
    });
  };

  if (!modelAlreadySet) {
    await setModel(baseUrl, sessionId, agent.modelRef.provider, agent.modelRef.modelId, cwd);
  }

  const before = snapshotRepoState(cwd);

  const agentStartId = tracer.event({
    adwId,
    phaseId,
    type: "agent_start",
    name: agent.name,
    parentId: phaseStartId,
    payload: { coding_agent: "pi", model: agent.model, session_id: sessionId },
  });

  const withPrefix = (text: string): string => (promptPrefix ? `${promptPrefix}\n${text}` : text);

  let currentPromptText = promptText;
  let attempts = 0;
  let messages: SessionMessage[] | undefined;
  let lastReport: GateReport | undefined;

  for (;;) {
    attempts += 1;
    await sendPrompt(baseUrl, sessionId, withPrefix(currentPromptText), cwd);
    const result = await waitForCompletion(baseUrl, sessionId, waitOptions, cwd);

    if (result.status === "blocked-on-human") {
      tracer.event({
        adwId,
        phaseId,
        type: "handoff",
        name: "blocked-on-human",
        parentId: phaseStartId,
        payload: { pendingAsk: result.pendingAsk },
      });
      const question = result.pendingAsk.questions[0]?.question;
      failPhase("blocked-on-human", question ? `blocked on human: ${question}` : "blocked on human");
      return { status: "blocked-on-human", pendingAsk: result.pendingAsk, attempts };
    }

    if (result.status === "error") {
      tracer.event({
        adwId,
        phaseId,
        type: "error",
        name: "waitForCompletion",
        parentId: phaseStartId,
        payload: { detail: result.detail },
      });
      failPhase(result.detail, `error: ${result.detail}`);
      return { status: "error", reason: result.detail, attempts };
    }

    messages = result.messages;
    const text = lastAssistantText(messages) ?? "";
    const parseReport = jsonParses(text, envelopeSchema);
    const parsedOk = parseReport.checks.every((c) => c.ok);

    if (parsedOk) {
      lastReport = undefined;
      break;
    }

    lastReport = parseReport;
    tracer.event({
      adwId,
      phaseId,
      type: "log",
      name: "parse_failure",
      parentId: phaseStartId,
      payload: { attempt: attempts, checks: parseReport.checks },
    });

    if (attempts >= maxParseAttempts) {
      tracer.event({
        adwId,
        phaseId,
        type: "gate_fail",
        name: "json_parses",
        parentId: phaseStartId,
        payload: { attempt: attempts, checks: parseReport.checks },
      });
      // The raw last-attempt response text is what actually lets a human
      // diagnose this (wrapped in markdown fences? prose before the JSON?
      // wrong field names? truncated output?) — the generic "unparseable
      // after N attempts" string alone gives zero signal. Capped via
      // truncateRawResponse (module-level RAW_RESPONSE_CAP) since a raw
      // agent response can be arbitrarily long and this both becomes a
      // trace-db column and a CLI-printed line.
      const truncated = truncateRawResponse(text);
      failPhase(
        `unparseable after ${String(attempts)} attempts — last response: ${truncated}`,
        `unparseable after ${String(attempts)} attempts — last response: ${truncated}`,
      );
      return { status: "unparseable", lastReport: parseReport, attempts, rawResponse: truncated };
    }

    // Retry-on-parse-failure: re-prompt the SAME session with a correction
    // naming exactly what was wrong — never a cold restart (design doc §1.1).
    currentPromptText = buildCorrectionMessage(parseReport, outputTypeName);
  }

  const text = lastAssistantText(messages ?? []) ?? "";
  // extractJson (not a raw JSON.parse) — the jsonParses gate check above
  // validated the fence-stripped/extracted form, not raw `text` itself, so
  // re-parsing with a naive JSON.parse here would crash on exactly the
  // fenced/prose-wrapped responses that check was built to tolerate.
  const envelope = envelopeSchema.parse(extractJson(text)) as z.infer<Schema>;

  tracer.envelopeRow({
    adwId,
    phaseId,
    agent: agent.name,
    outputType: outputTypeName,
    payloadJson: text,
    valid: true,
    attempt: attempts,
  });

  // M-074: fetch the session's current usage snapshot so agent_end's payload
  // can carry real `usage`/`cost` (previously omitted entirely) — this both
  // keeps `sessions.total_tokens` accumulating (via `_sideEffects`'s
  // existing `sessionAddUsage` call, unchanged) and, new here, threads the
  // same numbers into this Step's own input/output/cached token columns.
  // Best-effort: a status fetch failing here must not fail an otherwise-
  // successful phase, so `usage` is simply omitted (columns stay null) if
  // this call throws.
  let usage: { input: number; output: number; cached: number } | undefined;
  let statusTokens = 0;
  let statusCost = 0;
  try {
    const status = await getStatus(baseUrl, sessionId, cwd);
    statusTokens = status.tokens.total;
    statusCost = status.cost;
    usage = { input: status.tokens.input, output: status.tokens.output, cached: status.tokens.cacheRead };
  } catch {
    // best-effort — see comment above
  }

  const envelopeRecord = envelope as unknown as Record<string, unknown>;
  const outputSummary = typeof envelopeRecord["summary"] === "string" ? envelopeRecord["summary"] : undefined;

  tracer.event({
    adwId,
    phaseId,
    type: "agent_end",
    name: agent.name,
    parentId: phaseStartId,
    tokens: statusTokens,
    payload: {
      agent: agent.name,
      session_id: sessionId,
      cost: statusCost,
      tokens: statusTokens,
      usage,
      outputSummary,
    },
  });

  tracer.event({
    adwId,
    phaseId,
    type: "gate_pass",
    name: "json_parses",
    parentId: phaseStartId,
    payload: { attempt: attempts, checks: [{ item: "json", ok: true, note: "parses and matches schema" }] },
  });

  const permissions = enforceWrites(cwd, before, agent.writes, protectedFiles);
  // A violation means the phase dies, full stop — per upstream SSSF's hard
  // rule #9 ("unauthorized changes are rolled back AND THE PHASE DIES"), not
  // "rolled back and continue if the rollback happened to succeed."
  // `permissions.clean` alone is the wrong signal here: it only reports
  // whether every rollback ATTEMPT succeeded, and is trivially true when
  // there were zero violations to roll back — it says nothing about whether
  // a violation occurred in the first place. The gate on violations vs
  // no-violations at all is `permissions.violations.length`.
  const hasViolation = permissions.violations.length > 0;

  tracer.event({
    adwId,
    phaseId,
    type: hasViolation ? "gate_fail" : "gate_pass",
    name: "permissions",
    parentId: phaseStartId,
    payload: {
      attempt: attempts,
      checks: permissions.touched.map((path) => ({
        item: path,
        ok: permissions.allowed.includes(path),
        note: permissions.allowed.includes(path) ? "permitted write" : "rolled back — outside writes allowlist",
      })),
    },
  });

  if (hasViolation) {
    // M-074: the permission violation list IS the obvious short summary for
    // this failure path — no need to invent one.
    const violationSummary = `permissions violation: ${permissions.violations.join(", ")}`;
    tracer.event({
      adwId,
      phaseId,
      type: "phase_end",
      name: outputTypeName,
      payload: { status: "fail", error: violationSummary, outputSummary: violationSummary },
    });
    void agentStartId;
    void lastReport;
    return { status: "permissions-violation", envelope, permissions, attempts };
  }

  tracer.event({
    adwId,
    phaseId,
    type: "phase_end",
    name: outputTypeName,
    // M-074: on success, output_summary comes from the envelope's own
    // `summary` field (already computed above as `outputSummary`) — the
    // agent_end event already wrote it into the Step row via
    // `_sideEffects`'s agent_end handling; this phase_end payload doesn't
    // need to repeat it (phaseUpsert's COALESCE keeps the column's value).
    payload: { status: "success" },
  });

  void agentStartId;
  void lastReport;
  return { status: "success", envelope, permissions, attempts };
}
