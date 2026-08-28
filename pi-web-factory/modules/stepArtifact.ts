/**
 * stepArtifact.ts: "what did this Step actually accomplish" record — a
 * completed `agent` Step's real output (branch name, commit SHA, PR link
 * if one was opened), captured the moment that Step reaches a terminal
 * SUCCESS outcome (`workflow.ts`'s `runAgentStep`), not just at run end.
 *
 * Filed directly from a real incident: a `build` Step pushed real commits,
 * then the following `review` Step hit a `waitForCompletion` timeout and
 * failed the whole run — the run's own record had no artifact pointing
 * back at the build's real work, so a human looking at the failed run had
 * no visibility into what actually happened before the failure (the
 * pushed branch was only discoverable because the build agent happened to
 * push directly to origin on its own initiative).
 *
 * Deliberately narrow, matching this codebase's "one Workflow Run = one
 * worktree/branch" model (`worktree.ts`'s `branchNameFor`): every Step in a
 * run shares the SAME branch, so `branch` is constant across a run's Steps —
 * what actually varies, and is worth capturing PER STEP, is the commit SHA
 * `HEAD` pointed at the moment THAT Step finished (an agent Step commonly
 * commits its own work before returning its envelope). `prUrl` is always
 * null today (no code path in this codebase opens a PR yet) — the field
 * exists so a future auto-PR Step can populate it without a second schema
 * migration; `recordStepArtifact`'s caller is free to pass one in once
 * that exists.
 */

import { spawnSync } from "node:child_process";

/**
 * `spawnSync` blocks the ENTIRE event
 * loop synchronously until the child exits — a hung `git` process (a stuck
 * lock file, a wedged filesystem) would stall the whole pi-web-factory
 * process, not just the current Step, since these two helpers now run
 * unconditionally on every successful `agent` Step (`workflow.ts`'s
 * `runAgentStep`), a much higher call frequency than this codebase's other,
 * pre-existing `spawnSync("git", ...)` call sites (`worktree.ts`,
 * `permissions.ts`, `gates.ts` — each called once per phase/violation, not
 * once per successful Step). A plain `git rev-parse` against a local
 * checkout normally completes in milliseconds; a few seconds is generous
 * headroom, not a real functional constraint. `spawnSync`'s own `timeout`
 * option sends `SIGTERM` to the child and sets `result.error` (an
 * `ETIMEDOUT`-shaped Error) rather than a clean nonzero `status` — the
 * existing `try/catch` + `status !== 0` checks below already treat both
 * shapes identically (a timeout degrades to "artifact capture skipped",
 * same as any other git failure — never a process-wide freeze).
 */
const GIT_SPAWN_TIMEOUT_MS = 5_000;

export interface StepArtifact {
  /** The run's own branch (`worktree.ts`'s `branchNameFor(adwId)`) — constant across every Step in one Workflow Run. */
  branch: string | null;
  /** `HEAD`'s commit SHA in the Step's own cwd at the moment the Step finished, or null if it couldn't be read (e.g. no commits yet, not a git checkout). */
  commitSha: string | null;
  /** A PR URL, if one was opened for this run's branch — always null today (no auto-PR Step exists yet in this codebase); a forward-compatible slot for when one does. */
  prUrl: string | null;
}

/**
 * `git rev-parse HEAD` in `cwd` — the current commit SHA, or `null` on any
 * failure (not a git checkout, no commits yet, `git` not on PATH, or a
 * timeout — see `GIT_SPAWN_TIMEOUT_MS`). Never throws: an artifact-capture
 * best-effort helper must not fail an otherwise-successful Step, same
 * discipline `run.ts`'s own best-effort usage-snapshot fetch already
 * established (see that module's `runAgentPhase` doc comment).
 */
export function currentHeadSha(cwd: string): string | null {
  try {
    const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", timeout: GIT_SPAWN_TIMEOUT_MS });
    if (result.status !== 0) return null;
    const sha = result.stdout.trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

/**
 * `git rev-parse --abbrev-ref HEAD` in `cwd` — the current branch name, or
 * `null` on any failure (including a timeout — see `GIT_SPAWN_TIMEOUT_MS`).
 * Read fresh from the actual checkout rather than assumed from
 * `worktree.ts`'s `branchNameFor(adwId)` naming convention, because that
 * assumption does NOT hold for a resumed run: verified that `--session-id`
 * resume mints a brand-new `adwId` while reusing the
 * OLD worktree/branch — so `branchNameFor(newAdwId)` would name a branch
 * that was never actually created. Reading the real branch is correct in
 * both the fresh-run and resumed-run case, no special casing needed here.
 * Never throws — same best-effort discipline as `currentHeadSha`.
 */
export function currentBranchName(cwd: string): string | null {
  try {
    const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      timeout: GIT_SPAWN_TIMEOUT_MS,
    });
    if (result.status !== 0) return null;
    const branch = result.stdout.trim();
    return branch.length > 0 && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}
