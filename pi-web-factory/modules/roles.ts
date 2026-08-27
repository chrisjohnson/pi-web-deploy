/**
 * Roles: loader/validator/lookup for `factory.config.yaml`'s unified
 * `roles:` registry (M-075), superseding `config.ts`'s earlier
 * `agents:`-only roster (`AgentEntrySchema`/`AgentConfig`/`FactoryConfig`/
 * `loadConfig`/`agentConfigFor` — all removed there, see that file's own
 * header comment for the full history).
 *
 * Per `pi-web-adw-design.md` §7.1/§7.2: a **Role** is the unified concept
 * covering what used to be split into an "agent identity" (model, thinking,
 * `writes:`) and an implicit, never-quite-named concept for code phases.
 * Two kinds, one registry:
 *   - **Agent Role** (`kind: agent`) — model (`provider/model-id`, reusing
 *     `config.ts`'s `parseModelRef`/`ModelRef` bridge), thinking level,
 *     `writes:`, and now a real **system prompt**.
 *   - **Code Role** (`kind: code`) — no model/prompt at all, just a
 *     `function` name resolved against `CODE_ROLE_REGISTRY` below (a plain,
 *     explicit `Record`, NOT a plugin-loading/dynamic-import mechanism —
 *     deliberately, per the M-075 card: "currently one entry").
 *
 * ── system_prompt: a file path, not an inline string — and why ───────────
 * The already-deployed `pi-web-factory-prompts` extension
 * (`jmfederico-pi-web/plugins/pi-web-factory-prompts/roles.json`) stores its
 * role -> prompt mapping as inline strings in a JSON file, which is a
 * reasonable shape for JSON but a poor one for hand-authored YAML: the real
 * prompt text per role (copied verbatim from that file into `prompts/*.md`
 * here — see factory.config.yaml's `roles:` entries) is multi-sentence
 * prose, and YAML's block-scalar syntax (`|`/`>`) for embedding that inline
 * is both easy to get wrong (indentation-sensitive) and painful to diff
 * across five roles in one file. A `system_prompt: prompts/<name>.md` path,
 * read from disk at load time (this module resolves it relative to the
 * CONFIG FILE's own directory, not `process.cwd()`, so `factory.config.yaml`
 * and its `prompts/` sibling directory can be loaded correctly regardless of
 * the caller's working directory), keeps the YAML itself short and each
 * role's prompt independently readable/diffable as ordinary markdown.
 *
 * ── Known, deliberate duplication with the deployed extension — NOT fixed
 *    here ───────────────────────────────────────────────────────────────
 * `jmfederico-pi-web/plugins/pi-web-factory-prompts/roles.json` is a
 * SEPARATE, already-deployed copy of this same prompt content, bundled
 * directly into that extension package because `pi-web-factory` itself is
 * not yet baked into the `jmfederico-pi-web` container (that's M-068,
 * sequenced LAST, after this card — see that extension's own `index.ts`
 * header comment, "Where the role -> prompt mapping lives (deliberate
 * short-term dup)"). This module adds the `system_prompt` field to
 * `pi-web-factory`'s OWN config schema so the shape exists and is correct —
 * it does NOT read from, write to, or otherwise touch
 * `plugins/pi-web-factory-prompts/` in any way, and it does NOT collapse the
 * duplication. The `prompts/*.md` files here are a manually-kept-in-sync
 * duplicate of that extension's `roles.json` content (the actual prose was
 * copied verbatim from there, not freshly written) until M-068 makes
 * `pi-web-factory`'s own files reachable from inside the container and a
 * future card (per M-069's decision log) can point the extension at THESE
 * files instead of its own bundled copy. If you're reading this because the
 * two have drifted: that's the known, accepted state, not a bug — keep them
 * in sync by hand for now, same discipline `roles.json`'s own `$comment`
 * describes.
 *
 * ── Code Role validation happens at LOAD time, not first-use ─────────────
 * A code Role's `function` field is validated against `CODE_ROLE_REGISTRY`'s
 * known keys inside the Zod schema itself (`CodeRoleEntrySchema`'s
 * `superRefine`), so a config naming an unregistered function fails
 * `loadRolesConfig`/`loadRolesConfigFromString` immediately — never a
 * surprise the first time some future Workflow runner (M-076) tries to
 * actually invoke it.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  ConfigError,
  ModelStringSchema,
  parseModelRef,
  ThinkingLevelSchema,
  type ModelRef,
  type ProjectConfig,
  type ThinkingLevel,
} from "./config.ts";
import { testsPass, type GateReport } from "./gates.ts";

// ── Code Role registry ───────────────────────────────────────────────────

/**
 * A code Role's callable shape: given the calling project's own
 * `ProjectConfig` (M-070's per-project `test`/`typecheck`/`lint` commands)
 * and the local filesystem cwd to run in, does the deterministic thing and
 * returns a `GateReport` — the same "verify claims" report shape every other
 * gate in `gates.ts` returns, so a Workflow runner (M-076) can treat a code
 * Role's result exactly like any other gate check.
 */
export type CodeRoleFn = (project: ProjectConfig, cwd: string) => Promise<GateReport>;

/**
 * The actual name -> function mapping. Deliberately a small, explicit
 * `Record` — NOT a plugin-loading/dynamic-import mechanism — per the M-075
 * card's own instruction ("don't build a plugin-loading mechanism for what's
 * currently one entry"). Add a new code Role by adding a key here AND a
 * matching `kind: code` entry in `factory.config.yaml`; the loader below
 * rejects any config entry naming a function not present in this map.
 */
export const CODE_ROLE_REGISTRY: Record<string, CodeRoleFn> = {
  "run-tests": (project, cwd) => testsPass(project.test ?? "", cwd),
};

/** Names of every registered code Role function, for error messages / validation. */
function knownCodeRoleFunctions(): string[] {
  return Object.keys(CODE_ROLE_REGISTRY);
}

// ── Raw YAML shape ───────────────────────────────────────────────────────

const DefaultsSchema = z.object({
  model: ModelStringSchema,
  thinking: ThinkingLevelSchema,
  protected_files: z.array(z.string()).default([]),
});

const AgentRoleEntrySchema = z.object({
  name: z.string().min(1),
  kind: z.literal("agent"),
  model: ModelStringSchema.optional(),
  thinking: ThinkingLevelSchema.optional(),
  // null/omitted = unrestricted (matches permissions.ts's isWritePermitted:
  // allowedWrites === null means unrestricted); [] = read-only; a populated
  // list restricts to exactly those paths (subject to protected_files).
  writes: z.array(z.string()).nullish(),
  /** Path to a system-prompt file, relative to this config file's own directory (see module header comment). */
  system_prompt: z.string().min(1),
});

const CodeRoleEntrySchema = z
  .object({
    name: z.string().min(1),
    kind: z.literal("code"),
    /** Name resolved against CODE_ROLE_REGISTRY — validated below, at load time. */
    function: z.string().min(1),
  })
  .superRefine((entry, ctx) => {
    if (!(entry.function in CODE_ROLE_REGISTRY)) {
      ctx.addIssue({
        code: "custom",
        path: ["function"],
        message:
          `unknown code Role function ${JSON.stringify(entry.function)} — available: ` +
          `${knownCodeRoleFunctions().join(", ") || "(none registered)"}`,
      });
    }
  });

const RoleEntrySchema = z.discriminatedUnion("kind", [AgentRoleEntrySchema, CodeRoleEntrySchema]);

const RawRolesConfigSchema = z.object({
  defaults: DefaultsSchema,
  roles: z.array(RoleEntrySchema).min(1),
});

// ── Loaded/validated shape ───────────────────────────────────────────────

export interface AgentRole {
  kind: "agent";
  name: string;
  /** Raw "provider/model-id" string — logging/tracing, matches upstream's agent.model field. */
  model: string;
  /** Split form, ready for piwebClient.ts's setModel(baseUrl, sessionId, provider, modelId). */
  modelRef: ModelRef;
  thinking: ThinkingLevel;
  /** null = unrestricted, [] = read-only, populated = allowlist. See permissions.ts. */
  writes: string[] | null;
  /** The resolved system-prompt text, read from disk at load time. */
  systemPrompt: string;
  /** The path (as written in the config) the prompt was read from — for logging/debugging. */
  systemPromptPath: string;
}

export interface CodeRole {
  kind: "code";
  name: string;
  /** Name as declared in config — already validated against CODE_ROLE_REGISTRY at load time. */
  function: string;
  /** The resolved callable itself — safe to invoke directly, no further lookup needed. */
  run: CodeRoleFn;
}

export type Role = AgentRole | CodeRole;

export interface RolesConfig {
  defaults: {
    model: string;
    modelRef: ModelRef;
    thinking: ThinkingLevel;
    protectedFiles: string[];
  };
  roles: Role[];
}

// ── load ─────────────────────────────────────────────────────────────────

/**
 * Parses YAML text and validates it into a `RolesConfig`. `baseDir` is the
 * directory `system_prompt` paths are resolved relative to — pass the
 * config file's own directory when loading from disk (`loadRolesConfig`
 * does this automatically); defaults to `process.cwd()` for callers
 * constructing a config from an in-memory string with no file of its own
 * (e.g. most of this module's own tests, which pass absolute paths or don't
 * exercise `system_prompt` resolution at all).
 *
 * Default-fill for an agent Role's `model`/`thinking` happens AFTER Zod
 * validation of the raw shape, same reasoning `config.ts`'s predecessor
 * documented: Zod v4's `.default()` only applies to a key that's
 * `undefined`/absent, and a Role entry legitimately omitting `model`/
 * `thinking` should mean "inherit defaults.*", not "field is missing,
 * reject the config."
 */
export function loadRolesConfigFromString(
  text: string,
  sourceLabel = "<config>",
  baseDir: string = process.cwd(),
): RolesConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`${sourceLabel}: could not parse YAML: ${detail}`);
  }

  const result = RawRolesConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new ConfigError(`${sourceLabel}: invalid config:\n${issues}`);
  }
  const parsed = result.data;

  const defaults = {
    model: parsed.defaults.model,
    modelRef: parseModelRef(parsed.defaults.model),
    thinking: parsed.defaults.thinking,
    protectedFiles: parsed.defaults.protected_files,
  };

  const seenNames = new Set<string>();
  const roles: Role[] = parsed.roles.map((entry) => {
    if (seenNames.has(entry.name)) {
      throw new ConfigError(`${sourceLabel}: duplicate role name ${JSON.stringify(entry.name)}`);
    }
    seenNames.add(entry.name);

    if (entry.kind === "code") {
      const fn = CODE_ROLE_REGISTRY[entry.function];
      if (!fn) {
        // Belt-and-suspenders: schema-level superRefine above already
        // rejects this at parse time, so this branch should be unreachable
        // in practice — kept as a defensive throw rather than a non-null
        // assertion, since silently invoking `undefined` would be far worse
        // than a clear error here.
        throw new ConfigError(
          `${sourceLabel}: role ${JSON.stringify(entry.name)} names unknown function ` +
            `${JSON.stringify(entry.function)} — available: ${knownCodeRoleFunctions().join(", ")}`,
        );
      }
      return { kind: "code", name: entry.name, function: entry.function, run: fn };
    }

    const model = entry.model ?? defaults.model;
    const systemPromptPath = resolve(baseDir, entry.system_prompt);
    let systemPrompt: string;
    try {
      systemPrompt = readFileSync(systemPromptPath, "utf8");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ConfigError(
        `${sourceLabel}: role ${JSON.stringify(entry.name)}'s system_prompt file ` +
          `${JSON.stringify(entry.system_prompt)} (resolved to ${systemPromptPath}) could not be read: ${detail}`,
      );
    }

    return {
      kind: "agent",
      name: entry.name,
      model,
      modelRef: parseModelRef(model),
      thinking: entry.thinking ?? defaults.thinking,
      writes: entry.writes ?? null,
      systemPrompt: systemPrompt.trim(),
      systemPromptPath: entry.system_prompt,
    };
  });

  return { defaults, roles };
}

/** Loads and validates `factory.config.yaml` (or another path) from disk. `system_prompt` paths resolve relative to this file's own directory. */
export function loadRolesConfig(path = "factory.config.yaml"): RolesConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`could not read config file ${JSON.stringify(path)}: ${detail}`);
  }
  return loadRolesConfigFromString(text, path, dirname(resolve(path)));
}

// ── lookups ──────────────────────────────────────────────────────────────

/** Resolves one Role by name (either kind). Throws — never falls back. */
export function roleFor(config: RolesConfig, name: string): Role {
  const role = config.roles.find((r) => r.name === name);
  if (!role) {
    const available = config.roles.map((r) => r.name).join(", ") || "(none configured)";
    throw new ConfigError(`role ${JSON.stringify(name)} is not defined in the config — available: ${available}`);
  }
  return role;
}

/** Resolves one Role by name, requiring it be an agent Role — the common case for chain code. Throws for an unknown name OR a name that resolves to a code Role. */
export function agentRoleFor(config: RolesConfig, name: string): AgentRole {
  const role = roleFor(config, name);
  if (role.kind !== "agent") {
    throw new ConfigError(`role ${JSON.stringify(name)} is a "code" role, not an "agent" role — cannot use it here`);
  }
  return role;
}

/** Resolves one Role by name, requiring it be a code Role. Throws for an unknown name OR a name that resolves to an agent Role. */
export function codeRoleFor(config: RolesConfig, name: string): CodeRole {
  const role = roleFor(config, name);
  if (role.kind !== "code") {
    throw new ConfigError(`role ${JSON.stringify(name)} is an "agent" role, not a "code" role — cannot use it here`);
  }
  return role;
}
