/**
 * envelopeJsonSchema.ts: converts `envelopes.ts`'s Zod schemas into the
 * litellm/OpenAI `response_format: {type: "json_schema", json_schema: {...}}`
 * shape (M-113).
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * M-113 investigated (and confirmed, empirically, against a real pi-web
 * session) that pi-web has no per-request `response_format` passthrough —
 * dynamic, per-Step schema forcing straight from `envelopes.ts` (Chris's
 * original preference) is not possible with pi-web as it exists today. Chris
 * picked the fallback already proven for `pi-continue` (litellm-role-
 * bundling, `docker/litellm/pi-continue-v4-schema.json` +
 * `scripts/litellm-bootstrap.sh`'s `CONTINUE_JSON_ROLES`): one DB-backed
 * litellm role per (base-model, schema) pair, carrying the schema HARDCODED
 * into that role's `litellm_params.response_format`. This module is the
 * "generated from envelopes.ts, not hand-written" half of that — see the
 * card's Plan step 1 for the source instruction. `pi-continue-v4-schema.json`
 * stays a separate, hand-maintained file (a different upstream project,
 * `pi-continue`, not `envelopes.ts`) — this module does not touch it.
 *
 * ── Conversion mechanism: Zod v4's own `z.toJSONSchema`, no new dependency ──
 * `package.json` already pins `zod: ^4.4.3` (checked per the card's Plan
 * step 1 instruction to look for a `zod-to-json-schema`-equivalent before
 * adding one) — Zod v4 ships a built-in `z.toJSONSchema()` that produces
 * exactly the shape litellm/OpenAI strict-mode `response_format` needs:
 * every property (including ones carrying a Zod `.default()`) lands in the
 * schema's own `required` array, and every object (including nested ones,
 * e.g. `ScoutOutputSchema`'s `findings[].{file,note}`) gets
 * `additionalProperties: false` recursively — confirmed empirically against
 * this repo's real `envelopeSchemas` shapes before relying on it here. No
 * `zod-to-json-schema` (or similar) package needed.
 *
 * ── `name`/`strict` wrapping ───────────────────────────────────────────────
 * `z.toJSONSchema()` only produces the bare JSON Schema (the `schema` key);
 * this module wraps it into the full litellm `response_format` object,
 * mirroring `pi-continue-v4-schema.json`'s own shape
 * (`{type: "json_schema", json_schema: {name, strict: true, schema}}`).
 * `strict: true` is what makes the backing engine's grammar-constrained
 * decoder actually enforce the schema, not just document it.
 */

import { z } from "zod";
import { envelopeSchemas, type AgentIdentity } from "./envelopes.ts";
import { RetryDecisionOutputSchema } from "./envelopes.ts";

/** The litellm/OpenAI `response_format` shape — same as `pi-continue-v4-schema.json`'s top level. */
export interface ResponseFormat {
  type: "json_schema";
  json_schema: {
    name: string;
    strict: true;
    schema: Record<string, unknown>;
  };
}

/**
 * Converts one Zod envelope schema into a full `response_format` object.
 * `name` becomes the JSON Schema's own `json_schema.name` — must be a
 * short, stable identifier (litellm/OpenAI require it match
 * `^[a-zA-Z0-9_-]+$`), NOT the litellm role name (the role name additionally
 * carries the base-model prefix — see `litellmJsonRoleName` below — while
 * this name only ever needs to identify the SCHEMA itself).
 */
export function envelopeResponseFormat(name: string, schema: z.ZodType): ResponseFormat {
  return {
    type: "json_schema",
    json_schema: {
      name,
      strict: true,
      schema: z.toJSONSchema(schema) as Record<string, unknown>,
    },
  };
}

/**
 * Every envelope schema this project's Roles need `response_format` forcing
 * for, keyed by the SAME name used in two other places that must stay in
 * sync with this map (see `envelopeJsonSchema.test.ts` for the check
 * that enforces it):
 *   - `envelopeSchemas` (envelopes.ts) for the five Step-facing identities
 *     (plan/build/review/scout/document) — `decide-retry` is deliberately
 *     NOT in that registry (see envelopes.ts's own comment on
 *     `RetryDecisionOutputSchema` — it isn't a Workflow Step and isn't
 *     looked up via `envelopeSchemaForRole`), so it's added here explicitly.
 *   - `factory.config.yaml`'s `roles:` list — every key below must also be
 *     an agent Role name there.
 */
export const jsonSchemaRoles = {
  ...envelopeSchemas,
  "decide-retry": RetryDecisionOutputSchema,
} as const;

export type JsonSchemaRoleName = keyof typeof jsonSchemaRoles | AgentIdentity;

/**
 * Builds every Role's `response_format`, keyed by ROLE NAME (plan/build/
 * review/scout/document/decide-retry) — NOT yet the litellm role name
 * (`litellmJsonRoleName` below adds the base-model prefix once the caller
 * knows which base model a given Role is pinned to).
 */
export function allResponseFormats(): Record<string, ResponseFormat> {
  const out: Record<string, ResponseFormat> = {};
  for (const [roleName, schema] of Object.entries(jsonSchemaRoles)) {
    // json_schema.name: litellm/OpenAI require ^[a-zA-Z0-9_-]+$ — role names
    // here are already hyphenated lowercase (no dots/slashes), so a
    // straight pass-through is safe; still route through one place so a
    // future role name with different characters fails visibly instead of
    // silently producing an invalid response_format.
    if (!/^[a-zA-Z0-9_-]+$/.test(roleName)) {
      throw new Error(`envelopeJsonSchema: role name ${JSON.stringify(roleName)} is not a valid json_schema.name (must match ^[a-zA-Z0-9_-]+$)`);
    }
    out[roleName] = envelopeResponseFormat(`pi_web_factory_${roleName.replace(/-/g, "_")}_v1`, schema);
  }
  return out;
}

/**
 * The litellm role-naming convention (M-113 Plan step 2, Chris's decided
 * option 1): one role per (base-model, schema) pair, named
 * `<baseModel>-<roleName>-json`, mirroring `medium-moe-continue-json`'s
 * existing `-json` suffix pattern (`docker/litellm/config.yaml`'s own
 * naming, `scripts/litellm-bootstrap.sh`'s `CONTINUE_JSON_ROLES`).
 * `baseModel` is the litellm role a factory.config.yaml agent Role's
 * `model:` field currently names (e.g. "big-moe", "medium-moe") — the value
 * on the LEFT of the `/` is a provider prefix (`local-litellm`) stripped
 * before this function is called, not passed in here.
 */
export function litellmJsonRoleName(baseModel: string, roleName: string): string {
  return `${baseModel}-${roleName}-json`;
}
