/**
 * Gates: TS port of upstream SSSF's `adws/adw_modules/gates.py`.
 *
 * A gate verifies CLAIMS an envelope already made, after the fact — never a
 * prediction. Function signatures below reflect that: anything a gate needs
 * to check "what did the envelope claim" takes that claim as an explicit
 * parameter (a list of paths, a JSON string, a command), never reaches into
 * global/session state to rediscover it. This mirrors upstream's own
 * `gate(envelope, run) -> GateReport` shape, adapted to plain parameters
 * since this port has no `run`-context object yet (nothing in this repo's
 * scope needs one — chain code owns wiring an envelope's fields into these
 * calls).
 *
 * Every gate returns one check per thing it looked at — never a bare
 * boolean — so a green gate still says WHAT it verified, and a red one
 * says exactly which claim failed and why (`GateCheck.note`).
 */

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ZodType } from "zod";
import type { GateCheck, GateReport } from "./tracer.ts";

// `GateCheck`/`GateReport` are NOT redefined here: `tracer.ts` already
// exports the exact `{item, ok, note?}` / `{checks}` shapes this module
// needs (see tracer.ts:54-62), and gate reports are written straight into
// the trace db via `Tracer.gateRow`/`Tracer.event({type: "gate_pass"|...})`
// — reusing tracer.ts's types keeps that path type-safe end to end instead
// of requiring a cast at the boundary between two structurally-identical
// but nominally-different interfaces.
export type { GateCheck, GateReport };

const TAIL_CHARS = 1000; // command output kept as evidence on a failure

function fmtSize(bytes: number): string {
  return bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(1)}KB`;
}

function report(checks: GateCheck[]): GateReport {
  return { checks };
}

// ── artifacts_exist ──────────────────────────────────────────────────────

/** Every declared path must exist on disk (relative to `cwd`). */
export function artifactsExist(paths: string[], cwd: string): GateReport {
  const checks: GateCheck[] = paths.map((p) => {
    const full = join(cwd, p);
    const exists = existsSync(full);
    if (!exists) return { item: p, ok: false, note: "declared artifact does not exist" };
    const size = statSync(full).size;
    return { item: p, ok: true, note: `exists, ${fmtSize(size)}` };
  });
  return report(checks);
}

// ── files_non_empty ──────────────────────────────────────────────────────

/**
 * Every declared path must exist AND have non-zero size. Existence is
 * `artifactsExist`'s job — a missing path is silently skipped here exactly
 * as upstream's `files_non_empty` does (`if not (p.exists() and
 * p.is_file()): continue`), so the two gates don't double-report the same
 * violation under two different names.
 */
export function filesNonEmpty(paths: string[], cwd: string): GateReport {
  const checks: GateCheck[] = [];
  for (const p of paths) {
    const full = join(cwd, p);
    if (!existsSync(full)) continue;
    const stat = statSync(full);
    if (!stat.isFile()) continue;
    const empty = stat.size === 0;
    checks.push({ item: p, ok: !empty, note: empty ? "declared artifact is empty" : fmtSize(stat.size) });
  }
  return report(checks);
}

// ── json_parses ───────────────────────────────────────────────────────────

/**
 * Strips a single top-level markdown code fence (```json\n...\n``` or
 * ```\n...\n```) if `text` is wrapped in exactly one, despite every Role
 * prompt explicitly asking for raw JSON only. Returns `text` unchanged if
 * it isn't fenced. Confirmed live: a real, recurring failure mode
 * independent of the message-settle race — some models (medium-moe/Ornith
 * observed directly) reliably wrap otherwise-valid JSON in fences
 * regardless of prompt instructions.
 */
function stripMarkdownFences(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = /^```[\w]*\n([\s\S]*?)```$/.exec(trimmed);
  return fenceMatch ? fenceMatch[1]!.trim() : text;
}

/**
 * Best-effort JSON extraction: strips markdown fences (see
 * `stripMarkdownFences`), then — if that alone doesn't parse — falls back
 * to slicing from the first `{` to the last `}` in the (fence-stripped)
 * text and trying that substring. Tolerates stray prose immediately before
 * or after the JSON object (e.g. "Here's the result: {...}\nDone.")
 * without accepting genuinely prose-only or malformed responses — if
 * neither the fence-stripped text nor the `{...}` slice parses, this
 * throws the LAST parse attempt's real error, not a synthesized one.
 */
export function extractJson(text: string): unknown {
  const stripped = stripMarkdownFences(text);
  try {
    return JSON.parse(stripped);
  } catch (strippedError) {
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) throw strippedError;
    return JSON.parse(stripped.slice(start, end + 1));
  }
}

/**
 * Parses `text` as JSON (via `extractJson` — tolerates a markdown fence
 * and/or minor surrounding prose, see that function's doc comment) and
 * validates it against `schema`. One check per Zod validation issue found
 * (upstream only distinguishes "parses" / "does not parse" for arbitrary
 * JSON files on disk; this port goes a step further and also validates
 * envelope SHAPE, since that's exactly what `envelopes.ts` schemas are for
 * and per-issue detail is more actionable than a single pass/fail). Falls
 * back to one check with the full parse-error detail in `note` if the text
 * isn't extractable as JSON at all — there's no per-field issue list to
 * expand at that point.
 */
export function jsonParses(text: string, schema: ZodType): GateReport {
  let parsed: unknown;
  try {
    parsed = extractJson(text);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return report([{ item: "json", ok: false, note: `does not parse: ${message}` }]);
  }

  const result = schema.safeParse(parsed);
  if (result.success) {
    return report([{ item: "json", ok: true, note: "parses and matches schema" }]);
  }

  const checks: GateCheck[] = result.error.issues.map((issue) => ({
    item: issue.path.length ? issue.path.join(".") : "json",
    ok: false,
    note: issue.message,
  }));
  return report(checks);
}

// ── diff_matches_claims ──────────────────────────────────────────────────

function gitOutput(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return (result.stdout ?? "").trim();
}

/** Files actually touched in `cwd`: tracked diff (`git diff --name-only`,
 * covering both staged and unstaged changes against HEAD) plus untracked
 * files from `git status --porcelain`. */
function actuallyChangedFiles(cwd: string): Set<string> {
  const diffed = gitOutput(cwd, ["diff", "--name-only", "HEAD"])
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const statusLines = gitOutput(cwd, ["status", "--porcelain"])
    .split("\n")
    .filter(Boolean);
  const untracked = statusLines
    .filter((l) => l.startsWith("??"))
    .map((l) => l.slice(3).trim());
  return new Set([...diffed, ...untracked]);
}

/**
 * Compares an envelope's claimed changed files/artifacts against the real
 * `git diff`/`git status` state of `cwd`. Flags claimed-but-unchanged
 * files (upstream's `diff_matches_claims` behavior: "every file claimed
 * changed must exist on disk" — extended here to also require it show up
 * as an actual change, not merely exist, since a file existing on disk
 * unchanged is a weaker claim than "I changed this file").
 *
 * Also flags changed-but-unclaimed files (upstream does NOT do this — its
 * `diff_matches_claims` only walks `envelope.changed_files` outward, never
 * the diff inward). Included here anyway: this gate's whole purpose is
 * catching a mismatch between what an agent SAYS it did and what actually
 * happened in the repo, and a change the agent silently didn't mention is
 * exactly that kind of mismatch — an unreviewed side effect is a real
 * finding, not noise. Marked with a distinct item prefix so a caller that
 * wants upstream's narrower one-directional behavior can filter these out.
 */
export function diffMatchesClaims(claimedFiles: string[], cwd: string): GateReport {
  const actual = actuallyChangedFiles(cwd);
  const claimed = new Set(claimedFiles);
  const checks: GateCheck[] = [];

  for (const f of claimedFiles) {
    checks.push(
      actual.has(f)
        ? { item: f, ok: true, note: "claimed change confirmed in diff" }
        : { item: f, ok: false, note: "claimed changed file is not in the actual diff" },
    );
  }

  for (const f of actual) {
    if (claimed.has(f)) continue;
    checks.push({ item: `unclaimed:${f}`, ok: false, note: "changed in diff but not claimed by the envelope" });
  }

  return report(checks);
}

// ── tests_pass ────────────────────────────────────────────────────────────

/**
 * Runs `cmd` via a shell in `cwd`; one check reporting exit code plus a
 * trimmed tail of combined stdout+stderr as evidence on failure. Takes the
 * command as a parameter — no hardcoded test command, since per-project
 * config (M-065) supplies it.
 */
export async function testsPass(cmd: string, cwd: string): Promise<GateReport> {
  const proc = Bun.spawn(["sh", "-c", cmd], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const ok = exitCode === 0;
  let note = `exit ${exitCode}`;
  if (!ok) {
    const tail = (stdout + stderr).slice(-TAIL_CHARS);
    note += `\n${tail}`;
  }
  return report([{ item: cmd, ok, note }]);
}
