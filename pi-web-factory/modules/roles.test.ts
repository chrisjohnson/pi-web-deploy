import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConfigError } from "./config.ts";
import { agentRoleFor, CODE_ROLE_REGISTRY, codeRoleFor, loadRolesConfig, loadRolesConfigFromString, roleFor } from "./roles.ts";

const REAL_CONFIG_PATH = join(import.meta.dir, "..", "factory.config.yaml");

// ── the real shipped factory.config.yaml ────────────────────────────────

describe("the shipped factory.config.yaml", () => {
  test("loads and validates successfully from disk", () => {
    const config = loadRolesConfig(REAL_CONFIG_PATH);
    expect(config.roles.length).toBeGreaterThan(0);
  });

  test("covers all five agent identities (plan, build, review, scout, document) plus decide-retry (M-103) plus at least one code role", () => {
    const config = loadRolesConfig(REAL_CONFIG_PATH);
    const agentNames = config.roles.filter((r) => r.kind === "agent").map((r) => r.name).sort();
    // decide-retry (M-103) is a real sixth agent Role — a narrow
    // classification Role, not one of envelopeSchemas' five Workflow-Step
    // identities (it's never looked up via envelopeSchemaForRole, see
    // retryDecision.ts's own RetryDecisionOutputSchema) — included here
    // deliberately, not a stale assumption left unfixed.
    expect(agentNames).toEqual(["build", "decide-retry", "document", "plan", "review", "scout"]);

    const codeNames = config.roles.filter((r) => r.kind === "code").map((r) => r.name);
    expect(codeNames.length).toBeGreaterThan(0);
    expect(codeNames).toContain("run-tests");
  });

  test("every agent role's model splits into a usable {provider, modelId} ModelRef", () => {
    const config = loadRolesConfig(REAL_CONFIG_PATH);
    for (const role of config.roles) {
      if (role.kind !== "agent") continue;
      expect(role.modelRef.provider.length).toBeGreaterThan(0);
      expect(role.modelRef.modelId.length).toBeGreaterThan(0);
      expect(`${role.modelRef.provider}/${role.modelRef.modelId}`).toBe(role.model);
    }
  });

  test("every agent role's system prompt was read from disk and is non-empty real prose, not a placeholder", () => {
    const config = loadRolesConfig(REAL_CONFIG_PATH);
    for (const role of config.roles) {
      if (role.kind !== "agent") continue;
      expect(role.systemPrompt.length).toBeGreaterThan(20);
      expect(role.systemPrompt.toLowerCase()).not.toContain("placeholder");
    }
  });

  test("the plan role's system prompt matches the deployed pi-web-factory-prompts extension's real roles.json content", () => {
    // Confirms this card copied the ACTUAL deployed prompt text (M-069), not
    // freshly-written placeholder prose — cross-checked against the
    // extension's own bundled roles.json, read directly here (read-only —
    // this test never writes to plugins/pi-web-factory-prompts/).
    const rolesJsonPath = join(
      import.meta.dir,
      "..",
      "..",
      "plugins",
      "pi-web-factory-prompts",
      "roles.json",
    );
    const deployed = JSON.parse(readFileSync(rolesJsonPath, "utf8")) as { roles: Record<string, string> };

    const config = loadRolesConfig(REAL_CONFIG_PATH);
    for (const name of ["plan", "build", "review", "scout", "document"]) {
      const role = agentRoleFor(config, name);
      const expected = deployed.roles[name];
      if (expected === undefined) throw new Error(`roles.json has no entry for ${name}`);
      expect(role.systemPrompt).toBe(expected);
    }
  });

  test("declares protected_files covering this project's own machinery", () => {
    const config = loadRolesConfig(REAL_CONFIG_PATH);
    expect(config.defaults.protectedFiles).toContain("modules/");
    expect(config.defaults.protectedFiles).toContain("factory.config.yaml");
  });

  test("raw YAML text also parses standalone, with system_prompt paths resolved relative to the real config's directory", () => {
    const text = readFileSync(REAL_CONFIG_PATH, "utf8");
    const config = loadRolesConfigFromString(text, "factory.config.yaml", join(import.meta.dir, ".."));
    // 6 agent roles: the original 5 (plan/build/review/scout/document) plus
    // decide-retry (M-103) — see the "covers all five agent identities..."
    // test above for the full reasoning on why this count grew.
    expect(config.roles.filter((r) => r.kind === "agent").length).toBe(6);
  });
});

// ── synthetic valid config: both role kinds ──────────────────────────────

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-web-factory-roles-test-"));
  writeFileSync(join(dir, "plan.md"), "You are the plan role.\n");
  writeFileSync(join(dir, "build.md"), "You are the build role.\n");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function minimalValidYaml(): string {
  return `
defaults:
  model: local-litellm/medium-moe
  thinking: medium
  protected_files:
    - modules/
roles:
  - name: plan
    kind: agent
    model: local-litellm/big-moe
    thinking: high
    writes:
      - specs/
    system_prompt: plan.md
  - name: build
    kind: agent
    thinking: low
    system_prompt: build.md
  - name: run-tests
    kind: code
    function: run-tests
`;
}

describe("a synthetic valid config with both role kinds", () => {
  test("loads successfully", () => {
    const config = loadRolesConfigFromString(minimalValidYaml(), "<test>", dir);
    expect(config.roles).toHaveLength(3);
  });

  test("an agent role that omits model/thinking inherits defaults", () => {
    const config = loadRolesConfigFromString(minimalValidYaml(), "<test>", dir);
    const build = agentRoleFor(config, "build");
    expect(build.model).toBe("local-litellm/medium-moe");
    expect(build.modelRef).toEqual({ provider: "local-litellm", modelId: "medium-moe" });
    // thinking WAS specified on this entry -> not inherited
    expect(build.thinking).toBe("low");
  });

  test("an agent role with no writes: key is unrestricted (null), not empty", () => {
    const config = loadRolesConfigFromString(minimalValidYaml(), "<test>", dir);
    expect(agentRoleFor(config, "build").writes).toBeNull();
  });

  test("an agent role with writes: [] means read-only, distinct from null", () => {
    const yaml = minimalValidYaml().replace("thinking: low", "thinking: low\n    writes: []");
    const config = loadRolesConfigFromString(yaml, "<test>", dir);
    expect(agentRoleFor(config, "build").writes).toEqual([]);
  });

  test("an agent role's system_prompt is read from disk, resolved relative to baseDir", () => {
    const config = loadRolesConfigFromString(minimalValidYaml(), "<test>", dir);
    expect(agentRoleFor(config, "plan").systemPrompt).toBe("You are the plan role.");
  });

  test("a code role resolves to the exact registered function", () => {
    const config = loadRolesConfigFromString(minimalValidYaml(), "<test>", dir);
    const runTests = codeRoleFor(config, "run-tests");
    const registered = CODE_ROLE_REGISTRY["run-tests"];
    if (registered === undefined) throw new Error("run-tests missing from CODE_ROLE_REGISTRY");
    expect(runTests.run).toBe(registered);
  });

  test("roleFor resolves either kind by name", () => {
    const config = loadRolesConfigFromString(minimalValidYaml(), "<test>", dir);
    expect(roleFor(config, "plan").kind).toBe("agent");
    expect(roleFor(config, "run-tests").kind).toBe("code");
  });

  test("agentRoleFor rejects a name that resolves to a code role", () => {
    const config = loadRolesConfigFromString(minimalValidYaml(), "<test>", dir);
    expect(() => agentRoleFor(config, "run-tests")).toThrow(ConfigError);
    expect(() => agentRoleFor(config, "run-tests")).toThrow(/"code" role, not an "agent" role/);
  });

  test("codeRoleFor rejects a name that resolves to an agent role", () => {
    const config = loadRolesConfigFromString(minimalValidYaml(), "<test>", dir);
    expect(() => codeRoleFor(config, "plan")).toThrow(ConfigError);
    expect(() => codeRoleFor(config, "plan")).toThrow(/"agent" role, not a "code" role/);
  });
});

// ── malformed agent role rejected at load time ───────────────────────────

describe("malformed agent role provider/model-id is rejected at load time", () => {
  test("defaults.model missing the slash", () => {
    const yaml = minimalValidYaml().replace("model: local-litellm/medium-moe", "model: medium-moe");
    expect(() => loadRolesConfigFromString(yaml, "<test>", dir)).toThrow(ConfigError);
    expect(() => loadRolesConfigFromString(yaml, "<test>", dir)).toThrow(/"\/"/);
  });

  test("an agent role's model has an empty provider half", () => {
    const yaml = minimalValidYaml().replace("model: local-litellm/big-moe", "model: /big-moe");
    expect(() => loadRolesConfigFromString(yaml, "<test>", dir)).toThrow(ConfigError);
  });

  test("an agent role's model has an empty model-id half", () => {
    const yaml = minimalValidYaml().replace("model: local-litellm/big-moe", "model: local-litellm/");
    expect(() => loadRolesConfigFromString(yaml, "<test>", dir)).toThrow(ConfigError);
  });

  test("error message is specific, not generic", () => {
    const yaml = minimalValidYaml().replace("model: local-litellm/medium-moe", "model: medium-moe");
    try {
      loadRolesConfigFromString(yaml, "test-fixture.yaml", dir);
      throw new Error("expected loadRolesConfigFromString to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as Error).message;
      expect(message).toContain("test-fixture.yaml");
      expect(message).toContain("defaults.model");
    }
  });
});

// ── unknown code-role function rejected at LOAD time, not first-use ──────

describe("a code role naming an unknown function is rejected at load time", () => {
  test("loadRolesConfigFromString throws before the role is ever looked up", () => {
    const yaml = minimalValidYaml().replace("function: run-tests", "function: launch-the-missiles");
    expect(() => loadRolesConfigFromString(yaml, "<test>", dir)).toThrow(ConfigError);
  });

  test("error message names the bad function and lists what IS available", () => {
    const yaml = minimalValidYaml().replace("function: run-tests", "function: launch-the-missiles");
    try {
      loadRolesConfigFromString(yaml, "<test>", dir);
      throw new Error("expected loadRolesConfigFromString to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as Error).message;
      expect(message).toContain("launch-the-missiles");
      expect(message).toContain("run-tests");
    }
  });
});

// ── other malformed shapes ────────────────────────────────────────────────

describe("other malformed shapes are rejected", () => {
  test("not valid YAML at all", () => {
    expect(() => loadRolesConfigFromString("{ this: is not: valid: yaml", "bad.yaml")).toThrow(ConfigError);
  });

  test("missing roles list entirely", () => {
    const yaml = `
defaults:
  model: local-litellm/medium-moe
  thinking: medium
`;
    expect(() => loadRolesConfigFromString(yaml)).toThrow(ConfigError);
  });

  test("empty roles list", () => {
    const yaml = `
defaults:
  model: local-litellm/medium-moe
  thinking: medium
roles: []
`;
    expect(() => loadRolesConfigFromString(yaml)).toThrow(ConfigError);
  });

  test("duplicate role names", () => {
    const yaml = `
defaults:
  model: local-litellm/medium-moe
  thinking: medium
roles:
  - name: plan
    kind: agent
    model: local-litellm/big-moe
    system_prompt: plan.md
  - name: plan
    kind: agent
    model: local-litellm/medium-moe
    system_prompt: plan.md
`;
    expect(() => loadRolesConfigFromString(yaml, "<test>", dir)).toThrow(/duplicate role name/);
  });

  test("invalid thinking level", () => {
    const yaml = minimalValidYaml().replace("thinking: medium", "thinking: ludicrous");
    expect(() => loadRolesConfigFromString(yaml, "<test>", dir)).toThrow(ConfigError);
  });

  test("an agent role missing system_prompt is rejected", () => {
    const yaml = `
defaults:
  model: local-litellm/medium-moe
  thinking: medium
roles:
  - name: plan
    kind: agent
    model: local-litellm/big-moe
`;
    expect(() => loadRolesConfigFromString(yaml, "<test>", dir)).toThrow(ConfigError);
  });

  test("an agent role whose system_prompt file does not exist on disk is rejected", () => {
    const yaml = minimalValidYaml().replace("system_prompt: plan.md", "system_prompt: does-not-exist.md");
    expect(() => loadRolesConfigFromString(yaml, "<test>", dir)).toThrow(ConfigError);
    expect(() => loadRolesConfigFromString(yaml, "<test>", dir)).toThrow(/could not be read/);
  });

  test("an unrecognized kind is rejected", () => {
    const yaml = `
defaults:
  model: local-litellm/medium-moe
  thinking: medium
roles:
  - name: mystery
    kind: mystery
`;
    expect(() => loadRolesConfigFromString(yaml, "<test>", dir)).toThrow(ConfigError);
  });
});

// ── roleFor unknown name ──────────────────────────────────────────────────

describe("roleFor with an unknown role name", () => {
  test("throws a specific error listing what IS available", () => {
    const config = loadRolesConfigFromString(minimalValidYaml(), "<test>", dir);
    try {
      roleFor(config, "nonexistent-role");
      throw new Error("expected roleFor to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as Error).message;
      expect(message).toContain("nonexistent-role");
      expect(message).toContain("plan");
      expect(message).toContain("build");
      expect(message).toContain("run-tests");
    }
  });
});
