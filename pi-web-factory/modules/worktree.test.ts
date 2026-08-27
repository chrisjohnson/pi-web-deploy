/**
 * Unit tests for worktree.ts against REAL scratch git repos (same pattern
 * permissions.test.ts already established) — worktree creation/removal is
 * genuinely git-mechanical, not worth mocking `child_process` for.
 */

import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRANCH_PREFIX,
  DURABLE_MOUNTS_ENV_VAR,
  WORKTREE_SUBDIR,
  WorktreeError,
  assertDurableProjectPath,
  assertRealRepoRoot,
  branchNameFor,
  createRunWorktree,
  durableMountsFromEnv,
  ensureWorktreeDirExcluded,
  removeRunWorktree,
  resolveMainCheckoutPath,
  worktreePathFor,
} from "./worktree.ts";
import { snapshotRepoState, changedPaths } from "./permissions.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-web-factory-worktree-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function git(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function initRepo(cwd: string): void {
  git(["init", "-q"], cwd);
  git(["config", "user.email", "test@example.com"], cwd);
  git(["config", "user.name", "Test"], cwd);
  git(["commit", "--allow-empty", "-q", "-m", "init"], cwd);
}

// ── naming convention ────────────────────────────────────────────────────

describe("branchNameFor / worktreePathFor", () => {
  test("branch is namespaced under pi-web-factory/ + the adwId", () => {
    expect(branchNameFor("adw_a1b2c3d4e5f6")).toBe("pi-web-factory/adw_a1b2c3d4e5f6");
    expect(BRANCH_PREFIX).toBe("pi-web-factory/");
  });

  test("worktree path nests the adwId under the fixed subdirectory, inside the project path", () => {
    const path = worktreePathFor("/tmp/my-project", "adw_a1b2c3d4e5f6");
    expect(path).toBe(join("/tmp/my-project", WORKTREE_SUBDIR, "adw_a1b2c3d4e5f6"));
  });
});

// ── ensureWorktreeDirExcluded ────────────────────────────────────────────

describe("ensureWorktreeDirExcluded", () => {
  test("adds the worktree subdir to .git/info/exclude, never .gitignore", () => {
    initRepo(dir);
    ensureWorktreeDirExcluded(dir);

    const exclude = readFileSync(join(dir, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain(`${WORKTREE_SUBDIR}/`);
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
  });

  test("is idempotent — calling twice does not duplicate the entry", () => {
    initRepo(dir);
    ensureWorktreeDirExcluded(dir);
    ensureWorktreeDirExcluded(dir);

    const exclude = readFileSync(join(dir, ".git", "info", "exclude"), "utf8");
    const occurrences = exclude.split("\n").filter((line) => line.trim() === `${WORKTREE_SUBDIR}/`).length;
    expect(occurrences).toBe(1);
  });

  test("preserves any pre-existing content in .git/info/exclude", () => {
    initRepo(dir);
    writeFileSync(join(dir, ".git", "info", "exclude"), "*.tmp\n");
    ensureWorktreeDirExcluded(dir);

    const exclude = readFileSync(join(dir, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("*.tmp");
    expect(exclude).toContain(`${WORKTREE_SUBDIR}/`);
  });

  test("the excluded worktree dir is genuinely invisible to permissions.ts's own snapshot (git diff + ls-files --others)", () => {
    initRepo(dir);
    ensureWorktreeDirExcluded(dir);

    const before = snapshotRepoState(dir);
    const worktree = createRunWorktree(dir, "adw_snapshottest01");
    void worktree;
    const after = snapshotRepoState(dir);

    // The worktree directory (and anything inside it) must not show up as a
    // changed path at all — this is the entire point of using
    // .git/info/exclude instead of leaving it untracked-and-visible.
    expect(changedPaths(before, after)).toEqual([]);
  });
});

// ── createRunWorktree ────────────────────────────────────────────────────

describe("createRunWorktree", () => {
  test("creates a real worktree at the documented path, on the documented branch", () => {
    initRepo(dir);
    const result = createRunWorktree(dir, "adw_createtest01");

    expect(result.path).toBe(worktreePathFor(dir, "adw_createtest01"));
    expect(result.branch).toBe("pi-web-factory/adw_createtest01");
    expect(existsSync(result.path)).toBe(true);
    expect(existsSync(join(result.path, ".git"))).toBe(true); // linked worktree marker (a file, not a dir)

    const branchList = git(["branch", "--list", "pi-web-factory/adw_createtest01"], dir).stdout;
    expect(branchList).toContain("pi-web-factory/adw_createtest01");
  });

  test("real git worktree list confirms both the main and new worktree", () => {
    initRepo(dir);
    const result = createRunWorktree(dir, "adw_listtest01");

    const listing = git(["worktree", "list", "--porcelain"], dir).stdout;
    expect(listing).toContain(dir);
    expect(listing).toContain(result.path);
  });

  test("throws WorktreeError when cwd is not a git checkout", () => {
    expect(() => createRunWorktree(dir, "adw_notarepo01")).toThrow(WorktreeError);
  });

  test("the not-a-git-checkout error is the explicit real-repo-root message (M-115), not a generic git-plumbing failure", () => {
    expect(() => createRunWorktree(dir, "adw_notarepo02")).toThrow(/not a real single-repo root/);
  });

  test("throws WorktreeError (not a bare git failure) when the worktree path already exists", () => {
    initRepo(dir);
    createRunWorktree(dir, "adw_duplicate01");
    expect(() => createRunWorktree(dir, "adw_duplicate01")).toThrow(WorktreeError);
  });

  test("ensures the exclude entry exists even before this repo ever had one written by pi-web-factory", () => {
    initRepo(dir);
    // `git init` itself already creates .git/info/exclude with template
    // content (confirmed: real git behavior, not something to assert away)
    // — what matters is OUR entry isn't there yet, and is added.
    const before = readFileSync(join(dir, ".git", "info", "exclude"), "utf8");
    expect(before).not.toContain(WORKTREE_SUBDIR);
    createRunWorktree(dir, "adw_firstexclude01");
    const exclude = readFileSync(join(dir, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain(`${WORKTREE_SUBDIR}/`);
  });
});

// ── durable-mount pre-flight guard (M-109) ──────────────────────────────

describe("durableMountsFromEnv", () => {
  const original = process.env[DURABLE_MOUNTS_ENV_VAR];
  afterEach(() => {
    if (original === undefined) delete process.env[DURABLE_MOUNTS_ENV_VAR];
    else process.env[DURABLE_MOUNTS_ENV_VAR] = original;
  });

  test("returns [] when unset", () => {
    delete process.env[DURABLE_MOUNTS_ENV_VAR];
    expect(durableMountsFromEnv()).toEqual([]);
  });

  test("returns [] when set to an empty string", () => {
    process.env[DURABLE_MOUNTS_ENV_VAR] = "";
    expect(durableMountsFromEnv()).toEqual([]);
  });

  test("splits on commas, trims whitespace, drops blank entries", () => {
    process.env[DURABLE_MOUNTS_ENV_VAR] = "/work, /other , ,/third";
    expect(durableMountsFromEnv()).toEqual(["/work", "/other", "/third"]);
  });
});

describe("assertDurableProjectPath", () => {
  test("is a no-op when no mounts are configured (empty allowlist)", () => {
    expect(() => assertDurableProjectPath("/anywhere/at/all", [])).not.toThrow();
  });

  test("passes when the path IS the mount root exactly", () => {
    expect(() => assertDurableProjectPath("/work", ["/work"])).not.toThrow();
  });

  test("passes when the path is nested under a configured mount", () => {
    expect(() => assertDurableProjectPath("/work/my-project", ["/work"])).not.toThrow();
  });

  test("passes when any one of several configured mounts covers the path", () => {
    expect(() => assertDurableProjectPath("/second/my-project", ["/work", "/second"])).not.toThrow();
  });

  test("throws WorktreeError, naming the offending path and the allowed mounts, when the path is outside every mount", () => {
    expect(() => assertDurableProjectPath("/home/piweb/pi-web-perf-metrics", ["/work"])).toThrow(WorktreeError);
    try {
      assertDurableProjectPath("/home/piweb/pi-web-perf-metrics", ["/work"]);
      throw new Error("expected assertDurableProjectPath to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WorktreeError);
      expect((err as Error).message).toContain("/home/piweb/pi-web-perf-metrics");
      expect((err as Error).message).toContain("/work");
    }
  });

  test("does NOT treat a sibling directory with a shared string prefix as covered (/work-other vs /work)", () => {
    expect(() => assertDurableProjectPath("/work-other/my-project", ["/work"])).toThrow(WorktreeError);
  });

  test("never allows the pi-web config dir even though it is also durable in this deployment — it must be passed explicitly, never defaulted", () => {
    expect(() => assertDurableProjectPath("/home/piweb/.pi-web", ["/work"])).toThrow(WorktreeError);
  });
});

describe("createRunWorktree — durable-mount enforcement", () => {
  const original = process.env[DURABLE_MOUNTS_ENV_VAR];
  afterEach(() => {
    if (original === undefined) delete process.env[DURABLE_MOUNTS_ENV_VAR];
    else process.env[DURABLE_MOUNTS_ENV_VAR] = original;
  });

  test("rejects a project path outside the configured durable mount BEFORE creating any worktree or branch", () => {
    initRepo(dir);
    process.env[DURABLE_MOUNTS_ENV_VAR] = "/some/other/durable/mount";

    expect(() => createRunWorktree(dir, "adw_durabletest01")).toThrow(WorktreeError);

    // Nothing was created — no worktree directory, no branch.
    expect(existsSync(worktreePathFor(dir, "adw_durabletest01"))).toBe(false);
    const branchList = git(["branch", "--list", "pi-web-factory/adw_durabletest01"], dir).stdout;
    expect(branchList).toBe("");
  });

  test("still works exactly as before when the project path IS under the configured durable mount", () => {
    initRepo(dir);
    process.env[DURABLE_MOUNTS_ENV_VAR] = dir;

    const result = createRunWorktree(dir, "adw_durabletest02");
    expect(existsSync(result.path)).toBe(true);
    expect(result.branch).toBe("pi-web-factory/adw_durabletest02");
  });

  test("still works exactly as before when the env var is unset (no allowlist configured)", () => {
    initRepo(dir);
    delete process.env[DURABLE_MOUNTS_ENV_VAR];

    const result = createRunWorktree(dir, "adw_durabletest03");
    expect(existsSync(result.path)).toBe(true);
  });
});

describe("assertRealRepoRoot (M-115)", () => {
  test("passes silently for a real repo root (.git directly present)", () => {
    initRepo(dir);
    expect(() => assertRealRepoRoot(dir)).not.toThrow();
  });

  test("throws for a directory with no .git of its own, even if real repos live underneath it", () => {
    // Models the /work case from the card: the bind-mount root itself has no
    // .git, even though real, valid projects (e.g. /work/some-project) are
    // nested inside it — assertRealRepoRoot must reject the ROOT, not defer
    // to whatever repos happen to exist somewhere below it.
    const nestedRepo = join(dir, "some-project");
    mkdirSync(nestedRepo, { recursive: true });
    initRepo(nestedRepo);

    expect(() => assertRealRepoRoot(dir)).toThrow(WorktreeError);
    expect(() => assertRealRepoRoot(dir)).toThrow(/not a real single-repo root/);
    // The nested repo itself is still a valid root.
    expect(() => assertRealRepoRoot(nestedRepo)).not.toThrow();
  });

  test("throws for a path that doesn't exist at all", () => {
    expect(() => assertRealRepoRoot(join(dir, "does-not-exist"))).toThrow(WorktreeError);
  });
});

// ── removeRunWorktree ────────────────────────────────────────────────────

describe("removeRunWorktree", () => {
  test("removes a clean worktree successfully", () => {
    initRepo(dir);
    const created = createRunWorktree(dir, "adw_removetest01");
    const outcome = removeRunWorktree(dir, created.path, false);

    expect(outcome.status).toBe("removed");
    expect(existsSync(created.path)).toBe(false);
  });

  test("returns skipped (not an error) when the path does not exist", () => {
    initRepo(dir);
    const outcome = removeRunWorktree(dir, join(dir, WORKTREE_SUBDIR, "adw_never_created"), false);
    expect(outcome.status).toBe("skipped");
  });

  test("fails (without force) on a worktree with uncommitted changes, and never throws", () => {
    initRepo(dir);
    const created = createRunWorktree(dir, "adw_dirtytest01");
    writeFileSync(join(created.path, "uncommitted.txt"), "dirty\n");

    const outcome = removeRunWorktree(dir, created.path, false);
    expect(outcome.status).toBe("failed");
    expect(existsSync(created.path)).toBe(true); // left in place, not silently destroyed
  });

  test("force removes a worktree with uncommitted changes", () => {
    initRepo(dir);
    const created = createRunWorktree(dir, "adw_forcetest01");
    writeFileSync(join(created.path, "uncommitted.txt"), "dirty\n");

    const outcome = removeRunWorktree(dir, created.path, true);
    expect(outcome.status).toBe("removed");
    expect(existsSync(created.path)).toBe(false);
  });

  test("does NOT delete the branch — only the checkout", () => {
    initRepo(dir);
    const created = createRunWorktree(dir, "adw_branchsurvives01");
    removeRunWorktree(dir, created.path, false);

    const branchList = git(["branch", "--list", created.branch], dir).stdout;
    expect(branchList).toContain(created.branch);
  });
});

// ── resolveMainCheckoutPath ──────────────────────────────────────────────

describe("resolveMainCheckoutPath", () => {
  test("returns the SAME real path resolveMainCheckoutPath itself resolves for the main checkout, when called from the main checkout", () => {
    initRepo(dir);
    // git's own --show-toplevel is the ground truth for "the real, resolved
    // main checkout path" (macOS /tmp is often a symlink to /private/tmp) —
    // compare against THAT rather than mkdtempSync's possibly-unresolved
    // `dir`, and confirm resolveMainCheckoutPath agrees with it.
    const realDir = git(["rev-parse", "--show-toplevel"], dir).stdout.trim();
    expect(resolveMainCheckoutPath(dir)).toBe(realDir);
  });

  test("resolves back to the main checkout from a linked worktree's path, including a NESTED one", () => {
    initRepo(dir);
    const mainResolved = resolveMainCheckoutPath(dir);
    const created = createRunWorktree(dir, "adw_resolvetest01");

    expect(resolveMainCheckoutPath(created.path)).toBe(mainResolved);
  });

  test("throws WorktreeError when cwd is not a git repository at all", () => {
    expect(() => resolveMainCheckoutPath(dir)).toThrow(WorktreeError);
  });
});
