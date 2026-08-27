/**
 * Unit tests for parseRoleMarker, the pure marker-parsing logic
 * before_agent_start's handler uses. Run standalone with `bun test` from
 * this directory — this package has no build step and is not part of the
 * pi-web-factory bun workspace (it's a separately-deployed extension, see
 * this directory's index.ts header comment and the repo Dockerfile's COPY
 * step). Kept dependency-free (no pi-coding-agent SDK import needed here)
 * so it can run without installing the SDK locally.
 */

import { describe, expect, test } from "bun:test";
import { parseRoleMarker } from "./index.ts";

describe("parseRoleMarker", () => {
  test("extracts the role name from a well-formed marker at the start of the prompt", () => {
    expect(parseRoleMarker("[[pi-web-factory:role=build]]\nTask: do the thing")).toBe("build");
  });

  test("extracts the role name even with no trailing text", () => {
    expect(parseRoleMarker("[[pi-web-factory:role=plan]]")).toBe("plan");
  });

  test("returns undefined for a prompt with no marker at all (an ordinary, non-factory session)", () => {
    expect(parseRoleMarker("just a normal prompt")).toBeUndefined();
  });

  test("returns undefined when the marker is present but not at the very start", () => {
    expect(parseRoleMarker("preamble [[pi-web-factory:role=build]]\ntask")).toBeUndefined();
  });

  test("returns undefined for an unterminated marker (no closing ]])", () => {
    expect(parseRoleMarker("[[pi-web-factory:role=build\ntask")).toBeUndefined();
  });

  test("returns undefined for an empty role name", () => {
    expect(parseRoleMarker("[[pi-web-factory:role=]]\ntask")).toBeUndefined();
  });

  test("trims surrounding whitespace inside the marker", () => {
    expect(parseRoleMarker("[[pi-web-factory:role= review ]]\ntask")).toBe("review");
  });
});
