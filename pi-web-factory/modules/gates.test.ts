import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildOutputSchema } from "./envelopes.ts";
import { artifactsExist, diffMatchesClaims, filesNonEmpty, jsonParses, testsPass } from "./gates.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-web-factory-gates-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function git(args: string[], cwd: string): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

function initRepo(cwd: string): void {
  git(["init", "-q"], cwd);
  git(["config", "user.email", "test@example.com"], cwd);
  git(["config", "user.name", "Test"], cwd);
}

describe("artifactsExist", () => {
  test("all paths present -> all checks ok:true", () => {
    writeFileSync(join(dir, "a.md"), "hello");
    writeFileSync(join(dir, "b.md"), "world");

    const result = artifactsExist(["a.md", "b.md"], dir);
    expect(result.checks).toHaveLength(2);
    expect(result.checks.every((c) => c.ok)).toBe(true);
    expect(result.checks[0]?.note).toContain("exists");
  });

  test("missing path -> that specific check ok:false with an inspectable note", () => {
    writeFileSync(join(dir, "a.md"), "hello");

    const result = artifactsExist(["a.md", "missing.md"], dir);
    expect(result.checks).toHaveLength(2);

    const good = result.checks.find((c) => c.item === "a.md");
    const bad = result.checks.find((c) => c.item === "missing.md");
    expect(good?.ok).toBe(true);
    expect(bad?.ok).toBe(false);
    expect(bad?.note).toBe("declared artifact does not exist");
  });
});

describe("filesNonEmpty", () => {
  test("all paths present and non-empty -> all checks ok:true", () => {
    writeFileSync(join(dir, "a.md"), "hello");
    writeFileSync(join(dir, "b.md"), "world");

    const result = filesNonEmpty(["a.md", "b.md"], dir);
    expect(result.checks).toHaveLength(2);
    expect(result.checks.every((c) => c.ok)).toBe(true);
  });

  test("missing path -> skipped (not this gate's job); empty path -> ok:false with note", () => {
    writeFileSync(join(dir, "a.md"), "hello");
    writeFileSync(join(dir, "empty.md"), "");

    const result = filesNonEmpty(["a.md", "empty.md", "missing.md"], dir);
    // "missing.md" is skipped entirely (existence is artifactsExist's job).
    expect(result.checks.map((c) => c.item)).toEqual(["a.md", "empty.md"]);

    const good = result.checks.find((c) => c.item === "a.md");
    const empty = result.checks.find((c) => c.item === "empty.md");
    expect(good?.ok).toBe(true);
    expect(empty?.ok).toBe(false);
    expect(empty?.note).toBe("declared artifact is empty");
  });
});

describe("jsonParses", () => {
  test("valid JSON matching a real envelope schema passes", () => {
    const text = JSON.stringify({
      status: "success",
      summary: "built it",
      changed_files: ["src/server.ts"],
      artifacts: [],
      commit_message: "Add endpoint",
      notes_for_next_agent: "",
    });

    const result = jsonParses(text, BuildOutputSchema);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]?.ok).toBe(true);
  });

  test("invalid JSON fails with a useful note", () => {
    const result = jsonParses("{not valid json", BuildOutputSchema);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]?.ok).toBe(false);
    expect(result.checks[0]?.note).toContain("does not parse");
  });

  test("schema-violating JSON (missing required field) fails with per-issue notes", () => {
    const text = JSON.stringify({ summary: "no status field" });

    const result = jsonParses(text, BuildOutputSchema);
    expect(result.checks.length).toBeGreaterThan(0);
    expect(result.checks.every((c) => !c.ok)).toBe(true);
    const statusIssue = result.checks.find((c) => c.item === "status");
    expect(statusIssue).toBeDefined();
    expect(statusIssue?.note).toBeTruthy();
  });

  // Some models (medium-moe/Ornith, confirmed live) reliably wrap
  // otherwise-valid JSON in a markdown fence despite prompt instructions to
  // return raw JSON only — a real, recurring failure mode independent of
  // the message-settle race.
  test("JSON wrapped in a ```json fence still parses", () => {
    const envelope = { status: "success", summary: "did it", artifacts: [], notes_for_next_agent: "" };
    const text = "```json\n" + JSON.stringify(envelope) + "\n```";

    const result = jsonParses(text, BuildOutputSchema);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]?.ok).toBe(true);
  });

  test("JSON wrapped in a bare ``` fence (no language tag) still parses", () => {
    const envelope = { status: "success", summary: "did it", artifacts: [], notes_for_next_agent: "" };
    const text = "```\n" + JSON.stringify(envelope) + "\n```";

    const result = jsonParses(text, BuildOutputSchema);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]?.ok).toBe(true);
  });

  test("JSON with a little prose immediately before/after it still parses (best-effort brace extraction)", () => {
    const envelope = { status: "success", summary: "did it", artifacts: [], notes_for_next_agent: "" };
    const text = `Here's the result:\n${JSON.stringify(envelope)}\nDone.`;

    const result = jsonParses(text, BuildOutputSchema);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]?.ok).toBe(true);
  });

  test("genuinely prose-only text (no JSON object anywhere) still fails, not silently accepted", () => {
    const result = jsonParses("I have completed the task successfully.", BuildOutputSchema);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]?.ok).toBe(false);
    expect(result.checks[0]?.note).toContain("does not parse");
  });

  test("empty string still fails cleanly (the message-settle race's own failure shape, unrelated to fence-stripping)", () => {
    const result = jsonParses("", BuildOutputSchema);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]?.ok).toBe(false);
  });
});

describe("diffMatchesClaims", () => {
  test("claimed file matches a real tracked change in a scratch git repo", () => {
    initRepo(dir);
    writeFileSync(join(dir, "server.ts"), "console.log('v1')\n");
    git(["add", "."], dir);
    git(["commit", "-q", "-m", "initial"], dir);

    writeFileSync(join(dir, "server.ts"), "console.log('v2')\n");

    const result = diffMatchesClaims(["server.ts"], dir);
    const claim = result.checks.find((c) => c.item === "server.ts");
    expect(claim?.ok).toBe(true);
  });

  test("claimed-but-unchanged file fails", () => {
    initRepo(dir);
    writeFileSync(join(dir, "server.ts"), "console.log('v1')\n");
    writeFileSync(join(dir, "untouched.ts"), "console.log('untouched')\n");
    git(["add", "."], dir);
    git(["commit", "-q", "-m", "initial"], dir);

    writeFileSync(join(dir, "server.ts"), "console.log('v2')\n");

    const result = diffMatchesClaims(["server.ts", "untouched.ts"], dir);
    const untouchedCheck = result.checks.find((c) => c.item === "untouched.ts");
    expect(untouchedCheck?.ok).toBe(false);
    expect(untouchedCheck?.note).toContain("not in the actual diff");
  });

  test("new untracked file counts as an actual change", () => {
    initRepo(dir);
    writeFileSync(join(dir, "server.ts"), "console.log('v1')\n");
    git(["add", "."], dir);
    git(["commit", "-q", "-m", "initial"], dir);

    writeFileSync(join(dir, "new-file.ts"), "console.log('new')\n");

    const result = diffMatchesClaims(["new-file.ts"], dir);
    const claim = result.checks.find((c) => c.item === "new-file.ts");
    expect(claim?.ok).toBe(true);
  });

  test("changed-but-unclaimed file is flagged separately", () => {
    initRepo(dir);
    writeFileSync(join(dir, "server.ts"), "console.log('v1')\n");
    writeFileSync(join(dir, "sneaky.ts"), "console.log('v1')\n");
    git(["add", "."], dir);
    git(["commit", "-q", "-m", "initial"], dir);

    writeFileSync(join(dir, "server.ts"), "console.log('v2')\n");
    writeFileSync(join(dir, "sneaky.ts"), "console.log('v2, unclaimed')\n");

    const result = diffMatchesClaims(["server.ts"], dir);
    const unclaimed = result.checks.find((c) => c.item === "unclaimed:sneaky.ts");
    expect(unclaimed).toBeDefined();
    expect(unclaimed?.ok).toBe(false);
    expect(unclaimed?.note).toContain("not claimed");
  });
});

describe("testsPass", () => {
  test("exit 0 command passes", async () => {
    const result = await testsPass("exit 0", dir);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]?.ok).toBe(true);
    expect(result.checks[0]?.note).toBe("exit 0");
  });

  test("non-zero exit fails with a trimmed output snippet", async () => {
    const result = await testsPass("echo 'boom' >&2; exit 1", dir);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]?.ok).toBe(false);
    expect(result.checks[0]?.note).toContain("exit 1");
    expect(result.checks[0]?.note).toContain("boom");
  });

  test("runs in the given cwd (real subprocess, not mocked)", async () => {
    writeFileSync(join(dir, "marker.txt"), "present");
    const result = await testsPass("test -f marker.txt", dir);
    expect(result.checks[0]?.ok).toBe(true);
  });
});
