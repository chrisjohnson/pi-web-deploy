import { describe, expect, test } from "bun:test";
import {
  BuildOutputSchema,
  DocumentOutputSchema,
  EnvelopeBaseSchema,
  PlanOutputSchema,
  ReviewOutputSchema,
  ScoutOutputSchema,
} from "./envelopes.ts";

describe("EnvelopeBaseSchema", () => {
  test("a well-formed payload parses successfully", () => {
    const result = EnvelopeBaseSchema.safeParse({
      status: "success",
      summary: "did the thing",
      artifacts: ["a.md"],
      notes_for_next_agent: "check a.md",
    });
    expect(result.success).toBe(true);
  });

  test("missing required field (status) fails with a specific Zod error", () => {
    const result = EnvelopeBaseSchema.safeParse({
      summary: "no status here",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join(".") === "status");
      expect(issue).toBeDefined();
      // zod 4 reports a missing/mismatched enum member as "invalid_value",
      // not "invalid_type" (that code is reserved for e.g. string vs number).
      expect(issue?.code).toBe("invalid_value");
    }
  });
});

describe("PlanOutputSchema", () => {
  test("well-formed plan envelope (matches planner/user.md's Report example) parses", () => {
    const result = PlanOutputSchema.safeParse({
      status: "success",
      summary: "Plan for the /health endpoint",
      artifacts: ["context_handoff/plan.md", "specs/adw123_health-endpoint.md"],
      commit_message: "Add spec for the /health endpoint",
      notes_for_next_agent: "build per the spec",
    });
    expect(result.success).toBe(true);
  });

  test("missing status fails with a specific Zod error", () => {
    const result = PlanOutputSchema.safeParse({
      summary: "no status",
      commit_message: "x",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join(".") === "status")).toBe(true);
    }
  });
});

describe("BuildOutputSchema", () => {
  test("well-formed build envelope (matches builder/user.md's Report example) parses", () => {
    const result = BuildOutputSchema.safeParse({
      status: "success",
      summary: "Implemented the /health endpoint",
      changed_files: ["src/server.ts"],
      artifacts: [],
      commit_message: "Add /health endpoint",
      notes_for_next_agent: "curl /health to verify",
    });
    expect(result.success).toBe(true);
  });

  test("missing status fails with a specific Zod error", () => {
    const result = BuildOutputSchema.safeParse({
      changed_files: ["src/server.ts"],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join(".") === "status")).toBe(true);
    }
  });

  test("wrong type for changed_files fails with a specific Zod error", () => {
    const result = BuildOutputSchema.safeParse({
      status: "success",
      changed_files: "src/server.ts", // should be an array
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join(".") === "changed_files");
      expect(issue).toBeDefined();
      expect(issue?.code).toBe("invalid_type");
    }
  });
});

describe("ScoutOutputSchema", () => {
  test("well-formed scout envelope (matches scout/user.md's Report example) parses", () => {
    const result = ScoutOutputSchema.safeParse({
      status: "success",
      summary: "Found the relevant files",
      findings: [{ file: "src/server.ts", note: "route registration lives here" }],
      artifacts: ["context_handoff/scout_findings.md"],
    });
    expect(result.success).toBe(true);
  });

  test("finding missing required field (file) fails with a specific Zod error", () => {
    const result = ScoutOutputSchema.safeParse({
      status: "success",
      findings: [{ note: "no file field" }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join(".") === "findings.0.file")).toBe(true);
    }
  });
});

describe("ReviewOutputSchema", () => {
  test("well-formed review envelope (matches reviewer/user.md's Report example) parses", () => {
    const result = ReviewOutputSchema.safeParse({
      status: "success",
      approved: false,
      summary: "1 of 2 requirements met",
      findings: [
        { requirement: "endpoint returns 200", met: true, evidence: "src/server.ts:42" },
        { requirement: "endpoint is tested", met: false, evidence: "no test found" },
      ],
      blocking: ["add a test for /health"],
      artifacts: ["context_handoff/review.md"],
      notes_for_next_agent: "add the missing test",
    });
    expect(result.success).toBe(true);
  });

  test("finding missing required field (met) fails with a specific Zod error", () => {
    const result = ReviewOutputSchema.safeParse({
      status: "success",
      findings: [{ requirement: "x", evidence: "y" }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join(".") === "findings.0.met")).toBe(true);
    }
  });
});

describe("DocumentOutputSchema", () => {
  test("well-formed document envelope (matches documenter/user.md's Report example) parses", () => {
    const result = DocumentOutputSchema.safeParse({
      status: "success",
      summary: "Documented the /health endpoint",
      document_path: "app_docs/adw123_health-endpoint.md",
      documented_files: ["src/server.ts"],
      artifacts: ["context_handoff/document.md", "app_docs/adw123_health-endpoint.md"],
      commit_message: "Document the /health endpoint",
      notes_for_next_agent: "",
    });
    expect(result.success).toBe(true);
  });

  test("missing status fails with a specific Zod error", () => {
    const result = DocumentOutputSchema.safeParse({
      document_path: "app_docs/x.md",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join(".") === "status")).toBe(true);
    }
  });
});
