#!/usr/bin/env bun
/**
 * cli.ts: the manually-triggered entrypoint for pi-web-factory — design doc
 * §0 point 2, §3.4 ("the ticket-layer seam"). `--workflow` matches the
 * design doc §7 terminology ("Workflow" replaces "chain" everywhere) — the
 * underlying registry (`chains/registry.ts`) resolves both generic-
 * interpreter-driven YAML Workflows AND the one remaining hand-written chain
 * (`chains/planBuildTest.ts`) behind the SAME name, so this flag covers
 * every runnable shape regardless of how it's implemented.
 *
 * Invocation (mirrors upstream SSSF's own `uv run adws/adw_x.py "<prompt or
 * path/to/prompt.md>" [--config ...] [--adw-id ...]`, adapted to this
 * project's flag names):
 *
 *   bun cli.ts --project <abs-path> --workflow <name> [--session-id <id>] "<prompt or path/to/prompt.md>"
 *
 * There is also a second, standalone invocation mode — no run performed:
 *
 *   bun cli.ts --list-workflows
 *
 * Prints every registered `--workflow` name plus its whole-Workflow
 * `description` (`chains/registry.ts`'s `WORKFLOW_DESCRIPTIONS`), exits 0.
 * This is the self-describing registry `skills/pi-web-factory/SKILL.md`
 * shells out to at routing time instead of embedding a static, hand-
 * maintained table — see that skill file for the full reasoning.
 *
 * A THIRD standalone invocation mode exists too — no run performed, on-demand
 * reconciliation of stale pi-web project registrations (a real directory that
 * no longer exists, or a registered path that isn't a real single-repo root —
 * see `modules/projectReconcile.ts`):
 *
 *   bun cli.ts --reconcile-projects [--delete]
 *
 * Dry-run by DEFAULT (prints every stale entry found, deletes nothing) —
 * `--delete` is required to actually call pi-web's `DELETE /projects/:id`
 * (confirmed to exist live) for each flagged entry. Deliberately NOT wired
 * into `orchestrator/server.ts`'s periodic sweep at all (see that file's own
 * comment): that container has no `/work` mount, so a filesystem-existence
 * check run from there would be permanently, unconditionally wrong for every
 * real project, not just racy. This CLI mode is the only reconciliation
 * entry point — always run via `docker exec pi-web bun cli.ts
 * --reconcile-projects`, i.e. inside the container that DOES have `/work`
 * mounted (same container every other `cli.ts` invocation already runs in).
 *
 * The four flags/positional above are deliberately exactly the `WorkItem`
 * shape from design doc §3.4:
 *
 *   WorkItem = {
 *     project: <abs path>,        # --project -> cwd
 *     workflow: <workflow name>,  # --workflow -> chains/registry.ts lookup
 *     prompt: <string or path>,   # positional arg
 *     session_id?: <existing session to resume>,  # --session-id
 *     model_overrides?: { <agent identity>: <role> }  # NOT implemented here —
 *       no chain/config plumbing for per-run model overrides exists yet;
 *       left out rather than half-wired. Flagging the omission per the
 *       card's brief rather than silently dropping it.
 *   }
 *
 * This file is deliberately a thin wrapper — argument parsing, config/
 * registry lookups, and I/O only. All real execution logic lives in
 * `modules/workflow.ts` (the generic interpreter) and `chains/`
 * (`planBuildTest.ts`, the one remaining hand-written chain).
 *
 * When the future `.fleet`-lite ticket-queue worker exists (design doc §3.4),
 * its job is: pull a card from `now/`, build this same WorkItem shape from
 * the card's frontmatter/body, and call `runWorkflow()`/the registry below
 * directly as a library function (or re-exec this CLI) — no change to this
 * shape without updating §3.4 to match.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { WORKFLOW_DESCRIPTIONS, workflowNames, workflowRegistry, type WorkflowResultBase } from "./chains/registry.ts";
import { ConfigError, projectConfigFor } from "./modules/config.ts";
import { loadRolesConfig } from "./modules/roles.ts";
import { DEFAULT_BASE_URL } from "./modules/piwebClient.ts";
import { Tracer } from "./modules/tracer.ts";
import { formatStaleProjectOutcome, reconcileStaleProjects } from "./modules/projectReconcile.ts";

// ── argument parsing ────────────────────────────────────────────────────

export interface ParsedArgs {
  project: string;
  workflow: string;
  sessionId?: string;
  /** Optional ticket to attach this run to (an existing internal ticket_<hex> id, or an external id like a `.fleet` board id). Omitted -> a fresh internal ticket is minted for this run. This is the mechanism a human resuming a run, or a future automated retry, uses to keep multiple attempts grouped under one ticket. */
  ticketId?: string;
  promptArg: string;
}

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

const USAGE =
  'usage: bun cli.ts --project <abs-path> --workflow <name> [--session-id <id>] [--ticket-id <id>] "<prompt or path/to/prompt.md>"\n' +
  "   or: bun cli.ts --list-workflows\n" +
  "   or: bun cli.ts --reconcile-projects [--delete]";

/**
 * Parses `argv` (i.e. everything after `bun cli.ts`) into `--project`,
 * `--workflow`, `--session-id` (optional), `--ticket-id` (optional),
 * and exactly one positional prompt-or-path argument. Throws `CliUsageError`
 * (never a bare stack trace) for anything malformed — unknown flags, missing
 * required flags, a missing flag value, more than one positional argument, or
 * zero positional arguments.
 *
 * `--list-workflows` is a standalone mode this function does NOT
 * handle — `main()` checks for it and returns early BEFORE calling this
 * function at all, since it needs none of the required flags this function
 * enforces (no `--project`/`--workflow`/prompt). See `formatWorkflowList`.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  let project: string | undefined;
  let workflow: string | undefined;
  let sessionId: string | undefined;
  let ticketId: string | undefined;
  const positionals: string[] = [];

  const knownFlags = new Set(["--project", "--workflow", "--session-id", "--ticket-id"]);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      if (!knownFlags.has(arg)) {
        throw new CliUsageError(`unknown flag ${JSON.stringify(arg)}\n${USAGE}`);
      }
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new CliUsageError(`flag ${arg} requires a value\n${USAGE}`);
      }
      i += 1;
      if (arg === "--project") project = value;
      else if (arg === "--workflow") workflow = value;
      else if (arg === "--session-id") sessionId = value;
      else if (arg === "--ticket-id") ticketId = value;
      continue;
    }
    positionals.push(arg);
  }

  if (!project) throw new CliUsageError(`missing required --project <abs-path>\n${USAGE}`);
  if (!workflow) throw new CliUsageError(`missing required --workflow <name>\n${USAGE}`);
  if (positionals.length === 0) {
    throw new CliUsageError(`missing required prompt argument (literal text or a path to a prompt file)\n${USAGE}`);
  }
  if (positionals.length > 1) {
    throw new CliUsageError(
      `expected exactly one positional prompt argument, got ${String(positionals.length)}: ` +
        `${positionals.map((p) => JSON.stringify(p)).join(", ")}\n${USAGE}`,
    );
  }

  return { project, workflow, sessionId, ticketId, promptArg: positionals[0] as string };
}

/**
 * Resolves the positional prompt argument: if it names an existing file on
 * disk, read that file's contents as the prompt; otherwise treat the
 * argument itself as literal prompt text. Matches SSSF's own convention
 * (`"<prompt or path/to/prompt.md>"`).
 */
export function resolvePrompt(promptArg: string): string {
  if (existsSync(promptArg)) {
    return readFileSync(promptArg, "utf8");
  }
  return promptArg;
}

// ── deep link ────────────────────────────────────────────────────────────

/**
 * Derives pi-web's browser origin from its own API base URL. `DEFAULT_BASE_URL`
 * (`piwebClient.ts`) is `http://<host>:<port>/api` — the API mount point, not
 * where the browser UI itself is served — but confirmed (`pi-web-adw-design.md`
 * §6.2, `app.ts`'s route registration) that pi-web serves both its static
 * client AND its `/api` routes off the SAME host/port, just different path
 * prefixes. So the browser origin is exactly `baseUrl` with a trailing
 * `/api` (only) stripped — derived from the one existing source of truth
 * rather than hardcoding a second copy of the host/port here.
 */
export function browserOriginFromApiBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/api") ? baseUrl.slice(0, -"/api".length) : baseUrl;
}

/**
 * Builds the working session deep-link — `?project=<id>&workspace=<id>&
 * session=<id>` (confirmed against pi-web's client router, `route.ts`/
 * `PiWebApp.ts`: `session` alone does nothing, `project` is read first and
 * short-circuits if absent — pi-web-adw-design.md §6.2/§6.3). `workspaceId`
 * is optional in the URL (an absent `workspace` param still opens the
 * project, just not pinned to a specific worktree) since
 * `resolveWorkspaceId` can itself come back `undefined` in an edge case
 * (e.g. the workspace list hasn't caught up yet) — never block printing a
 * link over one missing piece when the other two are real.
 */
export function sessionDeepLink(baseUrl: string, link: { projectId: string; workspaceId?: string }, sessionId: string): string {
  const origin = browserOriginFromApiBaseUrl(baseUrl);
  const params = new URLSearchParams({ project: link.projectId, session: sessionId });
  if (link.workspaceId) params.set("workspace", link.workspaceId);
  return `${origin}/?${params.toString()}`;
}

// ── status line ──────────────────────────────────────────────────────────

/**
 * Renders the final status line for any registered workflow's result.
 * Handles every branch of `PlanBuildTestResult`'s AND `WorkflowRunResult`'s
 * discriminated unions (and, structurally, any future runner's result
 * carrying the same {status, adwId, sessionId, link} base) distinctly —
 * never collapsed into a generic pass/fail. `step`/`phase` are read
 * generically (`workflow.ts`'s results use `step`, `planBuildTest.ts`'s use
 * `phase` — both narrow to a step/phase NAME string, rendered under one
 * shared label). Returns the message plus the process exit code that should
 * follow it. `baseUrl` defaults to `DEFAULT_BASE_URL` (the same base every
 * run itself defaults to when the caller doesn't override it) so the
 * printed link always points at the SAME server the run actually used.
 */
export function describeResult(result: WorkflowResultBase, baseUrl: string = DEFAULT_BASE_URL): { message: string; exitCode: number } {
  const idLine = `adwId=${result.adwId} sessionId=${result.sessionId}`;
  const link = `link=${sessionDeepLink(baseUrl, result.link, result.sessionId)}`;
  const stepName = (): string => {
    if ("step" in result) return String((result as { step?: unknown }).step);
    if ("phase" in result) return String((result as { phase?: unknown }).phase);
    return "unknown";
  };
  switch (result.status) {
    case "success":
      return { message: `SUCCESS — ${idLine} — ${link}`, exitCode: 0 };
    case "blocked-on-human": {
      return {
        message: `BLOCKED-ON-HUMAN (step=${stepName()}) — ${idLine} — ${link} — the agent asked a question and is waiting; resume with --session-id ${result.sessionId} once answered in pi-web's UI`,
        exitCode: 2,
      };
    }
    case "unparseable": {
      // `rawResponse` distinguishes THREE cases, not two — checked by
      // presence (`in`), not truthiness, specifically because an empty
      // string is itself a real, distinct, and diagnostically important
      // case: confirmed live (2026-08-05) that the model sometimes returns
      // NO text at all after retries (not malformed JSON, not prose-wrapped
      // JSON — genuinely nothing). A falsy-string check here would silently
      // collapse that case back into the old generic message, hiding the
      // one piece of information ("the agent said nothing") that's easiest
      // for a human to actually understand and act on.
      const hasRawResponse = "rawResponse" in result;
      const rawResponse = hasRawResponse ? String((result as { rawResponse?: unknown }).rawResponse) : undefined;
      const detail = !hasRawResponse
        ? " — the agent's response never matched the required envelope schema after retries"
        : rawResponse === ""
          ? " — the agent returned no response text at all (empty) after retries"
          : ` — last response: ${rawResponse}`;
      return {
        message: `UNPARSEABLE (step=${stepName()}) — ${idLine} — ${link}${detail}`,
        exitCode: 3,
      };
    }
    case "permissions-violation": {
      const permissions = "permissions" in result
        ? (result as { permissions?: { violations?: string[] } }).permissions
        : undefined;
      const violations = permissions?.violations ?? [];
      const detail = violations.length > 0
        ? ` — the agent wrote outside its allowed paths (${violations.join(", ")}); changes were rolled back`
        : " — the agent wrote outside its allowed paths; changes were rolled back";
      return {
        message: `PERMISSIONS-VIOLATION (step=${stepName()}) — ${idLine} — ${link}${detail}`,
        exitCode: 4,
      };
    }
    case "failed": {
      const reason = "reason" in result ? String((result as { reason?: unknown }).reason) : "(no reason given)";
      return { message: `FAILED (step=${stepName()}) — ${idLine} — ${link} — ${reason}`, exitCode: 1 };
    }
    case "gate-failed": {
      const report = "report" in result ? (result as { report?: { checks?: { item: string; ok: boolean; note?: string }[] } }).report : undefined;
      const firstFailure = report?.checks?.find((c) => !c.ok);
      const reason = firstFailure ? `${firstFailure.item}: ${firstFailure.note ?? "failed"}` : "a code step's gate failed";
      return { message: `GATE-FAILED (step=${stepName()}) — ${idLine} — ${link} — ${reason}`, exitCode: 5 };
    }
    case "loop-exhausted": {
      const rounds = "rounds" in result ? String((result as { rounds?: unknown }).rounds) : "unknown";
      return {
        message: `LOOP-EXHAUSTED (step=${stepName()}, rounds=${rounds}) — ${idLine} — ${link} — the loop's until condition was never satisfied within max_rounds`,
        exitCode: 6,
      };
    }
    case "review-rejected": {
      // A no-loop Workflow's review step explicitly did not approve —
      // distinct from permissions-violation (4) and gate-failed (5) so a
      // human/CI script watching exit codes can tell "review said no" apart
      // from an enforcement/gate failure.
      const review = "review" in result ? (result as { review?: { blocking?: string[]; summary?: string } }).review : undefined;
      const blocking = review?.blocking ?? [];
      const detail = blocking.length > 0 ? blocking.join("; ") : review?.summary ?? "(no summary given)";
      return {
        message: `REVIEW-REJECTED (step=${stepName()}) — ${idLine} — ${link} — review did not approve: ${detail}`,
        exitCode: 7,
      };
    }
    default:
      return { message: `UNKNOWN STATUS ${JSON.stringify(result.status)} — ${idLine} — ${link}`, exitCode: 1 };
  }
}

// ── main ─────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG_PATH = join(import.meta.dir, "factory.config.yaml");
const DEFAULT_DB_PATH = join(import.meta.dir, "factory.db");

/**
 * `factory.db` accumulates real observability history across every run — it
 * must NOT default to a path that a deploy mechanism might periodically wipe
 * (the Docker bake-in re-syncs `pi-web-factory`'s own code directory
 * wholesale, `rm -rf` included, on every container start, exactly like the
 * existing `pi-continue-companion`/`pi-web-factory-prompts` plugin/extension
 * syncs already do — see `docker-entrypoint.sh`). `PI_WEB_FACTORY_DB_PATH`
 * lets the container set this to a path OUTSIDE that resynced directory
 * (under the bind-mounted, persistent `$PI_CODING_AGENT_DIR`) so the trace
 * db survives both container restarts and code redeploys. Defaults to the
 * historical co-located path for local dev, unchanged.
 */
function resolveDbPath(): string {
  const path = process.env["PI_WEB_FACTORY_DB_PATH"] ?? DEFAULT_DB_PATH;
  // bun:sqlite's `create: true` makes the FILE if missing, not missing
  // parent directories — needed once PI_WEB_FACTORY_DB_PATH can point
  // somewhere that doesn't yet exist (e.g. a fresh bind-mounted config
  // volume on a container's first ever start).
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

/**
 * Config path is resolved relative to THIS file's own location (not the
 * caller's cwd), same convention the test suite already uses
 * (`join(import.meta.dir, "..", "factory.config.yaml")` from chains/modules
 * subdirs — see config.test.ts / planBuildTest.integration.test.ts) — so
 * `bun cli.ts ...` behaves identically no matter what directory it's invoked
 * from. `PI_WEB_FACTORY_CONFIG` is an escape hatch for exactly one situation:
 * ad hoc smoke-testing against a scratch project that isn't (and shouldn't
 * be) registered in the real, committed `factory.config.yaml` — not a
 * documented/supported flag, not part of the WorkItem shape, never touched by
 * ordinary `--project`/`--workflow` invocations.
 */
function resolveConfigPath(): string {
  return process.env["PI_WEB_FACTORY_CONFIG"] ?? DEFAULT_CONFIG_PATH;
}

/**
 * `gates.ts`'s `testsPass` shells out LOCALLY, on the machine cli.ts itself
 * runs on (`Bun.spawn`, refuses a nonexistent cwd) — correct in production,
 * where cli.ts runs as a sibling process inside the same container as the
 * target project (design doc §2), so `--project`'s path IS a real local
 * path there. `PI_WEB_FACTORY_TEST_CWD` is the same kind of dev-only escape
 * hatch as `PI_WEB_FACTORY_CONFIG` above, for the one case that assumption
 * doesn't hold: running cli.ts from a dev machine against a project that
 * only exists inside a remote container, with a self-contained ssh/docker-
 * exec `test` command (see planBuildTest.ts's own `testCwd` doc comment,
 * and planBuildTest.integration.test.ts, which establishes exactly this
 * pattern). Defaults to `--project`'s path, matching planBuildTest.ts's own
 * default.
 */
function resolveTestCwd(projectPath: string): string {
  return process.env["PI_WEB_FACTORY_TEST_CWD"] ?? projectPath;
}

// ── --list-workflows ─────────────────────────────────────────────────────

/**
 * Plain-text `name: description` list, one per registered `--workflow` name
 * (`chains/registry.ts`'s `workflowNames()`/`WORKFLOW_DESCRIPTIONS`) — the
 * exact "self-describing registry" a routing caller reads generically
 * instead of a hand-maintained table. Plain text, not JSON:
 * matches this CLI's existing convention of human/agent-readable stdout
 * lines (the run status line, the "unknown --workflow" error) rather than a
 * structured format nothing else here uses — the intended reader is a
 * Claude Code skill's own agent, which reads prose fine and doesn't need a
 * parser.
 */
export function formatWorkflowList(names: string[], descriptions: Record<string, string>): string {
  return names.map((name) => `${name}: ${descriptions[name] ?? "(no description)"}`).join("\n");
}

async function main(): Promise<number> {
  // Standalone mode: no --project/--workflow/prompt required, performs no
  // run, exits 0. Checked before parseArgs's own required-flag validation so
  // `bun cli.ts --list-workflows` alone (no other flags) succeeds.
  if (Bun.argv.slice(2).includes("--list-workflows")) {
    console.log(formatWorkflowList(workflowNames(), WORKFLOW_DESCRIPTIONS));
    return 0;
  }

  // On-demand stale-project-registration reconciliation — same
  // standalone-mode shape as --list-workflows above (checked before
  // parseArgs's required-flag validation, since it needs none of
  // --project/--workflow/prompt either).
  //
  // Dry-run is the DEFAULT — deletion only happens with an explicit --delete.
  // Flipped deliberately (verification against the real deployed server once
  // hit exactly this footgun live: a `DELETE` probe accidentally removed a
  // real project registration) — matches the "opt-in
  // to danger" posture `orchestrator/server.ts`'s own reconciliation-style
  // passes already use elsewhere in this file (e.g. RETRY_TRIGGER_ENABLED),
  // and is the safer default for a destructive, irreversible-from-this-CLI
  // action a human can trivially run without thinking twice about a flag.
  if (Bun.argv.slice(2).includes("--reconcile-projects")) {
    const dryRun = !Bun.argv.slice(2).includes("--delete");
    const result = await reconcileStaleProjects(process.env["PI_WEB_FACTORY_BASE_URL"] ?? DEFAULT_BASE_URL, { dryRun });
    console.log(
      `scanned ${String(result.scanned)} registered project(s), ${String(result.stale.length)} stale` +
        (dryRun ? " (dry run — nothing deleted; pass --delete to actually delete)" : ""),
    );
    for (const entry of result.stale) {
      console.log(formatStaleProjectOutcome(entry));
    }
    return result.stale.some((e) => e.outcome === "failed") ? 1 : 0;
  }

  let args: ParsedArgs;
  try {
    args = parseArgs(Bun.argv.slice(2));
  } catch (error) {
    if (error instanceof CliUsageError) {
      console.error(error.message);
      return 64; // EX_USAGE
    }
    throw error;
  }

  const workflowRunner = workflowRegistry[args.workflow];
  if (!workflowRunner) {
    console.error(
      `unknown --workflow ${JSON.stringify(args.workflow)} — available workflows: ${workflowNames().join(", ") || "(none registered)"}`,
    );
    return 64;
  }

  let config;
  let testCmd: string | undefined;
  try {
    config = loadRolesConfig(resolveConfigPath());
    // projectConfigFor's own thrown ConfigError already names what IS
    // configured (config.ts) — surfaced verbatim, never rewrapped into
    // something less specific. Its `test` command (when present) is threaded
    // through to the runner explicitly: planBuildTest.ts's own `testCmd`
    // option does not look this up itself (see that file's doc comment on
    // `testCmd` vs its actual behavior), and the generic interpreter's `code`
    // steps get it via their own Role function (roles.ts's `run-tests`
    // reading `project.test` from `projectConfigFor` directly) — cli.ts, as
    // the thin wrapper, is where "look up this project's configured test
    // command" belongs regardless of which runner ends up using it. This
    // reads `<project>/.pi-web-factory.yaml` (a file the target project
    // owns) rather than a centralized map in `config`.
    testCmd = projectConfigFor(args.project).test;
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      return 64;
    }
    throw error;
  }

  const taskPrompt = resolvePrompt(args.promptArg);

  // Mint the adwId here (same shape planBuildTest.ts/workflow.ts mint
  // internally when omitted) so it can be printed and handed to the runner
  // via `adwId`, rather than waiting for the run to finish to learn it. When
  // resuming (--session-id given), the sessionId is already known too, but
  // the real working deep-link (project/workspace ids) is NOT knowable
  // until the run itself resolves them (workspace resolution needs a real,
  // already-created worktree path to query pi-web for) — so this line stays
  // a short "starting/resuming" progress note, and the full link prints once
  // via `describeResult` after the run returns (both success and every
  // failure branch).
  const adwId = `adw_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  console.log(
    `${args.sessionId ? "resuming" : "starting"} workflow ${JSON.stringify(args.workflow)}: adwId=${adwId}` +
      (args.sessionId ? ` sessionId=${args.sessionId}` : " sessionId=(minting a fresh pi-web session...)") +
      // ticketId isn't known until sessionStart resolves it (a fresh
      // internal id is minted there when --ticket-id is omitted) — this line
      // only echoes what was EXPLICITLY passed, never guesses the minted one.
      (args.ticketId ? ` ticketId=${args.ticketId}` : " ticketId=(minting a fresh ticket...)"),
  );

  const tracer = new Tracer(resolveDbPath());
  try {
    const result = await workflowRunner({
      tracer,
      config,
      cwd: args.project,
      taskPrompt,
      sessionId: args.sessionId,
      ticketId: args.ticketId,
      adwId,
      testCmd,
      testCwd: resolveTestCwd(args.project),
      engineer: process.env["USER"] ?? undefined,
    });

    const { message, exitCode } = describeResult(result);
    console.log(message);
    return exitCode;
  } finally {
    tracer.close();
  }
}

// Only auto-run when executed directly (`bun cli.ts ...`), not when imported
// by a test that wants `parseArgs`/`resolvePrompt`/`describeResult` alone.
if (import.meta.main) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exit(1);
    });
}
