import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { currentBranchName, currentHeadSha } from "./stepArtifact.ts";

let dir: string;
let cwd: string;

function git(args: string[], cwd_: string): { stdout: string; status: number | null } {
  const result = spawnSync("git", args, { cwd: cwd_, encoding: "utf8" });
  return { stdout: String(result.stdout ?? ""), status: result.status };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-web-factory-stepartifact-test-"));
  cwd = join(dir, "repo");
  spawnSync("mkdir", ["-p", cwd]);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("currentHeadSha", () => {
  test("returns the real HEAD commit SHA in a git checkout with a commit", () => {
    git(["init", "-q"], cwd);
    git(["config", "user.email", "test@example.com"], cwd);
    git(["config", "user.name", "Test"], cwd);
    git(["commit", "--allow-empty", "-q", "-m", "init"], cwd);
    const expected = git(["rev-parse", "HEAD"], cwd).stdout.trim();

    expect(currentHeadSha(cwd)).toBe(expected);
  });

  test("reflects a NEW commit made after the first read — not a cached/stale value", () => {
    git(["init", "-q"], cwd);
    git(["config", "user.email", "test@example.com"], cwd);
    git(["config", "user.name", "Test"], cwd);
    git(["commit", "--allow-empty", "-q", "-m", "first"], cwd);
    const first = currentHeadSha(cwd);

    git(["commit", "--allow-empty", "-q", "-m", "second"], cwd);
    const second = currentHeadSha(cwd);

    expect(second).not.toBe(first);
    expect(second).toBe(git(["rev-parse", "HEAD"], cwd).stdout.trim());
  });

  test("returns null (never throws) for a directory that isn't a git checkout at all", () => {
    expect(currentHeadSha(cwd)).toBeNull();
  });

  test("returns null (never throws) for a git checkout with no commits yet", () => {
    git(["init", "-q"], cwd);
    expect(currentHeadSha(cwd)).toBeNull();
  });
});

describe("currentBranchName", () => {
  test("returns the real current branch name", () => {
    git(["init", "-q"], cwd);
    git(["config", "user.email", "test@example.com"], cwd);
    git(["config", "user.name", "Test"], cwd);
    git(["commit", "--allow-empty", "-q", "-m", "init"], cwd);
    git(["checkout", "-q", "-b", "pi-web-factory/adw_abc123"], cwd);

    expect(currentBranchName(cwd)).toBe("pi-web-factory/adw_abc123");
  });

  test("returns null (never throws) for a directory that isn't a git checkout at all", () => {
    expect(currentBranchName(cwd)).toBeNull();
  });

  test("returns null for a detached HEAD (not a real branch name)", () => {
    git(["init", "-q"], cwd);
    git(["config", "user.email", "test@example.com"], cwd);
    git(["config", "user.name", "Test"], cwd);
    git(["commit", "--allow-empty", "-q", "-m", "init"], cwd);
    const sha = git(["rev-parse", "HEAD"], cwd).stdout.trim();
    git(["checkout", "-q", sha], cwd); // detach HEAD

    expect(currentBranchName(cwd)).toBeNull();
  });
});
