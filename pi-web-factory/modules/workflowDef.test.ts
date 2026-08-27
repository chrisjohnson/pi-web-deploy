/**
 * Unit tests for workflowDef.ts's YAML shape loader/validator — no network,
 * no live server. Covers both shipped Workflow files (loaded for real, off
 * disk) plus load-time validation of malformed shapes (duplicate step names,
 * a loop's `until.step` pointing outside its own `steps`, etc).
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ConfigError } from "./config.ts";
import { loadWorkflows, loadWorkflowsFromString, workflowFor } from "./workflowDef.ts";

const WORKFLOWS_DIR = join(import.meta.dir, "..", "workflows");

describe("the shipped plan-build-review.yaml", () => {
  test("loads and validates successfully from disk", () => {
    const workflows = loadWorkflows(join(WORKFLOWS_DIR, "plan-build-review.yaml"));
    expect(workflows.length).toBe(1);
    expect(workflows[0]?.name).toBe("plan-build-review");
  });

  test("has exactly the three agent steps plan -> build -> review, no loop", () => {
    const [workflow] = loadWorkflows(join(WORKFLOWS_DIR, "plan-build-review.yaml"));
    expect(workflow?.steps.map((s) => s.kind)).toEqual(["agent", "agent", "agent"]);
    expect(workflow?.steps.map((s) => s.name)).toEqual(["plan", "build", "review"]);
  });

  test("build step's prompt references plan's summary via interpolation syntax", () => {
    const [workflow] = loadWorkflows(join(WORKFLOWS_DIR, "plan-build-review.yaml"));
    const build = workflow?.steps.find((s) => s.name === "build");
    expect(build?.kind).toBe("agent");
    if (build?.kind === "agent") expect(build.prompt).toContain("{{plan.summary}}");
  });

  test("every step has a human-friendly title and summary (M-105 items 5/6)", () => {
    const [workflow] = loadWorkflows(join(WORKFLOWS_DIR, "plan-build-review.yaml"));
    for (const step of workflow?.steps ?? []) {
      expect(step.title).toBeTruthy();
      expect(step.summary).toBeTruthy();
    }
    const plan = workflow?.steps.find((s) => s.name === "plan");
    expect(plan?.title).toBe("Construct a Plan");
  });

  test("has a whole-Workflow description a router can read (M-104)", () => {
    const [workflow] = loadWorkflows(join(WORKFLOWS_DIR, "plan-build-review.yaml"));
    expect(workflow?.description).toBeTruthy();
  });
});

describe("the shipped bounded-build-review.yaml", () => {
  test("loads and validates successfully from disk", () => {
    const workflows = loadWorkflows(join(WORKFLOWS_DIR, "bounded-build-review.yaml"));
    expect(workflows.length).toBe(1);
    expect(workflows[0]?.name).toBe("bounded-build-review");
  });

  test("is build (agent) -> loop { review, build-retry }, until review.approved == true, max_rounds 3", () => {
    const [workflow] = loadWorkflows(join(WORKFLOWS_DIR, "bounded-build-review.yaml"));
    expect(workflow?.steps.map((s) => s.kind)).toEqual(["agent", "loop"]);
    const loop = workflow?.steps[1];
    expect(loop?.kind).toBe("loop");
    if (loop?.kind === "loop") {
      expect(loop.steps.map((s) => s.name)).toEqual(["review", "build-retry"]);
      expect(loop.until).toEqual({ step: "review", field: "approved", equals: true });
      expect(loop.max_rounds).toBe(3);
    }
  });

  test("step names are unique across the whole workflow, including the outer build vs the loop's build-retry", () => {
    const [workflow] = loadWorkflows(join(WORKFLOWS_DIR, "bounded-build-review.yaml"));
    const names: string[] = [];
    for (const step of workflow?.steps ?? []) {
      names.push(step.name);
      if (step.kind === "loop") names.push(...step.steps.map((s) => s.name));
    }
    expect(new Set(names).size).toBe(names.length);
  });

  test("the loop step itself, and its inner steps, all have a title/summary (M-105 items 5/6)", () => {
    const [workflow] = loadWorkflows(join(WORKFLOWS_DIR, "bounded-build-review.yaml"));
    const loop = workflow?.steps.find((s) => s.kind === "loop");
    expect(loop?.title).toBeTruthy();
    expect(loop?.summary).toBeTruthy();
    if (loop?.kind === "loop") {
      for (const inner of loop.steps) {
        expect(inner.title).toBeTruthy();
        expect(inner.summary).toBeTruthy();
      }
    }
  });

  test("has a whole-Workflow description a router can read (M-104)", () => {
    const [workflow] = loadWorkflows(join(WORKFLOWS_DIR, "bounded-build-review.yaml"));
    expect(workflow?.description).toBeTruthy();
  });
});

describe("the shipped plan-build-review-with-tests.yaml (M-099)", () => {
  test("loads and validates successfully from disk, with a whole-Workflow description (M-104)", () => {
    const workflows = loadWorkflows(join(WORKFLOWS_DIR, "plan-build-review-with-tests.yaml"));
    expect(workflows.length).toBe(1);
    expect(workflows[0]?.name).toBe("plan-build-review-with-tests");
    expect(workflows[0]?.description).toBeTruthy();
  });
});

describe("retries (M-103)", () => {
  test("defaults to 0 when omitted — both shipped Workflow files (no retries field authored)", () => {
    const [pbr] = loadWorkflows(join(WORKFLOWS_DIR, "plan-build-review.yaml"));
    const [bbr] = loadWorkflows(join(WORKFLOWS_DIR, "bounded-build-review.yaml"));
    expect(pbr?.retries).toBe(0);
    expect(bbr?.retries).toBe(0);
  });

  test("a Workflow YAML can declare a real retries budget, distinct from a loop's max_rounds", () => {
    const yaml = `
workflows:
  - name: retry-demo
    description: A test fixture workflow.
    retries: 2
    steps:
      - kind: agent
        name: build
        role: build
        prompt: do the thing
`;
    const [workflow] = loadWorkflowsFromString(yaml);
    expect(workflow?.retries).toBe(2);
  });

  test("rejects a negative retries value", () => {
    const yaml = `
workflows:
  - name: bad-retries
    description: A test fixture workflow.
    retries: -1
    steps:
      - kind: agent
        name: build
        role: build
        prompt: do the thing
`;
    expect(() => loadWorkflowsFromString(yaml)).toThrow(ConfigError);
  });
});

describe("loadWorkflowsFromString — validation", () => {
  test("rejects a workflow with duplicate step names, including across a loop boundary", () => {
    const yaml = `
workflows:
  - name: bad
    description: A test fixture workflow.
    steps:
      - kind: agent
        name: build
        role: build
        prompt: do it
      - kind: loop
        name: loop1
        max_rounds: 2
        until: {step: review, field: approved, equals: true}
        steps:
          - kind: agent
            name: review
            role: review
            prompt: review it
          - kind: agent
            name: build
            role: build
            prompt: redo it
`;
    expect(() => loadWorkflowsFromString(yaml)).toThrow(ConfigError);
    expect(() => loadWorkflowsFromString(yaml)).toThrow(/duplicate step name/);
  });

  test("rejects a loop whose until.step is not one of its own inner steps", () => {
    const yaml = `
workflows:
  - name: bad
    description: A test fixture workflow.
    steps:
      - kind: agent
        name: plan
        role: plan
        prompt: plan it
      - kind: loop
        name: loop1
        max_rounds: 2
        until: {step: plan, field: approved, equals: true}
        steps:
          - kind: agent
            name: review
            role: review
            prompt: review it
`;
    expect(() => loadWorkflowsFromString(yaml)).toThrow(ConfigError);
    expect(() => loadWorkflowsFromString(yaml)).toThrow(/not one of this loop's own inner steps/);
  });

  test("rejects a loop step nested inside another loop's steps (schema-level: LoopInnerStepSchema has no 'loop' kind)", () => {
    const yaml = `
workflows:
  - name: bad
    description: A test fixture workflow.
    steps:
      - kind: loop
        name: outer
        max_rounds: 2
        until: {step: review, field: approved, equals: true}
        steps:
          - kind: loop
            name: inner
            max_rounds: 2
            until: {step: review, field: approved, equals: true}
            steps:
              - kind: agent
                name: review
                role: review
                prompt: review it
`;
    expect(() => loadWorkflowsFromString(yaml)).toThrow(ConfigError);
  });

  test("rejects duplicate workflow names in the same file", () => {
    const yaml = `
workflows:
  - name: dup
    description: A test fixture workflow.
    steps: [{kind: agent, name: a, role: plan, prompt: x}]
  - name: dup
    description: Another test fixture workflow.
    steps: [{kind: agent, name: b, role: plan, prompt: y}]
`;
    expect(() => loadWorkflowsFromString(yaml)).toThrow(/duplicate workflow name/);
  });

  test("rejects malformed YAML with a ConfigError, not a bare parse exception", () => {
    expect(() => loadWorkflowsFromString("workflows: [this is not: valid: yaml:")).toThrow(ConfigError);
  });

  test("a code step has no prompt field and is accepted", () => {
    const yaml = `
workflows:
  - name: ok
    description: A test fixture workflow.
    steps:
      - kind: code
        name: test
        role: run-tests
`;
    const [workflow] = loadWorkflowsFromString(yaml);
    expect(workflow?.steps[0]).toEqual({ kind: "code", name: "test", role: "run-tests" });
  });
});

describe("description (M-104)", () => {
  test("is REQUIRED — a workflow with no description is rejected with a ConfigError", () => {
    const yaml = `
workflows:
  - name: no-description
    steps:
      - kind: agent
        name: build
        role: build
        prompt: do it
`;
    expect(() => loadWorkflowsFromString(yaml)).toThrow(ConfigError);
  });

  test("rejects an empty-string description (min length 1, same discipline as name)", () => {
    const yaml = `
workflows:
  - name: bad
    description: ""
    steps:
      - kind: agent
        name: build
        role: build
        prompt: do it
`;
    expect(() => loadWorkflowsFromString(yaml)).toThrow(ConfigError);
  });

  test("a workflow with a description loads it verbatim, at whole-Workflow granularity", () => {
    const yaml = `
workflows:
  - name: described
    description: Pick this one when the task needs X.
    steps:
      - kind: agent
        name: build
        role: build
        prompt: do it
`;
    const [workflow] = loadWorkflowsFromString(yaml);
    expect(workflow?.description).toBe("Pick this one when the task needs X.");
  });
});

describe("title/summary (M-105 items 5/6)", () => {
  test("both fields are OPTIONAL — a step with neither still loads exactly as before", () => {
    const yaml = `
workflows:
  - name: legacy
    description: A test fixture workflow.
    steps:
      - kind: agent
        name: build
        role: build
        prompt: do it
`;
    const [workflow] = loadWorkflowsFromString(yaml);
    const step = workflow?.steps[0];
    expect(step).toEqual({ kind: "agent", name: "build", role: "build", prompt: "do it" });
    expect(step?.title).toBeUndefined();
    expect(step?.summary).toBeUndefined();
  });

  test("an agent step can declare both a title and a summary", () => {
    const yaml = `
workflows:
  - name: titled
    description: A test fixture workflow.
    steps:
      - kind: agent
        name: plan
        role: plan
        title: Construct a Plan
        summary: Produces an implementation plan before any code is written.
        prompt: do it
`;
    const [workflow] = loadWorkflowsFromString(yaml);
    const step = workflow?.steps[0];
    expect(step?.title).toBe("Construct a Plan");
    expect(step?.summary).toBe("Produces an implementation plan before any code is written.");
  });

  test("a code step can declare both a title and a summary", () => {
    const yaml = `
workflows:
  - name: titled-code
    description: A test fixture workflow.
    steps:
      - kind: code
        name: test
        role: run-tests
        title: Run the Test Suite
        summary: Mechanically runs the project's own test command.
`;
    const [workflow] = loadWorkflowsFromString(yaml);
    const step = workflow?.steps[0];
    expect(step?.title).toBe("Run the Test Suite");
    expect(step?.summary).toBe("Mechanically runs the project's own test command.");
  });

  test("a loop step can declare its own title and summary, independent of its inner steps' own", () => {
    const yaml = `
workflows:
  - name: titled-loop
    description: A test fixture workflow.
    steps:
      - kind: loop
        name: correction-loop
        title: Build/Review Correction Loop
        summary: Repeats review and correction rounds until approved.
        max_rounds: 2
        until: {step: review, field: approved, equals: true}
        steps:
          - kind: agent
            name: review
            role: review
            title: Review the Implementation
            prompt: review it
`;
    const [workflow] = loadWorkflowsFromString(yaml);
    const loop = workflow?.steps[0];
    expect(loop?.title).toBe("Build/Review Correction Loop");
    if (loop?.kind === "loop") {
      expect(loop.steps[0]?.title).toBe("Review the Implementation");
    }
  });

  test("rejects an empty-string title/summary (min length 1, same discipline as name/role)", () => {
    const badTitle = `
workflows:
  - name: bad
    description: A test fixture workflow.
    steps:
      - kind: agent
        name: build
        role: build
        title: ""
        prompt: do it
`;
    expect(() => loadWorkflowsFromString(badTitle)).toThrow(ConfigError);

    const badSummary = `
workflows:
  - name: bad2
    description: A test fixture workflow.
    steps:
      - kind: agent
        name: build
        role: build
        summary: ""
        prompt: do it
`;
    expect(() => loadWorkflowsFromString(badSummary)).toThrow(ConfigError);
  });
});

describe("workflowFor", () => {
  test("resolves a workflow by name", () => {
    const workflows = loadWorkflowsFromString(`
workflows:
  - name: one
    description: A test fixture workflow.
    steps: [{kind: agent, name: a, role: plan, prompt: x}]
`);
    expect(workflowFor(workflows, "one").name).toBe("one");
  });

  test("throws a ConfigError naming what's available for an unknown name", () => {
    const workflows = loadWorkflowsFromString(`
workflows:
  - name: one
    description: A test fixture workflow.
    steps: [{kind: agent, name: a, role: plan, prompt: x}]
`);
    expect(() => workflowFor(workflows, "nonexistent")).toThrow(ConfigError);
    expect(() => workflowFor(workflows, "nonexistent")).toThrow(/one/);
  });
});
