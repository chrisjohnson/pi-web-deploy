/**
 * pi-web-factory-prompts: a pi-coding-agent EXTENSION (NOT a pi-web browser-UI
 * plugin -- those are a different mechanism, see pi-continue-companion in
 * this same plugins/ dir for that other kind) that gives each pi-web-factory
 * agent role (plan/build/review/scout/document) a TRUE system prompt via the
 * `before_agent_start` hook, replacing the interim workaround of prepending
 * role-identity text to the first user-turn prompt.
 *
 * ── Why this exists (M-069) ──────────────────────────────────────────────
 * See `pi-web-adw-design.md` §1.4 at the repo root for the full evidence
 * trail. Short version: pi-web's `POST /sessions` has no `systemPrompt`
 * parameter anywhere in its stack (confirmed at the SDK level, not just the
 * HTTP layer), but pi-coding-agent's extension system exposes exactly the
 * right hook for this: `before_agent_start` fires after the user submits a
 * prompt and before the agent loop starts, and its result can carry a
 * `systemPrompt` override -- chained across every extension that returns
 * one. `pi-continue` (a real, already-deployed extension in this exact
 * stack, `npm:pi-continue`, see its own `extensions/continue/index.ts:155`)
 * already uses this same hook for an unrelated purpose (recognising its own
 * continuation-resume prompt by exact string match against `event.prompt`),
 * which is the closest real precedent for the marker-matching approach used
 * here.
 *
 * ── The marker mechanism ─────────────────────────────────────────────────
 * `before_agent_start`'s `BeforeAgentStartEventResult` has NO way to replace
 * or strip the visible prompt text itself (only `systemPrompt` and an
 * optional injected `message` are controllable) -- confirmed directly
 * against the installed `@earendil-works/pi-coding-agent@0.82.1` SDK's
 * `.d.ts` (`BeforeAgentStartEventResult` in `dist/core/extensions/types.d.ts`
 * has exactly two fields, `message?` and `systemPrompt?`; no `prompt`
 * field). `startupToken` (pi-web's own `POST /sessions {cwd, startupToken}`
 * field) was the leading marker candidate going in, but it does not exist
 * ANYWHERE in the pi-coding-agent SDK (grepped the whole installed package,
 * zero hits) -- it never crosses the pi-web HTTP layer into the agent
 * runtime's extension event system at all, so it is not reachable here.
 * `event.prompt` (the raw user prompt text, always present on
 * `BeforeAgentStartEvent`) is what IS reachable, so the marker rides there
 * instead: pi-web-factory's chain code (`chains/planBuildTest.ts`) prefixes
 * the very first prompt sent to a freshly-started session with a short tag,
 * `[[pi-web-factory:role=<name>]]`, on its own line. This extension detects
 * that prefix, maps `<name>` to the matching entry in `roles.json`, and
 * returns it as `systemPrompt`. The tag stays visible in the prompt text
 * (there is no way to strip it, per the point above) but it is short and
 * self-explanatory, a much smaller footprint than today's full prepended
 * role paragraph -- and unlike that paragraph, the ACTUAL role framing now
 * lives in a true system prompt, structurally immune to compaction and
 * recomputed fresh at session bootstrap regardless of message history
 * (design doc §1.4's whole point).
 *
 * ── Where the role -> prompt mapping lives (deliberate short-term dup) ────
 * `pi-web-factory` itself is not yet baked into the `jmfederico-pi-web`
 * container (that's M-068, sequenced after this card), so this extension
 * cannot read `pi-web-factory/factory.config.yaml` off the same filesystem.
 * Instead the mapping is bundled directly alongside this extension's own
 * code, `roles.json` in this same directory, deployed via the exact same
 * COPY-into-image + always-synced-on-container-start mechanism as this
 * extension itself (see Dockerfile / docker-entrypoint.sh). This
 * necessarily duplicates the *content* (not the schema) of the role
 * identities described in `factory.config.yaml`'s `agents:` roster and
 * adapted from what `chains/planBuildTest.ts` used to prepend to prompt
 * text -- NOT an oversight, a deliberate short-term seam. M-075 (unify
 * config) is the tracked follow-up to collapse this back to one source of
 * truth once pi-web-factory's own files ARE reachable from inside the
 * container.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Prompt prefix pi-web-factory's chain code puts on the first prompt of a
 * freshly-started session. Must match the constant chains/planBuildTest.ts
 * builds with (search that file for ROLE_MARKER_PREFIX's ported value if
 * this ever needs to change -- keep both sides in sync, same "synced pair"
 * discipline envelopes.ts's header comment describes for schema/prompt/
 * call-site triads).
 */
const ROLE_MARKER_PREFIX = "[[pi-web-factory:role=";
const ROLE_MARKER_SUFFIX = "]]";

interface RolesFile {
  roles: Record<string, string>;
}

function loadRoles(): Record<string, string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(join(here, "roles.json"), "utf8");
  const parsed = JSON.parse(raw) as RolesFile;
  return parsed.roles;
}

/**
 * Parses a leading `[[pi-web-factory:role=<name>]]` marker off a prompt's
 * first line. Returns the role name, or undefined if the prompt doesn't
 * start with the marker (an ordinary, non-factory session -- this extension
 * must be a no-op for those, never assume every session it sees is ours).
 */
export function parseRoleMarker(prompt: string): string | undefined {
  if (!prompt.startsWith(ROLE_MARKER_PREFIX)) return undefined;
  const closeIdx = prompt.indexOf(ROLE_MARKER_SUFFIX, ROLE_MARKER_PREFIX.length);
  if (closeIdx === -1) return undefined;
  const role = prompt.slice(ROLE_MARKER_PREFIX.length, closeIdx).trim();
  return role.length > 0 ? role : undefined;
}

export default function piWebFactoryPromptsExtension(pi: ExtensionAPI) {
  let roles: Record<string, string>;
  try {
    roles = loadRoles();
  } catch (error) {
    // Fail soft: a broken/missing roles.json must not take down every
    // session in the container, just leave this extension a no-op (matches
    // how a non-factory session already falls through untouched below).
    console.error(`[pi-web-factory-prompts] failed to load roles.json: ${String(error)}`);
    roles = {};
  }

  pi.on("before_agent_start", async (event) => {
    const role = parseRoleMarker(event.prompt);
    if (role === undefined) return undefined; // not a pi-web-factory session -- no-op

    const rolePrompt = roles[role];
    if (rolePrompt === undefined) {
      console.error(
        `[pi-web-factory-prompts] session prompt named role ${JSON.stringify(role)}, ` +
          `which has no entry in roles.json (known roles: ${Object.keys(roles).join(", ") || "(none loaded)"})`,
      );
      return undefined;
    }

    // Chain onto whatever system prompt earlier extensions/base config
    // already assembled (event.systemPrompt), same pattern as the SDK's own
    // pirate.ts example -- never blindly overwrite it.
    console.error(`[pi-web-factory-prompts] injecting system prompt for role=${role}`);
    return {
      systemPrompt: `${event.systemPrompt}\n\n${rolePrompt}`,
    };
  });
}
