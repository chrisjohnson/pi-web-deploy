/**
 * workflowDef.ts: the Workflow YAML shape (`pi-web-adw-design.md` §7.1/§7.2,
 * M-076 card) — loader/validator for a named, reusable Step-sequence
 * template, separate from `workflow.ts`'s interpreter so the DATA shape and
 * the EXECUTION logic aren't tangled in one file (mirrors `roles.ts` vs
 * `run.ts`'s own separation: config/schema module vs the module that
 * actually calls out).
 *
 * ── Step kinds ────────────────────────────────────────────────────────────
 * Three kinds, deliberately narrow (card's own words: "two known shapes, not
 * a workflow DSL"):
 *   - `agent` — one bounded agent turn. `role` names an AgentRole (Roles
 *     registry, M-075). `prompt` is the task text for that step; may
 *     reference prior steps' parsed envelope fields via `{{stepName.field}}`
 *     interpolation (see `workflow.ts`'s `interpolate`) — a narrow, explicit
 *     string-substitution mechanism, NOT a general template engine.
 *   - `code` — one deterministic, non-agent action. `role` names a CodeRole
 *     (Roles registry) — no `prompt` field; code Roles take `(project, cwd)`,
 *     not a task description.
 *   - `loop` — repeats `steps` (agent/code only — one level of nesting, no
 *     recursive loop-in-loop support) in order, up to `max_rounds` times,
 *     checking `until` against the named inner step's most-recently-parsed
 *     envelope after each full round.
 *
 * ── Why a real Zod schema, not "just YAML.parse and trust it" ────────────
 * Same discipline `roles.ts` established for `factory.config.yaml`: a
 * malformed Workflow definition should fail loudly at load time (a specific
 * `ConfigError`), not produce a confusing runtime crash three steps into a
 * live run against a real model.
 */

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ConfigError } from "./config.ts";

// ── Raw YAML shape ───────────────────────────────────────────────────────

/**
 * M-105 items 5/6: `title`/`summary` are both OPTIONAL at the schema level —
 * every Workflow YAML authored before this ticket has neither field, and
 * must keep loading/running exactly as before (no forced re-authoring).
 * `orchestrator/src/detailView.ts` falls back to the Step's short `name`
 * keyword when `title` is absent, and simply omits the "summary" row
 * entirely when `summary` is absent — see that module's own doc comment.
 */
const STEP_TITLE_FIELD = { title: z.string().min(1).optional() };
const STEP_SUMMARY_FIELD = {
  /** Human-friendly description of what this step GENERALLY accomplishes, authored once here in the workflow definition — distinct from a per-run agent's OWN output summary (`phases.output_summary`, labeled "result" on the detail page as of M-105 item 6). */
  summary: z.string().min(1).optional(),
};

const AgentStepSchema = z.object({
  kind: z.literal("agent"),
  name: z.string().min(1),
  role: z.string().min(1),
  prompt: z.string().min(1),
  ...STEP_TITLE_FIELD,
  ...STEP_SUMMARY_FIELD,
});

const CodeStepSchema = z.object({
  kind: z.literal("code"),
  name: z.string().min(1),
  role: z.string().min(1),
  ...STEP_TITLE_FIELD,
  ...STEP_SUMMARY_FIELD,
});

/** Steps allowed INSIDE a loop — agent/code only, never a nested loop (module doc comment). */
const LoopInnerStepSchema = z.discriminatedUnion("kind", [AgentStepSchema, CodeStepSchema]);

const LoopUntilSchema = z.object({
  /** Name of the inner step (within this SAME loop's `steps`) whose envelope is checked. */
  step: z.string().min(1),
  /** Envelope field name to compare (e.g. "approved"). */
  field: z.string().min(1),
  /** Value the field must equal for the loop to stop, e.g. `true`. */
  equals: z.unknown(),
});

const LoopStepSchema = z.object({
  kind: z.literal("loop"),
  name: z.string().min(1),
  steps: z.array(LoopInnerStepSchema).min(1),
  until: LoopUntilSchema,
  max_rounds: z.number().int().positive(),
  ...STEP_TITLE_FIELD,
  ...STEP_SUMMARY_FIELD,
});

const StepSchema = z.discriminatedUnion("kind", [AgentStepSchema, CodeStepSchema, LoopStepSchema]);

const RawWorkflowSchema = z.object({
  name: z.string().min(1),
  /**
   * M-104: whole-Workflow-level "when to pick me" prose — a self-describing
   * registry entry a routing caller (today: `skills/pi-web-factory/SKILL.md`,
   * via `cli.ts --list-workflows`) can read generically instead of a
   * hand-maintained table growing stale as more Workflow variants ship.
   * Whole-Workflow granularity deliberately, NOT per-step (`STEP_SUMMARY_FIELD`
   * above already covers "what does this step do"; this is "when should a
   * caller pick this whole Workflow", matching how the old SKILL.md table had
   * one row per Workflow, not per step). Required (not optional, unlike
   * title/summary): every Workflow this router can select needs one — there's
   * no legacy/pre-M-104 YAML to stay backward-compatible with the way
   * title/summary did for M-105 (this field is brand new for every workflow).
   */
  description: z.string().min(1),
  steps: z.array(StepSchema).min(1),
  /**
   * M-103: max ADDITIONAL full-run attempts allowed after an initial
   * failure, before a ticket is marked exhausted and left for a human. A
   * BETWEEN-runs retry budget — each retry is its own fresh `adwId`/
   * trace-db row, linked to the same ticket — distinct from `loop`'s
   * `max_rounds` (a WITHIN-one-run, same-session correction loop). Default
   * 0 (no automatic retries) — existing Workflow YAML files need no changes
   * to keep their current, retry-free behavior.
   */
  retries: z.number().int().min(0).default(0),
});

const RawWorkflowsFileSchema = z.object({
  workflows: z.array(RawWorkflowSchema).min(1),
});

// ── Loaded/validated shape (also the TS-facing public types) ───────────────

export interface AgentStep {
  kind: "agent";
  name: string;
  role: string;
  prompt: string;
  /** M-105 item 5: human-friendly name, e.g. "Construct a Plan" for the `plan` step — optional, absent on every pre-M-105 Workflow YAML. */
  title?: string;
  /** M-105 item 6: human-friendly description of what this step GENERALLY accomplishes, authored once here — optional, distinct from a per-run agent's own output summary. */
  summary?: string;
}

export interface CodeStep {
  kind: "code";
  name: string;
  role: string;
  /** M-105 item 5 — see AgentStep.title. */
  title?: string;
  /** M-105 item 6 — see AgentStep.summary. */
  summary?: string;
}

export interface LoopUntil {
  step: string;
  field: string;
  equals: unknown;
}

export interface LoopStep {
  kind: "loop";
  name: string;
  steps: (AgentStep | CodeStep)[];
  until: LoopUntil;
  max_rounds: number;
  /** M-105 item 5 — see AgentStep.title. */
  title?: string;
  /** M-105 item 6 — see AgentStep.summary. */
  summary?: string;
}

export type Step = AgentStep | CodeStep | LoopStep;

export interface Workflow {
  name: string;
  /** M-104: whole-Workflow "when to pick me" prose — see RawWorkflowSchema's doc comment. */
  description: string;
  steps: Step[];
  /** M-103: between-runs retry budget — see RawWorkflowSchema's doc comment. */
  retries: number;
}

/**
 * Validates step-name uniqueness across a Workflow — required for
 * `{{stepName.field}}` interpolation (`workflow.ts`) and for a loop's
 * `until.step` reference to be unambiguous. Names inside a loop's `steps`
 * share the SAME namespace as the outer Workflow's step names (a loop step
 * is not a separate scope) — deliberately, since a loop's inner steps are
 * exactly what `until` and later interpolation need to address directly.
 */
function validateUniqueStepNames(workflow: Workflow, sourceLabel: string): void {
  const seen = new Set<string>();
  const walk = (steps: Step[]): void => {
    for (const step of steps) {
      if (seen.has(step.name)) {
        throw new ConfigError(
          `${sourceLabel}: workflow ${JSON.stringify(workflow.name)} has a duplicate step name ${JSON.stringify(step.name)} — step names must be unique across the whole workflow, including inside loops`,
        );
      }
      seen.add(step.name);
      if (step.kind === "loop") walk(step.steps);
    }
  };
  walk(workflow.steps);
}

/** Validates a loop's `until.step` actually names one of ITS OWN inner steps — not some other step outside the loop. */
function validateLoopUntilRefs(workflow: Workflow, sourceLabel: string): void {
  const walk = (steps: Step[]): void => {
    for (const step of steps) {
      if (step.kind !== "loop") continue;
      const innerNames = new Set(step.steps.map((s) => s.name));
      if (!innerNames.has(step.until.step)) {
        throw new ConfigError(
          `${sourceLabel}: workflow ${JSON.stringify(workflow.name)}'s loop ${JSON.stringify(step.name)} has ` +
            `until.step ${JSON.stringify(step.until.step)}, which is not one of this loop's own inner steps ` +
            `(${Array.from(innerNames).join(", ") || "(none)"})`,
        );
      }
    }
  };
  walk(workflow.steps);
}

/** Parses+validates YAML text containing a `workflows:` list into `Workflow[]`. */
export function loadWorkflowsFromString(text: string, sourceLabel = "<workflows>"): Workflow[] {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`${sourceLabel}: could not parse YAML: ${detail}`);
  }

  const result = RawWorkflowsFileSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new ConfigError(`${sourceLabel}: invalid workflow definition:\n${issues}`);
  }

  const seenNames = new Set<string>();
  const workflows = result.data.workflows.map((w) => {
    if (seenNames.has(w.name)) {
      throw new ConfigError(`${sourceLabel}: duplicate workflow name ${JSON.stringify(w.name)}`);
    }
    seenNames.add(w.name);
    validateUniqueStepNames(w, sourceLabel);
    validateLoopUntilRefs(w, sourceLabel);
    return w;
  });

  return workflows;
}

/** Loads+validates a `workflows:` YAML file from disk. */
export function loadWorkflows(path: string): Workflow[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`could not read workflow file ${JSON.stringify(path)}: ${detail}`);
  }
  return loadWorkflowsFromString(text, path);
}

/** Resolves one Workflow by name from an already-loaded list. Throws — never falls back. */
export function workflowFor(workflows: Workflow[], name: string): Workflow {
  const workflow = workflows.find((w) => w.name === name);
  if (!workflow) {
    const available = workflows.map((w) => w.name).join(", ") || "(none loaded)";
    throw new ConfigError(`workflow ${JSON.stringify(name)} is not defined — available: ${available}`);
  }
  return workflow;
}
