#!/usr/bin/env bun
/**
 * generate-litellm-schemas.ts (M-113): writes one JSON file per
 * `modules/envelopeJsonSchema.ts`'s `jsonSchemaRoles` entry into
 * `../../docker/litellm/generated-json-schemas/<roleName>.json` — the full
 * litellm/OpenAI `response_format` object (`{type: "json_schema",
 * json_schema: {name, strict, schema}}`), generated straight from
 * `envelopes.ts`'s Zod schemas via `z.toJSONSchema()`.
 *
 * ── Why committed, generated files instead of a live bun call from bootstrap
 * `scripts/litellm-bootstrap.sh` runs on the litellm host directly (no bun/
 * node runtime assumed there — see that script's own header, it's plain
 * bash + python3 + curl). Rather than adding a cross-language runtime
 * dependency to the bootstrap path, this script is run HERE (inside
 * `pi-web-factory`, where bun already is the runtime) at commit time, and
 * its output is committed to git — the same "hand-maintained mirror,
 * reviewable in the PR diff" spirit as `docker/litellm/
 * pi-continue-v4-schema.json` (M-113's own card explicitly calls out
 * generated-not-hand-written as the goal; committing the generated output
 * satisfies both: still generated FROM envelopes.ts, not typed by hand, but
 * `litellm-bootstrap.sh` stays a pure bash/python3/curl script with no new
 * runtime dependency).
 *
 * Re-run this (`bun run generate-litellm-schemas.ts` from this directory,
 * or `bun run generate:litellm-schemas` per package.json) any time
 * `envelopes.ts` changes and commit the diff — `envelopeJsonSchema.test.ts`
 * does NOT re-run this generator itself (a test suite shouldn't write repo
 * files as a side effect); it only checks the conversion LOGIC. A stale
 * generated file after an envelopes.ts edit is a real drift risk this
 * script's own output makes visible in `git diff`, not a silent runtime gap
 * (the wrong role would just be seeded with the old schema next bootstrap).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { allResponseFormats } from "./modules/envelopeJsonSchema.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../../docker/litellm/generated-json-schemas");

mkdirSync(outDir, { recursive: true });

const formats = allResponseFormats();
for (const [roleName, responseFormat] of Object.entries(formats)) {
  const outPath = resolve(outDir, `${roleName}.json`);
  writeFileSync(outPath, `${JSON.stringify(responseFormat, null, 2)}\n`, "utf8");
  console.log(`wrote ${outPath}`);
}
