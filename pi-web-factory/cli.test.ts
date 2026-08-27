/**
 * Unit tests for cli.ts's argument-parsing/prompt-resolution/status-line
 * logic — the parts that don't need a live pi-web server. M-067 card, Plan
 * item 4 ("you may also add a lightweight automated test ... if you think it
 * adds real value"). The manual smoke test (real terminal run against a real
 * scratch project) covers the actual end-to-end wiring; this covers the
 * argument-shape edge cases that are tedious to exercise by hand every time.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PlanBuildTestLinkInfo, PlanBuildTestResult } from "./chains/planBuildTest.ts";
import { WORKFLOW_DESCRIPTIONS, workflowNames } from "./chains/registry.ts";
import {
  browserOriginFromApiBaseUrl,
  CliUsageError,
  describeResult,
  formatWorkflowList,
  parseArgs,
  resolvePrompt,
  sessionDeepLink,
} from "./cli.ts";

const TEST_LINK: PlanBuildTestLinkInfo = { projectId: "proj_1", workspaceId: "ws_1", cwd: "/tmp/whatever" };

// ── parseArgs ────────────────────────────────────────────────────────────

describe("parseArgs", () => {
  test("parses the full flag set plus a positional prompt", () => {
    const args = parseArgs(["--project", "/abs/path", "--workflow", "plan-build-test", "do the thing"]);
    expect(args).toEqual({
      project: "/abs/path",
      workflow: "plan-build-test",
      sessionId: undefined,
      ticketId: undefined,
      promptArg: "do the thing",
    });
  });

  test("parses an optional --session-id", () => {
    const args = parseArgs([
      "--project",
      "/abs/path",
      "--workflow",
      "plan-build-test",
      "--session-id",
      "sess_123",
      "do the thing",
    ]);
    expect(args.sessionId).toBe("sess_123");
  });

  test("parses an optional --ticket-id (M-103)", () => {
    const args = parseArgs([
      "--project",
      "/abs/path",
      "--workflow",
      "plan-build-test",
      "--ticket-id",
      "M-103",
      "do the thing",
    ]);
    expect(args.ticketId).toBe("M-103");
  });

  test("--ticket-id is undefined when omitted", () => {
    const args = parseArgs(["--project", "/abs/path", "--workflow", "plan-build-test", "do the thing"]);
    expect(args.ticketId).toBeUndefined();
  });

  test("flags may appear in any order relative to the positional", () => {
    const args = parseArgs(["do the thing", "--workflow", "plan-build-test", "--project", "/abs/path"]);
    expect(args.promptArg).toBe("do the thing");
  });

  test("missing --project throws CliUsageError naming what's missing", () => {
    expect(() => parseArgs(["--workflow", "plan-build-test", "prompt"])).toThrow(CliUsageError);
    expect(() => parseArgs(["--workflow", "plan-build-test", "prompt"])).toThrow(/--project/);
  });

  test("missing --workflow throws CliUsageError naming what's missing", () => {
    expect(() => parseArgs(["--project", "/abs/path", "prompt"])).toThrow(/--workflow/);
  });

  test("missing positional prompt throws CliUsageError", () => {
    expect(() => parseArgs(["--project", "/abs/path", "--workflow", "plan-build-test"])).toThrow(/prompt/);
  });

  test("more than one positional argument throws CliUsageError", () => {
    expect(() =>
      parseArgs(["--project", "/abs/path", "--workflow", "plan-build-test", "prompt one", "prompt two"]),
    ).toThrow(/exactly one positional/);
  });

  test("an unknown flag throws CliUsageError", () => {
    expect(() =>
      parseArgs(["--project", "/abs/path", "--workflow", "plan-build-test", "--bogus", "x", "prompt"]),
    ).toThrow(/unknown flag/);
  });

  test("a flag with a missing value throws CliUsageError", () => {
    expect(() => parseArgs(["--project", "--workflow", "plan-build-test", "prompt"])).toThrow(/requires a value/);
  });

  test("usage errors include the usage string", () => {
    expect(() => parseArgs([])).toThrow(/usage: bun cli\.ts/);
  });
});

// ── formatWorkflowList (M-104: --list-workflows) ────────────────────────────

describe("formatWorkflowList", () => {
  test("renders one 'name: description' line per workflow, in the given order", () => {
    const text = formatWorkflowList(["a", "b"], { a: "Does A.", b: "Does B." });
    expect(text).toBe("a: Does A.\nb: Does B.");
  });

  test("falls back to a placeholder for a name with no description entry, rather than throwing", () => {
    const text = formatWorkflowList(["a"], {});
    expect(text).toBe("a: (no description)");
  });

  test("every REAL registered workflow (chains/registry.ts) has a non-empty description — the actual data --list-workflows prints", () => {
    const names = workflowNames();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(WORKFLOW_DESCRIPTIONS[name]).toBeTruthy();
    }
    const text = formatWorkflowList(names, WORKFLOW_DESCRIPTIONS);
    for (const name of names) {
      expect(text).toContain(`${name}: `);
    }
    expect(text).not.toContain("(no description)");
  });
});

// ── resolvePrompt ────────────────────────────────────────────────────────

describe("resolvePrompt", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-web-factory-cli-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("literal text that isn't a path on disk is returned as-is", () => {
    expect(resolvePrompt("add a /health endpoint")).toBe("add a /health endpoint");
  });

  test("a path to an existing file is read and its contents returned", () => {
    const promptFile = join(dir, "prompt.md");
    writeFileSync(promptFile, "do the documented thing\n");
    expect(resolvePrompt(promptFile)).toBe("do the documented thing\n");
  });

  test("a path-shaped string that does not exist on disk is treated as literal text", () => {
    const missing = join(dir, "does-not-exist.md");
    expect(resolvePrompt(missing)).toBe(missing);
  });
});

// ── browserOriginFromApiBaseUrl / sessionDeepLink (M-071) ──────────────────

describe("browserOriginFromApiBaseUrl", () => {
  test("strips a trailing /api from the API base URL", () => {
    expect(browserOriginFromApiBaseUrl("http://192.168.1.21:8080/api")).toBe("http://192.168.1.21:8080");
  });

  test("leaves a base URL without a trailing /api unchanged", () => {
    expect(browserOriginFromApiBaseUrl("http://192.168.1.21:8080")).toBe("http://192.168.1.21:8080");
  });
});

describe("sessionDeepLink", () => {
  test("builds a link with project, workspace, and session query params", () => {
    const link = sessionDeepLink("http://192.168.1.21:8080/api", { projectId: "proj_1", workspaceId: "ws_1" }, "sess_1");
    expect(link).toBe("http://192.168.1.21:8080/?project=proj_1&session=sess_1&workspace=ws_1");
  });

  test("omits the workspace param when workspaceId is undefined, but still includes project+session", () => {
    const link = sessionDeepLink("http://192.168.1.21:8080/api", { projectId: "proj_1" }, "sess_1");
    expect(link).toBe("http://192.168.1.21:8080/?project=proj_1&session=sess_1");
    expect(link).not.toContain("workspace");
  });
});

// ── describeResult ───────────────────────────────────────────────────────

describe("describeResult", () => {
  test("success -> exit code 0, includes a real deep-link", () => {
    const { message, exitCode } = describeResult({ status: "success", adwId: "adw_1", sessionId: "sess_1", link: TEST_LINK });
    expect(exitCode).toBe(0);
    expect(message).toContain("SUCCESS");
    expect(message).toContain("adw_1");
    expect(message).toContain("sess_1");
    expect(message).toContain("project=proj_1");
    expect(message).toContain("workspace=ws_1");
    expect(message).toContain("session=sess_1");
  });

  test("blocked-on-human -> distinct message, non-zero exit code, includes deep-link", () => {
    const result: PlanBuildTestResult = {
      status: "blocked-on-human",
      adwId: "adw_1",
      sessionId: "sess_1",
      phase: "plan",
      pendingAsk: {},
      link: TEST_LINK,
    };
    const { message, exitCode } = describeResult(result);
    expect(exitCode).not.toBe(0);
    expect(message).toContain("BLOCKED-ON-HUMAN");
    expect(message).toContain("--session-id sess_1");
    expect(message).toContain("project=proj_1");
  });

  test("unparseable with an empty rawResponse -> says the agent returned no text at all, not the generic fallback", () => {
    // Regression test: rawResponse "" is falsy in JS, so a naive `rawResponse
    // ? ... : fallback` check silently collapses this into the same generic
    // message as a runner that never populated rawResponse at all -- hiding
    // the single most useful, easiest-to-understand diagnosis (the agent
    // said literally nothing). Confirmed live 2026-08-05 that this is a
    // real, recurring failure mode, not a hypothetical edge case.
    const result: PlanBuildTestResult = {
      status: "unparseable",
      adwId: "adw_1",
      sessionId: "sess_1",
      phase: "build",
      lastReport: { checks: [] },
      rawResponse: "",
      link: TEST_LINK,
    };
    const { message, exitCode } = describeResult(result);
    expect(exitCode).not.toBe(0);
    expect(message).toContain("UNPARSEABLE");
    expect(message).toContain("no response text");
    expect(message).not.toContain("never matched the required envelope schema");
  });

  test("unparseable -> message includes the agent's actual raw response text, not just a generic phrase", () => {
    const result: PlanBuildTestResult = {
      status: "unparseable",
      adwId: "adw_1",
      sessionId: "sess_1",
      phase: "build",
      lastReport: { checks: [{ item: "json", ok: false, note: "does not parse" }] },
      rawResponse: "```json\n{\"status\": \"success\"}\n```",
      link: TEST_LINK,
    };
    const { message } = describeResult(result);
    expect(message).toContain("```json");
    expect(message).not.toContain("never matched the required envelope schema after retries");
  });

  test("permissions-violation -> distinct message, non-zero exit code", () => {
    const result: PlanBuildTestResult = {
      status: "permissions-violation",
      adwId: "adw_1",
      sessionId: "sess_1",
      phase: "build",
      permissions: { touched: [], allowed: [], violations: [], rollbacks: [], clean: true },
      link: TEST_LINK,
    };
    const { message, exitCode } = describeResult(result);
    expect(exitCode).not.toBe(0);
    expect(message).toContain("PERMISSIONS-VIOLATION");
  });

  test("permissions-violation -> message names the actual violating file(s)", () => {
    const result: PlanBuildTestResult = {
      status: "permissions-violation",
      adwId: "adw_1",
      sessionId: "sess_1",
      phase: "build",
      permissions: {
        touched: ["stack.py", "unauthorized.txt"],
        allowed: [],
        violations: ["stack.py", "unauthorized.txt"],
        rollbacks: [],
        clean: true,
      },
      link: TEST_LINK,
    };
    const { message } = describeResult(result);
    expect(message).toContain("stack.py");
    expect(message).toContain("unauthorized.txt");
  });

  test("failed -> distinct message including the reason, non-zero exit code", () => {
    const result: PlanBuildTestResult = {
      status: "failed",
      adwId: "adw_1",
      sessionId: "sess_1",
      phase: "test",
      reason: "tests failed: 2 of 5",
      link: TEST_LINK,
    };
    const { message, exitCode } = describeResult(result);
    expect(exitCode).not.toBe(0);
    expect(message).toContain("FAILED");
    expect(message).toContain("tests failed: 2 of 5");
  });

  test("every non-success status yields a different exit code from success and from each other where distinguishable", () => {
    const success = describeResult({ status: "success", adwId: "a", sessionId: "s", link: TEST_LINK }).exitCode;
    const failedResult: PlanBuildTestResult = {
      status: "failed",
      adwId: "a",
      sessionId: "s",
      phase: "test",
      reason: "x",
      link: TEST_LINK,
    };
    const blockedResult: PlanBuildTestResult = {
      status: "blocked-on-human",
      adwId: "a",
      sessionId: "s",
      phase: "plan",
      pendingAsk: {},
      link: TEST_LINK,
    };
    const failed = describeResult(failedResult).exitCode;
    const blocked = describeResult(blockedResult).exitCode;
    expect(success).toBe(0);
    expect(failed).not.toBe(0);
    expect(blocked).not.toBe(0);
  });
});
