/**
 * Permissions: TS port of upstream SSSF's `adws/adw_modules/permissions.py`.
 *
 * What an agent may CHANGE, enforced in code after the fact. `tools:` is a
 * capability list, not a sandbox, and two holes make it unenforceable on its
 * own:
 *
 *   - `bash` runs anything. A builder handed bash to run a test suite can
 *     also run `git checkout adws/` — discarding uncommitted work that was
 *     never its business to touch.
 *   - `write` reaches any path, not just the one report file an agent was
 *     given it for.
 *
 * So permission is verified the way every other claim in this system is —
 * after the fact, against the repo itself. `snapshotRepoState()` fingerprints
 * the working tree's change-set before an agent runs; `enforceWrites()`
 * compares it afterwards and rolls back anything outside the allowlist.
 *
 * Comparing change-sets, rather than watching for writes, is what catches a
 * `git checkout`/revert: a path that was modified before the agent ran and is
 * clean afterwards has been reverted, and a reversion is a modification.
 * Appearing, disappearing, and changing all count.
 *
 * This is cwd-scoped by design (per the M-064 card and design doc §3.1): the
 * caller passes the target PROJECT's working tree, not pi-web-factory's own
 * directory, since one factory instance drives phases across many projects.
 *
 * ── Default-exempt incidental artifacts (M-082) ───────────────────────────
 * `isWritePermitted` also checks a small, hardcoded `DEFAULT_EXEMPT_ARTIFACTS`
 * list (see that constant's own doc comment) ahead of `writes:`/
 * `protectedFiles` entirely: well-known, tool-generated paths (`__pycache__/`,
 * `*.pyc`, `.pytest_cache/`, etc.) that a read-only or write-restricted
 * Role's own legitimate tool use (e.g. running `python3` to verify code
 * actually works) leaves behind as a side effect, never as a content
 * decision. Found live: a `review` Step (writes: none) tripped
 * PERMISSIONS-VIOLATION on `__pycache__/stack.cpython-311.pyc` from
 * verifying, not authoring, code. Deliberately NOT reliance on the target
 * repo's own `.gitignore` alone (a fresh/minimal/non-Python-aware repo's
 * `.gitignore` won't cover this — confirmed this is exactly what the
 * incident repo hit) and deliberately NOT a per-project config option
 * (`config.ts`'s `ProjectConfigFileSchema` is scoped to test/typecheck/lint
 * commands, wrong fit for a factory-internal enforcement exemption).
 */

import { spawnSync } from "node:child_process";
import { unlinkSync } from "node:fs";
import { join } from "node:path";

// ── snapshot ─────────────────────────────────────────────────────────────

/**
 * Fingerprint of every path the working tree currently differs on, keyed by
 * path. Tracked files carry their `git diff --numstat` counts (so an edit to
 * an already-dirty file still registers as a change on top of whatever was
 * already there); untracked files are fingerprinted as the literal string
 * `"untracked"`.
 *
 * One upstream tier deliberately NOT ported: `permissions.py`'s
 * `always_writable(cfg)` exempts the agent's own `data_dir` (e.g.
 * `adws/adw_data/`) ahead of the `writes:` check, because upstream writes
 * each agent's report/handoff files INTO the target repo's working tree and
 * that directory must stay writable no matter what `writes:` says. Upstream
 * is explicit that this exemption is NOT allowed to depend on a gitignore
 * entry, since "an agent's ability to record its work must not hang on a
 * gitignore entry that someone can delete." This port has no equivalent
 * need: pi-web-factory's own session/trace state lives entirely outside the
 * target project's cwd by design (design doc §2, "Trace/config storage must
 * live outside any project repo too") — an agent's envelope is its final
 * chat message, fetched via `GET /messages`, never a file it writes into
 * the target repo. If a future card ever has pi-web-factory ask an agent to
 * write a report file INTO the target repo, revisit this — do not rely on
 * gitignore for that case either, upstream's reasoning above still applies.
 */
export type RepoSnapshot = Record<string, string>;

function gitOutput(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return result.status === 0 ? (result.stdout ?? "") : "";
}

/** Snapshot the repo at `cwd` right before an agent call. */
export function snapshotRepoState(cwd: string): RepoSnapshot {
  const fingerprints: RepoSnapshot = {};

  for (const line of gitOutput(cwd, ["diff", "HEAD", "--numstat"]).split("\n")) {
    if (!line.trim()) continue;
    const fields = line.split("\t");
    if (fields.length >= 3) {
      const path = fields[fields.length - 1]!.trim();
      fingerprints[path] = `${fields[0]},${fields[1]}`;
    }
  }

  for (const path of gitOutput(cwd, ["ls-files", "--others", "--exclude-standard"]).split("\n")) {
    const trimmed = path.trim();
    if (trimmed) fingerprints[trimmed] = "untracked";
  }

  return fingerprints;
}

/** Every path whose state differs between two snapshots — appeared, vanished, or was rewritten. */
export function changedPaths(before: RepoSnapshot, after: RepoSnapshot): string[] {
  const all = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const p of all) {
    if (before[p] !== after[p]) changed.push(p);
  }
  return changed.sort();
}

// ── glob-aware matching ─────────────────────────────────────────────────

/**
 * Translate a `writes:`/`protected_files` pattern to a regex, matching
 * upstream's own translator exactly: `*` stops at a path separator, `**`
 * crosses directories, `?` matches one non-separator character. A plain
 * `fnmatch` would let `*` cross `/`, which would quietly widen every
 * pattern (`adws/adw_*.py` would then also match
 * `adws/adw_data/sessions/x/y.py`).
 */
function globToRegex(pattern: string): RegExp {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i];
    if (pattern.startsWith("**", i)) {
      out += ".*";
      i += 2;
    } else if (char === "*") {
      out += "[^/]*";
      i += 1;
    } else if (char === "?") {
      out += "[^/]";
      i += 1;
    } else {
      out += char!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

function matchesPattern(path: string, pattern: string): boolean {
  if (pattern.endsWith("/")) return path.startsWith(pattern); // directory prefix
  if (pattern.includes("*") || pattern.includes("?")) return globToRegex(pattern).test(path);
  return path === pattern;
}

// ── permission decision ─────────────────────────────────────────────────

/**
 * Default-exempt patterns: incidental verification/build artifacts a
 * read-only or write-restricted Role's own tool use (running a test,
 * importing a module to check it works) commonly leaves behind, that are
 * never meaningful CONTENT changes an agent authored. Checked ahead of
 * protectedFiles/writes — same "naming a path is what unlocks it" spirit
 * as the writes: allowlist, just an always-on list instead of a per-Role
 * one. Uses the same globToRegex/matchesPattern machinery as writes:/
 * protectedFiles (directory-prefix trailing "/" semantics included).
 *
 * M-082: found live when a `review` Step (writes: none, deliberately
 * read-only) tripped PERMISSIONS-VIOLATION on `__pycache__/stack.cpython-
 * 311.pyc` — the incidental side effect of legitimately running `python3`
 * to verify the build's code works, not content the agent authored.
 * `snapshotRepoState`'s `git ls-files --others --exclude-standard` already
 * respects a target repo's own .gitignore (confirmed by direct execution)
 * — the gap is a fresh/minimal/non-Python-aware target repo whose
 * .gitignore doesn't cover this, exactly the scenario the incident hit.
 * Scoped conservatively to well-known, tool-generated, never-hand-authored
 * paths (same bar as .gitignore's own community-standard templates) — do
 * not add broader patterns (e.g. generic dist/build/) without a real
 * second incident motivating them.
 *
 * Each artifact type gets a bare (repo-root) form AND a double-star-
 * prefixed nested form (no bare trailing slash on the nested form) — NOT a
 * double-star-prefixed pattern that ALSO ends in a bare trailing slash,
 * which is a no-op: verified by direct execution that `matchesPattern`'s
 * directory-prefix branch (pattern ends with a slash implies a plain
 * path.startsWith(pattern) check) treats a double-star-slash-name-slash
 * pattern as a literal string, never glob-expanding the leading double-star
 * at all, so that form can never match anything. The bare form only
 * matches at repo root (changedPaths returns repo-root-relative paths);
 * the double-star-prefixed form with NO trailing bare slash (so it takes
 * globToRegex's regex branch instead) is what covers a NESTED occurrence
 * in a subdirectory.
 */
export const DEFAULT_EXEMPT_ARTIFACTS: string[] = [
  "__pycache__/", "**/__pycache__/**",
  "*.pyc", "**/*.pyc",
  "*.pyo", "**/*.pyo",
  ".pytest_cache/", "**/.pytest_cache/**",
  ".mypy_cache/", "**/.mypy_cache/**",
  ".ruff_cache/", "**/.ruff_cache/**",
  "node_modules/.cache/", "**/node_modules/.cache/**",
  ".next/cache/", "**/.next/cache/**",
  "*.class", "**/*.class",
  ".DS_Store", "**/.DS_Store",
];

/**
 * Precedence, matching upstream `permitted()` exactly, plus one new tier
 * ahead of it (M-082):
 *   0. `DEFAULT_EXEMPT_ARTIFACTS` — an incidental verification/build
 *      artifact never even counts as "touched" in spirit, regardless of
 *      what a Role's own `writes:`/`protectedFiles` say (opposite
 *      precedence from writes: vs protectedFiles below — an exempt
 *      artifact was never a content decision the agent made).
 *   1. `writes:` allowlist — naming a path here is what unlocks it, even if
 *      it also matches `protectedFiles`. This is upstream's own precedence
 *      (`permissions.py:127-135`: the `writes` check runs before the
 *      `protected_files` check), not a guess: an agent explicitly told it
 *      may touch a path wins over the general protection default.
 *   2. `protectedFiles` denylist — blocks anything not explicitly named
 *      above.
 *   3. Default: `allowedWrites === null` means unrestricted (upstream's
 *      `agent.writes is None`); `[]` means read-only (nothing beyond 1/2
 *      ever passes); a populated list restricts to exactly that list plus
 *      whatever protected_files doesn't block (moot, since protected_files
 *      already returned false for anything not in the allowlist).
 */
export function isWritePermitted(
  path: string,
  allowedWrites: string[] | null,
  protectedFiles: string[],
): boolean {
  if (DEFAULT_EXEMPT_ARTIFACTS.some((p) => matchesPattern(path, p))) {
    return true;
  }
  if (allowedWrites !== null && allowedWrites.some((p) => matchesPattern(path, p))) {
    return true; // naming a path is what unlocks a protected one
  }
  if (protectedFiles.some((p) => matchesPattern(path, p))) {
    return false;
  }
  return allowedWrites === null; // null = unrestricted, [] = no repo writes
}

// ── rollback ─────────────────────────────────────────────────────────────

export type RollbackOutcome =
  | "rolled-back" // tracked file restored via `git checkout --`
  | "deleted" // untracked file removed
  | "left-as-is" // was already dirty before the agent ran; not ours to touch
  | "reverted-by-agent" // was dirty before, and the agent reverted it — content unrecoverable
  | "rollback-failed"; // attempted and failed — surfaced, never swallowed

export interface PermissionOutcome {
  path: string;
  outcome: RollbackOutcome;
  detail?: string;
}

/**
 * Undo one unauthorized change. Mirrors upstream `_roll_back()`'s three
 * cases exactly, including the one upstream is explicit about NOT doing:
 * only changes the agent introduced are undone. A path that was already
 * dirty when the agent started is left exactly as it is — the operator had
 * uncommitted work there, and discarding it to "clean up" would be the same
 * class of harm this module exists to prevent, just committed by the
 * cleanup step instead of the agent.
 */
function rollBackOne(cwd: string, path: string, before: RepoSnapshot, after: RepoSnapshot): PermissionOutcome {
  if (path in before) {
    if (!(path in after)) {
      // Was dirty before, clean now: the agent reverted an operator's
      // uncommitted work. The content is not ours to reconstruct.
      return { path, outcome: "reverted-by-agent", detail: "uncommitted work lost, cannot restore" };
    }
    return { path, outcome: "left-as-is", detail: "was already modified before this agent ran" };
  }

  if (after[path] === "untracked") {
    try {
      unlinkSync(join(cwd, path));
      return { path, outcome: "deleted" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { path, outcome: "rollback-failed", detail: `could not delete: ${message}` };
    }
  }

  const result = spawnSync("git", ["checkout", "--", path], { cwd, encoding: "utf8" });
  if (result.status === 0) {
    return { path, outcome: "rolled-back" };
  }
  return { path, outcome: "rollback-failed", detail: (result.stderr ?? "").trim() || "git checkout failed" };
}

// ── enforcement ──────────────────────────────────────────────────────────

export interface PermissionsResult {
  /** Every path that changed between the two snapshots. */
  touched: string[];
  /** Subset of `touched` that was within the allowlist/not protected. */
  allowed: string[];
  /** Subset of `touched` that was NOT permitted — what got rolled back (or attempted). */
  violations: string[];
  /** One rollback outcome per violation, in the same order as `violations`. */
  rollbacks: PermissionOutcome[];
  /** True if every rollback attempt in `rollbacks` actually succeeded (or there were none). */
  clean: boolean;
}

/**
 * Compare the tree at `cwd` against `before`; roll back anything the agent
 * touched outside `allowedWrites`/`protectedFiles`, and report the full
 * picture rather than a bare boolean.
 *
 * Detection alone would leave the repo holding the unauthorized change,
 * so anything introduced outside the allowlist is rolled back as part of
 * this call, not left for a caller to remember to do. What rollback cannot
 * fix (`rollback-failed`, `reverted-by-agent`), it names explicitly in the
 * result rather than swallowing it as a generic failure.
 */
export function enforceWrites(
  cwd: string,
  before: RepoSnapshot,
  allowedWrites: string[] | null,
  protectedFiles: string[],
): PermissionsResult {
  const after = snapshotRepoState(cwd);
  const touched = changedPaths(before, after);

  const allowed: string[] = [];
  const violations: string[] = [];
  for (const path of touched) {
    if (isWritePermitted(path, allowedWrites, protectedFiles)) {
      allowed.push(path);
    } else {
      violations.push(path);
    }
  }

  const rollbacks = violations.map((path) => rollBackOne(cwd, path, before, after));
  // "clean" means no rollback ATTEMPT itself failed. "left-as-is" and
  // "reverted-by-agent" are not failures of this function — they're the
  // documented, correct outcome for a path that was already dirty before
  // the agent ran (see rollBackOne) — only "rollback-failed" means the
  // enforcement machinery itself broke and must be surfaced loudly.
  const clean = rollbacks.every((r) => r.outcome !== "rollback-failed");

  return { touched, allowed, violations, rollbacks, clean };
}
