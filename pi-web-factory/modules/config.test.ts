import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConfigError, parseModelRef, PROJECT_CONFIG_FILENAME, projectConfigFor } from "./config.ts";

// ── parseModelRef ────────────────────────────────────────────────────────
//
// M-075: the agent roster (loadConfig/loadConfigFromString/agentConfigFor/
// AgentConfig/FactoryConfig) moved to roles.ts — see modules/roles.test.ts
// for those tests now. This file keeps only what's still genuinely
// config.ts's own: the provider/model-id bridge and the project-local
// quality-gate lookup, neither of which changed shape in M-075.

describe("parseModelRef", () => {
  test("splits a well-formed provider/model-id string", () => {
    expect(parseModelRef("local-litellm/big-moe")).toEqual({ provider: "local-litellm", modelId: "big-moe" });
  });

  test("rejects a string with no slash", () => {
    expect(() => parseModelRef("big-moe")).toThrow(/"\/"/);
  });

  test("rejects a string with more than one slash", () => {
    expect(() => parseModelRef("local-litellm/nested/big-moe")).toThrow();
  });

  test("rejects an empty provider half", () => {
    expect(() => parseModelRef("/big-moe")).toThrow();
  });

  test("rejects an empty model-id half", () => {
    expect(() => parseModelRef("local-litellm/")).toThrow();
  });
});

// ── projectConfigFor: project-local .pi-web-factory.yaml ────────────────
//
// M-070: per-project quality-gate config moved out of factory.config.yaml's
// centralized `projects:` map into a file the target project owns itself,
// at <project>/.pi-web-factory.yaml. These tests use a real temp dir with a
// real file on disk, matching this project's established real-filesystem
// testing style (see gates.test.ts).

describe("projectConfigFor reading a project-local .pi-web-factory.yaml", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-web-factory-config-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("loads a valid project-local file from disk", () => {
    writeFileSync(
      join(dir, PROJECT_CONFIG_FILENAME),
      "test: npm test\ntypecheck: npx tsc --noEmit\nlint: npm run lint\n",
    );

    const project = projectConfigFor(dir);
    expect(project.path).toBe(dir);
    expect(project.test).toBe("npm test");
    expect(project.typecheck).toBe("npx tsc --noEmit");
    expect(project.lint).toBe("npm run lint");
  });

  test("a field can be legitimately omitted (e.g. no lint command configured)", () => {
    writeFileSync(join(dir, PROJECT_CONFIG_FILENAME), "test: go test ./...\ntypecheck: go vet ./...\n");

    const project = projectConfigFor(dir);
    expect(project.test).toBe("go test ./...");
    expect(project.typecheck).toBe("go vet ./...");
    expect(project.lint).toBeUndefined();
  });

  test("missing file throws a specific ConfigError naming the expected path", () => {
    try {
      projectConfigFor(dir);
      throw new Error("expected projectConfigFor to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as Error).message;
      expect(message).toContain(join(dir, PROJECT_CONFIG_FILENAME));
      expect(message).toContain("does not exist");
    }
  });

  test("malformed YAML throws a specific ConfigError with the parse detail", () => {
    writeFileSync(join(dir, PROJECT_CONFIG_FILENAME), "{ this: is not: valid: yaml");

    try {
      projectConfigFor(dir);
      throw new Error("expected projectConfigFor to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as Error).message;
      expect(message).toContain(join(dir, PROJECT_CONFIG_FILENAME));
      expect(message).toContain("could not parse YAML");
    }
  });

  test("a field with the wrong type throws with the actual Zod validation detail", () => {
    writeFileSync(join(dir, PROJECT_CONFIG_FILENAME), "test:\n  - not-a-string\n");

    try {
      projectConfigFor(dir);
      throw new Error("expected projectConfigFor to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as Error).message;
      expect(message).toContain(join(dir, PROJECT_CONFIG_FILENAME));
      expect(message).toContain("test");
    }
  });
});
