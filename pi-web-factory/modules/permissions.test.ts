import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_EXEMPT_ARTIFACTS, enforceWrites, isWritePermitted, snapshotRepoState } from "./permissions.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-web-factory-permissions-test-"));
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

// ── isWritePermitted (precedence) ───────────────────────────────────────

describe("isWritePermitted", () => {
  test("null allowedWrites is unrestricted", () => {
    expect(isWritePermitted("anything.ts", null, [])).toBe(true);
  });

  test("empty allowedWrites is read-only: nothing passes", () => {
    expect(isWritePermitted("report.md", [], [])).toBe(false);
  });

  test("path in allowedWrites passes even without a protected list", () => {
    expect(isWritePermitted("report.md", ["report.md"], [])).toBe(true);
  });

  test("path in protectedFiles is blocked when not explicitly allowed", () => {
    expect(isWritePermitted("adws/adw_data/x.py", null, ["adws/"])).toBe(false);
  });

  test("writes: takes precedence over protected_files (naming a path unlocks it)", () => {
    expect(isWritePermitted("adws/special.py", ["adws/special.py"], ["adws/"])).toBe(true);
  });

  test("glob in writes: matches within a directory but not across separators", () => {
    expect(isWritePermitted("adws/adw_plan.py", ["adws/adw_*.py"], [])).toBe(true);
    expect(isWritePermitted("adws/adw_data/sessions/x/y.py", ["adws/adw_*.py"], [])).toBe(false);
  });

  test("** glob crosses directory separators", () => {
    expect(isWritePermitted("adws/adw_data/sessions/x/y.py", ["adws/**"], [])).toBe(true);
  });

  test("trailing-slash pattern is a directory prefix match", () => {
    expect(isWritePermitted("context_handoff/plan.json", ["context_handoff/"], [])).toBe(true);
    expect(isWritePermitted("other/context_handoff/plan.json", ["context_handoff/"], [])).toBe(false);
  });
});

// ── DEFAULT_EXEMPT_ARTIFACTS (M-082) ────────────────────────────────────

describe("isWritePermitted — default-exempt incidental artifacts (M-082)", () => {
  test("repo-root __pycache__/*.pyc is exempt even when fully read-only", () => {
    expect(isWritePermitted("__pycache__/stack.cpython-311.pyc", [], [])).toBe(true);
  });

  test("NESTED __pycache__/*.pyc (inside a subdirectory) is also exempt", () => {
    expect(isWritePermitted("sub/dir/__pycache__/stack.cpython-311.pyc", [], [])).toBe(true);
  });

  test(".pytest_cache/ (repo-root and nested) is exempt", () => {
    expect(isWritePermitted(".pytest_cache/README.md", [], [])).toBe(true);
    expect(isWritePermitted("sub/.pytest_cache/README.md", [], [])).toBe(true);
  });

  test("a root-level *.pyc NOT inside a __pycache__ dir is still exempt (pattern is by extension, not just directory)", () => {
    expect(isWritePermitted("stray.pyc", [], [])).toBe(true);
    expect(isWritePermitted("sub/stray.pyc", [], [])).toBe(true);
  });

  test("exemption applies regardless of allowedWrites/protectedFiles — even an explicit protectedFiles entry can't override it", () => {
    expect(isWritePermitted("__pycache__/x.pyc", [], ["__pycache__/"])).toBe(true);
    expect(isWritePermitted("__pycache__/x.pyc", null, [])).toBe(true);
  });

  test("a path that merely CONTAINS 'pycache'-like text but doesn't match any exempt pattern is NOT exempted (exemption is precise, not a loose substring match)", () => {
    expect(isWritePermitted("notes_about_pycache.md", [], [])).toBe(false);
  });

  test("every DEFAULT_EXEMPT_ARTIFACTS pattern actually matches its own intended shape (regression guard against the naive '**/__pycache__/'-style no-op bug caught during this card's own research)", () => {
    expect(DEFAULT_EXEMPT_ARTIFACTS).not.toContain("**/__pycache__/");
    expect(isWritePermitted("__pycache__/x.pyc", [], [])).toBe(true);
    expect(isWritePermitted("a/b/__pycache__/x.pyc", [], [])).toBe(true);
  });
});

// ── snapshotRepoState / changedPaths sanity (used implicitly by enforceWrites) ──

describe("snapshotRepoState", () => {
  test("captures tracked-modified and untracked separately", () => {
    initRepo(dir);
    writeFileSync(join(dir, "tracked.ts"), "v1\n");
    git(["add", "."], dir);
    git(["commit", "-q", "-m", "initial"], dir);

    writeFileSync(join(dir, "tracked.ts"), "v2\n");
    writeFileSync(join(dir, "new.ts"), "new\n");

    const snap = snapshotRepoState(dir);
    expect(snap["tracked.ts"]).toBeDefined();
    expect(snap["tracked.ts"]).not.toBe("untracked");
    expect(snap["new.ts"]).toBe("untracked");
  });
});

// ── enforceWrites: the card's required scenarios ────────────────────────

describe("enforceWrites", () => {
  test("agent turn writes an allowed path and a disallowed NEW (untracked) path -> only disallowed reverted", () => {
    initRepo(dir);
    writeFileSync(join(dir, "README.md"), "hello\n");
    git(["add", "."], dir);
    git(["commit", "-q", "-m", "initial"], dir);

    const before = snapshotRepoState(dir);

    // Simulated agent turn.
    writeFileSync(join(dir, "allowed.md"), "agent wrote this\n");
    writeFileSync(join(dir, "forbidden.md"), "agent should not have written this\n");

    const result = enforceWrites(dir, before, ["allowed.md"], []);

    expect(result.touched.sort()).toEqual(["allowed.md", "forbidden.md"]);
    expect(result.allowed).toEqual(["allowed.md"]);
    expect(result.violations).toEqual(["forbidden.md"]);
    expect(result.clean).toBe(true);

    // Disallowed untracked file was deleted; allowed one survives untouched.
    expect(existsSync(join(dir, "forbidden.md"))).toBe(false);
    expect(existsSync(join(dir, "allowed.md"))).toBe(true);

    const rb = result.rollbacks[0];
    expect(rb?.path).toBe("forbidden.md");
    expect(rb?.outcome).toBe("deleted");
  });

  test("agent turn modifies an allowed tracked file and a disallowed TRACKED file -> disallowed one reverted via git checkout", async () => {
    initRepo(dir);
    writeFileSync(join(dir, "allowed.ts"), "v1\n");
    writeFileSync(join(dir, "forbidden.ts"), "original content\n");
    git(["add", "."], dir);
    git(["commit", "-q", "-m", "initial"], dir);

    const before = snapshotRepoState(dir);

    // Simulated agent turn: both are pre-existing tracked files being edited.
    writeFileSync(join(dir, "allowed.ts"), "v2\n");
    writeFileSync(join(dir, "forbidden.ts"), "agent overwrote this\n");

    const result = enforceWrites(dir, before, ["allowed.ts"], []);

    expect(result.allowed).toEqual(["allowed.ts"]);
    expect(result.violations).toEqual(["forbidden.ts"]);
    expect(result.clean).toBe(true);

    const rb = result.rollbacks[0];
    expect(rb?.path).toBe("forbidden.ts");
    expect(rb?.outcome).toBe("rolled-back");

    // Content actually restored via `git checkout --`; allowed file's edit survives.
    const forbiddenContent = await Bun.file(join(dir, "forbidden.ts")).text();
    expect(forbiddenContent).toBe("original content\n");
    const allowedContent = await Bun.file(join(dir, "allowed.ts")).text();
    expect(allowedContent).toBe("v2\n");
  });

  test("tracked-file rollback actually restores original content on disk", async () => {
    initRepo(dir);
    writeFileSync(join(dir, "forbidden.ts"), "original content\n");
    git(["add", "."], dir);
    git(["commit", "-q", "-m", "initial"], dir);

    const before = snapshotRepoState(dir);
    writeFileSync(join(dir, "forbidden.ts"), "agent overwrote this\n");

    const result = enforceWrites(dir, before, [], []);
    expect(result.violations).toEqual(["forbidden.ts"]);
    expect(result.rollbacks[0]?.outcome).toBe("rolled-back");

    const restored = await Bun.file(join(dir, "forbidden.ts")).text();
    expect(restored).toBe("original content\n");
  });

  test("protected_files wins even when the path also matches the writes: allowlist pattern is absent (protected blocks by default)", () => {
    initRepo(dir);
    git(["commit", "--allow-empty", "-q", "-m", "initial"], dir);

    const before = snapshotRepoState(dir);
    writeFileSync(join(dir, "secrets.env"), "TOKEN=abc\n");

    // Not named in writes:, and matches protected_files -> blocked & rolled back.
    const result = enforceWrites(dir, before, null, ["secrets.env"]);
    expect(result.violations).toEqual(["secrets.env"]);
    expect(result.allowed).toEqual([]);
    expect(existsSync(join(dir, "secrets.env"))).toBe(false);
  });

  test("writes: allowlist takes precedence over protected_files for the same path (explicit grant wins)", () => {
    initRepo(dir);
    git(["commit", "--allow-empty", "-q", "-m", "initial"], dir);

    const before = snapshotRepoState(dir);
    writeFileSync(join(dir, "secrets.env"), "TOKEN=abc\n");

    // Same path is both explicitly allowed AND protected -> allowed wins.
    const result = enforceWrites(dir, before, ["secrets.env"], ["secrets.env"]);
    expect(result.allowed).toEqual(["secrets.env"]);
    expect(result.violations).toEqual([]);
    expect(existsSync(join(dir, "secrets.env"))).toBe(true);
  });

  test("all writes allowed -> nothing rolled back, clean result", async () => {
    initRepo(dir);
    writeFileSync(join(dir, "a.ts"), "v1\n");
    git(["add", "."], dir);
    git(["commit", "-q", "-m", "initial"], dir);

    const before = snapshotRepoState(dir);
    writeFileSync(join(dir, "a.ts"), "v2\n");
    writeFileSync(join(dir, "b.ts"), "new\n");

    const result = enforceWrites(dir, before, null, []);

    expect(result.violations).toEqual([]);
    expect(result.rollbacks).toEqual([]);
    expect(result.allowed.sort()).toEqual(["a.ts", "b.ts"]);
    expect(result.clean).toBe(true);
    expect(existsSync(join(dir, "b.ts"))).toBe(true);
    const content = await Bun.file(join(dir, "a.ts")).text();
    expect(content).toBe("v2\n");
  });

  test("path already dirty before the agent ran is left as-is, not rolled back", async () => {
    initRepo(dir);
    writeFileSync(join(dir, "operator-dirty.ts"), "v1\n");
    git(["add", "."], dir);
    git(["commit", "-q", "-m", "initial"], dir);

    // Operator has uncommitted work BEFORE the agent runs.
    writeFileSync(join(dir, "operator-dirty.ts"), "operator's uncommitted edit\n");
    const before = snapshotRepoState(dir);

    // Agent further edits the already-dirty file without permission. Adds a
    // line (not just a same-line replacement) so `git diff --numstat`'s
    // insertion/deletion counts actually differ from `before`'s fingerprint
    // — numstat is not content-aware, so a same-line-count replacement of
    // an already-dirty file can fingerprint identically before and after
    // and wouldn't register as "touched" at all; that's a real limitation
    // inherited from upstream's own numstat-based snapshot, not something
    // this test is trying to exercise.
    writeFileSync(
      join(dir, "operator-dirty.ts"),
      "operator's edit, then agent edited more\nand added another line\n",
    );

    const result = enforceWrites(dir, before, [], []);
    expect(result.violations).toEqual(["operator-dirty.ts"]);
    expect(result.rollbacks[0]?.outcome).toBe("left-as-is");
    expect(result.clean).toBe(true);

    // Content is untouched by rollback (still the agent's further edit,
    // since this module refuses to discard an operator's own uncommitted
    // history on cleanup).
    const content = await Bun.file(join(dir, "operator-dirty.ts")).text();
    expect(content).toBe("operator's edit, then agent edited more\nand added another line\n");
  });

  test("M-082 regression: a review Step (fully read-only) that incidentally leaves a __pycache__/*.pyc behind is NOT flagged as a violation and the file is left in place", () => {
    initRepo(dir);
    git(["commit", "--allow-empty", "-q", "-m", "initial"], dir);

    const before = snapshotRepoState(dir);

    // Simulated incidental side effect of a read-only "review" Role actually
    // running `python3`/importing a module to verify the build's code works
    // — mirrors the real incident exactly (__pycache__/stack.cpython-
    // 311.pyc), not content the agent authored.
    spawnSync("mkdir", ["-p", join(dir, "__pycache__")]);
    writeFileSync(join(dir, "__pycache__", "stack.cpython-311.pyc"), "fake bytecode\n");

    // allowedWrites: [] matches the actual review Role config (writes:
    // none, fully read-only).
    const result = enforceWrites(dir, before, [], []);

    expect(result.violations).toEqual([]);
    expect(result.allowed).toEqual(["__pycache__/stack.cpython-311.pyc"]);
    expect(result.rollbacks).toEqual([]);
    expect(result.clean).toBe(true);
    // Left in place — not rolled back, since it was never a real violation.
    expect(existsSync(join(dir, "__pycache__", "stack.cpython-311.pyc"))).toBe(true);
  });

  test("agent reverts operator's pre-existing uncommitted work -> reported, not silently accepted", () => {
    initRepo(dir);
    writeFileSync(join(dir, "operator-dirty.ts"), "v1\n");
    git(["add", "."], dir);
    git(["commit", "-q", "-m", "initial"], dir);

    writeFileSync(join(dir, "operator-dirty.ts"), "operator's uncommitted edit\n");
    const before = snapshotRepoState(dir);

    // Agent runs `git checkout -- operator-dirty.ts`, discarding the
    // operator's uncommitted edit and returning the file to HEAD's content.
    git(["checkout", "--", "operator-dirty.ts"], dir);

    const result = enforceWrites(dir, before, [], []);
    expect(result.violations).toEqual(["operator-dirty.ts"]);
    expect(result.rollbacks[0]?.outcome).toBe("reverted-by-agent");
    expect(result.clean).toBe(true); // detection worked; content loss is inherent, not a tool failure
  });
});
