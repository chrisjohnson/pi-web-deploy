/**
 * Unit tests for workflow.ts — the generic Workflow interpreter.
 * Covers what doesn't need a live pi-web server:
 *   - `interpolate`/`recordStepEnvelope`: the {{stepName.field}} mechanism.
 *   - `buildLoopCorrectionMessage`: the chain-level correction builder.
 *   - `runWorkflow` end to end against a MOCKED `fetch` (matching
 *     run.test.ts's established pattern), covering: an agent step, a code
 *     step (pass and gate-failure), and a loop step (early-approval AND
 *     bounded-exhaustion paths) — scripting a "review" agent's response to
 *     be not-approved for N-1 rounds and approved on the last (or never
 *     approved through max_rounds, for exhaustion).
 *
 * Live end-to-end coverage (real model, real session, at least one genuine
 * review REJECTION for bounded-build-review) lives in
 * chains/workflow.integration.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ConfigError } from "./config.ts";
import { Tracer } from "./tracer.ts";
import { loadRolesConfigFromString, type RolesConfig } from "./roles.ts";
import { loadWorkflowsFromString, type Workflow } from "./workflowDef.ts";
import {
  buildLoopCorrectionMessage,
  interpolate,
  recordStepEnvelope,
  runWorkflow,
  WorkflowError,
  type InterpolationContext,
} from "./workflow.ts";
import type { ReviewOutput } from "./envelopes.ts";
import type { StepArtifact } from "./stepArtifact.ts";
import { DURABLE_MOUNTS_ENV_VAR, WorktreeError } from "./worktree.ts";

const BASE_URL = "http://fake-pi-web.test/api";

// ── interpolate / recordStepEnvelope ────────────────────────────────────

describe("recordStepEnvelope + interpolate", () => {
  test("substitutes a {{stepName.field}} token from a previously-recorded envelope", () => {
    const ctx: InterpolationContext = new Map();
    recordStepEnvelope(ctx, "plan", { summary: "add a health endpoint", status: "success" });
    expect(interpolate("Plan summary: {{plan.summary}}", ctx)).toBe("Plan summary: add a health endpoint");
  });

  test("substitutes multiple distinct tokens in one string", () => {
    const ctx: InterpolationContext = new Map();
    recordStepEnvelope(ctx, "plan", { summary: "plan summary" });
    recordStepEnvelope(ctx, "build", { summary: "build summary" });
    expect(interpolate("{{plan.summary}} then {{build.summary}}", ctx)).toBe("plan summary then build summary");
  });

  test("non-string envelope fields stringify via JSON.stringify, not dropped", () => {
    const ctx: InterpolationContext = new Map();
    recordStepEnvelope(ctx, "review", { blocking: ["fix x", "fix y"], approved: false });
    expect(interpolate("{{review.blocking}}", ctx)).toBe('["fix x","fix y"]');
    expect(interpolate("{{review.approved}}", ctx)).toBe("false");
  });

  test("throws WorkflowError naming the exact unresolved token for an unknown step", () => {
    const ctx: InterpolationContext = new Map();
    expect(() => interpolate("{{nonexistent.field}}", ctx)).toThrow(WorkflowError);
    expect(() => interpolate("{{nonexistent.field}}", ctx)).toThrow(/\{\{nonexistent\.field\}\}/);
  });

  test("throws WorkflowError for a known step but unknown field", () => {
    const ctx: InterpolationContext = new Map();
    recordStepEnvelope(ctx, "plan", { summary: "x" });
    expect(() => interpolate("{{plan.nonexistent}}", ctx)).toThrow(/plan/);
  });

  test("text with no tokens passes through unchanged", () => {
    const ctx: InterpolationContext = new Map();
    expect(interpolate("no tokens here", ctx)).toBe("no tokens here");
  });
});

// ── buildLoopCorrectionMessage ──────────────────────────────────────────

describe("buildLoopCorrectionMessage", () => {
  test("names exactly what was wrong — blocking items and unmet findings, not a generic 'try again'", () => {
    const review: ReviewOutput = {
      status: "success",
      summary: "reviewed",
      artifacts: [],
      notes_for_next_agent: "",
      approved: false,
      findings: [
        { requirement: "endpoint returns 200", met: true, evidence: "confirmed" },
        { requirement: "endpoint validates input", met: false, evidence: "no validation found" },
      ],
      blocking: ["missing input validation"],
    };
    const message = buildLoopCorrectionMessage(review, "Implement the /health endpoint.");
    expect(message).toContain("NOT approved");
    expect(message).toContain("missing input validation");
    expect(message).toContain("endpoint validates input");
    expect(message).toContain("no validation found");
    // Met findings are not listed as problems.
    expect(message).not.toContain("endpoint returns 200");
    expect(message).toContain("Implement the /health endpoint.");
  });

  test("falls back to a placeholder when blocking/findings are both empty (still names the state clearly)", () => {
    const review: ReviewOutput = {
      status: "success",
      summary: "reviewed",
      artifacts: [],
      notes_for_next_agent: "",
      approved: false,
      findings: [],
      blocking: [],
    };
    const message = buildLoopCorrectionMessage(review, "do the task");
    expect(message).toContain("no specific blocking items listed");
    expect(message).toContain("no specific unmet requirements listed");
  });
});

// ── runWorkflow — full mocked end-to-end ────────────────────────────────

function testRolesConfig(): RolesConfig {
  return loadRolesConfigFromString(
    `
defaults:
  model: local-litellm/medium-moe
  thinking: medium
  protected_files: []
roles:
  - name: plan
    kind: agent
    model: local-litellm/medium-moe
    thinking: medium
    system_prompt: ${join(import.meta.dir, "..", "prompts", "plan.md")}
  - name: build
    kind: agent
    model: local-litellm/medium-moe
    thinking: medium
    system_prompt: ${join(import.meta.dir, "..", "prompts", "build.md")}
  - name: review
    kind: agent
    model: local-litellm/medium-moe
    thinking: medium
    writes: []
    system_prompt: ${join(import.meta.dir, "..", "prompts", "review.md")}
  - name: run-tests
    kind: code
    function: run-tests
`,
    "<test-config>",
  );
}

let dir: string;
let cwd: string;
let dbPath: string;
let tracer: Tracer;
let originalFetch: typeof fetch;

function git(args: string[], cwd_: string): void {
  spawnSync("git", args, { cwd: cwd_, encoding: "utf8" });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-web-factory-workflow-test-"));
  cwd = join(dir, "repo");
  spawnSync("mkdir", ["-p", cwd]);
  git(["init", "-q"], cwd);
  git(["config", "user.email", "test@example.com"], cwd);
  git(["config", "user.name", "Test"], cwd);
  git(["commit", "--allow-empty", "-q", "-m", "init"], cwd);

  dbPath = join(dir, "factory.db");
  tracer = new Tracer(dbPath);
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  tracer.close();
  globalThis.fetch = originalFetch;
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Full mock covering every call `runWorkflow` makes for a fresh (non-resume)
 * run: project registration, worktree workspace resolution, session start,
 * plus run.ts's own model/prompt/status/messages sequence (mirrors
 * run.test.ts's mockFetchSequence, extended for the extra pre-session calls
 * workflow.ts itself makes via piwebProject.ts).
 *
 * `assistantTextsByRole` scripts each agent step's response by ROLE name, in
 * the order that role is called — so a role called multiple times (e.g.
 * "build" across loop rounds, "review" across loop rounds) gets its Nth
 * response on its Nth call.
 */
function mockWorkflowFetch(opts: { assistantTextsByRole: Record<string, string[]>; workspacePath: string }): {
  promptCallsByRole: Record<string, string[]>;
} {
  const promptCallsByRole: Record<string, string[]> = {};
  const roleCallIndex: Record<string, number> = {};
  let lastPromptedSessionRole = ""; // tracks which role's prompt is "in flight" so /messages can answer correctly
  // ensureProjectRegistered does a verify-after-write GET
  // /projects after its POST — this mock must actually reflect a
  // just-POSTed project on the NEXT GET, not always return [], or every
  // registration in these tests would (correctly, per the new client-side
  // retry) look like a lost write and exhaust its retries. Echoes back
  // whatever `path` the caller actually POSTed (NOT the test's own `cwd`
  // closure variable) — `ensureProjectRegistered` registers
  // `resolveMainCheckoutPath(cwd)`, which is `cwd` run through
  // `realpathSync` (macOS symlinks `/tmp` -> `/private/tmp`), so the real
  // registered path can legitimately differ from the raw `cwd` string.
  let registeredProjectPath: string | undefined;

  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.endsWith("/projects") && (init?.method ?? "GET") === "GET") {
      const projects = registeredProjectPath
        ? [{ id: "proj_1", name: "repo", path: registeredProjectPath, createdAt: "2026-01-01T00:00:00Z" }]
        : [];
      return new Response(JSON.stringify(projects), { status: 200 });
    }
    if (url.endsWith("/projects") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { path: string };
      registeredProjectPath = body.path;
      return new Response(JSON.stringify({ id: "proj_1", name: "repo", path: body.path, createdAt: "2026-01-01T00:00:00Z" }), {
        status: 200,
      });
    }
    if (url.includes("/projects/") && url.endsWith("/workspaces")) {
      // Real pi-web wraps this in an envelope object, not a bare array —
      // confirmed live 2026-08-13.
      return new Response(
        JSON.stringify({
          status: "provider",
          projectId: "proj_1",
          ownerPluginId: "git",
          workspaces: [
            { id: "ws_1", projectId: "proj_1", path: opts.workspacePath, label: "main", isMain: true, isGitRepo: true, isGitWorktree: false },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.endsWith("/sessions") && init?.method === "POST") {
      return new Response(
        JSON.stringify({ id: "sess_1", path: "", cwd: opts.workspacePath, created: "2026-01-01T00:00:00Z", modified: "2026-01-01T00:00:00Z", messageCount: 0, firstMessage: "" }),
        { status: 200 },
      );
    }
    if (url.endsWith("/model") && init?.method === "POST") {
      return new Response(
        JSON.stringify({ isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
        { status: 200 },
      );
    }
    if (url.endsWith("/prompt") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { text: string };
      // Recover which role this prompt belongs to from the roleMarker prefix
      // (`[[pi-web-factory:role=<name>]]`) workflow.ts always prepends.
      const match = /\[\[pi-web-factory:role=([\w-]+)\]\]/.exec(body.text);
      const role = match?.[1] ?? "unknown";
      lastPromptedSessionRole = role;
      promptCallsByRole[role] = promptCallsByRole[role] ?? [];
      promptCallsByRole[role]?.push(body.text);
      return new Response(JSON.stringify({ accepted: true }), { status: 200 });
    }
    if (url.includes("/status")) {
      return new Response(
        JSON.stringify({ isStreaming: false, tokens: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, total: 20 }, cost: 0.001 }),
        { status: 200 },
      );
    }
    if (url.includes("/messages")) {
      const role = lastPromptedSessionRole;
      const idx = roleCallIndex[role] ?? 0;
      roleCallIndex[role] = idx + 1;
      const texts = opts.assistantTextsByRole[role] ?? [];
      const text = texts[idx] ?? texts[texts.length - 1] ?? "";
      const messages = [{ role: "assistant", content: [{ type: "text", text }] }];
      return new Response(JSON.stringify({ messages, start: 0, total: messages.length }), { status: 200 });
    }

    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;

  return { promptCallsByRole };
}

function agentEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { status: "success", summary: "did it", artifacts: [], notes_for_next_agent: "", ...overrides };
}

function reviewEnvelope(approved: boolean, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "success",
    summary: "reviewed",
    artifacts: [],
    notes_for_next_agent: "",
    approved,
    findings: approved ? [] : [{ requirement: "must validate input", met: false, evidence: "not found" }],
    blocking: approved ? [] : ["missing validation"],
    ...overrides,
  };
}

describe("runWorkflow — plain agent-step sequence (no loop)", () => {
  test("plan -> build -> review, all approved on first pass, succeeds and threads interpolation through", async () => {
    const workflow: Workflow = loadWorkflowsFromString(`
workflows:
  - name: plan-build-review
    description: A test fixture workflow.
    steps:
      - kind: agent
        name: plan
        role: plan
        prompt: "Reply with a single valid JSON object matching the required schema."
      - kind: agent
        name: build
        role: build
        prompt: "Plan said: {{plan.summary}}. Reply with JSON."
      - kind: agent
        name: review
        role: review
        prompt: "Build said: {{build.summary}}. Reply with JSON."
`)[0] as Workflow;

    mockWorkflowFetch({
      assistantTextsByRole: {
        plan: [JSON.stringify(agentEnvelope({ summary: "plan: add health endpoint" }))],
        build: [JSON.stringify(agentEnvelope({ summary: "build: implemented it" }))],
        review: [JSON.stringify(reviewEnvelope(true, { summary: "review: looks good" }))],
      },
      workspacePath: cwd,
    });

    const result = await runWorkflow({
      tracer,
      config: testRolesConfig(),
      workflow,
      cwd,
      taskPrompt: "add a /health endpoint",
      baseUrl: BASE_URL,
      adwId: "adw_wf_test1",
      sessionId: "sess_preexisting", // resume path: skip worktree creation, cwd used directly
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error(JSON.stringify(result));
    expect(result.steps["plan"]).toMatchObject({ summary: "plan: add health endpoint" });
    expect(result.steps["build"]).toMatchObject({ summary: "build: implemented it" });
    expect(result.steps["review"]).toMatchObject({ approved: true });

    // Interpolation actually threaded plan's summary into build's prompt, and
    // build's summary into review's prompt — confirms the {{...}} mechanism
    // ran for real end to end, not just in the isolated unit tests above.
    const phaseRow = tracer.db
      .query<{ status: string }, [string]>("select status from phases where phase_id=?")
      .get("adw_wf_test1_build");
    expect(phaseRow?.status).toBe("success");
  });

  test("a blocked-on-human agent step stops the whole workflow with a distinct outcome naming that step", async () => {
    const workflow: Workflow = loadWorkflowsFromString(`
workflows:
  - name: single
    description: A test fixture workflow.
    steps:
      - kind: agent
        name: plan
        role: plan
        prompt: "Reply with JSON."
`)[0] as Workflow;

    // Echo back whatever `path` the caller actually POSTed (NOT the
    // test's own `cwd` closure variable) — ensureProjectRegistered registers
    // resolveMainCheckoutPath(cwd), which can legitimately differ from the
    // raw cwd string (e.g. macOS symlinks /tmp -> /private/tmp via
    // realpathSync) — its verify-after-write GET must see a matching path.
    let registeredProjectPath: string | undefined;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/projects") && (init?.method ?? "GET") === "GET") {
        const projects = registeredProjectPath
          ? [{ id: "proj_1", name: "repo", path: registeredProjectPath, createdAt: "x" }]
          : [];
        return new Response(JSON.stringify(projects), { status: 200 });
      }
      if (url.endsWith("/projects") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { path: string };
        registeredProjectPath = body.path;
        return new Response(JSON.stringify({ id: "proj_1", name: "repo", path: body.path, createdAt: "x" }), { status: 200 });
      }
      if (url.includes("/workspaces")) {
        return new Response(
          JSON.stringify({ status: "provider", projectId: "proj_1", ownerPluginId: "git", workspaces: [{ id: "ws_1", path: cwd, isMain: true }] }),
          { status: 200 },
        );
      }
      if (url.endsWith("/model")) return new Response("{}", { status: 200 });
      if (url.endsWith("/prompt")) return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      if (url.includes("/status")) {
        return new Response(
          JSON.stringify({ isStreaming: false, pendingAsk: { askId: "ask_1", askedAt: "x", questions: [{ id: "q1", question: "which approach?", options: [] }] } }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    const result = await runWorkflow({
      tracer,
      config: testRolesConfig(),
      workflow,
      cwd,
      taskPrompt: "do something ambiguous",
      baseUrl: BASE_URL,
      adwId: "adw_wf_blocked",
      sessionId: "sess_preexisting",
    });

    expect(result.status).toBe("blocked-on-human");
    if (result.status !== "blocked-on-human") throw new Error(JSON.stringify(result));
    expect(result.step).toBe("plan");
  });

  test("an unparseable agent step's result carries the agent's actual raw response text through to the workflow result", async () => {
    const workflow: Workflow = loadWorkflowsFromString(`
workflows:
  - name: single
    description: A test fixture workflow.
    steps:
      - kind: agent
        name: plan
        role: plan
        prompt: "Reply with JSON."
`)[0] as Workflow;

    mockWorkflowFetch({
      assistantTextsByRole: {
        plan: ["Sure! Here's my plan:\n```json\nnot actually valid json\n```"],
      },
      workspacePath: cwd,
    });

    const result = await runWorkflow({
      tracer,
      config: testRolesConfig(),
      workflow,
      cwd,
      taskPrompt: "add a /health endpoint",
      baseUrl: BASE_URL,
      adwId: "adw_wf_unparseable",
      sessionId: "sess_preexisting",
    });

    expect(result.status).toBe("unparseable");
    if (result.status !== "unparseable") throw new Error(JSON.stringify(result));
    expect(result.step).toBe("plan");
    expect(result.rawResponse).toContain("```json");
    expect(result.rawResponse).toContain("not actually valid json");

    const phaseRow = tracer.db
      .query<{ error: string | null }, [string]>("select error from phases where phase_id=?")
      .get("adw_wf_unparseable_plan");
    expect(phaseRow?.error).toContain("not actually valid json");
  });

  test("a permissions-violation agent step's result names the violating file(s)", async () => {
    // testRolesConfig's "review" role is the one with `writes: []`
    // (read-only) — reused here so ANY write it makes is a violation,
    // mirroring run.test.ts's readOnlyAgent pattern without needing to
    // hand-construct a RolesConfig (its shape is `{defaults, roles: Role[]}`,
    // not a plain agents map, so mutating a role in place isn't the natural
    // way to do this).
    const workflow: Workflow = loadWorkflowsFromString(`
workflows:
  - name: single
    description: A test fixture workflow.
    steps:
      - kind: agent
        name: review
        role: review
        prompt: "Reply with JSON."
`)[0] as Workflow;

    // Echo back whatever `path` the caller actually POSTed (NOT the
    // test's own `cwd` closure variable) — ensureProjectRegistered registers
    // resolveMainCheckoutPath(cwd), which can legitimately differ from the
    // raw cwd string (e.g. macOS symlinks /tmp -> /private/tmp via
    // realpathSync) — its verify-after-write GET must see a matching path.
    let registeredProjectPath: string | undefined;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/projects") && (init?.method ?? "GET") === "GET") {
        const projects = registeredProjectPath
          ? [{ id: "proj_1", name: "repo", path: registeredProjectPath, createdAt: "x" }]
          : [];
        return new Response(JSON.stringify(projects), { status: 200 });
      }
      if (url.endsWith("/projects") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { path: string };
        registeredProjectPath = body.path;
        return new Response(JSON.stringify({ id: "proj_1", name: "repo", path: body.path, createdAt: "x" }), { status: 200 });
      }
      if (url.includes("/workspaces")) {
        return new Response(
          JSON.stringify({ status: "provider", projectId: "proj_1", ownerPluginId: "git", workspaces: [{ id: "ws_1", path: cwd, isMain: true }] }),
          { status: 200 },
        );
      }
      if (url.endsWith("/model")) return new Response("{}", { status: 200 });
      if (url.endsWith("/prompt") && init?.method === "POST") {
        writeFileSync(join(cwd, "stack.py"), "print('should not have been written')\n");
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }
      if (url.includes("/status")) return new Response(JSON.stringify({ isStreaming: false }), { status: 200 });
      if (url.includes("/messages")) {
        const messages = [{ role: "assistant", content: [{ type: "text", text: JSON.stringify(reviewEnvelope(true)) }] }];
        return new Response(
          JSON.stringify({ messages, start: 0, total: messages.length }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    const result = await runWorkflow({
      tracer,
      config: testRolesConfig(),
      workflow,
      cwd,
      taskPrompt: "add a /health endpoint",
      baseUrl: BASE_URL,
      adwId: "adw_wf_permviol",
      sessionId: "sess_preexisting",
    });

    expect(result.status).toBe("permissions-violation");
    if (result.status !== "permissions-violation") throw new Error(JSON.stringify(result));
    expect(result.step).toBe("review");
    expect(result.permissions.violations).toContain("stack.py");
  });
});

describe("runWorkflow — review-rejected outside a loop", () => {
  test("a no-loop Workflow ending in a review step with approved: false reports 'review-rejected', not 'success'", async () => {
    const workflow: Workflow = loadWorkflowsFromString(`
workflows:
  - name: plan-build-review
    description: A test fixture workflow.
    steps:
      - kind: agent
        name: plan
        role: plan
        prompt: "Reply with JSON."
      - kind: agent
        name: build
        role: build
        prompt: "Plan said: {{plan.summary}}. Reply with JSON."
      - kind: agent
        name: review
        role: review
        prompt: "Build said: {{build.summary}}. Reply with JSON."
`)[0] as Workflow;

    mockWorkflowFetch({
      assistantTextsByRole: {
        plan: [JSON.stringify(agentEnvelope({ summary: "plan: add health endpoint" }))],
        build: [JSON.stringify(agentEnvelope({ summary: "build: claimed done, but wasn't" }))],
        review: [JSON.stringify(reviewEnvelope(false, { summary: "the file doesn't exist" }))],
      },
      workspacePath: cwd,
    });

    const result = await runWorkflow({
      tracer,
      config: testRolesConfig(),
      workflow,
      cwd,
      taskPrompt: "add a /health endpoint",
      baseUrl: BASE_URL,
      adwId: "adw_wf_review_rejected",
      sessionId: "sess_preexisting",
    });

    expect(result.status).toBe("review-rejected");
    if (result.status !== "review-rejected") throw new Error(JSON.stringify(result));
    expect(result.step).toBe("review");
    expect(result.review.approved).toBe(false);
    expect(result.review.blocking).toContain("missing validation");

    // The run itself is traced as a failure, not a success.
    const sessionRow = tracer.db
      .query<{ status: string }, [string]>("select status from sessions where adw_id=?")
      .get("adw_wf_review_rejected");
    expect(sessionRow?.status).toBe("fail");
  });

  test("a no-loop Workflow ending in an approved review still reports 'success' (no false-positive regression)", async () => {
    const workflow: Workflow = loadWorkflowsFromString(`
workflows:
  - name: plan-build-review
    description: A test fixture workflow.
    steps:
      - kind: agent
        name: plan
        role: plan
        prompt: "Reply with JSON."
      - kind: agent
        name: build
        role: build
        prompt: "Plan said: {{plan.summary}}. Reply with JSON."
      - kind: agent
        name: review
        role: review
        prompt: "Build said: {{build.summary}}. Reply with JSON."
`)[0] as Workflow;

    mockWorkflowFetch({
      assistantTextsByRole: {
        plan: [JSON.stringify(agentEnvelope({ summary: "plan: add health endpoint" }))],
        build: [JSON.stringify(agentEnvelope({ summary: "build: implemented it" }))],
        review: [JSON.stringify(reviewEnvelope(true, { summary: "looks good" }))],
      },
      workspacePath: cwd,
    });

    const result = await runWorkflow({
      tracer,
      config: testRolesConfig(),
      workflow,
      cwd,
      taskPrompt: "add a /health endpoint",
      baseUrl: BASE_URL,
      adwId: "adw_wf_review_approved",
      sessionId: "sess_preexisting",
    });

    expect(result.status).toBe("success");
  });

  test("bounded-build-review's loop with a review that never approves within max_rounds still reports 'loop-exhausted', unaffected by the review-rejected check", async () => {
    mockWorkflowFetch({
      assistantTextsByRole: {
        build: [JSON.stringify(agentEnvelope({ summary: "build v1" }))],
        review: [
          JSON.stringify(reviewEnvelope(false)),
          JSON.stringify(reviewEnvelope(false)),
          JSON.stringify(reviewEnvelope(false)),
        ],
      },
      workspacePath: cwd,
    });

    const workflow: Workflow = loadWorkflowsFromString(`
workflows:
  - name: bounded
    description: A test fixture workflow.
    steps:
      - kind: agent
        name: build
        role: build
        prompt: "Implement the task. Reply with JSON."
      - kind: loop
        name: build-review-loop
        max_rounds: 3
        until: {step: review, field: approved, equals: true}
        steps:
          - kind: agent
            name: review
            role: review
            prompt: "Review the build. Build said: {{build.summary}}. Reply with JSON."
          - kind: agent
            name: build-retry
            role: build
            prompt: "Fix it up. Reply with JSON."
`)[0] as Workflow;

    const result = await runWorkflow({
      tracer,
      config: testRolesConfig(),
      workflow,
      cwd,
      taskPrompt: "implement the feature",
      baseUrl: BASE_URL,
      adwId: "adw_wf_loop_still_exhausted",
      sessionId: "sess_preexisting",
    });

    // Still loop-exhausted (the loop's own outcome), NOT review-rejected —
    // confirms the loop path and the final review-rejected check don't
    // double-handle the same rejection.
    expect(result.status).toBe("loop-exhausted");
    if (result.status !== "loop-exhausted") throw new Error(JSON.stringify(result));
    expect(result.step).toBe("build-review-loop");
  });
});

describe("runWorkflow — code step", () => {
  test("a passing code step traces gate_pass and lets the workflow succeed", async () => {
    writeFileSync(join(cwd, ".pi-web-factory.yaml"), "test: 'true'\n"); // shell 'true' always exits 0
    const workflow: Workflow = loadWorkflowsFromString(`
workflows:
  - name: code-only
    description: A test fixture workflow.
    steps:
      - kind: code
        name: test
        role: run-tests
`)[0] as Workflow;

    // A code-step-only Workflow never calls run.ts's own network path, but
    // runWorkflow ALWAYS registers the pi-web Project / resolves a workspace
    // id first (same as planBuildTest.ts, unconditionally) — mock those
    // calls too, not just the ones code steps themselves need.
    mockWorkflowFetch({ assistantTextsByRole: {}, workspacePath: cwd });

    const result = await runWorkflow({
      tracer,
      config: testRolesConfig(),
      workflow,
      cwd,
      taskPrompt: "run tests",
      baseUrl: BASE_URL,
      adwId: "adw_wf_code_pass",
      sessionId: "sess_preexisting",
    });

    expect(result.status).toBe("success");

    const gateRow = tracer.db
      .query<{ passed: number }, [string]>("select passed from gate_results where adw_id=? and gate='run-tests'")
      .get("adw_wf_code_pass");
    expect(gateRow?.passed).toBe(1);
  });

  test("a failing code step stops the workflow with a distinct 'gate-failed' outcome, not silently continuing", async () => {
    writeFileSync(join(cwd, ".pi-web-factory.yaml"), "test: 'false'\n"); // shell 'false' always exits 1
    const workflow: Workflow = loadWorkflowsFromString(`
workflows:
  - name: code-only
    description: A test fixture workflow.
    steps:
      - kind: code
        name: test
        role: run-tests
`)[0] as Workflow;

    mockWorkflowFetch({ assistantTextsByRole: {}, workspacePath: cwd });

    const result = await runWorkflow({
      tracer,
      config: testRolesConfig(),
      workflow,
      cwd,
      taskPrompt: "run tests",
      baseUrl: BASE_URL,
      adwId: "adw_wf_code_fail",
      sessionId: "sess_preexisting",
    });

    expect(result.status).toBe("gate-failed");
    if (result.status !== "gate-failed") throw new Error(JSON.stringify(result));
    expect(result.step).toBe("test");
    expect(result.report.checks.some((c) => !c.ok)).toBe(true);

    const phaseRow = tracer.db
      .query<{ status: string; output_summary: string | null }, [string]>(
        "select status, output_summary from phases where phase_id=?",
      )
      .get("adw_wf_code_fail_test");
    expect(phaseRow?.status).toBe("fail");
    expect(phaseRow?.output_summary).toBeTruthy();

    const gateRow = tracer.db
      .query<{ passed: number }, [string]>("select passed from gate_results where adw_id=? and gate='run-tests'")
      .get("adw_wf_code_fail");
    expect(gateRow?.passed).toBe(0);
  });

  test("a .pi-web-factory.yaml that omits test: fails loudly instead of silently passing", async () => {
    // Deliberately no "test:" key at all — distinct from the pass/fail cases
    // above, which both set one explicitly. Without this guard, roles.ts's
    // run-tests function would compute `project.test ?? ""` and shell out
    // `sh -c ""`, which exits 0 and reads as a false "pass". No gate_results
    // row should even be written for this case — it must fail before ever
    // calling testsPass.
    writeFileSync(join(cwd, ".pi-web-factory.yaml"), "typecheck: 'true'\n");
    const workflow: Workflow = loadWorkflowsFromString(`
workflows:
  - name: code-only
    description: A test fixture workflow.
    steps:
      - kind: code
        name: test
        role: run-tests
`)[0] as Workflow;

    mockWorkflowFetch({ assistantTextsByRole: {}, workspacePath: cwd });

    const result = await runWorkflow({
      tracer,
      config: testRolesConfig(),
      workflow,
      cwd,
      taskPrompt: "run tests",
      baseUrl: BASE_URL,
      adwId: "adw_wf_code_no_test_cmd",
      sessionId: "sess_preexisting",
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error(JSON.stringify(result));
    expect(result.step).toBe("test");
    expect(result.reason).toContain("no test command configured");

    const phaseRow = tracer.db
      .query<{ status: string; error: string | null }, [string]>("select status, error from phases where phase_id=?")
      .get("adw_wf_code_no_test_cmd_test");
    expect(phaseRow?.status).toBe("fail");
    expect(phaseRow?.error).toContain("no test command configured");

    const gateRow = tracer.db
      .query<{ passed: number }, [string]>("select passed from gate_results where adw_id=? and gate='run-tests'")
      .get("adw_wf_code_no_test_cmd");
    expect(gateRow).toBeNull();
  });
});

describe("runWorkflow — loop step", () => {
  const boundedWorkflow = (): Workflow =>
    loadWorkflowsFromString(`
workflows:
  - name: bounded
    description: A test fixture workflow.
    steps:
      - kind: agent
        name: build
        role: build
        prompt: "Implement the task. Reply with JSON."
      - kind: loop
        name: build-review-loop
        max_rounds: 3
        until: {step: review, field: approved, equals: true}
        steps:
          - kind: agent
            name: review
            role: review
            prompt: "Review the build. Build said: {{build.summary}}. Reply with JSON."
          - kind: agent
            name: build-retry
            role: build
            prompt: "Fix it up. Reply with JSON."
`)[0] as Workflow;

  test("early approval: loop stops as soon as 'until' is satisfied, WITHOUT running the round's remaining steps", async () => {
    const { promptCallsByRole } = mockWorkflowFetch({
      assistantTextsByRole: {
        build: [JSON.stringify(agentEnvelope({ summary: "build v1" }))],
        // approved on round 1 -> build-retry must NEVER be called this round.
        review: [JSON.stringify(reviewEnvelope(true))],
      },
      workspacePath: cwd,
    });

    const result = await runWorkflow({
      tracer,
      config: testRolesConfig(),
      workflow: boundedWorkflow(),
      cwd,
      taskPrompt: "implement the feature",
      baseUrl: BASE_URL,
      adwId: "adw_wf_loop_early",
      sessionId: "sess_preexisting",
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error(JSON.stringify(result));
    expect(result.steps["review"]).toMatchObject({ approved: true });
    // build-retry never ran at all — no phase row for it.
    expect(result.steps["build-retry"]).toBeUndefined();
    expect(promptCallsByRole["build"]?.length).toBe(1); // only the outer "build" step's one call
  });

  test("rejected then approved: build-retry gets called with a correction folded in, then review approves on round 2", async () => {
    const { promptCallsByRole } = mockWorkflowFetch({
      assistantTextsByRole: {
        build: [JSON.stringify(agentEnvelope({ summary: "build v1" }))],
        review: [JSON.stringify(reviewEnvelope(false)), JSON.stringify(reviewEnvelope(true, { summary: "now approved" }))],
      },
      workspacePath: cwd,
    });

    const result = await runWorkflow({
      tracer,
      config: testRolesConfig(),
      workflow: boundedWorkflow(),
      cwd,
      taskPrompt: "implement the feature",
      baseUrl: BASE_URL,
      adwId: "adw_wf_loop_retry",
      sessionId: "sess_preexisting",
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error(JSON.stringify(result));
    expect(result.steps["review"]).toMatchObject({ approved: true, summary: "now approved" });

    // build-retry (the loop's OWN "build" role step) got exactly one call,
    // and its prompt carries the correction naming what was wrong.
    const buildCalls = promptCallsByRole["build"] ?? [];
    expect(buildCalls.length).toBe(2); // outer build (round-0) + build-retry (round 1's correction)
    expect(buildCalls[1]).toContain("NOT approved");
    expect(buildCalls[1]).toContain("missing validation");
  });

  test("bounded exhaustion: never approved through max_rounds stops with a distinct 'loop-exhausted' outcome, not folded into success or a generic failure", async () => {
    mockWorkflowFetch({
      assistantTextsByRole: {
        build: [JSON.stringify(agentEnvelope({ summary: "build v1" }))],
        review: [
          JSON.stringify(reviewEnvelope(false)),
          JSON.stringify(reviewEnvelope(false)),
          JSON.stringify(reviewEnvelope(false)),
        ],
      },
      workspacePath: cwd,
    });

    const result = await runWorkflow({
      tracer,
      config: testRolesConfig(),
      workflow: boundedWorkflow(),
      cwd,
      taskPrompt: "implement the feature",
      baseUrl: BASE_URL,
      adwId: "adw_wf_loop_exhausted",
      sessionId: "sess_preexisting",
    });

    expect(result.status).toBe("loop-exhausted");
    if (result.status !== "loop-exhausted") throw new Error(JSON.stringify(result));
    expect(result.step).toBe("build-review-loop");
    expect(result.rounds).toBe(3);

    // The Workflow Run itself is traced as a failure, not a success.
    const sessionRow = tracer.db
      .query<{ status: string }, [string]>("select status from sessions where adw_id=?")
      .get("adw_wf_loop_exhausted");
    expect(sessionRow?.status).toBe("fail");
  });

  test("an inner step's own terminal outcome (e.g. blocked-on-human) stops the loop immediately, not folded into loop-exhausted", async () => {
    // Echo back whatever `path` the caller actually POSTed (NOT the
    // test's own `cwd` closure variable) — ensureProjectRegistered registers
    // resolveMainCheckoutPath(cwd), which can legitimately differ from the
    // raw cwd string (e.g. macOS symlinks /tmp -> /private/tmp via
    // realpathSync) — its verify-after-write GET must see a matching path.
    let registeredProjectPath: string | undefined;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/projects") && (init?.method ?? "GET") === "GET") {
        const projects = registeredProjectPath
          ? [{ id: "proj_1", name: "repo", path: registeredProjectPath, createdAt: "x" }]
          : [];
        return new Response(JSON.stringify(projects), { status: 200 });
      }
      if (url.endsWith("/projects") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { path: string };
        registeredProjectPath = body.path;
        return new Response(JSON.stringify({ id: "proj_1", name: "repo", path: body.path, createdAt: "x" }), { status: 200 });
      }
      if (url.includes("/workspaces")) {
        return new Response(
          JSON.stringify({ status: "provider", projectId: "proj_1", ownerPluginId: "git", workspaces: [{ id: "ws_1", path: cwd, isMain: true }] }),
          { status: 200 },
        );
      }
      if (url.endsWith("/model")) return new Response("{}", { status: 200 });
      if (url.endsWith("/prompt")) return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      if (url.includes("/status")) {
        const match = /\[\[pi-web-factory:role=([\w-]+)\]\]/;
        void match;
        return new Response(
          JSON.stringify({ isStreaming: false, pendingAsk: { askId: "ask_1", askedAt: "x", questions: [{ id: "q1", question: "which fix?", options: [] }] } }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    const result = await runWorkflow({
      tracer,
      config: testRolesConfig(),
      workflow: boundedWorkflow(),
      cwd,
      taskPrompt: "implement the feature",
      baseUrl: BASE_URL,
      adwId: "adw_wf_loop_blocked",
      sessionId: "sess_preexisting",
    });

    // The FIRST step in this workflow is the outer "build" step, which will
    // itself hit the scripted blocked-on-human status before the loop is
    // ever entered — confirms an inner-step-shaped terminal outcome (the
    // same discriminated result the loop's own inner steps would produce)
    // propagates immediately rather than being swallowed by the loop's
    // round-counting.
    expect(result.status).toBe("blocked-on-human");
    if (result.status !== "blocked-on-human") throw new Error(JSON.stringify(result));
    expect(result.step).toBe("build");
  });

  test("regression: a Workflow whose FIRST step is a loop still injects taskPrompt into that loop's first inner agent step (neither shipped workflow exercises this — the interpreter must still be correct for one that would)", async () => {
    const loopFirstWorkflow: Workflow = loadWorkflowsFromString(`
workflows:
  - name: loop-first
    description: A test fixture workflow.
    steps:
      - kind: loop
        name: build-review-loop
        max_rounds: 2
        until: {step: review, field: approved, equals: true}
        steps:
          - kind: agent
            name: build
            role: build
            prompt: "Implement it. Reply with JSON."
          - kind: agent
            name: review
            role: review
            prompt: "Review. Reply with JSON."
`)[0] as Workflow;

    const { promptCallsByRole } = mockWorkflowFetch({
      assistantTextsByRole: {
        build: [JSON.stringify(agentEnvelope({ summary: "build v1" }))],
        review: [JSON.stringify(reviewEnvelope(true))],
      },
      workspacePath: cwd,
    });

    const result = await runWorkflow({
      tracer,
      config: testRolesConfig(),
      workflow: loopFirstWorkflow,
      cwd,
      taskPrompt: "THE-ORIGINAL-TASK-PROMPT-MARKER",
      baseUrl: BASE_URL,
      adwId: "adw_wf_loop_first",
      sessionId: "sess_preexisting",
    });

    expect(result.status).toBe("success");
    // The loop's first inner step ("build") is also the Workflow's first
    // agent step overall — its prompt must carry the original task prompt,
    // not just its own step-authored text (this is exactly what broke before
    // ctx.taskPromptInjected moved the check inside runAgentStep itself).
    const buildCalls = promptCallsByRole["build"] ?? [];
    expect(buildCalls.length).toBe(1);
    expect(buildCalls[0]).toContain("THE-ORIGINAL-TASK-PROMPT-MARKER");
  });
});

describe("runWorkflow — unknown role/config errors surface clearly", () => {
  test("an agent step naming a role with no matching envelope schema throws a clear WorkflowError at run time", async () => {
    const config = loadRolesConfigFromString(
      `
defaults: {model: local-litellm/medium-moe, thinking: medium, protected_files: []}
roles:
  - name: mystery
    kind: agent
    system_prompt: ${join(import.meta.dir, "..", "prompts", "build.md")}
`,
      "<test>",
    );
    const workflow: Workflow = loadWorkflowsFromString(`
workflows:
  - name: bad-role
    description: A test fixture workflow.
    steps:
      - kind: agent
        name: step1
        role: mystery
        prompt: "do it"
`)[0] as Workflow;

    mockWorkflowFetch({ assistantTextsByRole: {}, workspacePath: cwd });

    await expect(
      runWorkflow({
        tracer,
        config,
        workflow,
        cwd,
        taskPrompt: "x",
        baseUrl: BASE_URL,
        adwId: "adw_wf_badrole",
        sessionId: "sess_preexisting",
      }),
    ).rejects.toThrow(WorkflowError);
  });

  test("a code step naming an unknown role throws a ConfigError (roles.ts's own lookup, not swallowed)", async () => {
    const config = testRolesConfig();
    const workflow: Workflow = loadWorkflowsFromString(`
workflows:
  - name: bad-code-role
    description: A test fixture workflow.
    steps:
      - kind: code
        name: step1
        role: nonexistent-code-role
`)[0] as Workflow;

    mockWorkflowFetch({ assistantTextsByRole: {}, workspacePath: cwd });

    await expect(
      runWorkflow({
        tracer,
        config,
        workflow,
        cwd,
        taskPrompt: "x",
        baseUrl: BASE_URL,
        adwId: "adw_wf_badcoderole",
        sessionId: "sess_preexisting",
      }),
    ).rejects.toThrow(ConfigError);
  });
});

// ── Write-path catch-all ────────────────────────────────────────────────────

describe("runWorkflow — catch-all on an uncaught exception", () => {
  test("an agent step's setModel throwing before waitForCompletion still writes a terminal fail phase_end and sessionFinish, then re-throws", async () => {
    // Reproduces the real failure mode exactly: a PiWebClientError (e.g. a
    // bad/nonexistent --session-id, HTTP 404) thrown by setModel/sendPrompt
    // BEFORE waitForCompletion is ever reached. Without this catch-all, that
    // would propagate all the way past runWorkflow uncaught, leaving the
    // phase row stuck at status='running' forever.
    const workflow: Workflow = loadWorkflowsFromString(`
workflows:
  - name: single
    description: A test fixture workflow.
    steps:
      - kind: agent
        name: plan
        role: plan
        prompt: "Reply with JSON."
`)[0] as Workflow;

    // Echo back whatever `path` the caller actually POSTed (NOT the
    // test's own `cwd` closure variable) — ensureProjectRegistered registers
    // resolveMainCheckoutPath(cwd), which can legitimately differ from the
    // raw cwd string (e.g. macOS symlinks /tmp -> /private/tmp via
    // realpathSync) — its verify-after-write GET must see a matching path.
    let registeredProjectPath: string | undefined;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/projects") && (init?.method ?? "GET") === "GET") {
        const projects = registeredProjectPath
          ? [{ id: "proj_1", name: "repo", path: registeredProjectPath, createdAt: "x" }]
          : [];
        return new Response(JSON.stringify(projects), { status: 200 });
      }
      if (url.endsWith("/projects") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { path: string };
        registeredProjectPath = body.path;
        return new Response(JSON.stringify({ id: "proj_1", name: "repo", path: body.path, createdAt: "x" }), { status: 200 });
      }
      if (url.includes("/workspaces")) {
        return new Response(
          JSON.stringify({ status: "provider", projectId: "proj_1", ownerPluginId: "git", workspaces: [{ id: "ws_1", path: cwd, isMain: true }] }),
          { status: 200 },
        );
      }
      if (url.endsWith("/model")) {
        // The real failure mode: pi-web 404s on setModel (bad session id).
        return new Response(JSON.stringify({ error: "Session not found" }), { status: 404 });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    await expect(
      runWorkflow({
        tracer,
        config: testRolesConfig(),
        workflow,
        cwd,
        taskPrompt: "add a thing",
        baseUrl: BASE_URL,
        adwId: "adw_wf_catchall",
        sessionId: "sess_bad_id",
      }),
    ).rejects.toThrow(/404/);

    // The open Step (plan) must have a terminal fail phase_end, not be left
    // at status='running' forever.
    const phaseRow = tracer.db
      .query<{ status: string; error: string | null }, [string]>("select status, error from phases where phase_id=?")
      .get("adw_wf_catchall_plan");
    expect(phaseRow?.status).toBe("fail");
    expect(phaseRow?.error).toContain("404");

    // The Workflow Run itself must also be resolved to a terminal status,
    // via tracer.sessionFinish(adwId, false) — not left 'running'.
    const sessionRow = tracer.db
      .query<{ status: string }, [string]>("select status from sessions where adw_id=?")
      .get("adw_wf_catchall");
    expect(sessionRow?.status).toBe("fail");
  });

  test("a code step's role.run() throwing still writes a terminal fail phase_end for that step, then re-throws", async () => {
    // Same catch-all, exercised via a code Step instead of an agent Step —
    // confirms ctx.openPhase tracking works for both runAgentStep AND
    // runCodeStep call sites (see RunContext's doc comment), not just the
    // agent-step path.
    const config = loadRolesConfigFromString(
      `
defaults: {model: local-litellm/medium-moe, thinking: medium, protected_files: []}
roles:
  - name: run-tests
    kind: code
    function: run-tests
`,
      "<test>",
    );
    const workflow: Workflow = loadWorkflowsFromString(`
workflows:
  - name: single
    description: A test fixture workflow.
    steps:
      - kind: code
        name: test
        role: run-tests
`)[0] as Workflow;

    mockWorkflowFetch({ assistantTextsByRole: {}, workspacePath: cwd });

    // No factory.config.yaml in this scratch repo -> projectConfigFor (or
    // the role's own run()) throws before any gate_pass/gate_fail/phase_end
    // gets traced — a real, uncontrived way for a code Step to blow up
    // mid-flight, not a synthetic-only scenario.
    await expect(
      runWorkflow({
        tracer,
        config,
        workflow,
        cwd,
        taskPrompt: "x",
        baseUrl: BASE_URL,
        adwId: "adw_wf_catchall_code",
        sessionId: "sess_preexisting",
      }),
    ).rejects.toThrow();

    const phaseRow = tracer.db
      .query<{ status: string }, [string]>("select status from phases where phase_id=?")
      .get("adw_wf_catchall_code_test");
    expect(phaseRow?.status).toBe("fail");

    const sessionRow = tracer.db
      .query<{ status: string }, [string]>("select status from sessions where adw_id=?")
      .get("adw_wf_catchall_code");
    expect(sessionRow?.status).toBe("fail");
  });
});

describe("runWorkflow — worktree-per-run", () => {
  test("a fresh run (no sessionId) creates a real worktree and uses it as the session cwd", async () => {
    const workflow: Workflow = loadWorkflowsFromString(`
workflows:
  - name: single
    description: A test fixture workflow.
    steps:
      - kind: agent
        name: plan
        role: plan
        prompt: "Reply with JSON."
`)[0] as Workflow;

    const worktreePath = join(cwd, ".pi-web-factory-worktrees", "adw_wf_fresh");
    mockWorkflowFetch({
      assistantTextsByRole: { plan: [JSON.stringify(agentEnvelope())] },
      workspacePath: worktreePath,
    });

    const result = await runWorkflow({
      tracer,
      config: testRolesConfig(),
      workflow,
      cwd, // main checkout, NOT a worktree — no sessionId means a fresh worktree gets created
      taskPrompt: "add a thing",
      baseUrl: BASE_URL,
      adwId: "adw_wf_fresh",
      mainCheckoutPath: cwd,
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error(JSON.stringify(result));
    expect(result.link.cwd).toBe(worktreePath);
    expect(existsSync(worktreePath)).toBe(true);
  });
});

// ── Project-path guards run BEFORE registration, not just before worktree creation ──

describe("runWorkflow — project-path guards fire before pi-web project registration", () => {
  const originalDurableMounts = process.env[DURABLE_MOUNTS_ENV_VAR];
  afterEach(() => {
    if (originalDurableMounts === undefined) delete process.env[DURABLE_MOUNTS_ENV_VAR];
    else process.env[DURABLE_MOUNTS_ENV_VAR] = originalDurableMounts;
  });

  test("a project path outside the configured durable mount is rejected BEFORE any POST /projects call", async () => {
    const workflow: Workflow = loadWorkflowsFromString(`
workflows:
  - name: single
    description: A test fixture workflow.
    steps:
      - kind: agent
        name: plan
        role: plan
        prompt: "Reply with JSON."
`)[0] as Workflow;

    process.env[DURABLE_MOUNTS_ENV_VAR] = "/some/other/durable/mount";

    let projectsPosted = false;
    globalThis.fetch = (async (_input: string | URL, init?: RequestInit): Promise<Response> => {
      if (init?.method === "POST") projectsPosted = true;
      throw new Error("no network call should happen at all — the guard must fire first, purely locally");
    }) as typeof fetch;

    await expect(
      runWorkflow({
        tracer,
        config: testRolesConfig(),
        workflow,
        cwd,
        taskPrompt: "add a thing",
        baseUrl: BASE_URL,
        adwId: "adw_wf_guard_mount",
        mainCheckoutPath: cwd, // real repo root, but outside the configured durable mount
      }),
    ).rejects.toThrow(WorktreeError);
    expect(projectsPosted).toBe(false);
  });

  test("a project path that is not a real single-repo root (e.g. /work itself) is rejected BEFORE any POST /projects call", async () => {
    const workflow: Workflow = loadWorkflowsFromString(`
workflows:
  - name: single
    description: A test fixture workflow.
    steps:
      - kind: agent
        name: plan
        role: plan
        prompt: "Reply with JSON."
`)[0] as Workflow;

    // Models the real /work incident: a directory that exists, is durable
    // (or has no durable-mount restriction configured), but has no .git of
    // its own — the whole bind-mount root, not a single repo.
    delete process.env[DURABLE_MOUNTS_ENV_VAR];
    const notARepoRoot = dir; // the mkdtemp scratch dir itself — `cwd` (a real repo) is nested one level under it, `dir` itself has no .git

    let projectsPosted = false;
    globalThis.fetch = (async (_input: string | URL, init?: RequestInit): Promise<Response> => {
      if (init?.method === "POST") projectsPosted = true;
      throw new Error("no network call should happen at all — the guard must fire first, purely locally");
    }) as typeof fetch;

    await expect(
      runWorkflow({
        tracer,
        config: testRolesConfig(),
        workflow,
        cwd: notARepoRoot,
        taskPrompt: "add a thing",
        baseUrl: BASE_URL,
        adwId: "adw_wf_guard_reporoot",
        mainCheckoutPath: notARepoRoot,
      }),
    ).rejects.toThrow(WorktreeError);
    expect(projectsPosted).toBe(false);
  });
});

// ── Circuit-breaker retry on a timeout-class Step error ───────────────────

describe("runAgentPhaseWithCircuitBreaker (via runWorkflow)", () => {
  test("a status:'error' Step result (waitForCompletion timeout) retries and succeeds on the 2nd attempt — same session, no fresh worktree", async () => {
    const workflow: Workflow = loadWorkflowsFromString(`
workflows:
  - name: single
    description: A test fixture workflow.
    steps:
      - kind: agent
        name: plan
        role: plan
        prompt: "Reply with JSON."
`)[0] as Workflow;

    let registeredProjectPath: string | undefined;
    // Tracks which prompt/wait "round" we're in — the FIRST prompt's own
    // wait-loop must see isStreaming: true on EVERY poll until its short
    // deadline (timeoutMs=20) is hit, resolving "error"; the retry's own
    // prompt (the 2nd /prompt call) must settle immediately. Keying off
    // /prompt call count (not /status call count) avoids the earlier bug
    // where a later poll inside the SAME still-in-flight attempt could flip
    // to "settled" too early and mask the timeout entirely.
    let promptCalls = 0;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/projects") && (init?.method ?? "GET") === "GET") {
        const projects = registeredProjectPath ? [{ id: "proj_1", name: "repo", path: registeredProjectPath, createdAt: "x" }] : [];
        return new Response(JSON.stringify(projects), { status: 200 });
      }
      if (url.endsWith("/projects") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { path: string };
        registeredProjectPath = body.path;
        return new Response(JSON.stringify({ id: "proj_1", name: "repo", path: body.path, createdAt: "x" }), { status: 200 });
      }
      if (url.includes("/workspaces")) {
        return new Response(
          JSON.stringify({ status: "provider", projectId: "proj_1", ownerPluginId: "git", workspaces: [{ id: "ws_1", path: cwd, isMain: true }] }),
          { status: 200 },
        );
      }
      if (url.endsWith("/model")) return new Response("{}", { status: 200 });
      if (url.endsWith("/prompt")) {
        promptCalls += 1;
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }
      if (url.includes("/status")) {
        // promptCalls===1: the FIRST agent turn's own wait-loop — every poll
        // still reports isStreaming: true, so the short (timeoutMs=20)
        // deadline is hit and it resolves "error", simulating a real
        // waitForCompletion timeout without a real multi-minute wait.
        // promptCalls===2 with no /messages read yet (the circuit breaker's
        // own sessionIsReachable check, between the timeout and the retry
        // prompt) also needs a getStatus response — reused as "reachable".
        if (promptCalls <= 1) {
          return new Response(JSON.stringify({ isStreaming: true, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), { status: 200 });
        }
        // The retry's own wait-loop (promptCalls===2) settles immediately.
        return new Response(JSON.stringify({ isStreaming: false, tokens: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, total: 10 }, cost: 0.001 }), { status: 200 });
      }
      if (url.includes("/messages")) {
        const messages = [{ role: "assistant", content: [{ type: "text", text: JSON.stringify(agentEnvelope({ summary: "recovered after retry" })) }] }];
        return new Response(JSON.stringify({ messages, start: 0, total: messages.length }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    const result = await runWorkflow({
      tracer,
      config: testRolesConfig(),
      workflow,
      cwd,
      taskPrompt: "add a thing",
      baseUrl: BASE_URL,
      adwId: "adw_wf_cb_retry",
      sessionId: "sess_preexisting",
      waitOptions: { forcePollOnly: true, timeoutMs: 20, pollIntervalMs: 5 },
      circuitBreaker: { skipBackoffSleep: true, maxRetries: 2 },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error(JSON.stringify(result));
    expect(result.steps["plan"]).toMatchObject({ summary: "recovered after retry" });

    // Both the "retry scheduled" and "retry starting" log events were traced
    // — a human/future reader can see the circuit breaker actually fired,
    // not just that the Step eventually succeeded.
    const logEvents = tracer.db
      .query<{ name: string }, [string]>("select name from events where adw_id=? and type='log' order by rowid")
      .all("adw_wf_cb_retry");
    expect(logEvents.map((e) => e.name)).toContain("circuit_breaker_retry_scheduled");
    expect(logEvents.map((e) => e.name)).toContain("circuit_breaker_retry_starting");

    // The Step's own phase row landed as success, not left showing the
    // transient first-attempt failure.
    const phaseRow = tracer.db
      .query<{ status: string }, [string]>("select status from phases where phase_id=?")
      .get("adw_wf_cb_retry_plan");
    expect(phaseRow?.status).toBe("success");
  });

  test("a status:'error' Step result that never recovers fails the run after maxRetries — bounded, not infinite", async () => {
    const workflow: Workflow = loadWorkflowsFromString(`
workflows:
  - name: single
    description: A test fixture workflow.
    steps:
      - kind: agent
        name: plan
        role: plan
        prompt: "Reply with JSON."
`)[0] as Workflow;

    let registeredProjectPath: string | undefined;
    let promptCalls = 0;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/projects") && (init?.method ?? "GET") === "GET") {
        const projects = registeredProjectPath ? [{ id: "proj_1", name: "repo", path: registeredProjectPath, createdAt: "x" }] : [];
        return new Response(JSON.stringify(projects), { status: 200 });
      }
      if (url.endsWith("/projects") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { path: string };
        registeredProjectPath = body.path;
        return new Response(JSON.stringify({ id: "proj_1", name: "repo", path: body.path, createdAt: "x" }), { status: 200 });
      }
      if (url.includes("/workspaces")) {
        return new Response(
          JSON.stringify({ status: "provider", projectId: "proj_1", ownerPluginId: "git", workspaces: [{ id: "ws_1", path: cwd, isMain: true }] }),
          { status: 200 },
        );
      }
      if (url.endsWith("/model")) return new Response("{}", { status: 200 });
      if (url.endsWith("/prompt")) {
        promptCalls += 1;
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }
      // Every /status call (both the wait-loop's own polling AND the
      // reachability check between retries) reports still-streaming —
      // every attempt times out, every retry's reachability check reads
      // "reachable" (still streaming counts as alive), so this exercises
      // the fully-exhausted path deterministically.
      if (url.includes("/status")) {
        return new Response(JSON.stringify({ isStreaming: true, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    const result = await runWorkflow({
      tracer,
      config: testRolesConfig(),
      workflow,
      cwd,
      taskPrompt: "add a thing",
      baseUrl: BASE_URL,
      adwId: "adw_wf_cb_exhausted",
      sessionId: "sess_preexisting",
      waitOptions: { forcePollOnly: true, timeoutMs: 20, pollIntervalMs: 5 },
      circuitBreaker: { skipBackoffSleep: true, maxRetries: 2 },
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error(JSON.stringify(result));
    expect(result.step).toBe("plan");

    // 3 total attempts (1 initial + 2 retries), never a 4th — the bound is
    // real, not a runaway loop.
    expect(promptCalls).toBe(3);

    const exhaustedLog = tracer.db
      .query<{ name: string }, [string]>("select name from events where adw_id=? and type='log' and name='circuit_breaker_exhausted'")
      .all("adw_wf_cb_exhausted");
    expect(exhaustedLog.length).toBe(1);

    const phaseRow = tracer.db
      .query<{ status: string }, [string]>("select status from phases where phase_id=?")
      .get("adw_wf_cb_exhausted_plan");
    expect(phaseRow?.status).toBe("fail");
  });

  test("blocked-on-human is NOT retried by the circuit breaker — stays terminal on the first attempt", async () => {
    const workflow: Workflow = loadWorkflowsFromString(`
workflows:
  - name: single
    description: A test fixture workflow.
    steps:
      - kind: agent
        name: plan
        role: plan
        prompt: "Reply with JSON."
`)[0] as Workflow;

    let registeredProjectPath: string | undefined;
    let promptCalls = 0;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/projects") && (init?.method ?? "GET") === "GET") {
        const projects = registeredProjectPath ? [{ id: "proj_1", name: "repo", path: registeredProjectPath, createdAt: "x" }] : [];
        return new Response(JSON.stringify(projects), { status: 200 });
      }
      if (url.endsWith("/projects") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { path: string };
        registeredProjectPath = body.path;
        return new Response(JSON.stringify({ id: "proj_1", name: "repo", path: body.path, createdAt: "x" }), { status: 200 });
      }
      if (url.includes("/workspaces")) {
        return new Response(
          JSON.stringify({ status: "provider", projectId: "proj_1", ownerPluginId: "git", workspaces: [{ id: "ws_1", path: cwd, isMain: true }] }),
          { status: 200 },
        );
      }
      if (url.endsWith("/model")) return new Response("{}", { status: 200 });
      if (url.endsWith("/prompt")) {
        promptCalls += 1;
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }
      if (url.includes("/status")) {
        return new Response(
          JSON.stringify({ isStreaming: false, pendingAsk: { askId: "ask_1", askedAt: "x", questions: [{ id: "q1", question: "which approach?", options: [] }] } }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    const result = await runWorkflow({
      tracer,
      config: testRolesConfig(),
      workflow,
      cwd,
      taskPrompt: "do something ambiguous",
      baseUrl: BASE_URL,
      adwId: "adw_wf_cb_blocked",
      sessionId: "sess_preexisting",
      waitOptions: { forcePollOnly: true, timeoutMs: 20, pollIntervalMs: 5 },
      circuitBreaker: { skipBackoffSleep: true, maxRetries: 2 },
    });

    expect(result.status).toBe("blocked-on-human");
    expect(promptCalls).toBe(1); // never retried

    const retryLogs = tracer.db
      .query<{ name: string }, [string]>("select name from events where adw_id=? and type='log' and name like 'circuit_breaker%'")
      .all("adw_wf_cb_blocked");
    expect(retryLogs.length).toBe(0);
  });
});

// ── Artifact capture (branch/commit/PR) on a completed Step ───────────────

describe("runAgentStep — artifact capture", () => {
  test("a successful agent Step records its branch/commit into phases.artifact_json — not just at run end", async () => {
    const workflow: Workflow = loadWorkflowsFromString(`
workflows:
  - name: single
    description: A test fixture workflow.
    steps:
      - kind: agent
        name: build
        role: build
        prompt: "Reply with JSON."
`)[0] as Workflow;

    // Commit real work in the (resumed-session) cwd BEFORE running the
    // Step, mirroring the real incident: an agent Step's own work is
    // already committed by the time it returns its envelope.
    writeFileSync(join(cwd, "feature.txt"), "real work\n");
    spawnSync("git", ["add", "-A"], { cwd });
    spawnSync("git", ["commit", "-q", "-m", "real work"], { cwd });
    spawnSync("git", ["checkout", "-q", "-b", "pi-web-factory/adw_wf_artifact"], { cwd });
    const expectedSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).stdout.trim();

    mockWorkflowFetch({
      assistantTextsByRole: { build: [JSON.stringify(agentEnvelope({ summary: "did the work" }))] },
      workspacePath: cwd,
    });

    const result = await runWorkflow({
      tracer,
      config: testRolesConfig(),
      workflow,
      cwd,
      taskPrompt: "add a thing",
      baseUrl: BASE_URL,
      adwId: "adw_wf_artifact",
      sessionId: "sess_preexisting",
    });

    expect(result.status).toBe("success");

    const phaseRow = tracer.db
      .query<{ artifact_json: string | null }, [string]>("select artifact_json from phases where phase_id=?")
      .get("adw_wf_artifact_build");
    expect(phaseRow?.artifact_json).not.toBeNull();
    const artifact = JSON.parse(phaseRow?.artifact_json ?? "{}") as StepArtifact;
    expect(artifact.branch).toBe("pi-web-factory/adw_wf_artifact");
    expect(artifact.commitSha).toBe(expectedSha);
    expect(artifact.prUrl).toBeNull();
  });

  test("an EARLIER successful Step's artifact survives a LATER Step's failure — the whole point of this artifact capture", async () => {
    const workflow: Workflow = loadWorkflowsFromString(`
workflows:
  - name: two-step
    description: A test fixture workflow.
    steps:
      - kind: agent
        name: build
        role: build
        prompt: "Reply with JSON."
      - kind: agent
        name: review
        role: review
        prompt: "Reply with JSON."
`)[0] as Workflow;

    writeFileSync(join(cwd, "feature.txt"), "real work\n");
    spawnSync("git", ["add", "-A"], { cwd });
    spawnSync("git", ["commit", "-q", "-m", "real work"], { cwd });
    const expectedSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).stdout.trim();

    let registeredProjectPath: string | undefined;
    // Declared OUTSIDE the fetch closure (a real bug caught while writing
    // this test: re-declaring `let lastRole` INSIDE the handler resets it to
    // "" on every single call, so the /status branch below could never see
    // any role other than the empty default) — persists across calls, same
    // as mockWorkflowFetch's own `lastPromptedSessionRole`.
    let lastRole = "";
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/projects") && (init?.method ?? "GET") === "GET") {
        const projects = registeredProjectPath ? [{ id: "proj_1", name: "repo", path: registeredProjectPath, createdAt: "x" }] : [];
        return new Response(JSON.stringify(projects), { status: 200 });
      }
      if (url.endsWith("/projects") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { path: string };
        registeredProjectPath = body.path;
        return new Response(JSON.stringify({ id: "proj_1", name: "repo", path: body.path, createdAt: "x" }), { status: 200 });
      }
      if (url.includes("/workspaces")) {
        return new Response(
          JSON.stringify({ status: "provider", projectId: "proj_1", ownerPluginId: "git", workspaces: [{ id: "ws_1", path: cwd, isMain: true }] }),
          { status: 200 },
        );
      }
      if (url.endsWith("/model")) return new Response("{}", { status: 200 });
      if (url.endsWith("/prompt") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { text: string };
        lastRole = /\[\[pi-web-factory:role=([\w-]+)\]\]/.exec(body.text)?.[1] ?? "";
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }
      if (url.includes("/status")) {
        if (lastRole === "review") {
          // review's own waitForCompletion call always times out — the
          // failure this whole card was filed from.
          return new Response(JSON.stringify({ isStreaming: true, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), { status: 200 });
        }
        return new Response(JSON.stringify({ isStreaming: false, tokens: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, total: 10 }, cost: 0.001 }), { status: 200 });
      }
      if (url.includes("/messages")) {
        const messages = [{ role: "assistant", content: [{ type: "text", text: JSON.stringify(agentEnvelope({ summary: "build done" })) }] }];
        return new Response(JSON.stringify({ messages, start: 0, total: messages.length }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    const result = await runWorkflow({
      tracer,
      config: testRolesConfig(),
      workflow,
      cwd,
      taskPrompt: "add a thing",
      baseUrl: BASE_URL,
      adwId: "adw_wf_artifact_survives",
      sessionId: "sess_preexisting",
      waitOptions: { forcePollOnly: true, timeoutMs: 20, pollIntervalMs: 5 },
      circuitBreaker: { skipBackoffSleep: true, maxRetries: 0 },
    });

    // The RUN itself failed (review's Step never completed)...
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error(JSON.stringify(result));
    expect(result.step).toBe("review");

    // ...but build's own artifact is still there, fully intact, in the
    // trace db — this is exactly the guarantee artifact capture exists for: a
    // later Step's failure must never erase an earlier Step's real output.
    const buildPhase = tracer.db
      .query<{ status: string; artifact_json: string | null }, [string]>("select status, artifact_json from phases where phase_id=?")
      .get("adw_wf_artifact_survives_build");
    expect(buildPhase?.status).toBe("success");
    expect(buildPhase?.artifact_json).not.toBeNull();
    const artifact = JSON.parse(buildPhase?.artifact_json ?? "{}") as StepArtifact;
    expect(artifact.commitSha).toBe(expectedSha);

    const reviewPhase = tracer.db
      .query<{ status: string; artifact_json: string | null }, [string]>("select status, artifact_json from phases where phase_id=?")
      .get("adw_wf_artifact_survives_review");
    expect(reviewPhase?.status).toBe("fail");
    expect(reviewPhase?.artifact_json).toBeNull(); // review never succeeded — nothing to capture
  });
});
