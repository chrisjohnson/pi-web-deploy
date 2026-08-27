/**
 * worktree.ts: one git worktree per Workflow Run — M-071 card, Plan item 2.
 * Closes the design's long-standing "no branch-per-run isolation" gap
 * (`pi-web-adw-design.md` §0/§4/§6.4) by giving every run its own checkout
 * and branch, created via plain `git worktree add` (pi-web has no
 * worktree-creation API of its own — confirmed §6.2 — pi-web's UI/
 * `WorkspaceService` only *discovers* real worktrees after the fact).
 *
 * ── Naming convention ────────────────────────────────────────────────────
 * Both the worktree directory and its branch are named directly from the
 * run's own `adwId` (`adw_<12 lowercase hex chars>`, minted by `cli.ts`/
 * `planBuildTest.ts`) — the same id every trace-db row for this run is keyed
 * by (`tracer.ts`'s `sessions.adw_id`, `phases.adw_id`, `events.adw_id`).
 * One id, one lookup key, everywhere — a worktree directory or branch name
 * found on disk or in `git branch -a` traces straight back to its trace-db
 * rows with a single `grep`/`select ... where adw_id=?`, no separate mapping
 * table to keep in sync.
 *
 *   - Branch: `pi-web-factory/<adwId>` (e.g. `pi-web-factory/adw_a1b2c3d4e5f6`)
 *     — namespaced under `pi-web-factory/` so these branches are visibly
 *     machine-created in `git branch -a`/any GUI, distinct from a human's
 *     own feature branches, and trivially bulk-matchable
 *     (`git branch --list 'pi-web-factory/*'`) for a future cleanup sweep.
 *   - Directory: `<adwId>` alone, nested under a fixed subdirectory (see
 *     below) — the parent directory name already supplies the
 *     `pi-web-factory` namespacing, so repeating it in every leaf directory
 *     name would be redundant.
 *
 * ── Location: nested inside the project's own checkout, not a true sibling ─
 * The obvious-looking alternative — `<project-parent>/<project-name>-
 * worktrees/<adwId>/`, a true sibling directory outside the project's own
 * tree — was considered and rejected for a concrete, verified reason, not a
 * style preference: in the actual deployment this runs in
 * (`jmfederico-pi-web`'s container, `docker/docker-compose.yml`), a target
 * project is reached through exactly ONE bind mount
 * (`/home/chris/turnstone-workspace/printer-dashboard:/work` today) — there
 * is no bind mount, and no reason to add one per project, covering a
 * sibling directory OUTSIDE that mount's host path. A worktree created at
 * `/work/../printer-dashboard-worktrees/<adwId>` would resolve to a host
 * path the container simply cannot see. Nesting under the project's own
 * checkout (`<cwd>/.pi-web-factory-worktrees/<adwId>/`) stays entirely
 * inside the one mount that's guaranteed to exist for any project
 * pi-web-factory is pointed at — confirmed live 2026-08-04 (`git worktree
 * add` + pi-web's own `GET /projects/:id/workspaces` discovery both work
 * identically whether the worktree is nested or a true sibling; nesting is
 * the only one of the two that's actually reachable in this deployment).
 *
 * ── Keeping nested worktrees invisible to permissions.ts ────────────────
 * `permissions.ts`'s `snapshotRepoState`/`enforceWrites` diff the SAME repo
 * this worktree is nested inside (`opts.cwd`, per that module's own cwd-
 * scoped-by-design docstring) — an untracked `.pi-web-factory-worktrees/`
 * directory sitting inside the project tree would otherwise show up as an
 * untracked path on every single phase's before/after snapshot and get
 * rolled back (deleted) by `enforceWrites` as an unauthorized write, which
 * would be actively destructive here (deleting a worktree out from under
 * its own in-flight session). Two ways to hide a path from git's untracked-
 * file listing: `.gitignore` (tracked, committed, a footprint on every
 * target project) or `.git/info/exclude` (repo-local, NEVER committed, no
 * footprint on the project's own tracked files at all). This module uses
 * `.git/info/exclude` — confirmed live 2026-08-04: with an entry there,
 * neither `git diff HEAD --numstat` nor `git ls-files --others --exclude-
 * standard` (permissions.ts's own two snapshot queries) surface anything
 * under the excluded directory, so it's genuinely invisible to
 * `enforceWrites`, not just hidden from a casual `git status`. Written once,
 * idempotently (a repeat line is harmless but avoided), before the first
 * worktree is ever created for a given project.
 *
 * ── Isolation from a chain's own file operations ────────────────────────
 * Nesting does mean an agent with unrestricted (`writes: null`) file access
 * COULD in principle read/traverse into `.pi-web-factory-worktrees/` if it
 * went looking — no stronger sandbox exists here than anywhere else in this
 * codebase (`permissions.ts`'s own docstring: "`tools:` is a capability
 * list, not a sandbox"). In practice an agent is never told this path exists
 * (it's not part of any prompt), and `enforceWrites`'s allow/deny precedence
 * still applies to whatever it touches there the same as anywhere else in
 * the tree — the `.git/info/exclude` entry only controls whether an
 * UNTOUCHED worktree directory shows up as noise on every snapshot, not
 * whether writes into it are governed. That's an accepted, documented
 * tradeoff, not an oversight.
 *
 * ── Durable-mount pre-flight guard (M-109) ───────────────────────────────
 * The "reached through exactly ONE bind mount" assumption above (see
 * "Location") was written down but never actually ENFORCED — nothing
 * stopped a project from being registered/operated on at a path outside
 * that mount. That gap was real, not hypothetical: `pi-web-perf-metrics`
 * was registered at `/home/piweb/pi-web-perf-metrics` (container-overlay
 * storage, NOT the `/work` bind mount), pi-web-factory ran 4 real Workflow
 * Runs against it — including creating real worktrees/branches via this
 * very module — and every bit of that work was silently wiped on the next
 * container recreate. No error, no warning, right up until the directory
 * itself was gone (M-109 card, full incident detail).
 *
 * `createRunWorktree` now calls `assertDurableProjectPath` FIRST, before
 * doing anything else (including the pre-existing `.git` check) — a
 * project root outside every durable mount is refused outright (throws,
 * never warn-and-continue: a silent warning is exactly the failure mode
 * that let the incident above go unnoticed for 4 full runs). The allowlist
 * itself is read from `PI_WEB_FACTORY_DURABLE_MOUNTS` (comma-separated,
 * for future growth beyond the current single-mount deployment) rather
 * than hardcoding `/work` — this module has no business knowing today's
 * `docker-compose.yml` shape, and a second durable mount added later
 * (or a different deployment entirely) shouldn't need a code change here.
 * Deliberately does NOT default to `/home/piweb/.pi-web` even though that
 * path is also durable in this deployment — it's pi-web's own config dir,
 * never a valid project root, and silently allowing it would defeat the
 * point of an explicit allowlist. When the env var is unset entirely
 * (local dev, `bun test`, any environment with no fixed durable-mount
 * contract), the guard is a deliberate no-op — there is nothing to check
 * against, and refusing every project path in that case would just break
 * every test/dev invocation for no safety benefit.
 *
 * Written as its own small, separately-callable function (not inlined into
 * `createRunWorktree`) so a second pre-flight check can be added next to it
 * without restructuring — M-115 (a "real `.git` root" guard) is expected to
 * land here shortly after, as a sibling check run from the same call site.
 *
 * ── Real single-repo-root guard (M-115) ───────────────────────────────────
 * `createRunWorktree` already required `.git` to exist directly under
 * `projectPath` before this card (a bare `existsSync(join(projectPath,
 * ".git"))` check) — read closely, that logic is ALREADY the right shape: it
 * rejects `/work` itself (the whole bind mount, no `.git` of its own) exactly
 * as correctly as a project actually scoped to one real repo (`/work/<repo>`,
 * which does have `.git`). So M-115 does not change the underlying logic.
 * What it DOES fix: the bare message that check threw
 * (`"${projectPath} does not look like a git checkout (no .git found) —
 * cannot create a worktree"`) reads like a generic/incidental git-plumbing
 * failure — indistinguishable, to a human or an agent reading a stack trace,
 * from a typo'd path or an uninitialized repo. `assertRealRepoRoot` below
 * throws the SAME underlying condition with a message that names the actual
 * failure mode this card was filed from (a project path pointed at something
 * too broad to be a single repo, e.g. the `/work` mount root itself) as
 * plainly as `assertDurableProjectPath` names ITS failure mode — so a
 * `WorktreeError` thrown here is self-explanatory without needing to cross-
 * reference this card. `createRunWorktree` now calls this INSTEAD of the old
 * inline check (same pre-flight location, right after
 * `assertDurableProjectPath` — both guards answer "is this project path
 * legitimate to run a Workflow against", per this card's Plan).
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/** Subdirectory (relative to a project's main checkout) all run worktrees nest under. */
export const WORKTREE_SUBDIR = ".pi-web-factory-worktrees";

/** Branch namespace prefix — see module docstring. */
export const BRANCH_PREFIX = "pi-web-factory/";

export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeError";
  }
}

function git(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * Env var naming the allowlist of durable-mount roots a project path must
 * live under — comma-separated (e.g. `PI_WEB_FACTORY_DURABLE_MOUNTS=/work`),
 * so a future deployment with more than one durable mount doesn't need a
 * code change. See module docstring ("Durable-mount pre-flight guard") for
 * the incident this closes and why it's env-driven rather than hardcoded.
 */
export const DURABLE_MOUNTS_ENV_VAR = "PI_WEB_FACTORY_DURABLE_MOUNTS";

/**
 * Parses `PI_WEB_FACTORY_DURABLE_MOUNTS` into a list of absolute mount
 * roots — comma-separated, blank entries and surrounding whitespace
 * dropped. Returns `[]` when the env var is unset/empty, which callers
 * treat as "no allowlist configured, guard is a no-op" (see
 * `assertDurableProjectPath`).
 */
export function durableMountsFromEnv(): string[] {
  const raw = process.env[DURABLE_MOUNTS_ENV_VAR];
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Fails fast (throws `WorktreeError`) when `projectPath` does not live
 * under any configured durable mount — see module docstring ("Durable-mount
 * pre-flight guard", M-109) for the full incident/rationale. A no-op when
 * `PI_WEB_FACTORY_DURABLE_MOUNTS` is unset/empty (no allowlist configured
 * — e.g. local dev, `bun test`), by design.
 *
 * Checked with plain path-prefix matching against `mounts` as given (both
 * `projectPath` and each mount are expected to already be absolute,
 * resolved paths — callers pass `mainCheckoutPath`, which
 * `resolveMainCheckoutPath`/`realpathSync` already normalize). A mount
 * counts as covering `projectPath` when `projectPath` equals the mount or
 * is nested under it (`<mount>/...`) — a bare string-prefix check would
 * wrongly let `/work-other` pass a `/work` mount; this guards against that
 * with an explicit separator check.
 */
export function assertDurableProjectPath(projectPath: string, mounts: string[] = durableMountsFromEnv()): void {
  if (mounts.length === 0) return; // no allowlist configured — nothing to enforce

  const isCovered = mounts.some((mount) => projectPath === mount || projectPath.startsWith(mount.endsWith("/") ? mount : `${mount}/`));
  if (!isCovered) {
    throw new WorktreeError(
      `project path ${projectPath} is not under any durable mount (allowed: ${mounts.join(", ")}) — refusing to create a worktree here. ` +
        `A path outside every durable mount is wiped on the next container recreate, silently losing any worktree/branch created against it (M-109). ` +
        `Register this project under one of the allowed mount(s) instead, or add its real durable mount to ${DURABLE_MOUNTS_ENV_VAR}.`,
    );
  }
}

/**
 * Fails fast (throws `WorktreeError`) when `projectPath` is not a real,
 * single-repo root — i.e. does not have its own `.git` directly at that
 * path. See module docstring ("Real single-repo-root guard", M-115) for why
 * this exists as its own named function rather than staying an inline
 * `existsSync` check: the underlying condition is unchanged from
 * `createRunWorktree`'s original bare check, but the error message here is
 * explicit about the actual failure mode (a project path too broad to be one
 * repo — e.g. `/work`, the whole bind mount, which has no `.git` of its own)
 * rather than reading like a generic/incidental git-plumbing failure.
 */
export function assertRealRepoRoot(projectPath: string): void {
  if (!existsSync(join(projectPath, ".git"))) {
    throw new WorktreeError(
      `${projectPath} is not a real single-repo root — it has no .git directly at that path, so it cannot be sandboxed to one repo's worktree/branch operations. ` +
        `This is refused even if ${projectPath} exists and is readable (e.g. a bind-mount root like /work containing many projects underneath it is exactly this case: the mount itself has no .git of its own even though real repos live inside it). ` +
        `Point --project at the specific repo directory (the one with its own .git), not a parent directory containing it.`,
    );
  }
}

/** Branch name for a given run id — `pi-web-factory/<adwId>`. */
export function branchNameFor(adwId: string): string {
  return `${BRANCH_PREFIX}${adwId}`;
}

/** Worktree directory (absolute path) for a given run id, nested under `projectPath`. */
export function worktreePathFor(projectPath: string, adwId: string): string {
  return join(projectPath, WORKTREE_SUBDIR, adwId);
}

/**
 * Ensures `WORKTREE_SUBDIR` is excluded from `projectPath`'s own git status
 * (via `.git/info/exclude`, never `.gitignore` — see module docstring),
 * idempotently. Safe to call before every worktree creation; a no-op if the
 * entry is already present.
 */
export function ensureWorktreeDirExcluded(projectPath: string): void {
  const excludePath = join(projectPath, ".git", "info", "exclude");
  const entry = `${WORKTREE_SUBDIR}/`;

  let existing = "";
  if (existsSync(excludePath)) {
    existing = readFileSync(excludePath, "utf8");
    if (existing.split("\n").some((line) => line.trim() === entry)) return; // already present
  } else {
    // `.git/info/` always exists for a real repo (created by `git init`);
    // this mkdir is defensive only, in case some unusual git layout omits it.
    mkdirSync(join(projectPath, ".git", "info"), { recursive: true });
  }

  const needsNewline = existing.length > 0 && !existing.endsWith("\n");
  writeFileSync(excludePath, `${existing}${needsNewline ? "\n" : ""}${entry}\n`);
}

export interface CreateRunWorktreeResult {
  /** Absolute path to the new worktree — use as the chain's `cwd`. */
  path: string;
  /** Branch created for this worktree. */
  branch: string;
}

/**
 * Creates one worktree for a Workflow Run: `git worktree add <path> -b
 * <branch>` at `worktreePathFor(projectPath, adwId)` /
 * `branchNameFor(adwId)`, off `projectPath`'s current `HEAD` (git's own
 * default base for `-b` with no explicit start-point). Ensures the
 * containing subdirectory is excluded first (see
 * `ensureWorktreeDirExcluded`).
 *
 * Throws `WorktreeError` (never a bare `git` stderr dump without context) on
 * any failure — including the case where `adwId`'s worktree/branch already
 * exists (a caller minting a fresh `adwId` per run, as `cli.ts`/
 * `planBuildTest.ts` both do, should never hit this in practice; a
 * `--session-id`-resume run reuses the SAME worktree rather than calling
 * this again — see `chains/planBuildTest.ts`'s wiring).
 *
 * Runs `assertDurableProjectPath` and `assertRealRepoRoot` FIRST, ahead of
 * every other check, in that order — see module docstring ("Durable-mount
 * pre-flight guard", M-109, and "Real single-repo-root guard", M-115): a
 * project path outside every configured durable mount, or one that is not a
 * real single-repo root (no `.git` of its own — e.g. `/work` itself), must
 * both be refused before any worktree/branch gets created, not after.
 */
export function createRunWorktree(projectPath: string, adwId: string): CreateRunWorktreeResult {
  assertDurableProjectPath(projectPath);
  assertRealRepoRoot(projectPath);

  ensureWorktreeDirExcluded(projectPath);

  const path = worktreePathFor(projectPath, adwId);
  const branch = branchNameFor(adwId);

  if (existsSync(path)) {
    throw new WorktreeError(`worktree path ${path} already exists — refusing to overwrite (adwId collision?)`);
  }

  const result = git(projectPath, ["worktree", "add", path, "-b", branch]);
  if (result.status !== 0) {
    throw new WorktreeError(`git worktree add ${path} -b ${branch} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }

  return { path, branch };
}

export type WorktreeRemovalOutcome =
  | { status: "removed" }
  | { status: "skipped"; reason: string }
  | { status: "failed"; detail: string };

/**
 * Removes a run's worktree — `git worktree remove [--force] <path>` — run
 * from `projectPath` (the main checkout), never from inside the worktree
 * being removed. Does NOT delete the branch (`branchNameFor(adwId)` is left
 * behind on purpose — the branch is the durable, cheap-to-keep artifact;
 * the worktree's checked-out files are the disposable, expensive-to-keep
 * one).
 *
 * NOT called anywhere in this codebase's own chain wiring (`planBuildTest.ts`
 * deliberately never calls this — see that file's own "cleanup policy"
 * comment for the full reasoning: worktrees are kept around after a run for
 * post-hoc inspection, not auto-removed). Exported/tested here for a future
 * cleanup sweep (a separate, explicit tool — not part of this card's scope)
 * or for a caller with a genuinely different policy need.
 *
 * Never throws — a cleanup step failing must not mask/replace the chain's
 * own result. Returns a discriminated outcome instead:
 *   - `"removed"` — worktree gone.
 *   - `"skipped"` — path didn't exist (already removed, or never created);
 *     not an error, just nothing to do.
 *   - `"failed"` — `git worktree remove` itself failed (e.g. uncommitted
 *     changes and `force` was false) — surfaced, never swallowed silently.
 */
export function removeRunWorktree(projectPath: string, worktreePath: string, force: boolean): WorktreeRemovalOutcome {
  if (!existsSync(worktreePath)) {
    return { status: "skipped", reason: "worktree path does not exist" };
  }

  const args = ["worktree", "remove"];
  if (force) args.push("--force");
  args.push(worktreePath);

  const result = git(projectPath, args);
  if (result.status !== 0) {
    return { status: "failed", detail: result.stderr.trim() || result.stdout.trim() || "git worktree remove failed" };
  }
  return { status: "removed" };
}

/** Random suffix helper, exported for tests that need a throwaway adwId shape without pulling in the CLI's own minting logic. */
export function randomAdwIdForTests(): string {
  return `adw_${randomBytes(6).toString("hex")}`;
}

/**
 * Resolves the MAIN checkout path for whatever git working tree `cwd` is —
 * `cwd` itself, if it already IS the main checkout, or the main checkout's
 * path if `cwd` is a linked worktree (nested or not). Needed because
 * `PlanBuildTestOptions.cwd` means two different things depending on
 * whether a run is fresh or resumed (see that file's `sessionId` doc
 * comment): on a resume, `cwd` is often already a worktree path, and
 * `ensureProjectRegistered`/`resolveWorkspaceId` both need the PROJECT's
 * main path (what pi-web's own Project registry and `git worktree list`
 * are keyed by), not the worktree's own path, to resolve the right
 * `projectId`/`workspaceId` — registering a worktree path itself as its own
 * separate pi-web Project would be wrong (confirmed live 2026-08-04: a
 * worktree's own path is never equal to any Project's registered `path` in
 * pi-web's data model — `WorkspaceService.list()` is only ever called with
 * the PROJECT's path, and returns per-worktree entries FROM that call, it
 * never treats a worktree as a project of its own).
 *
 * `git rev-parse --git-common-dir` returns `<mainCheckout>/.git` from ANY
 * worktree of that repo, including the main one itself — but git is
 * inconsistent about WHICH form depending on which of those two cases it
 * is: from a linked worktree it returns an absolute, symlink-resolved path;
 * from the main checkout itself it returns a bare relative `.git` (resolved
 * here against the CALLER's own, possibly symlinked, `cwd` — e.g. macOS's
 * `/tmp` -> `/private/tmp`). Confirmed live 2026-08-04 (both forms, from a
 * real repo and a real nested worktree). `realpathSync` on the final result
 * normalizes both cases to the same real path regardless of which form git
 * happened to return, so this function's output is stable no matter which
 * of the two `cwd` might be.
 */
export function resolveMainCheckoutPath(cwd: string): string {
  const result = git(cwd, ["rev-parse", "--git-common-dir"]);
  if (result.status !== 0) {
    throw new WorktreeError(`could not resolve git-common-dir for ${cwd}: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  const gitCommonDir = result.stdout.trim();
  const absoluteGitDir = gitCommonDir.startsWith("/") ? gitCommonDir : join(cwd, gitCommonDir);
  // absoluteGitDir is always "<mainCheckout>/.git" (git-common-dir names the
  // real .git directory, never a bare repo root) — strip exactly that suffix.
  if (!absoluteGitDir.endsWith("/.git")) {
    throw new WorktreeError(`unexpected git-common-dir shape for ${cwd}: ${gitCommonDir}`);
  }
  return realpathSync(absoluteGitDir.slice(0, -"/.git".length));
}
