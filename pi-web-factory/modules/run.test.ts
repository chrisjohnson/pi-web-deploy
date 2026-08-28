/**
 * Unit tests for run.ts's logic that doesn't need a live pi-web server —
 * the retry-on-parse-failure loop's bounded-attempts behavior and the
 * blocked-on-human result shape. The full live end-to-end flow (real model,
 * real session) is covered separately in
 * chains/planBuildTest.integration.test.ts.
 *
 * `fetch` is mocked at the global level (piwebClient.ts calls the ambient
 * `fetch`), and `waitOptions.forcePollOnly: true` is used everywhere so the
 * WebSocket branch (which needs a real socket server) is never exercised
 * here — status-polling only, which is trivial to script against a mocked
 * fetch sequence.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { Tracer } from "./tracer.ts";
import { runAgentPhase, buildCorrectionMessage, truncateRawResponse } from "./run.ts";
import type { AgentRole } from "./roles.ts";
import { jsonParses } from "./gates.ts";

const BASE_URL = "http://fake-pi-web.test/api";

const TestEnvelopeSchema = z.object({
  status: z.enum(["success", "fail"]),
  summary: z.string().default(""),
  artifacts: z.array(z.string()).default([]),
  notes_for_next_agent: z.string().default(""),
});

const agent: AgentRole = {
  kind: "agent",
  name: "build",
  model: "local-litellm/medium-moe",
  modelRef: { provider: "local-litellm", modelId: "medium-moe" },
  thinking: "medium",
  writes: null,
  systemPrompt: "You are the build agent.",
  systemPromptPath: "prompts/build.md",
};

let dir: string;
let cwd: string;
let dbPath: string;
let tracer: Tracer;
let originalFetch: typeof fetch;

function git(args: string[], cwd_: string): void {
  spawnSync("git", args, { cwd: cwd_, encoding: "utf8" });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-web-factory-run-test-"));
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
 * Installs a scripted mock `fetch` that answers the exact call sequence
 * runAgentPhase makes: POST .../model (only if modelAlreadySet is false),
 * POST .../prompt, then repeated GET .../status polls until the caller's
 * `statusSequence` is exhausted, then GET .../messages once status settles.
 */
function mockFetchSequence(opts: {
  statusSequence: Array<Record<string, unknown>>;
  assistantTexts: string[]; // one per "done" status reached, in order
}): { promptCalls: string[] } {
  const promptCalls: string[] = [];
  let statusIndex = 0;
  let doneIndex = 0;

  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.endsWith("/model") && init?.method === "POST") {
      return new Response(JSON.stringify({ isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0, model: { provider: "local-litellm", id: "medium-moe" } }), { status: 200 });
    }

    if (url.endsWith("/prompt") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { text: string };
      promptCalls.push(body.text);
      return new Response(JSON.stringify({ accepted: true }), { status: 200 });
    }

    if (url.includes("/status")) {
      const status = opts.statusSequence[Math.min(statusIndex, opts.statusSequence.length - 1)]!;
      statusIndex += 1;
      return new Response(JSON.stringify(status), { status: 200 });
    }

    if (url.includes("/messages")) {
      const text = opts.assistantTexts[doneIndex] ?? opts.assistantTexts[opts.assistantTexts.length - 1] ?? "";
      doneIndex += 1;
      const messages = [{ role: "assistant", content: [{ type: "text", text }] }];
      return new Response(
        JSON.stringify({ messages, start: 0, total: messages.length }),
        { status: 200 },
      );
    }

    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;

  return { promptCalls };
}

describe("runAgentPhase — retry-on-parse-failure loop", () => {
  test("parses on the first attempt when the response is valid JSON matching the schema", async () => {
    const validEnvelope = { status: "success", summary: "did it", artifacts: [], notes_for_next_agent: "" };
    mockFetchSequence({
      statusSequence: [{ isStreaming: false }],
      assistantTexts: [JSON.stringify(validEnvelope)],
    });

    const result = await runAgentPhase({
      tracer,
      baseUrl: BASE_URL,
      adwId: "adw_test1",
      phaseId: "adw_test1_build",
      seq: 1,
      cwd,
      agent,
      sessionId: "sess_1",
      modelAlreadySet: false,
      promptText: "do the thing",
      envelopeSchema: TestEnvelopeSchema,
      outputTypeName: "build",
      protectedFiles: [],
      waitOptions: { forcePollOnly: true },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(result.attempts).toBe(1);
    expect(result.envelope.summary).toBe("did it");
  });

  // Regression guard: jsonParses's gate check tolerates a markdown-fenced
  // response (gates.ts), so the final envelope build at the bottom of
  // runAgentPhase must reuse that same fence-stripping extraction rather
  // than a naive JSON.parse on the raw response — otherwise a
  // fenced-but-valid response can pass the gate and then crash with
  // "Unrecognized token '`'" right after. Caught live via a real
  // bounded-build-review smoke run.
  test("a markdown-fenced first response passes the gate AND builds the envelope without crashing", async () => {
    const validEnvelope = { status: "success", summary: "fenced but valid", artifacts: [], notes_for_next_agent: "" };
    mockFetchSequence({
      statusSequence: [{ isStreaming: false }],
      assistantTexts: ["```json\n" + JSON.stringify(validEnvelope) + "\n```"],
    });

    const result = await runAgentPhase({
      tracer,
      baseUrl: BASE_URL,
      adwId: "adw_test_fenced",
      phaseId: "adw_test_fenced_build",
      seq: 1,
      cwd,
      agent,
      sessionId: "sess_fenced",
      modelAlreadySet: false,
      promptText: "do the thing",
      envelopeSchema: TestEnvelopeSchema,
      outputTypeName: "build",
      protectedFiles: [],
      waitOptions: { forcePollOnly: true },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(result.attempts).toBe(1);
    expect(result.envelope.summary).toBe("fenced but valid");
  });

  test("re-prompts the SAME session with a correction on a bad first response, then succeeds on retry", async () => {
    const validEnvelope = { status: "success", summary: "fixed", artifacts: [], notes_for_next_agent: "" };
    const { promptCalls } = mockFetchSequence({
      statusSequence: [{ isStreaming: false }, { isStreaming: false }],
      assistantTexts: ["this is not json at all", JSON.stringify(validEnvelope)],
    });

    const result = await runAgentPhase({
      tracer,
      baseUrl: BASE_URL,
      adwId: "adw_test2",
      phaseId: "adw_test2_build",
      seq: 1,
      cwd,
      agent,
      sessionId: "sess_2",
      modelAlreadySet: false,
      promptText: "do the thing",
      envelopeSchema: TestEnvelopeSchema,
      outputTypeName: "build",
      protectedFiles: [],
      waitOptions: { forcePollOnly: true },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(result.attempts).toBe(2);

    // Same session — no fresh startSession call happened (that would show up
    // as a POST to /sessions, which this mock doesn't even implement/allow).
    expect(promptCalls.length).toBe(2);
    expect(promptCalls[0]).toBe("do the thing");
    // The correction names what was wrong, not a generic "try again".
    expect(promptCalls[1]).toContain("did not parse as valid JSON");
    expect(promptCalls[1]).toContain("build");
  });

  // M-069: before_agent_start (the hook pi-web-factory-prompts uses to
  // inject a true per-role system prompt) fires on EVERY prompt submission,
  // not just a phase's first — so a role marker passed as promptPrefix must
  // survive a retry-on-parse-failure correction too, not just the initial
  // prompt. See run.ts's promptPrefix doc comment and piwebClient.ts's
  // roleMarker for the full context.
  test("promptPrefix rides on every prompt in the phase, including retry corrections", async () => {
    const validEnvelope = { status: "success", summary: "fixed", artifacts: [], notes_for_next_agent: "" };
    const { promptCalls } = mockFetchSequence({
      statusSequence: [{ isStreaming: false }, { isStreaming: false }],
      assistantTexts: ["this is not json at all", JSON.stringify(validEnvelope)],
    });

    const result = await runAgentPhase({
      tracer,
      baseUrl: BASE_URL,
      adwId: "adw_test2b",
      phaseId: "adw_test2b_build",
      seq: 1,
      cwd,
      agent,
      sessionId: "sess_2b",
      modelAlreadySet: false,
      promptText: "do the thing",
      promptPrefix: "[[pi-web-factory:role=build]]",
      envelopeSchema: TestEnvelopeSchema,
      outputTypeName: "build",
      protectedFiles: [],
      waitOptions: { forcePollOnly: true },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(result.attempts).toBe(2);

    expect(promptCalls.length).toBe(2);
    // Prefix present on the initial prompt...
    expect(promptCalls[0]).toBe("[[pi-web-factory:role=build]]\ndo the thing");
    // ...AND on the retry correction, not dropped.
    expect(promptCalls[1]?.startsWith("[[pi-web-factory:role=build]]\n")).toBe(true);
    expect(promptCalls[1]).toContain("did not parse as valid JSON");
  });

  test("no promptPrefix: prompt text is sent unmodified (backward-compatible default)", async () => {
    const validEnvelope = { status: "success", summary: "did it", artifacts: [], notes_for_next_agent: "" };
    const { promptCalls } = mockFetchSequence({
      statusSequence: [{ isStreaming: false }],
      assistantTexts: [JSON.stringify(validEnvelope)],
    });

    await runAgentPhase({
      tracer,
      baseUrl: BASE_URL,
      adwId: "adw_test2c",
      phaseId: "adw_test2c_build",
      seq: 1,
      cwd,
      agent,
      sessionId: "sess_2c",
      modelAlreadySet: false,
      promptText: "do the thing",
      envelopeSchema: TestEnvelopeSchema,
      outputTypeName: "build",
      protectedFiles: [],
      waitOptions: { forcePollOnly: true },
    });

    expect(promptCalls[0]).toBe("do the thing");
  });

  test("bounded attempts: fails as 'unparseable' with the last gate report attached after maxParseAttempts", async () => {
    const { promptCalls } = mockFetchSequence({
      statusSequence: [{ isStreaming: false }, { isStreaming: false }, { isStreaming: false }],
      assistantTexts: ["nope 1", "nope 2", "nope 3"],
    });

    const result = await runAgentPhase({
      tracer,
      baseUrl: BASE_URL,
      adwId: "adw_test3",
      phaseId: "adw_test3_build",
      seq: 1,
      cwd,
      agent,
      sessionId: "sess_3",
      modelAlreadySet: false,
      promptText: "do the thing",
      envelopeSchema: TestEnvelopeSchema,
      outputTypeName: "build",
      protectedFiles: [],
      maxParseAttempts: 3,
      waitOptions: { forcePollOnly: true },
    });

    expect(result.status).toBe("unparseable");
    if (result.status !== "unparseable") throw new Error("expected unparseable");
    expect(result.attempts).toBe(3);
    expect(promptCalls.length).toBe(3);
    expect(result.lastReport.checks.some((c) => !c.ok)).toBe(true);
    // The raw last-attempt response text is captured, not discarded — this
    // is what lets a human see roughly what the agent actually said.
    expect(result.rawResponse).toBe("nope 3");

    // Traced as a distinct gate_fail, not silently dropped.
    const gateRow = tracer.db
      .query<{ passed: number; gate: string }, [string]>(
        "select passed, gate from gate_results where adw_id=? order by id desc limit 1",
      )
      .get("adw_test3");
    expect(gateRow?.passed).toBe(0);
    expect(gateRow?.gate).toBe("json_parses");

    const phaseRow = tracer.db
      .query<{ status: string }, [string]>("select status from phases where phase_id=?")
      .get("adw_test3_build");
    expect(phaseRow?.status).toBe("fail");
  });
});

describe("runAgentPhase — blocked-on-human", () => {
  test("resolves to a distinct 'blocked-on-human' status, not success or a generic error", async () => {
    const pendingAsk = {
      askId: "ask_1",
      askedAt: "2026-08-04T00:00:00.000Z",
      questions: [{ id: "q1", question: "Which approach?", options: [{ value: "a", label: "A" }] }],
    };
    mockFetchSequence({
      statusSequence: [{ isStreaming: false, pendingAsk }],
      assistantTexts: [""],
    });

    const result = await runAgentPhase({
      tracer,
      baseUrl: BASE_URL,
      adwId: "adw_test4",
      phaseId: "adw_test4_build",
      seq: 1,
      cwd,
      agent,
      sessionId: "sess_4",
      modelAlreadySet: false,
      promptText: "do the thing",
      envelopeSchema: TestEnvelopeSchema,
      outputTypeName: "build",
      protectedFiles: [],
      waitOptions: { forcePollOnly: true },
    });

    expect(result.status).toBe("blocked-on-human");
    if (result.status !== "blocked-on-human") throw new Error("expected blocked-on-human");
    expect(result.pendingAsk.askId).toBe("ask_1");
    expect(result.attempts).toBe(1);

    // Traced as its own event type — a "handoff" — never folded into "error".
    const events = tracer.db
      .query<{ type: string; name: string }, [string]>("select type, name from events where adw_id=? order by rowid")
      .all("adw_test4");
    expect(events.some((e) => e.type === "handoff" && e.name === "blocked-on-human")).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(false);

    const phaseRow = tracer.db
      .query<{ status: string }, [string]>("select status from phases where phase_id=?")
      .get("adw_test4_build");
    expect(phaseRow?.status).toBe("fail");
  });
});

describe("runAgentPhase — error result", () => {
  test("a waitForCompletion 'error' result is traced as `error` and fails the phase distinctly from unparseable", async () => {
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/model")) return new Response("{}", { status: 200 });
      if (url.endsWith("/prompt")) return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      if (url.includes("/status")) return new Response("boom", { status: 500 });
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    const result = await runAgentPhase({
      tracer,
      baseUrl: BASE_URL,
      adwId: "adw_test5",
      phaseId: "adw_test5_build",
      seq: 1,
      cwd,
      agent,
      sessionId: "sess_5",
      modelAlreadySet: false,
      promptText: "do the thing",
      envelopeSchema: TestEnvelopeSchema,
      outputTypeName: "build",
      protectedFiles: [],
      waitOptions: { forcePollOnly: true, timeoutMs: 50, pollIntervalMs: 10 },
    });

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected error");

    const events = tracer.db
      .query<{ type: string }, [string]>("select type from events where adw_id=? order by rowid")
      .all("adw_test5");
    expect(events.some((e) => e.type === "error")).toBe(true);
  });
});

describe("runAgentPhase — permissions violation", () => {
  test("a write outside the agent's writes: allowlist fails the phase, not just logs it — regression for the M-066 review fix", async () => {
    const readOnlyAgent: AgentRole = { ...agent, writes: [] }; // read-only: nothing is permitted
    const validEnvelope = { status: "success", summary: "did it", artifacts: [], notes_for_next_agent: "" };

    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/model")) return new Response("{}", { status: 200 });
      if (url.endsWith("/prompt")) {
        // Simulates the agent using its real tool access mid-turn to write a
        // file outside its writes: allowlist — the thing permissions.ts
        // exists to catch. Happens here (between the snapshot already taken
        // and waitForCompletion below) since there's no live model in this
        // unit test to actually do it.
        writeFileSync(join(cwd, "unauthorized.txt"), "the agent should not have written this\n");
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }
      if (url.includes("/status")) return new Response(JSON.stringify({ isStreaming: false }), { status: 200 });
      if (url.includes("/messages")) {
        const messages = [{ role: "assistant", content: [{ type: "text", text: JSON.stringify(validEnvelope) }] }];
        return new Response(
          JSON.stringify({ messages, start: 0, total: messages.length }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    const result = await runAgentPhase({
      tracer,
      baseUrl: BASE_URL,
      adwId: "adw_test6",
      phaseId: "adw_test6_build",
      seq: 1,
      cwd,
      agent: readOnlyAgent,
      sessionId: "sess_6",
      modelAlreadySet: false,
      promptText: "do the thing",
      envelopeSchema: TestEnvelopeSchema,
      outputTypeName: "build",
      protectedFiles: [],
      waitOptions: { forcePollOnly: true },
    });

    // The envelope parsed fine — this must not be misread as an "error" or
    // "unparseable" result. It's specifically a permissions violation.
    expect(result.status).toBe("permissions-violation");
    if (result.status !== "permissions-violation") throw new Error("expected permissions-violation");
    expect(result.permissions.violations).toContain("unauthorized.txt");

    // The rollback itself still runs and succeeds (permissions.ts's job) —
    // that's orthogonal to whether the phase is reported as failed.
    expect(result.permissions.clean).toBe(true);
    expect(existsSync(join(cwd, "unauthorized.txt"))).toBe(false);

    // Before the fix, this event was traced as "success" unconditionally —
    // confirm it's now traced as a failure.
    const phaseRow = tracer.db
      .query<{ status: string }, [string]>("select status from phases where phase_id=?")
      .get("adw_test6_build");
    expect(phaseRow?.status).toBe("fail");

    const gateRow = tracer.db
      .query<{ passed: number; gate: string }, [string]>(
        "select passed, gate from gate_results where adw_id=? and gate='permissions'",
      )
      .get("adw_test6");
    expect(gateRow?.passed).toBe(0);
  });

  test("no violation -> phase still succeeds, unaffected by the fix", async () => {
    const validEnvelope = { status: "success", summary: "did it", artifacts: [], notes_for_next_agent: "" };
    mockFetchSequence({
      statusSequence: [{ isStreaming: false }],
      assistantTexts: [JSON.stringify(validEnvelope)],
    });

    const result = await runAgentPhase({
      tracer,
      baseUrl: BASE_URL,
      adwId: "adw_test7",
      phaseId: "adw_test7_build",
      seq: 1,
      cwd,
      agent, // writes: null — unrestricted
      sessionId: "sess_7",
      modelAlreadySet: false,
      promptText: "do the thing",
      envelopeSchema: TestEnvelopeSchema,
      outputTypeName: "build",
      protectedFiles: [],
      waitOptions: { forcePollOnly: true },
    });

    expect(result.status).toBe("success");
  });
});

describe("runAgentPhase — M-074 output_summary / per-step token columns", () => {
  test("success: output_summary comes from the envelope's summary field, and input/output/cached token columns populate from the post-turn status snapshot", async () => {
    const validEnvelope = { status: "success", summary: "implemented the health endpoint", artifacts: [], notes_for_next_agent: "" };
    mockFetchSequence({
      statusSequence: [
        {
          isStreaming: false,
          tokens: { input: 1200, output: 340, cacheRead: 80, cacheWrite: 0, total: 1540 },
          cost: 0.021,
        },
      ],
      assistantTexts: [JSON.stringify(validEnvelope)],
    });

    const phaseId = "adw_test_tok_build";
    const result = await runAgentPhase({
      tracer,
      baseUrl: BASE_URL,
      adwId: "adw_test_tok",
      phaseId,
      seq: 1,
      cwd,
      agent,
      sessionId: "sess_tok",
      modelAlreadySet: false,
      promptText: "do the thing",
      envelopeSchema: TestEnvelopeSchema,
      outputTypeName: "build",
      protectedFiles: [],
      waitOptions: { forcePollOnly: true },
    });

    expect(result.status).toBe("success");

    const row = tracer.db
      .query<
        {
          output_summary: string | null;
          input_tokens: number | null;
          output_tokens: number | null;
          cached_tokens: number | null;
        },
        [string]
      >("select output_summary, input_tokens, output_tokens, cached_tokens from phases where phase_id=?")
      .get(phaseId);
    expect(row?.output_summary).toBe("implemented the health endpoint");
    expect(row?.input_tokens).toBe(1200);
    expect(row?.output_tokens).toBe(340);
    expect(row?.cached_tokens).toBe(80);
  });

  test("unparseable failure: output_summary is populated with a real short string, not left null", async () => {
    mockFetchSequence({
      statusSequence: [{ isStreaming: false }, { isStreaming: false }, { isStreaming: false }],
      assistantTexts: ["nope 1", "nope 2", "nope 3"],
    });

    const phaseId = "adw_test_sumfail_build";
    const result = await runAgentPhase({
      tracer,
      baseUrl: BASE_URL,
      adwId: "adw_test_sumfail",
      phaseId,
      seq: 1,
      cwd,
      agent,
      sessionId: "sess_sumfail",
      modelAlreadySet: false,
      promptText: "do the thing",
      envelopeSchema: TestEnvelopeSchema,
      outputTypeName: "build",
      protectedFiles: [],
      maxParseAttempts: 3,
      waitOptions: { forcePollOnly: true },
    });

    expect(result.status).toBe("unparseable");

    const row = tracer.db
      .query<{ output_summary: string | null; error: string | null }, [string]>(
        "select output_summary, error from phases where phase_id=?",
      )
      .get(phaseId);
    // The generic "unparseable after N attempts" string alone is no longer
    // good enough — a human reading phases.error/output_summary must be
    // able to see roughly what the agent actually said.
    expect(row?.output_summary).toContain("unparseable after 3 attempts");
    expect(row?.output_summary).toContain("nope 3");
    expect(row?.error).toContain("nope 3");
  });

  test("unparseable failure: a long raw response is truncated with a note, not dumped in full", async () => {
    const longText = "x".repeat(2000);
    mockFetchSequence({
      statusSequence: [{ isStreaming: false }, { isStreaming: false }, { isStreaming: false }],
      assistantTexts: [longText, longText, longText],
    });

    const phaseId = "adw_test_trunc_build";
    const result = await runAgentPhase({
      tracer,
      baseUrl: BASE_URL,
      adwId: "adw_test_trunc",
      phaseId,
      seq: 1,
      cwd,
      agent,
      sessionId: "sess_trunc",
      modelAlreadySet: false,
      promptText: "do the thing",
      envelopeSchema: TestEnvelopeSchema,
      outputTypeName: "build",
      protectedFiles: [],
      maxParseAttempts: 3,
      waitOptions: { forcePollOnly: true },
    });

    expect(result.status).toBe("unparseable");
    if (result.status !== "unparseable") throw new Error("expected unparseable");
    expect(result.rawResponse.length).toBeLessThan(longText.length);
    expect(result.rawResponse).toContain("truncated");

    const row = tracer.db
      .query<{ output_summary: string | null }, [string]>("select output_summary from phases where phase_id=?")
      .get(phaseId);
    expect(row?.output_summary).toContain("truncated");
  });

  test("permissions-violation failure: output_summary names the violating file(s)", async () => {
    const readOnlyAgent: AgentRole = { ...agent, writes: [] };
    const validEnvelope = { status: "success", summary: "did it", artifacts: [], notes_for_next_agent: "" };

    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/model")) return new Response("{}", { status: 200 });
      if (url.endsWith("/prompt")) {
        writeFileSync(join(cwd, "unauthorized2.txt"), "nope\n");
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }
      if (url.includes("/status")) return new Response(JSON.stringify({ isStreaming: false }), { status: 200 });
      if (url.includes("/messages")) {
        const messages = [{ role: "assistant", content: [{ type: "text", text: JSON.stringify(validEnvelope) }] }];
        return new Response(
          JSON.stringify({ messages, start: 0, total: messages.length }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    const phaseId = "adw_test_sumperm_build";
    const result = await runAgentPhase({
      tracer,
      baseUrl: BASE_URL,
      adwId: "adw_test_sumperm",
      phaseId,
      seq: 1,
      cwd,
      agent: readOnlyAgent,
      sessionId: "sess_sumperm",
      modelAlreadySet: false,
      promptText: "do the thing",
      envelopeSchema: TestEnvelopeSchema,
      outputTypeName: "build",
      protectedFiles: [],
      waitOptions: { forcePollOnly: true },
    });

    expect(result.status).toBe("permissions-violation");

    const row = tracer.db
      .query<{ output_summary: string | null }, [string]>("select output_summary from phases where phase_id=?")
      .get(phaseId);
    expect(row?.output_summary).toContain("unauthorized2.txt");
  });
});

describe("buildCorrectionMessage", () => {
  test("names exactly what was wrong, not a generic 'try again'", () => {
    const report = jsonParses("not json", TestEnvelopeSchema);
    const message = buildCorrectionMessage(report, "build");
    expect(message).toContain("does not parse");
    expect(message).toContain('"build"');
  });

  test("lists each failed schema-validation check individually", () => {
    const report = jsonParses(JSON.stringify({ status: "bogus" }), TestEnvelopeSchema);
    const message = buildCorrectionMessage(report, "plan");
    for (const check of report.checks.filter((c) => !c.ok)) {
      expect(message).toContain(check.item);
    }
  });
});

describe("truncateRawResponse", () => {
  test("returns short text unchanged", () => {
    expect(truncateRawResponse("hello")).toBe("hello");
  });

  test("truncates text over the cap and notes how much was cut", () => {
    const text = "a".repeat(600);
    const result = truncateRawResponse(text, 500);
    expect(result.length).toBeLessThan(text.length);
    expect(result.startsWith("a".repeat(500))).toBe(true);
    expect(result).toContain("truncated");
    expect(result).toContain("100 more chars");
  });

  test("text exactly at the cap is left unchanged", () => {
    const text = "b".repeat(500);
    expect(truncateRawResponse(text, 500)).toBe(text);
  });
});
