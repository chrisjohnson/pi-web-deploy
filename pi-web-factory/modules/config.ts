/**
 * Config: shared config primitives used by `roles.ts` (the global `roles:`
 * registry loader, M-075) and by this project's own per-project quality-gate
 * lookup.
 *
 * ── M-075: the agent roster moved to roles.ts ────────────────────────────
 * Earlier revisions of this module (M-065) owned `factory.config.yaml`'s
 * entire shape: `defaults` + an `agents:` roster (`AgentEntrySchema`,
 * `AgentConfig`, `RawFactoryConfigSchema`, `FactoryConfig`,
 * `loadConfig`/`loadConfigFromString`, `agentConfigFor`). M-075 unifies that
 * agent-only roster with a new "code Role" concept (e.g. "run the project's
 * tests") into one `roles:` registry covering BOTH — see `roles.ts` for the
 * new schema/loader/lookup (`RolesConfig`, `AgentRole`, `CodeRole`, `Role`,
 * `loadRolesConfig`, `roleFor`). Everything agent-roster-specific has moved
 * there; this file now keeps only the primitives `roles.ts` reuses
 * (`ModelRef`/`parseModelRef`/`ModelStringSchema`/`ThinkingLevelSchema`/
 * `ConfigError`) plus the project-local quality-gate lookup below, which was
 * never part of the roster and is unaffected by this change.
 *
 * ── Per-project quality-gate config lives in the target project's own repo ─
 * M-070: each target project owns and versions its own `<project>/.pi-web-
 * factory.yaml` file declaring its `test`/`typecheck`/`lint` commands. See
 * `projectConfigFor` below.
 *
 * ── The provider/model-id bridge ────────────────────────────────────────
 * Upstream (and this project's own YAML, for human-readable authoring) writes
 * a model role as one combined string: `"local-litellm/big-moe"`. But
 * `piwebClient.ts`'s `setModel(baseUrl, sessionId, provider, modelId)` takes
 * TWO separate string parameters, not a combined string. Splitting that
 * string back apart ad hoc at every call site would be exactly the kind of
 * drift-prone duplication `envelopes.ts`'s "synced triad" comment warns
 * about elsewhere in this codebase — so the split happens ONCE, here, at
 * load time, and `roles.ts` reuses `parseModelRef`/`ModelStringSchema`
 * rather than duplicating the logic. A loaded agent Role exposes both:
 *   - `model` — the raw `"provider/model-id"` string, for logging/tracing
 *     (matches upstream's own `agent.model` field shape, e.g. the
 *     `agent_start` event payload in `agents.py:97`).
 *   - `modelRef` — `{provider, modelId}`, ready to spread/pass directly into
 *     `setModel(baseUrl, sessionId, modelRef.provider, modelRef.modelId)`
 *     with no further parsing at the call site.
 *
 * ── Known limitation: validated shape, not validated reachability ────────
 * `parseModelRef`/`ModelStringSchema` only check that a model string is
 * WELL-FORMED (`provider/model-id`, both halves non-empty) — never that the
 * modelId actually exists as a live litellm role. Confirming that would mean
 * a network call to litellm's Model Management API at config-load time, which
 * this module deliberately does not make (load/validate has to work offline,
 * in tests, and before any target session exists). This is the same sharp
 * edge upstream SSSF's own README calls out: a stale/renamed model role fails
 * SILENTLY MID-CHAIN (the `POST /sessions/:id/model` call either 4xxs deep
 * inside a run or, worse, litellm accepts the request and the session just
 * behaves oddly), not at startup where it would be cheap to catch. Not
 * hypothetical for this box: a litellm role rename (`coder` -> `medium-moe`,
 * 2026-08-03) has already broken other integrations that assumed a role name
 * was stable. Reachability validation, if ever added, belongs in a separate
 * explicit preflight step (e.g. a `factory doctor` command hitting litellm's
 * `/v1/models`), not folded into this loader.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// ── provider/model-id ────────────────────────────────────────────────────

export interface ModelRef {
  provider: string;
  modelId: string;
}

/**
 * Splits a `"provider/model-id"` string into the two-parameter shape
 * `piwebClient.ts`'s `setModel` takes. Requires exactly one `/`, with both
 * halves non-empty — a model-id itself may not contain further `/`
 * characters (none of this box's real roles do; if that ever changes, widen
 * this to split on the FIRST `/` instead of requiring exactly one).
 */
export function parseModelRef(raw: string): ModelRef {
  const parts = raw.split("/");
  if (parts.length !== 2 || !parts[0]?.trim() || !parts[1]?.trim()) {
    throw new Error(
      `invalid model ${JSON.stringify(raw)}: expected exactly one "/" separating a non-empty ` +
        `provider from a non-empty model-id, e.g. "local-litellm/big-moe"`,
    );
  }
  return { provider: parts[0], modelId: parts[1] };
}

/** Zod refinement: a string that `parseModelRef` accepts. Exported for reuse by `roles.ts`. */
export const ModelStringSchema = z.string().superRefine((value, ctx) => {
  try {
    parseModelRef(value);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/** Exported for reuse by `roles.ts`'s agent Role schema. */
export const ThinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

// ── project-local quality-gate config (`<project>/.pi-web-factory.yaml`) ──

/** Filename each target project owns, at its own repo root (M-070). */
export const PROJECT_CONFIG_FILENAME = ".pi-web-factory.yaml";

const ProjectConfigFileSchema = z.object({
  test: z.string().optional(),
  typecheck: z.string().optional(),
  lint: z.string().optional(),
});

// ── Loaded/validated shape ───────────────────────────────────────────────

export interface ProjectConfig {
  /** Absolute path to the project this config was read from. */
  path: string;
  test?: string;
  typecheck?: string;
  lint?: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// ── lookups ──────────────────────────────────────────────────────────────

/**
 * Resolves per-project quality-gate config by reading `<absolutePath>/
 * .pi-web-factory.yaml` — a file the TARGET PROJECT owns and versions
 * itself (M-070), not a centralized map inside pi-web-factory's own global
 * config. Takes no roles/config argument — project-local lookup doesn't
 * depend on the Roles registry at all, and threading an unused parameter
 * through just to preserve a signature shape would be more disruptive than
 * updating the (one) call site.
 *
 * Missing file -> a specific `ConfigError` naming the expected path — same
 * discipline the old centralized lookup had for an unknown project key, just
 * a different failure mode now (file-not-found instead of key-not-in-map),
 * never a silent fallback to some default project's commands (running
 * project A's test command against project B's cwd would be a worse failure
 * mode than refusing to run at all). Malformed file -> a specific
 * `ConfigError` carrying the actual Zod validation detail, same as every
 * other parse failure in this module.
 */
export function projectConfigFor(absolutePath: string): ProjectConfig {
  const configPath = join(absolutePath, PROJECT_CONFIG_FILENAME);

  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigError(
      `${configPath} does not exist — every project driven by pi-web-factory must have its own ` +
        `${PROJECT_CONFIG_FILENAME} at its repo root, declaring its test/typecheck/lint commands ` +
        `(${detail})`,
    );
  }

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`${configPath}: could not parse YAML: ${detail}`);
  }

  const result = ProjectConfigFileSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new ConfigError(`${configPath}: invalid config:\n${issues}`);
  }

  return { path: absolutePath, ...result.data };
}
