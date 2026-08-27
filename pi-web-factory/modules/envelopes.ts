/**
 * Envelopes: Zod port of upstream SSSF's `adws/adw_modules/data_types.py`
 * `EnvelopeBase` + per-agent output-type subclasses.
 *
 * An agent's only output channel is one final valid-JSON response, parsed
 * against the schema declared for its identity at the call site. A parse
 * failure re-prompts the SAME session with a correction — never a cold
 * restart (see pi-web-adw-design.md §1.1 "Envelopes").
 *
 * ── THE SYNCED-TRIAD RULE ───────────────────────────────────────────────
 * For every agent identity, three things describe ONE contract and must
 * change together, in the same edit:
 *   1. The Zod schema below (this file).
 *   2. The `## Report` JSON example in that agent's `user.md` prompt
 *      template (upstream reference:
 *      `.claude/skills/sssf/templates/prompt_engineering/<agent>/user.md`
 *      — this project's own chain prompts, once written, are the
 *      equivalent).
 *   3. The `output_type=`/schema passed at the call site where the
 *      envelope is parsed (upstream: `AgentCall.output_type`; here:
 *      whatever chain code calls `envelopeFor(...)` / passes a schema to
 *      `jsonParses`/`.parse()`).
 * Edit one, edit all three. A drift between them is exactly the failure
 * mode gates.ts's `jsonParses` exists to catch at runtime — but the
 * cheaper fix is never letting it happen in the first place.
 *
 * Field names below are ported verbatim from upstream's Pydantic models —
 * read directly from `data_types.py`, not reconstructed from memory of the
 * design doc's summary. Deliberate deviations are called out inline.
 */

import { z } from "zod";

// ── EnvelopeBase ────────────────────────────────────────────────────────

/**
 * Base of every agent's final JSON response. Ported field-for-field from
 * upstream's `EnvelopeBase(BaseModel)`:
 *   status: Literal["success", "fail"]
 *   summary: str = ""
 *   artifacts: list[str] = []
 *   notes_for_next_agent: str = ""
 */
export const EnvelopeBaseSchema = z.object({
  status: z.enum(["success", "fail"]),
  summary: z.string().default(""),
  artifacts: z.array(z.string()).default([]),
  notes_for_next_agent: z.string().default(""),
});
export type EnvelopeBase = z.infer<typeof EnvelopeBaseSchema>;

/** Upstream's `GenericOutput(EnvelopeBase): pass` — no extra fields. */
export const GenericOutputSchema = EnvelopeBaseSchema;
export type GenericOutput = z.infer<typeof GenericOutputSchema>;

// ── PlanOutput (planner) ─────────────────────────────────────────────────

/**
 * Ported from `PlanOutput(EnvelopeBase)`:
 *   commit_message: str = ""
 * (upstream's comment: subject line for committing the PLAN document
 * itself, not the implementation it describes — see planner/user.md's
 * `## Report` example.)
 */
export const PlanOutputSchema = EnvelopeBaseSchema.extend({
  commit_message: z.string().default(""),
});
export type PlanOutput = z.infer<typeof PlanOutputSchema>;

// ── BuildOutput (builder) ────────────────────────────────────────────────

/**
 * Ported from `BuildOutput(EnvelopeBase)`:
 *   changed_files: list[str] = []
 *   commit_message: str = ""        # consumed by the git commit phase
 */
export const BuildOutputSchema = EnvelopeBaseSchema.extend({
  changed_files: z.array(z.string()).default([]),
  commit_message: z.string().default(""),
});
export type BuildOutput = z.infer<typeof BuildOutputSchema>;

// ── ScoutOutput (scout) ──────────────────────────────────────────────────

/** Ported from `ScoutFinding(BaseModel)`: file: str; note: str = "" */
export const ScoutFindingSchema = z.object({
  file: z.string(),
  note: z.string().default(""),
});
export type ScoutFinding = z.infer<typeof ScoutFindingSchema>;

/** Ported from `ScoutOutput(EnvelopeBase)`: findings: list[ScoutFinding] = [] */
export const ScoutOutputSchema = EnvelopeBaseSchema.extend({
  findings: z.array(ScoutFindingSchema).default([]),
});
export type ScoutOutput = z.infer<typeof ScoutOutputSchema>;

// ── ReviewOutput (reviewer) ──────────────────────────────────────────────

/**
 * Ported from `ReviewFinding(BaseModel)`:
 *   requirement: str                # the ask, in the requester's words
 *   met: bool
 *   evidence: str = ""              # where it lives, or what is missing
 */
export const ReviewFindingSchema = z.object({
  requirement: z.string(),
  met: z.boolean(),
  evidence: z.string().default(""),
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

/**
 * Ported from `ReviewOutput(EnvelopeBase)`:
 *   approved: bool = False
 *   findings: list[ReviewFinding] = []
 *   blocking: list[str] = []        # what must change before approval
 *
 * Note upstream's own framing (docstring + reviewer/user.md): `status` is
 * whether the review itself completed, NOT the verdict — the verdict is
 * `approved`, true only when every finding is met and `blocking` is empty.
 * This schema only shapes the fields; upstream also has a `verdict_consistent`
 * gate (`gates.py`) that checks `approved` actually agrees with
 * `findings`/`blocking` (e.g. catches an approval that still lists blocking
 * items). It is NOT ported here — M-063's Plan enumerated five specific
 * gates and `verdict_consistent` wasn't one of them, same treatment as
 * `ChangesOutput`/`VerifyOutput` above: a real, cheap, upstream-precedented
 * gap, left for a future card (candidate for M-066, since that's what will
 * first build a review chain) rather than added here unrequested.
 */
export const ReviewOutputSchema = EnvelopeBaseSchema.extend({
  approved: z.boolean().default(false),
  findings: z.array(ReviewFindingSchema).default([]),
  blocking: z.array(z.string()).default([]),
});
export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

// ── DocumentOutput (documenter) ──────────────────────────────────────────

/**
 * Ported from `DocumentOutput(EnvelopeBase)`:
 *   document_path: str = ""         # the doc in the repo, e.g. app_docs/<adw_id>_<slug>.md
 *   documented_files: list[str] = []
 *   commit_message: str = ""
 */
export const DocumentOutputSchema = EnvelopeBaseSchema.extend({
  document_path: z.string().default(""),
  documented_files: z.array(z.string()).default([]),
  commit_message: z.string().default(""),
});
export type DocumentOutput = z.infer<typeof DocumentOutputSchema>;

// ── RetryDecisionOutput (decide-retry, M-103) ────────────────────────────

/**
 * NOT extended from `EnvelopeBaseSchema` — deliberately its own minimal
 * shape. The retry-decision Role isn't a Workflow Step in the
 * plan/build/review sense (it never runs inside a Workflow Run's own Step
 * sequence, has no `artifacts`/`notes_for_next_agent` concept, and isn't
 * looked up via `envelopeSchemaForRole` in workflow.ts) — forcing it into
 * the same base shape as a real Step's envelope would carry fields that
 * mean nothing here. `{decision, reasoning}` is the whole contract:
 *   - `decision`: "retry" (same session/worktree) | "new-run" (fresh
 *     session/worktree) | "give-up" (leave the ticket for a human).
 *   - `reasoning`: the model's own explanation — not just for humans
 *     reading the trace db after the fact, but forces the Role to actually
 *     reason about the evidence rather than pattern-matching a bare enum.
 */
export const RetryDecisionOutputSchema = z.object({
  decision: z.enum(["retry", "new-run", "give-up"]),
  reasoning: z.string().min(1),
});
export type RetryDecisionOutput = z.infer<typeof RetryDecisionOutputSchema>;

// ── Registry ──────────────────────────────────────────────────────────────

/**
 * One schema per agent identity this project's initial chains (M-066) need:
 * plan, build, review, scout, document. Deliberately excludes several
 * envelope-shaped types upstream also defines in `data_types.py`
 * (`ChangesOutput`, `VerifyOutput`) — those wrap upstream's own
 * deterministic quality-block/git-diff machinery (`quality.py`,
 * `documentation.capture()`), which has no port in this codebase yet and
 * isn't in M-063's scope (per the card's Plan: "subclasses for each phase
 * kind the initial chains need: plan, build, review, scout, document").
 * Add them here if/when a chain needs them rather than speculatively now.
 */
export const envelopeSchemas = {
  plan: PlanOutputSchema,
  build: BuildOutputSchema,
  review: ReviewOutputSchema,
  scout: ScoutOutputSchema,
  document: DocumentOutputSchema,
} as const;

export type AgentIdentity = keyof typeof envelopeSchemas;
