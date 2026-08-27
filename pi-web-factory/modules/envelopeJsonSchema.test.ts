import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  allResponseFormats,
  envelopeResponseFormat,
  jsonSchemaRoles,
  litellmJsonRoleName,
  type ResponseFormat,
} from "./envelopeJsonSchema.ts";
import { envelopeSchemas } from "./envelopes.ts";
import { loadRolesConfig } from "./roles.ts";

/** `docker/litellm/generated-json-schemas/` — same directory `generate-litellm-schemas.ts` writes to (its own `resolve(here, "../../docker/litellm/generated-json-schemas")`, `here` being `pi-web-factory/`), resolved from THIS file's own location (`modules/`) instead — one directory further up. */
const GENERATED_SCHEMA_DIR = join(import.meta.dir, "..", "..", "..", "docker", "litellm", "generated-json-schemas");

/** Recursively asserts every `type: "object"` node in a JSON Schema carries `additionalProperties: false` and lists every one of its own `properties` keys in `required` — the two properties litellm/OpenAI strict `json_schema` mode actually needs, checked structurally rather than trusting `z.toJSONSchema`'s defaults blindly. */
function assertStrictObjectShape(node: unknown, path = "$"): void {
  if (node === null || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;

  if (obj["type"] === "object") {
    expect(obj["additionalProperties"], `${path}.additionalProperties`).toBe(false);
    const properties = (obj["properties"] as Record<string, unknown> | undefined) ?? {};
    const required = (obj["required"] as string[] | undefined) ?? [];
    for (const key of Object.keys(properties)) {
      expect(required, `${path}.required should include ${key}`).toContain(key);
    }
  }

  if (obj["properties"] && typeof obj["properties"] === "object") {
    for (const [key, value] of Object.entries(obj["properties"] as Record<string, unknown>)) {
      assertStrictObjectShape(value, `${path}.properties.${key}`);
    }
  }
  if (obj["items"]) {
    assertStrictObjectShape(obj["items"], `${path}.items`);
  }
}

describe("envelopeResponseFormat", () => {
  test("wraps a Zod schema into the litellm response_format shape", () => {
    const schema = z.object({ status: z.enum(["success", "fail"]) });
    const rf: ResponseFormat = envelopeResponseFormat("test_schema_v1", schema);

    expect(rf.type).toBe("json_schema");
    expect(rf.json_schema.name).toBe("test_schema_v1");
    expect(rf.json_schema.strict).toBe(true);
    expect(rf.json_schema.schema).toMatchObject({
      type: "object",
      properties: { status: { type: "string", enum: ["success", "fail"] } },
      required: ["status"],
      additionalProperties: false,
    });
  });

  test("a field with a Zod .default() still lands in the schema's own required array (strict-mode requirement)", () => {
    const schema = z.object({ summary: z.string().default("") });
    const rf = envelopeResponseFormat("test_default_v1", schema);
    expect(rf.json_schema.schema["required"]).toContain("summary");
  });

  test("nested object arrays (e.g. ScoutOutputSchema's findings[]) get additionalProperties: false recursively", () => {
    const rf = envelopeResponseFormat("scout_test_v1", envelopeSchemas.scout);
    assertStrictObjectShape(rf.json_schema.schema);
  });
});

describe("jsonSchemaRoles", () => {
  test("covers every Step-facing envelope identity plus decide-retry (6 total, per the card)", () => {
    const names = Object.keys(jsonSchemaRoles).sort();
    expect(names).toEqual(["build", "decide-retry", "document", "plan", "review", "scout"]);
  });

  test("every jsonSchemaRoles key that is also an envelopeSchemas key uses the identical schema object (no drift between the two registries)", () => {
    for (const key of Object.keys(envelopeSchemas)) {
      expect(jsonSchemaRoles[key as keyof typeof jsonSchemaRoles]).toBe(envelopeSchemas[key as keyof typeof envelopeSchemas]);
    }
  });
});

describe("allResponseFormats", () => {
  test("produces one valid ResponseFormat per jsonSchemaRoles entry, each schema passing the strict-shape check", () => {
    const formats = allResponseFormats();
    const roleNames = Object.keys(jsonSchemaRoles);
    expect(Object.keys(formats).sort()) .toEqual(roleNames.sort());

    for (const [roleName, rf] of Object.entries(formats)) {
      expect(rf.type).toBe("json_schema");
      expect(rf.json_schema.strict).toBe(true);
      // litellm/OpenAI require json_schema.name to match ^[a-zA-Z0-9_-]+$.
      expect(rf.json_schema.name).toMatch(/^[a-zA-Z0-9_-]+$/);
      expect(rf.json_schema.name).toContain(roleName.replace(/-/g, "_"));
      assertStrictObjectShape(rf.json_schema.schema);
    }
  });

  test("every jsonSchemaRoles key names an agent Role that actually exists in factory.config.yaml, and vice versa for the five envelopeSchemas-backed Steps — catches drift between the two files (M-113 Plan step 2)", () => {
    const config = loadRolesConfig("factory.config.yaml");
    const configuredAgentRoleNames = new Set(config.roles.filter((r) => r.kind === "agent").map((r) => r.name));

    for (const roleName of Object.keys(jsonSchemaRoles)) {
      expect(configuredAgentRoleNames.has(roleName), `factory.config.yaml has no agent Role named ${JSON.stringify(roleName)}`).toBe(true);
    }
  });
});

describe("litellmJsonRoleName", () => {
  test("mirrors the -continue-json suffix convention (docker/litellm/config.yaml)", () => {
    expect(litellmJsonRoleName("medium-moe", "build")).toBe("medium-moe-build-json");
    expect(litellmJsonRoleName("big-moe", "plan")).toBe("big-moe-plan-json");
  });
});

// ── Drift detection: committed generated files vs. a fresh regeneration ───
//
// litellm-bootstrap.sh reads docker/litellm/generated-json-schemas/*.json
// straight off disk — it never calls into this module or re-derives
// anything from envelopes.ts at bootstrap time (deliberately, see that
// script's own header comment: no bun/node dependency on the bootstrap
// path). That means the committed files are the ONLY thing standing
// between a future envelopes.ts edit and a stale schema silently getting
// seeded into litellm. Nothing before this point in the file reads the
// COMMITTED files at all — every test above only exercises the conversion
// LOGIC (allResponseFormats() called fresh, in-memory). This suite closes
// that gap: it reads each committed file and diffs it against a fresh
// allResponseFormats() run, so an envelopes.ts change that isn't followed
// by `bun run generate:litellm-schemas` (+ committing the diff) fails
// `bun test` here instead of silently shipping a stale schema.
describe("committed generated-json-schemas/*.json — drift check", () => {
  test("one committed file exists per jsonSchemaRoles entry, and no extra/orphaned files", () => {
    const committedFiles = readdirSync(GENERATED_SCHEMA_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .sort();
    const expectedRoleNames = Object.keys(jsonSchemaRoles).sort();
    expect(committedFiles).toEqual(expectedRoleNames);
  });

  test("every committed file is byte-identical to a fresh regeneration from the current envelopes.ts schemas — stale means someone edited envelopes.ts without re-running `bun run generate:litellm-schemas`", () => {
    const fresh = allResponseFormats();

    for (const roleName of Object.keys(jsonSchemaRoles)) {
      const committedPath = join(GENERATED_SCHEMA_DIR, `${roleName}.json`);
      const committedText = readFileSync(committedPath, "utf8");
      const committedParsed: unknown = JSON.parse(committedText);

      // Deep-equal on the parsed structure (not string equality) so this
      // test cares about SHAPE drift, not incidental formatting — but also
      // require the committed text to match generate-litellm-schemas.ts's
      // own serialization exactly (2-space indent + trailing newline), so a
      // hand-edited-but-structurally-equivalent file still fails: the
      // whole point of "generated, not hand-written" (Plan step 1) is that
      // nobody hand-edits these.
      expect(committedParsed, `${roleName}.json's parsed content has drifted from a fresh regeneration`).toEqual(fresh[roleName]);
      expect(committedText, `${roleName}.json's serialized text doesn't match generate-litellm-schemas.ts's own output format (2-space indent + trailing newline) — was it hand-edited instead of regenerated?`).toBe(
        `${JSON.stringify(fresh[roleName], null, 2)}\n`,
      );
    }
  });
});
