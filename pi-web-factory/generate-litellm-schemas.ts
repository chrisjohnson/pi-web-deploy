#!/usr/bin/env bun
/**
 * generate-litellm-schemas.ts (M-113): writes one JSON file per
 * `modules/envelopeJsonSchema.ts`'s `jsonSchemaRoles` entry into
 * `generated-json-schemas/<roleName>.json` — the full litellm/OpenAI
 * `response_format` object (`{type: "json_schema", json_schema: {name,
 * strict, schema}}`), generated straight from `envelopes.ts`'s Zod
 * schemas via `z.toJSONSchema()`.
 *
 * ── Why committed, generated files instead of a live bun call from bootstrap
 * local-ai-machine's `scripts/litellm-bootstrap.sh` runs on the litellm
 * host directly (no bun/node runtime assumed there) and keeps its OWN
 * independently-committed copy at `docker/litellm/generated-json-schemas/`
 * — deliberately NOT read from this repo (M-134: the two extracted repos
 * don't reach across the split to read each other's generated output; if
 * envelopes.ts changes here, someone re-runs this generator, reviews the
 * diff, and separately updates local-ai-machine's own copy by hand, same
 * as any other cross-repo schema change — see envelopes.ts for whether
 * these are version-tagged yet). This repo's own committed copy exists so
 * `envelopeJsonSchema.test.ts` has something to drift-check the generator
 * LOGIC against, not to be consumed by local-ai-machine at all.
 *
 * Re-run this (`bun run generate-litellm-schemas.ts` from this directory,
 * or `bun run generate:litellm-schemas` per package.json) any time
 * `envelopes.ts` changes and commit the diff — `envelopeJsonSchema.test.ts`
 * does NOT re-run this generator itself (a test suite shouldn't write repo
 * files as a side effect); it only checks the conversion LOGIC. A stale
 * generated file after an envelopes.ts edit is a real drift risk this
 * script's own output makes visible in `git diff`, not a silent runtime gap.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { allResponseFormats } from "./modules/envelopeJsonSchema.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "generated-json-schemas");

mkdirSync(outDir, { recursive: true });

const formats = allResponseFormats();
for (const [roleName, responseFormat] of Object.entries(formats)) {
  const outPath = resolve(outDir, `${roleName}.json`);
  writeFileSync(outPath, `${JSON.stringify(responseFormat, null, 2)}\n`, "utf8");
  console.log(`wrote ${outPath}`);
}
