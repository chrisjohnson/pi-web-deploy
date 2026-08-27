/**
 * Unit tests for retryDecision.ts:
 *   - assembleEvidence / renderEvidencePrompt: pure DB-read + string-render
 *     logic, tested directly against a scratch bun:sqlite db (no network).
 *   - decideRetry: mocked `fetch`, same scripted-sequence pattern
 *     run.test.ts already established for piwebClient.ts calls.
 *   - traceRetryDecision: confirms the decision call's own cost/time lands
 *     as a real trace-db event.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tracer } from "./tracer.ts";
import {
  RetryDecisionError,
  assembleEvidence,
  decideRetry,
  renderEvidencePrompt,
  traceRetryDecision,
  type FailedRunEvidence,
} from "./retryDecision.ts";
import type { RolesConfig } from "./roles.ts";

const BASE_URL = "http://fake-pi-web.test/api";

let dir: string;
let dbPath: string;
let tracer: Tracer;
let originalFetch: typeof fetch;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-web-factory-retrydecision-test-"));
  dbPath = join(dir, "factory.db");
  tracer = new Tracer(dbPath);
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  tracer.close();
  globalThis.fetch = originalFetch;
  rmSync(dir, { recursive: true, force: true });
});

describe("assembleEvidence", () => {
  test("throws RetryDecisionError for an unknown adwId", () => {
    expect(() => assembleEvidence(tracer.db, "adw_does_not_exist")).toThrow(RetryDecisionError);
  });

  test("throws RetryDecisionError when the run is not status='fail' — only meant to be called on an already-confirmed-failed run", () => {
    tracer.sessionStart("adw_running1", { projectCwd: "/tmp/proj", taskPromptForTicket: "task" });
    expect(() => assembleEvidence(tracer.db, "adw_running1")).toThrow(/not status='fail'/);
  });

  test("throws RetryDecisionError when the run has no ticket_id (pre-M-103 row)", () => {
    tracer.sessionStart("adw_noticket1", { projectCwd: "/tmp/proj" }); // no ticketId/taskPromptForTicket -> ticket_id stays NULL
    tracer.sessionFinish("adw_noticket1", false);
    expect(() => assembleEvidence(tracer.db, "adw_noticket1")).toThrow(/no ticket_id/);
  });

  test("assembles the full evidence stack for a real failed run: prompt, failure reason, steps, prior attempts", () => {
    // First attempt on the ticket — already finished (fail), forms the
    // "prior attempt" this test's SECOND run should see in its evidence.
    tracer.sessionStart("adw_attempt1", {
      projectCwd: "/tmp/proj",
      ticketId: "M-999",
      taskPromptForTicket: "do the thing",
    });
    tracer.phaseUpsert({
      phaseId: "adw_attempt1_plan",
      adwId: "adw_attempt1",
      seq: 1,
      name: "plan",
      kind: "agent",
      role: "plan",
      description: "plan step",
      status: "fail",
      error: "unparseable after 3 attempts",
      outputSummary: "unparseable after 3 attempts",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:05:00.000Z",
    });
    tracer.sessionFinish("adw_attempt1", false);

    // The run we're actually assembling evidence FOR. `sessionRequest` is
    // what actually populates `sessions.request` (the field
    // `assembleEvidence` reads as `taskPrompt`) — `taskPromptForTicket`
    // above only feeds the TICKET's title derivation, a separate concern
    // (see Tracer.sessionStart's own doc comment) — a real Workflow Run
    // calls both (workflow.ts), so this test does too.
    tracer.sessionStart("adw_attempt2", {
      projectCwd: "/tmp/proj",
      ticketId: "M-999",
      taskPromptForTicket: "do the thing (retry)",
    });
    tracer.sessionRequest("adw_attempt2", "do the thing (retry)");
    tracer.phaseUpsert({
      phaseId: "adw_attempt2_plan",
      adwId: "adw_attempt2",
      seq: 1,
      name: "plan",
      kind: "agent",
      role: "plan",
      description: "plan step",
      status: "success",
      outputSummary: "planned it",
      startedAt: "2026-01-01T01:00:00.000Z",
      endedAt: "2026-01-01T01:02:00.000Z",
    });
    tracer.phaseUpsert({
      phaseId: "adw_attempt2_build",
      adwId: "adw_attempt2",
      seq: 2,
      name: "build",
      kind: "agent",
      role: "build",
      description: "build step",
      status: "fail",
      error: "permissions violation: wrote outside allowlist",
      outputSummary: "permissions violation: wrote outside allowlist",
      startedAt: "2026-01-01T01:02:00.000Z",
      endedAt: "2026-01-01T01:04:00.000Z",
    });
    tracer.sessionFinish("adw_attempt2", false);

    const evidence = assembleEvidence(tracer.db, "adw_attempt2");
    expect(evidence.adwId).toBe("adw_attempt2");
    expect(evidence.ticketId).toBe("M-999");
    expect(evidence.taskPrompt).toBe("do the thing (retry)");
    expect(evidence.failureReason).toContain("permissions violation");
    expect(evidence.steps.map((s) => s.name)).toEqual(["plan", "build"]);
    expect(evidence.steps[0]?.status).toBe("success");
    expect(evidence.steps[1]?.status).toBe("fail");
    // Prior attempts: exactly the OTHER run on this ticket, not itself.
    expect(evidence.priorAttempts.map((a) => a.adwId)).toEqual(["adw_attempt1"]);
    expect(evidence.priorAttempts[0]?.status).toBe("fail");
  });

  test("a first-ever attempt on a ticket has an empty priorAttempts array", () => {
    tracer.sessionStart("adw_first1", { projectCwd: "/tmp/proj", ticketId: "M-1000", taskPromptForTicket: "first ever" });
    tracer.sessionFinish("adw_first1", false);
    const evidence = assembleEvidence(tracer.db, "adw_first1");
    expect(evidence.priorAttempts).toEqual([]);
  });
});

describe("renderEvidencePrompt", () => {
  const baseEvidence: FailedRunEvidence = {
    adwId: "adw_x",
    ticketId: "M-1",
    taskPrompt: "build a widget",
    failureReason: "unparseable after 3 attempts",
    steps: [{ name: "plan", kind: "agent", status: "success", summary: "planned it" }],
    priorAttempts: [],
  };

  test("includes the original task prompt and failure reason verbatim", () => {
    const text = renderEvidencePrompt(baseEvidence);
    expect(text).toContain("build a widget");
    expect(text).toContain("unparseable after 3 attempts");
  });

  test("includes each step's name/kind/status/summary", () => {
    const text = renderEvidencePrompt(baseEvidence);
    expect(text).toContain("plan (agent): success");
    expect(text).toContain("planned it");
  });

  test("a first attempt (no prior history) says so explicitly, not an empty list", () => {
    const text = renderEvidencePrompt(baseEvidence);
    expect(text).toContain("this is the first attempt on this ticket");
  });

  test("prior attempt history is rendered with status + timing, most recent entries included", () => {
    const withHistory: FailedRunEvidence = {
      ...baseEvidence,
      priorAttempts: [
        { adwId: "adw_prev1", status: "fail", startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:05:00.000Z" },
        { adwId: "adw_prev2", status: "fail", startedAt: "2026-01-02T00:00:00.000Z", endedAt: "2026-01-02T00:05:00.000Z" },
      ],
    };
    const text = renderEvidencePrompt(withHistory);
    expect(text).toContain("adw_prev1");
    expect(text).toContain("adw_prev2");
    expect(text).toContain("2 earlier attempt(s)");
  });

  test("never dumps raw JSON/event payloads — output stays plain, human-readable text", () => {
    const text = renderEvidencePrompt(baseEvidence);
    expect(text).not.toContain("{\"");
    expect(text).not.toContain("payload_json");
  });
});

describe("decideRetry", () => {
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

  const evidence: FailedRunEvidence = {
    adwId: "adw_x",
    ticketId: "M-1",
    taskPrompt: "build a widget",
    failureReason: "unparseable after 3 attempts",
    steps: [],
    priorAttempts: [],
  };

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

  test("parses a valid {decision, reasoning} envelope and reports elapsed time", async () => {
    mockDecisionFetch(JSON.stringify({ decision: "retry", reasoning: "infra failure, agent did nothing wrong" }));
    const result = await decideRetry({ baseUrl: BASE_URL, config, evidence, cwd: "/tmp/proj" });
    expect(result.decision).toBe("retry");
    expect(result.reasoning).toContain("infra failure");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  test("throws a specific error when the decision Role isn't configured", async () => {
    const emptyConfig: RolesConfig = { ...config, roles: [] };
    await expect(decideRetry({ baseUrl: BASE_URL, config: emptyConfig, evidence, cwd: "/tmp/proj" })).rejects.toThrow(/no "decide-retry" Role configured/);
  });

  test("throws when the model's response doesn't parse as a valid decision envelope", async () => {
    mockDecisionFetch("not json at all");
    await expect(decideRetry({ baseUrl: BASE_URL, config, evidence, cwd: "/tmp/proj" })).rejects.toThrow(/did not parse/);
  });

  test("throws when decision is missing from an otherwise-valid JSON object", async () => {
    mockDecisionFetch(JSON.stringify({ reasoning: "no decision field" }));
    await expect(decideRetry({ baseUrl: BASE_URL, config, evidence, cwd: "/tmp/proj" })).rejects.toThrow();
  });
});

describe("traceRetryDecision", () => {
  test("records the decision call's own cost/time as a log event on the original failed run's adwId", () => {
    tracer.sessionStart("adw_decided1", { projectCwd: "/tmp/proj", taskPromptForTicket: "task" });
    traceRetryDecision(tracer, "adw_decided1", { decision: "new-run", reasoning: "permissions violation, fresh start safer", elapsedMs: 1234 });

    const rows = tracer.db
      .query<{ type: string; name: string; payload_json: string }, [string]>(
        "SELECT type, name, payload_json FROM events WHERE adw_id = ? AND type = 'log' AND name = 'retry_decision'",
      )
      .all("adw_decided1");
    expect(rows.length).toBe(1);
    const payload = JSON.parse(rows[0]!.payload_json) as { decision: string; reasoning: string; elapsedMs: number };
    expect(payload.decision).toBe("new-run");
    expect(payload.elapsedMs).toBe(1234);
  });
});
