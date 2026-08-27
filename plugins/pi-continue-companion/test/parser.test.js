// Standalone parser test — run with plain `node`, no framework/build step.
//   node jmfederico-pi-web/plugins/pi-continue-companion/test/parser.test.js

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

import { parseContinueHandoff } from "../continueHandoffParser.js";
import { decodeSessionLabel } from "../continueDiscovery.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readFixture(name) {
  return readFileSync(path.join(__dirname, "fixtures", name), "utf8");
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

// --- Real live handoff file (copied from the box) ---------------------------
section("Real handoff file: fixtures/real-example.md");
const real = parseContinueHandoff(readFixture("real-example.md"));
console.log(JSON.stringify(real, null, 2));

assert.equal(real.task.startsWith("Review all recent AMS code"), true, "task text should be parsed");
assert.equal(
  real.doneWhen.startsWith("Spec doc written"),
  true,
  "doneWhen text should be parsed",
);
assert.deepEqual(real.forbid, [], "no Forbid section present -> empty array, not a throw");
assert.equal(real.established.length, 11, "expected 11 Established entries");
assert.equal(real.learned.length, 3, "expected 3 Learned entries");
assert.equal(real.open.length, 1, "expected 1 Open entry");
assert.equal(real.next.length, 4, "expected 4 Next entries");

// Spot-check field extraction on one Established entry.
const firstEstablished = real.established[0];
assert.equal(firstEstablished.claim.startsWith("Frontend `amsHtml()`"), true);
assert.equal(firstEstablished.evidence, "internal/server/onboarding.go:1600-1690");
assert.equal(firstEstablished.basis, "observed");
assert.equal(firstEstablished.reopen, "if onboarding.go frontend functions are edited again");

// Spot-check a Next entry (uses arrow, not em dash).
const firstNext = real.next[0];
assert.equal(firstNext.action.startsWith("Fix brace mismatch"), true);
assert.equal(firstNext.outcome, "No compile errors when running `go vet` or `go test` on `parser_test.go`.");

// Spot-check the Open entry (uses "verifies:"). This entry's value contains
// several semicolons of its own -- regression check that the parser doesn't
// truncate at the first one.
const firstOpen = real.open[0];
assert.equal(firstOpen.question.startsWith("Syntax error at"), true);
assert.equal(
  firstOpen.verifies,
  "Count braces after `Trays: []printers.FilamentSlot{`; replace the excessive `}}}}}` with `}}},` to close Trays slice, AMSUnit struct, and want slice; ensure subsequent `},` and `}` match test case and slice closures.",
  "verifies value should not be truncated at internal semicolons",
);

console.log("\nAll assertions passed for real-example.md");

// --- Minimal handoff: only Task/Done When, no bullet sections at all -------
section("Minimal handoff file: fixtures/minimal-example.md");
const minimal = parseContinueHandoff(readFixture("minimal-example.md"));
console.log(JSON.stringify(minimal, null, 2));

assert.equal(minimal.task, "Fix the failing test.");
assert.equal(minimal.doneWhen, "`go test ./...` passes.");
assert.deepEqual(minimal.forbid, []);
assert.deepEqual(minimal.established, []);
assert.deepEqual(minimal.learned, []);
assert.deepEqual(minimal.open, []);
assert.deepEqual(minimal.next, []);
console.log("All assertions passed for minimal-example.md (no crash on missing sections)");

// --- Fully empty / garbage input --------------------------------------------
section("Edge cases: empty string, undefined, garbage text");
for (const input of ["", undefined, null, "not markdown at all, just prose"]) {
  const result = parseContinueHandoff(input);
  assert.equal(result.task, "");
  assert.equal(result.doneWhen, "");
  assert.deepEqual(result.forbid, []);
  assert.deepEqual(result.established, []);
  assert.deepEqual(result.learned, []);
  assert.deepEqual(result.open, []);
  assert.deepEqual(result.next, []);
}
console.log("All assertions passed for empty/garbage input (no throw)");

// --- Session label decoding --------------------------------------------------
section("decodeSessionLabel");
const label = decodeSessionLabel("MDE5ZmM0NzYtNjEwZC03NmIyLWFmMWEtY2VhMDVmYzk5Y2Yw.md");
console.log(label);
assert.equal(label, "019fc476-610d-76b2-af1a-cea05fc99cf0");
assert.equal(decodeSessionLabel("not-base64!!.md"), "not-base64!!");

console.log("\nAll parser tests passed.");
