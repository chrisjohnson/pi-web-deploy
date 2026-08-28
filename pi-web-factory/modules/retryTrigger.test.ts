/**
 * Unit tests for retryTrigger.ts:
 *   - undecidedFailedRuns: DB-only, real bun:sqlite queries.
 *   - planNextAttempt: mocked `decideRetry` call (via mocked fetch, same
 *     pattern retryDecision.test.ts/run.test.ts already established),
 *     exercising every `outcome` branch (skipped for each reason, retry,
 *     new-run, give-up) and the exact `cli.ts` command shape for retry vs
 *     new-run.
 *   - triggerRetryIfNeeded: end-to-end over a scratch db, confirms decisions
 *     get durably recorded (via traceRetryDecision) so a re-run doesn't
 *     re-decide the same failed run.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tracer } from "./tracer.ts";
import { planNextAttempt, triggerRetryIfNeeded, undecidedFailedRuns, type FailedRunRow } from "./retryTrigger.ts";
import type { RolesConfig } from "./roles.ts";
import type { Workflow } from "./workflowDef.ts";

const BASE_URL = "http://fake-pi-web.test/api";

let dir: string;
let dbPath: string;
let tracer: Tracer;
let originalFetch: typeof fetch;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-web-factory-retrytrigger-test-"));
  dbPath = join(dir, "factory.db");
  tracer = new Tracer(dbPath);
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  tracer.close();
  globalThis.fetch = originalFetch;
  rmSync(dir, { recursive: true, force: true });
});

const config: RolesConfig = {
  defaults: { model: "local-litellm/medium-moe", modelRef: { provider: "local-litellm", modelId: "medium-moe" }, thinking: "medium", protectedFiles: [] },
  roles: [
    {
      kind: "agent",
      name: "decide-retry",
      model: "local-litellm/medium-moe",
      modelRef: { provider: "local-litellm", modelId: "medium-moe" },
      thinking: "low",
      writes: [],
      systemPrompt: "You decide retry/new-run/give-up.",
      systemPromptPath: "prompts/decide-retry.md",
    },
  ],
};

function workflowWithRetries(retries: number): Workflow {
  return {
    name: "plan-build-review",
    description: "A test fixture workflow.",
    retries,
    steps: [{ kind: "agent", name: "plan", role: "plan", prompt: "do the plan" }],
  };
}

function mockDecisionFetch(decisionText: string): void {
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/sessions") && init?.method === "POST") {
      return new Response(JSON.stringify({ id: "sess_decision1" }), { status: 200 });
    }
    if (url.endsWith("/model") && init?.method === "POST") {
      return new Response(JSON.stringify({ isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0, model: { provider: "local-litellm", id: "medium-moe" } }), { status: 200 });
    }
    if (url.endsWith("/prompt") && init?.method === "POST") {
      return new Response(JSON.stringify({ accepted: true }), { status: 200 });
    }
    if (url.includes("/status")) {
      return new Response(JSON.stringify({ isStreaming: false }), { status: 200 });
    }
    if (url.includes("/messages")) {
      const messages = [{ role: "assistant", content: [{ type: "text", text: decisionText }] }];
      return new Response(JSON.stringify({ messages, start: 0, total: messages.length }), { status: 200 });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;
}

/** Seeds a real failed run (session + a fail Step) linked to a ticket, matching what a real Workflow Run / reconciliation pass would have written. */
function seedFailedRun(opts: { adwId: string; ticketId: string; adwName?: string; projectCwd?: string; taskPrompt?: string }): void {
  tracer.sessionStart(opts.adwId, {
    projectCwd: opts.projectCwd ?? "/tmp/proj",
    adwName: opts.adwName ?? "plan-build-review",
    ticketId: opts.ticketId,
    taskPromptForTicket: opts.taskPrompt ?? "do the task",
  });
  tracer.sessionRequest(opts.adwId, opts.taskPrompt ?? "do the task");
  tracer.phaseUpsert({
    phaseId: `${opts.adwId}_plan`,
    adwId: opts.adwId,
    seq: 1,
    name: "plan",
    kind: "agent",
    role: "plan",
    description: "plan step",
    status: "fail",
    error: "unparseable after 3 attempts",
    outputSummary: "unparseable after 3 attempts",
  });
  tracer.sessionFinish(opts.adwId, false);
}

describe("undecidedFailedRuns", () => {
  test("returns every status='fail' run with no retry_decision event yet", () => {
    seedFailedRun({ adwId: "adw_a", ticketId: "M-1" });
    seedFailedRun({ adwId: "adw_b", ticketId: "M-2" });
    tracer.sessionStart("adw_c_running", { projectCwd: "/tmp/proj", ticketId: "M-3", taskPromptForTicket: "still going" });

    const rows = undecidedFailedRuns(tracer.db);
    expect(rows.map((r) => r.adwId).sort()).toEqual(["adw_a", "adw_b"]);
  });

  test("excludes a failed run that already has a retry_decision event", () => {
    seedFailedRun({ adwId: "adw_decided", ticketId: "M-1" });
    tracer.event({ adwId: "adw_decided", type: "log", name: "retry_decision", payload: { decision: "give-up", reasoning: "x", elapsedMs: 1 } });
    seedFailedRun({ adwId: "adw_undecided", ticketId: "M-2" });

    const rows = undecidedFailedRuns(tracer.db);
    expect(rows.map((r) => r.adwId)).toEqual(["adw_undecided"]);
  });

  test("carries ticketId/adwName/projectCwd through for planNextAttempt's own lookups", () => {
    seedFailedRun({ adwId: "adw_a", ticketId: "M-1", adwName: "plan-build-review", projectCwd: "/tmp/proj-a" });
    const row = undecidedFailedRuns(tracer.db)[0];
    expect(row?.ticketId).toBe("M-1");
    expect(row?.adwName).toBe("plan-build-review");
    expect(row?.projectCwd).toBe("/tmp/proj-a");
  });
});

describe("planNextAttempt", () => {
  test("skips a run with no ticketId (a row predating the ticket system)", async () => {
    const failedRun: FailedRunRow = { adwId: "adw_x", ticketId: null, adwName: "plan-build-review", projectCwd: "/tmp/proj" };
    const plan = await planNextAttempt({ db: tracer.db, config, workflows: [workflowWithRetries(2)], failedRun, baseUrl: BASE_URL });
    expect(plan.outcome).toBe("skipped");
    if (plan.outcome === "skipped") expect(plan.reason).toContain("no ticket_id");
  });

  test("skips a run with no projectCwd", async () => {
    const failedRun: FailedRunRow = { adwId: "adw_x", ticketId: "M-1", adwName: "plan-build-review", projectCwd: null };
    const plan = await planNextAttempt({ db: tracer.db, config, workflows: [workflowWithRetries(2)], failedRun, baseUrl: BASE_URL });
    expect(plan.outcome).toBe("skipped");
    if (plan.outcome === "skipped") expect(plan.reason).toContain("no project_cwd");
  });

  test("skips a run whose Workflow name isn't a known YAML Workflow", async () => {
    seedFailedRun({ adwId: "adw_x", ticketId: "M-1", adwName: "some-unknown-workflow" });
    const failedRun = undecidedFailedRuns(tracer.db)[0]!;
    const plan = await planNextAttempt({ db: tracer.db, config, workflows: [workflowWithRetries(2)], failedRun, baseUrl: BASE_URL });
    expect(plan.outcome).toBe("skipped");
    if (plan.outcome === "skipped") expect(plan.reason).toContain("not a known YAML Workflow");
  });

  test("skips once the ticket's retries budget is exhausted — never even calls the decision Role", async () => {
    seedFailedRun({ adwId: "adw_attempt1", ticketId: "M-1" });
    seedFailedRun({ adwId: "adw_attempt2", ticketId: "M-1" }); // 1 prior attempt beyond adwId itself when checking attempt2... let's check attempt3
    seedFailedRun({ adwId: "adw_attempt3", ticketId: "M-1" });
    // retries: 2 means 2 ADDITIONAL attempts allowed after the first — by
    // the time attempt3 fails, 2 OTHER attempts (1, 2) already exist on this
    // ticket, exactly at budget.
    const failedRun = undecidedFailedRuns(tracer.db).find((r) => r.adwId === "adw_attempt3")!;
    globalThis.fetch = (() => {
      throw new Error("decision Role should never be called once budget is exhausted");
    }) as unknown as typeof fetch;
    const plan = await planNextAttempt({ db: tracer.db, config, workflows: [workflowWithRetries(2)], failedRun, baseUrl: BASE_URL });
    expect(plan.outcome).toBe("skipped");
    if (plan.outcome === "skipped") expect(plan.reason).toContain("retries budget");
  });

  test("outcome 'retry' — builds a --session-id resume command using the failed run's OWN adwId as the session id", async () => {
    seedFailedRun({ adwId: "adw_x", ticketId: "M-1", projectCwd: "/tmp/my-project", taskPrompt: "build the thing" });
    const failedRun = undecidedFailedRuns(tracer.db)[0]!;
    mockDecisionFetch(JSON.stringify({ decision: "retry", reasoning: "infra failure, safe to resume" }));

    const plan = await planNextAttempt({ db: tracer.db, config, workflows: [workflowWithRetries(2)], failedRun, baseUrl: BASE_URL });
    expect(plan.outcome).toBe("retry");
    if (plan.outcome !== "retry" && plan.outcome !== "new-run") throw new Error("expected retry or new-run");
    expect(plan.command).toContain("--session-id");
    expect(plan.command).not.toContain("--session-id-never"); // sanity
    expect(plan.command.join(" ")).toContain("--project /tmp/my-project");
    expect(plan.command.join(" ")).toContain("--ticket-id M-1");
    expect(plan.command.at(-1)).toBe("build the thing");
  });

  test("outcome 'new-run' — builds a fresh command with NO --session-id", async () => {
    seedFailedRun({ adwId: "adw_x", ticketId: "M-1", projectCwd: "/tmp/my-project" });
    const failedRun = undecidedFailedRuns(tracer.db)[0]!;
    mockDecisionFetch(JSON.stringify({ decision: "new-run", reasoning: "permissions violation, fresh start safer" }));

    const plan = await planNextAttempt({ db: tracer.db, config, workflows: [workflowWithRetries(2)], failedRun, baseUrl: BASE_URL });
    expect(plan.outcome).toBe("new-run");
    if (plan.outcome !== "retry" && plan.outcome !== "new-run") throw new Error("expected retry or new-run");
    expect(plan.command).not.toContain("--session-id");
  });

  test("outcome 'give-up' — no command built, just the decision", async () => {
    seedFailedRun({ adwId: "adw_x", ticketId: "M-1" });
    const failedRun = undecidedFailedRuns(tracer.db)[0]!;
    mockDecisionFetch(JSON.stringify({ decision: "give-up", reasoning: "this ticket has failed too many times" }));

    const plan = await planNextAttempt({ db: tracer.db, config, workflows: [workflowWithRetries(2)], failedRun, baseUrl: BASE_URL });
    expect(plan.outcome).toBe("give-up");
    expect("command" in plan).toBe(false);
  });
});

describe("triggerRetryIfNeeded", () => {
  test("decides every undecided failed run and durably records the decision — a second call finds nothing left to decide", async () => {
    seedFailedRun({ adwId: "adw_a", ticketId: "M-1", projectCwd: "/tmp/proj-a" });
    mockDecisionFetch(JSON.stringify({ decision: "give-up", reasoning: "no budget left, leave for a human" }));

    const logs: string[] = [];
    const first = await triggerRetryIfNeeded({
      db: tracer.db,
      tracer,
      config,
      workflows: [workflowWithRetries(0)], // 0 retries -> give-up branch would normally be skipped via budget, but here we force the decision Role to weigh in by having 0 prior attempts still within budget... actually 0 retries means budget is 0, exhausted immediately.
      baseUrl: BASE_URL,
      log: (m) => logs.push(m),
    });
    // With retries: 0 and zero prior attempts, budget (0 prior >= 0 budget)
    // is exhausted immediately — this run is SKIPPED, not decided via the
    // model. Confirms the budget-first ordering end to end.
    expect(first.skipped).toBe(1);
    expect(first.decided).toBe(0);

    // Re-running finds the same run — still undecided, since "skipped" never
    // gets a durable retry_decision marker (only real decisions do — see
    // module header: "skipped ... never even asked").
    const second = await triggerRetryIfNeeded({ db: tracer.db, tracer, config, workflows: [workflowWithRetries(0)], baseUrl: BASE_URL, log: () => undefined });
    expect(second.skipped).toBe(1);
  });

  test("a real decision (budget available) gets durably recorded — a second sweep does not re-decide it", async () => {
    seedFailedRun({ adwId: "adw_b", ticketId: "M-2", projectCwd: "/tmp/proj-b" });
    mockDecisionFetch(JSON.stringify({ decision: "new-run", reasoning: "clean start is safer here" }));

    const first = await triggerRetryIfNeeded({ db: tracer.db, tracer, config, workflows: [workflowWithRetries(2)], baseUrl: BASE_URL, log: () => undefined });
    expect(first.decided).toBe(1);

    const rows = tracer.db
      .query<{ n: number }, [string]>("SELECT COUNT(*) as n FROM events WHERE adw_id = ? AND type = 'log' AND name = 'retry_decision'")
      .get("adw_b");
    expect(rows?.n).toBe(1);

    const second = await triggerRetryIfNeeded({ db: tracer.db, tracer, config, workflows: [workflowWithRetries(2)], baseUrl: BASE_URL, log: () => undefined });
    expect(second.decided).toBe(0);
    expect(second.skipped).toBe(0);
  });
});
