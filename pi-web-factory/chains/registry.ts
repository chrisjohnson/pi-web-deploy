/**
 * registry.ts: workflow-name -> runner-function lookup for `cli.ts`'s
 * `--workflow` flag (renamed from `--chain`, M-076 — see cli.ts's own header
 * comment for the rename's full reasoning).
 *
 * ── M-076: Workflows are now YAML data, not hand-written TS files ────────
 * Three of the four entries below (`plan-build-review`, `bounded-build-review`,
 * `plan-build-review-with-tests` — the last added M-099) are ordinary YAML
 * `Workflow` definitions (`modules/workflowDef.ts`) loaded from
 * `workflows/*.yaml` and executed by ONE generic interpreter
 * (`modules/workflow.ts`'s `runWorkflow`) — adding another workflow from
 * here on is a YAML edit plus one line in `WORKFLOW_FILES` below, not a new
 * TS file (M-099 proved this out for real: `plan-build-review-with-tests`
 * needed zero interpreter changes, only a new YAML + this registration).
 * The remaining entry, `plan-build-test`, is `chains/planBuildTest.ts`
 * (M-066) — the original, hand-written implementation, deliberately KEPT
 * (not retired) as an independent, already-tested option; see this
 * file's own `planBuildTest` section below and the M-076 card's decision log
 * for why.
 *
 * This module normalizes both kinds (generic-interpreter-driven YAML
 * Workflows AND the one hand-written chain) behind the SAME `WorkflowRunner`
 * shape `cli.ts` depends on, so `cli.ts` itself never needs to know which
 * kind a given `--workflow` name resolves to.
 */

import { planBuildTest, type PlanBuildTestLinkInfo, type PlanBuildTestOptions, type PlanBuildTestResult } from "./planBuildTest.ts";
import { runWorkflow, type WorkflowRunLinkInfo, type WorkflowRunOptions, type WorkflowRunResult } from "../modules/workflow.ts";
import { loadWorkflows, workflowFor, type Workflow } from "../modules/workflowDef.ts";
import type { RolesConfig } from "../modules/roles.ts";
import type { Tracer } from "../modules/tracer.ts";
import { join } from "node:path";

/** Fields every registered workflow runner accepts — the CLI only ever supplies these. */
export interface WorkflowRunOptionsBase {
  tracer: Tracer;
  config: RolesConfig;
  cwd: string;
  taskPrompt: string;
  sessionId?: string;
  baseUrl?: string;
  adwId?: string;
  engineer?: string;
  /** Project's configured test/quality-gate command, when known (config.ts's projectConfigFor(...).test). Only used by chains/Workflows that include a test-running code step. */
  testCmd?: string;
  /** Local cwd for a test/gate code step's shell-out, when it must differ from `cwd` — see planBuildTest.ts's own testCwd doc comment. */
  testCwd?: string;
  /** The ticket this run belongs to — see modules/workflow.ts's `WorkflowRunOptions.ticketId` doc comment. Threaded through unchanged to whichever runner (YAML Workflow or planBuildTest) this name resolves to. */
  ticketId?: string;
}

/** Fields every registered workflow's result carries, regardless of its own status union — what `cli.ts`'s `describeResult` renders. */
export interface WorkflowResultBase {
  status: string;
  adwId: string;
  sessionId: string;
  link: PlanBuildTestLinkInfo | WorkflowRunLinkInfo;
}

export type WorkflowRunner = (opts: WorkflowRunOptionsBase) => Promise<WorkflowResultBase>;

// ── YAML-defined Workflows (M-076) ─────────────────────────────────────────

/** Every `workflows/*.yaml` file loaded at module-load time — add a new file here to register more Workflows without touching runner-wiring code below. */
const WORKFLOW_FILES = [
  join(import.meta.dir, "..", "workflows", "plan-build-review.yaml"),
  join(import.meta.dir, "..", "workflows", "bounded-build-review.yaml"),
  join(import.meta.dir, "..", "workflows", "plan-build-review-with-tests.yaml"),
];

function loadAllWorkflows(): Workflow[] {
  return WORKFLOW_FILES.flatMap((path) => loadWorkflows(path));
}

const YAML_WORKFLOWS = loadAllWorkflows();

/**
 * Read-only access to every loaded YAML Workflow's own definition
 * (name, steps, `retries` budget) — needed by the orchestrator's reconciliation
 * loop to look up a failed run's `retries` budget by its `sessions.adw_name`
 * (the Workflow name a run recorded at `sessionStart`, `workflow.ts`) without
 * duplicating this module's own YAML-loading/registration logic. Exposes the
 * already-loaded array directly (not a new lookup function) — callers that
 * need `workflowFor`'s throw-on-missing semantics can import that directly
 * from `workflowDef.ts` themselves. Note this only covers YAML-defined
 * Workflows, not `chains/planBuildTest.ts` (the one hand-written chain) —
 * that chain has no `retries` concept of its own to look up (`retries` was
 * added to `workflowDef.ts`'s schema specifically, not to
 * `planBuildTest.ts`'s options).
 */
export function loadedWorkflows(): Workflow[] {
  return YAML_WORKFLOWS;
}

/** Builds a `WorkflowRunner` for a named, already-loaded YAML Workflow — a thin adapter from `WorkflowRunOptionsBase` to `runWorkflow`'s own options shape. */
function runnerFor(workflowName: string): WorkflowRunner {
  const workflow = workflowFor(YAML_WORKFLOWS, workflowName);
  return async (opts: WorkflowRunOptionsBase): Promise<WorkflowResultBase> => {
    const runOpts: WorkflowRunOptions = {
      tracer: opts.tracer,
      config: opts.config,
      workflow,
      cwd: opts.cwd,
      taskPrompt: opts.taskPrompt,
      testCwd: opts.testCwd,
      baseUrl: opts.baseUrl,
      adwId: opts.adwId,
      sessionId: opts.sessionId,
      engineer: opts.engineer,
      ticketId: opts.ticketId,
    };
    return runWorkflow(runOpts);
  };
}

// ── chains/planBuildTest.ts (M-066) — kept as a third, independent option ──

/**
 * Adapts `planBuildTest`'s own options shape (which additionally needs
 * `testCmd` threaded through explicitly, since its shape ends in a CODE step
 * that run.ts's generic interpreter doesn't own) to `WorkflowRunOptionsBase`.
 */
async function runPlanBuildTest(opts: WorkflowRunOptionsBase): Promise<WorkflowResultBase> {
  const runOpts: PlanBuildTestOptions = {
    tracer: opts.tracer,
    config: opts.config,
    cwd: opts.cwd,
    taskPrompt: opts.taskPrompt,
    testCmd: opts.testCmd,
    testCwd: opts.testCwd,
    baseUrl: opts.baseUrl,
    adwId: opts.adwId,
    sessionId: opts.sessionId,
    engineer: opts.engineer,
    ticketId: opts.ticketId,
  };
  return planBuildTest(runOpts);
}

// ── registry ─────────────────────────────────────────────────────────────

/** CLI-facing workflow name -> runner. Keys are the exact `--workflow` values accepted. */
export const workflowRegistry: Record<string, WorkflowRunner> = {
  "plan-build-review": runnerFor("plan-build-review"),
  "bounded-build-review": runnerFor("bounded-build-review"),
  "plan-build-test": runPlanBuildTest,
  "plan-build-review-with-tests": runnerFor("plan-build-review-with-tests"),
};

export function workflowNames(): string[] {
  return Object.keys(workflowRegistry);
}

/**
 * Whole-Workflow "when to pick me" prose for every registered
 * Workflow, keyed by the same `--workflow` name as `workflowRegistry` —
 * what `cli.ts --list-workflows` prints, and what `skills/pi-web-factory/
 * SKILL.md` shells out to read instead of embedding a static, hand-maintained
 * table. The three YAML-defined Workflows carry
 * their own `description` inline in `workflows/*.yaml`
 * (`modules/workflowDef.ts`'s schema) and are read straight off
 * `YAML_WORKFLOWS` here — never duplicated by hand. `plan-build-test` is the
 * one exception: it's `chains/planBuildTest.ts`, a hand-written chain with no
 * YAML file of its own, so its description is hardcoded here instead — a
 * small hardcoded constant, not a new sidecar file just for one chain.
 */
const HAND_WRITTEN_WORKFLOW_DESCRIPTIONS: Record<string, string> = {
  "plan-build-test":
    "The user wants a mechanical, code-based acceptance check instead of (or in addition to) a judgment call — " +
    '"make sure the tests pass", "TDD this". Requires the target project to have a .pi-web-factory.yaml declaring ' +
    "its test command; if it doesn't, say so rather than guessing a command.",
};

export const WORKFLOW_DESCRIPTIONS: Record<string, string> = Object.fromEntries(
  Object.keys(workflowRegistry).map((name) => {
    const yamlWorkflow = YAML_WORKFLOWS.find((w) => w.name === name);
    const description = yamlWorkflow?.description ?? HAND_WRITTEN_WORKFLOW_DESCRIPTIONS[name];
    if (!description) {
      // Fails loudly at module-load time (same discipline as workflowDef.ts's
      // own ConfigError) rather than silently shipping a Workflow the router
      // can't describe — a registered name with no description anywhere
      // defeats the whole point of this table.
      throw new Error(`workflow ${JSON.stringify(name)} is registered but has no description anywhere (neither its YAML nor HAND_WRITTEN_WORKFLOW_DESCRIPTIONS)`);
    }
    return [name, description];
  }),
);

/** Re-exported so callers that need the concrete, non-widened types can get them from one place. */
export type { PlanBuildTestLinkInfo, PlanBuildTestOptions, PlanBuildTestResult, WorkflowRunLinkInfo, WorkflowRunOptions, WorkflowRunResult };
