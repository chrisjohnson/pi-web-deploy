/**
 * piwebClient: the execution primitive that replaces upstream SSSF's
 * `agent_pi.py` (which spawns a bare `pi` CLI subprocess and tails its JSONL
 * stdout — confirmed not available on PATH anywhere in the running
 * `jmfederico-pi-web` container). Instead this talks to pi-web's own session
 * REST/WebSocket API over HTTP, as a sibling process in the same container
 * (loopback) or, for standalone dev/test, straight at the LAN address.
 *
 * Route shapes below are ported from `@jmfederico/pi-web@1.202607.3` source
 * (`src/server/sessions/sessionRoutes.ts`, `src/shared/apiTypes.ts`) and
 * confirmed live against the real running instance at
 * `http://192.168.1.21:8080/api` — see `piwebClient.integration.test.ts`.
 *
 * See `pi-web-adw-design.md` §1.3 (API surface) and §3.2 (execution
 * pseudocode this module implements).
 */

// ── Ported wire types (subset of src/shared/apiTypes.ts we actually use) ──

export interface SessionModel {
  provider?: string;
  id?: string;
  name?: string;
  contextWindow?: number;
  reasoning?: unknown;
}

export interface QueuedSessionMessage {
  kind: "steer" | "followUp";
  text: string;
}

export interface AskUserQuestionOption {
  value: string;
  label: string;
  detail?: string;
}

export interface AskUserQuestion {
  id: string;
  question: string;
  detail?: string;
  options: AskUserQuestionOption[];
  allowOther?: boolean;
  multiple?: boolean;
}

export interface PendingAskUser {
  askId: string;
  askedAt: string;
  questions: AskUserQuestion[];
}

export type SessionWarningSeverity = "info" | "warning" | "error";

export interface SessionWarning {
  severity: SessionWarningSeverity;
  message: string;
  source?: string;
  path?: string;
  dismiss?: { id: string };
}

/** `GET /sessions/:id/status` response shape (also returned by `POST /model`). */
export interface SessionStatus {
  sessionId: string;
  persisted?: boolean;
  model?: SessionModel;
  thinkingLevel?: string;
  isStreaming: boolean;
  isCompacting: boolean;
  isBashRunning: boolean;
  pendingMessageCount: number;
  queuedMessages: QueuedSessionMessage[];
  messageCount?: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
  warnings?: SessionWarning[];
  pendingAsk?: PendingAskUser;
  pendingDialogs?: unknown[];
}

/** `POST /sessions` response shape (a `SessionInfo`). */
export interface SessionInfo {
  id: string;
  path: string;
  cwd: string;
  persisted?: boolean;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
}

/**
 * One entry of `GET /sessions/:id/messages`'s transcript array — the
 * `projectBrowserMessageResponse` projection of pi's own persisted session
 * messages, not raw JSONL. Only the fields we actually read are typed; the
 * rest of the shape (usage, stopReason, provider/model, etc.) is passed
 * through untouched.
 */
export interface SessionMessageContentPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface SessionMessage {
  role: "user" | "assistant" | "toolResult";
  content: SessionMessageContentPart[];
  timestamp?: number;
  [key: string]: unknown;
}

export interface MessagePage {
  messages: SessionMessage[];
  start: number;
  total: number;
}

/** Transport-level event envelope on `GET /sessions/:id/events` (WebSocket). */
export type SessionUiEvent = { type: string; seq?: number; [key: string]: unknown };

// ── Config ──────────────────────────────────────────────────────────────

/**
 * Default base URL for this box's `jmfederico-pi-web` instance, LAN-reachable.
 *
 * Overridable via `PI_WEB_FACTORY_BASE_URL` — added 2026-08-05 after the
 * hardcoded LAN IP went stale mid-session (the box's wired interface dropped,
 * DHCP reassigned a new address on WiFi: `192.168.1.21` -> `192.168.1.226`),
 * breaking every dev/test invocation until the constant was updated by hand.
 * This is a genuinely dev-only convenience value — once pi-web-factory is
 * baked into the `jmfederico-pi-web` container itself (M-068), the real
 * default becomes a loopback address (design doc §2), which won't have this
 * problem at all. Until then, the env var means a future IP change is a
 * one-line shell export, not a code edit + redeploy.
 */
export const DEFAULT_BASE_URL = process.env["PI_WEB_FACTORY_BASE_URL"] ?? "http://192.168.1.226:8080/api";

export class PiWebClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "PiWebClientError";
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown;
  try {
    body = text === "" ? undefined : JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    const detail = isRecord(body) && typeof body["error"] === "string" ? body["error"] : text || res.statusText;
    throw new PiWebClientError(`pi-web request failed (${String(res.status)}): ${detail}`, res.status);
  }
  return body as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── Role marker (M-069: true system prompt via before_agent_start) ───────

/**
 * Builds the `[[pi-web-factory:role=<name>]]` marker `pi-web-factory-prompts`
 * (the pi-coding-agent EXTENSION at
 * `jmfederico-pi-web/plugins/pi-web-factory-prompts/index.ts`, baked into
 * the `jmfederico-pi-web` container) matches against a prompt's text to
 * decide which role's system prompt to inject via `before_agent_start` for
 * that turn — the extension only sees `event.prompt` at that hook, there is
 * no separate out-of-band channel (`startupToken`, `POST /sessions`' own
 * opaque label field, does not reach the pi-coding-agent extension runtime
 * at all — confirmed absent, zero references, in the installed
 * `@earendil-works/pi-coding-agent@0.82.1` SDK — see `pi-web-adw-design.md`
 * §1.4 and the extension's own header comment for the full trail).
 *
 * `before_agent_start` fires on EVERY prompt submission, not just a
 * session's first (confirmed against the pi-coding-agent SDK's own
 * `extensions.md` lifecycle diagram) — the injected system prompt from a
 * previous turn does not persist automatically. So this marker must ride on
 * every prompt for a given role's turn, including retry-on-parse-failure
 * corrections within the same phase, not just a session's opening prompt.
 * `run.ts`'s `runAgentPhase` takes this as `promptPrefix` and re-applies it
 * on every `sendPrompt` call within a phase (its own doc comment explains
 * why) — call sites should generally use that rather than pre-concatenating
 * with `roleMarkerPrompt` below, which only covers a single prompt.
 *
 * This is the real system-prompt delivery mechanism now — chain code no
 * longer prepends full role-identity paragraphs to prompt text itself (that
 * text now lives once, in `plugins/pi-web-factory-prompts/roles.json`, kept
 * in sync with this constant by hand until M-075 unifies config).
 */
export function roleMarker(role: string): string {
  return `[[pi-web-factory:role=${role}]]`;
}

/**
 * Prepends `roleMarker(role)` to `promptText` on its own line, for the rare
 * one-shot call site that sends a single prompt outside `runAgentPhase`'s
 * `promptPrefix` machinery. Most chain code should prefer passing
 * `promptPrefix: roleMarker(role)` to `runAgentPhase` instead, so the marker
 * survives retries within a phase too.
 */
export function roleMarkerPrompt(role: string, promptText: string): string {
  return `${roleMarker(role)}\n${promptText}`;
}

// ── Session lifecycle ───────────────────────────────────────────────────

/**
 * `POST /sessions {cwd, startupToken}` — starts a new session. `cwd` must be
 * a non-empty absolute path; no project/workspace pre-registration required.
 * `startupToken` is an opaque label the caller can use to recognise its own
 * construction's startup reports (see `session.startup` WS event); optional.
 */
export async function startSession(baseUrl: string, cwd: string, startupToken?: string): Promise<SessionInfo> {
  return requestJson<SessionInfo>(`${baseUrl}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(startupToken === undefined ? { cwd } : { cwd, startupToken }),
  });
}

/**
 * `POST /sessions/:id/model {provider, modelId, cwd}` — pins the session's
 * model. Returns the resulting `SessionStatus` (the route echoes the full
 * status, not just an ack — confirmed live).
 *
 * `cwd` is REQUIRED by pi-web's route today (confirmed live 2026-08-13,
 * `{"error":"cwd field must be a string"}` on a request that omits it) —
 * this function previously didn't send it at all (an API-drift gap, not
 * a regression from a working state), which broke every real Workflow
 * Run's very first model-pin call. Must be the SAME cwd `startSession`
 * was called with for this session (its own worktree path) — callers
 * already have this in scope.
 */
export async function setModel(
  baseUrl: string,
  sessionId: string,
  provider: string,
  modelId: string,
  cwd: string,
): Promise<SessionStatus> {
  return requestJson<SessionStatus>(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/model`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, modelId, cwd }),
  });
}

/**
 * `POST /sessions/:id/prompt {text, cwd}` — sends a message.
 * **Fire-and-forget**: the response is `{accepted: true}` the instant the
 * server has queued the message, well before the model has produced (or
 * even started producing) a reply. Do NOT treat this response as turn
 * completion — use `waitForCompletion` for that.
 *
 * `cwd` is REQUIRED by pi-web's route today (confirmed live 2026-08-13,
 * same API-drift class as `setModel`'s own `cwd` requirement — see that
 * function's doc comment). Must be the session's own cwd.
 */
export async function prompt(baseUrl: string, sessionId: string, text: string, cwd: string): Promise<{ accepted: true }> {
  return requestJson<{ accepted: true }>(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, cwd }),
  });
}

/**
 * `GET /sessions/:id/status?cwd=` — current streaming/ask/usage state.
 * `cwd` is REQUIRED (confirmed live 2026-08-13, `{"error":"cwd query
 * parameter is required"}` without it — same API-drift class as
 * `setModel`).
 */
export async function getStatus(baseUrl: string, sessionId: string, cwd: string): Promise<SessionStatus> {
  return requestJson<SessionStatus>(
    `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/status?cwd=${encodeURIComponent(cwd)}`,
  );
}

/**
 * `GET /sessions/:id/messages?cwd=` — structured transcript
 * (`projectBrowserMessageResponse`'s output), not raw session-file JSONL.
 * `cwd` is REQUIRED (confirmed live 2026-08-13, `{"error":"cwd query
 * parameter is required"}` without it — same API-drift class as
 * `setModel`).
 *
 * **The response is a `MessagePage` envelope (`{messages, start, total}`),
 * NOT a bare array** — confirmed live 2026-08-13 (M-114 follow-up). This
 * function used to treat the response itself as `SessionMessage[]`
 * directly (stale — the "no paging params -> bare array" assumption in
 * this doc comment no longer holds against the currently-installed pi-web
 * version), which meant `messages.length` was silently `undefined` and
 * `lastAssistantText`'s `for` loop (`i = messages.length - 1`, i.e. `NaN`)
 * never executed, ALWAYS returning `undefined` regardless of how many
 * times the message-settle retry in `getMessagesSettled` retried — a much
 * simpler, more severe bug than the settle-race timing issue it was
 * mistaken for across a full day of live debugging (real response
 * confirmed available in the transcript within 11ms of the prompt in one
 * directly-traced case, yet the 21-SECOND exponential-backoff retry
 * budget still exhausted and returned empty — proving this was never a
 * timing problem at all).
 */
export async function getMessages(baseUrl: string, sessionId: string, cwd: string): Promise<SessionMessage[]> {
  const page = await requestJson<MessagePage>(
    `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/messages?cwd=${encodeURIComponent(cwd)}`,
  );
  return page.messages;
}

/**
 * Extracts the last assistant message's text content from a transcript
 * (concatenating all `type: "text"` content parts, in order — an assistant
 * message may carry `thinking` parts alongside `text`, which are excluded).
 * Returns `undefined` when no assistant message exists yet.
 */
export function lastAssistantText(messages: SessionMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    const text = message.content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("");
    return text;
  }
  return undefined;
}

// ── Completion wait-loop ────────────────────────────────────────────────

/**
 * Default `waitForCompletion` timeout, overridable via
 * `PI_WEB_FACTORY_STEP_TIMEOUT_MS` (M-094) — matches this module's own
 * `PI_WEB_FACTORY_BASE_URL` convention. Needed once a Step's completion
 * request can genuinely queue behind another model's full generation (the
 * cross-model request-serialization proxy, M-094) — 120s was sized for
 * "pi-web is just slow sometimes," not "this request may sit behind someone
 * else's multi-minute generation before it even starts." Only affects
 * pi-web-factory's own automated wait-loop; a human's own pi-web browser
 * session never runs this code (see this function's own doc comment) — the
 * override cannot, by construction, change how a human waits.
 *
 * M-121 (2026-08-17): raised the code-level fallback from 120s to 30 minutes
 * (1_800_000ms) — Chris's decision, live-incident-driven: a real
 * `waitForCompletion` timeout fired on a Step whose underlying model request
 * eventually succeeded anyway (`litellm-queue-haproxy` logs confirmed it),
 * just after the Step had already given up waiting. "If the model is still
 * doing work, does the factory really even benefit by having a timeout?"
 * (Chris, verbatim) — a genuinely-still-working model shouldn't be
 * interrupted. The deployed default lives in `docker/docker-compose.yml`'s
 * own `PI_WEB_FACTORY_STEP_TIMEOUT_MS` (also raised by this card, from
 * 600000/10min to 1800000/30min); this in-code fallback is bumped to match
 * so the two never silently disagree for any invocation that skips
 * docker-compose entirely. A genuinely stuck (not just slow) Step is now
 * handled by `workflow.ts`'s circuit-breaker retry (M-121) layered on top of
 * this timeout, not by shortening the timeout itself.
 */
// Exported (M-100 Fix 2) so the orchestrator's reconciliation pass can reuse
// the SAME staleness threshold as this module's own wait-loop, rather than
// inventing a second env var/constant for "how long is too long to still be
// running" — see orchestrator/server.ts's reconciliation pass for the other
// use site.
export const DEFAULT_WAIT_FOR_COMPLETION_TIMEOUT_MS = (() => {
  const raw = process.env["PI_WEB_FACTORY_STEP_TIMEOUT_MS"];
  if (!raw) return 1_800_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1_800_000;
})();

export interface WaitForCompletionOptions {
  /** Overall timeout in ms before giving up and returning an "error" result. Default 1_800_000 (30min, M-121), or `PI_WEB_FACTORY_STEP_TIMEOUT_MS` if set. */
  timeoutMs?: number;
  /** Poll interval in ms for the `/status` fallback. Default 1500. */
  pollIntervalMs?: number;
  /** Skip the WebSocket entirely and go straight to poll-only (mainly for tests). Default false. */
  forcePollOnly?: boolean;
  /** Override for `MESSAGE_SETTLE_MAX_ATTEMPTS` (mainly for tests — avoids real multi-second exponential-backoff waits in the "gives up" case). Default: the module constant. */
  messageSettleMaxAttempts?: number;
  /** Override for `MESSAGE_SETTLE_RETRY_BASE_DELAY_MS` (mainly for tests). Default: the module constant. */
  messageSettleBaseDelayMs?: number;
}

/**
 * Base delay for `getMessagesSettled`'s exponential-backoff retry (see that
 * function's doc comment for the race this defends against). Each retry's
 * actual wait is `MESSAGE_SETTLE_RETRY_BASE_DELAY_MS * 2^(attempt-1)`,
 * capped at `MESSAGE_SETTLE_RETRY_MAX_DELAY_MS`.
 *
 * M-114 (2026-08-13): the original fixed 400ms/3-attempts budget (max
 * ~800ms of extra wait) was confirmed INSUFFICIENT under real load — a
 * live-traced failing run showed the model's response had genuinely
 * settled to valid, schema-conforming JSON, yet `run.ts`'s gate check still
 * evaluated an empty string, meaning the real settle gap exceeded that
 * budget. The SAME investigation independently proved (via HAProxy's own
 * `Tw` queue-wait timing under concurrent Workflow Run load) that real
 * end-to-end request latency under contention can run into the tens of
 * seconds — the settle-window assumption needed to grow to match, not stay
 * sized for an uncontended single-request case.
 */
export const MESSAGE_SETTLE_RETRY_BASE_DELAY_MS = 400;

/** Ceiling on any single backoff delay in `getMessagesSettled` — keeps the tail of the exponential curve from growing unboundedly. */
export const MESSAGE_SETTLE_RETRY_MAX_DELAY_MS = 5_000;

/**
 * Bounded number of `getMessages` attempts in `getMessagesSettled` — the
 * first fetch plus this many retries before giving up and returning
 * whatever the last fetch produced. Combined with the exponential backoff
 * above, 8 attempts spans roughly 400+800+1600+3200+5000+5000+5000 ≈ 21s of
 * total wait budget in the worst case — generous enough for the real
 * settle-under-contention delays M-114 observed, while still failing fast
 * (first retry or two) in the common, uncontended case. Still bounded, not
 * unbounded: a model that has genuinely produced no text after real
 * upstream retries (see `run.ts`'s own retry-on-parse-failure loop) should
 * still surface as a real failure, not be masked by this budget.
 */
export const MESSAGE_SETTLE_MAX_ATTEMPTS = 8;

export type WaitForCompletionResult =
  | { status: "done"; messages: SessionMessage[] }
  | { status: "blocked-on-human"; pendingAsk: PendingAskUser }
  | { status: "error"; detail: string };

/**
 * `getMessages`, but defends against a real, diagnosed race in pi-web's own
 * backend (no source access to pi-web to confirm authoritatively — it's a
 * prebuilt image — but strongly evidenced via a live debugging session:
 * repeated `UNPARSEABLE (step=build)` failures where the model's response
 * WAS valid JSON matching the schema when re-fetched moments later, yet the
 * live run's own immediate read got an empty final message). The apparent
 * root cause: pi-web's session-status endpoint flips `isStreaming` to
 * `false` a moment BEFORE the final assistant message's text content is
 * durably persisted/queryable via `/sessions/:id/messages` — so a caller
 * that reads messages the instant `isStreaming` goes false can race ahead
 * of pi-web's own message persistence and get an incomplete/empty result.
 * Observed empty-result shapes: a message with `text=""` (an empty `type:
 * "text"` part), and a message with ONLY a `type: "thinking"` part and no
 * `type: "text"` part at all — both treated as "not actually settled yet"
 * here (reusing `lastAssistantText`'s own notion of usable text, not a
 * reimplementation).
 *
 * Retries up to `MESSAGE_SETTLE_MAX_ATTEMPTS` total fetches, waiting an
 * EXPONENTIALLY GROWING delay between attempts (`MESSAGE_SETTLE_RETRY_
 * BASE_DELAY_MS * 2^(attempt-1)`, capped at `MESSAGE_SETTLE_RETRY_MAX_
 * DELAY_MS`) — fails fast on the common case (settles within the first
 * retry or two) while still covering the multi-second real-world gaps
 * M-114 observed under concurrent-request contention. Gives up after the
 * budget and returns whatever the last fetch produced — if the model
 * genuinely produced no text after real retries, that's a real failure and
 * should still surface as such, not be masked by this budget.
 */
async function getMessagesSettled(
  baseUrl: string,
  sessionId: string,
  cwd: string,
  maxAttempts: number = MESSAGE_SETTLE_MAX_ATTEMPTS,
  baseDelayMs: number = MESSAGE_SETTLE_RETRY_BASE_DELAY_MS,
): Promise<SessionMessage[]> {
  let messages = await getMessages(baseUrl, sessionId, cwd);
  for (let attempt = 1; attempt < maxAttempts; attempt += 1) {
    const text = lastAssistantText(messages);
    if (text !== undefined && text !== "") break;
    const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), MESSAGE_SETTLE_RETRY_MAX_DELAY_MS);
    await sleep(delay);
    messages = await getMessages(baseUrl, sessionId, cwd);
  }
  return messages;
}

/**
 * Waits for the session's in-flight turn to finish, preferring the
 * `/events` WebSocket for the authoritative `agent.end` signal (falling
 * back to a `status.update` event whose embedded status already reports
 * `isStreaming === false`), and falling back to polling `GET /status` on a
 * short interval if the socket never connects or drops before a terminal
 * signal arrives.
 *
 * There is no blocking/long-poll HTTP variant anywhere in pi-web — this is
 * the wait-loop that has to exist because of that (see design doc §1.3).
 *
 * Turn-complete = `isStreaming === false && pendingAsk === undefined`.
 * `pendingAsk` set instead means the agent is blocked on a question, a
 * distinct state from success/failure — surfaced as `blocked-on-human`,
 * never folded into `error` or a timeout.
 */
export async function waitForCompletion(
  baseUrl: string,
  sessionId: string,
  opts: WaitForCompletionOptions = {},
  cwd: string,
): Promise<WaitForCompletionResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WAIT_FOR_COMPLETION_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? 1500;
  const deadline = Date.now() + timeoutMs;

  const settleFromStatus = async (status: SessionStatus): Promise<WaitForCompletionResult | undefined> => {
    if (status.pendingAsk !== undefined) {
      return { status: "blocked-on-human", pendingAsk: status.pendingAsk };
    }
    if (!status.isStreaming) {
      const messages = await getMessagesSettled(baseUrl, sessionId, cwd, opts.messageSettleMaxAttempts, opts.messageSettleBaseDelayMs);
      return { status: "done", messages };
    }
    return undefined;
  };

  if (!opts.forcePollOnly) {
    const wsResult = await waitViaWebSocket(
      baseUrl,
      sessionId,
      deadline,
      settleFromStatus,
      cwd,
      opts.messageSettleMaxAttempts,
      opts.messageSettleBaseDelayMs,
    );
    if (wsResult !== undefined) return wsResult;
    // WebSocket failed/dropped/timed out without a terminal signal — fall through to polling
    // with whatever time remains.
  }

  return waitViaPolling(baseUrl, sessionId, deadline, pollIntervalMs, settleFromStatus, cwd);
}

function wsUrlFor(baseUrl: string, sessionId: string, cwd: string): string {
  const url = new URL(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/events`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("cwd", cwd);
  return url.toString();
}

/**
 * Holds the `/events` WebSocket open and resolves as soon as `agent.end` (or
 * an equivalent `status.update` with `isStreaming: false`) arrives, or a
 * `pendingAsk` is observed via `status.update`. Returns `undefined` (rather
 * than throwing) on connect failure, an unexpected close, or hitting the
 * deadline without a terminal signal — the caller falls back to polling.
 */
function waitViaWebSocket(
  baseUrl: string,
  sessionId: string,
  deadline: number,
  settleFromStatus: (status: SessionStatus) => Promise<WaitForCompletionResult | undefined>,
  cwd: string,
  messageSettleMaxAttempts?: number,
  messageSettleBaseDelayMs?: number,
): Promise<WaitForCompletionResult | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrlFor(baseUrl, sessionId, cwd));
    } catch {
      resolve(undefined);
      return;
    }

    const finish = (result: WaitForCompletionResult | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // already closed/closing — nothing to do
      }
      resolve(result);
    };

    const timer = setTimeout(() => finish(undefined), Math.max(0, deadline - Date.now()));

    ws.addEventListener("message", (event: MessageEvent) => {
      void (async () => {
        if (settled) return;
        const raw = event.data;
        const text = typeof raw === "string" ? raw : await bufferLikeToText(raw);
        if (text === undefined) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return;
        }
        if (!isRecord(parsed) || typeof parsed["type"] !== "string") return;
        const evt = parsed as SessionUiEvent;

        if (evt.type === "agent.end") {
          try {
            const messages = await getMessagesSettled(baseUrl, sessionId, cwd, messageSettleMaxAttempts, messageSettleBaseDelayMs);
            finish({ status: "done", messages });
          } catch (error) {
            finish({ status: "error", detail: errorDetail(error) });
          }
          return;
        }

        if (evt.type === "status.update" && isRecord(evt["status"])) {
          try {
            const result = await settleFromStatus(evt["status"] as unknown as SessionStatus);
            if (result !== undefined) finish(result);
          } catch (error) {
            finish({ status: "error", detail: errorDetail(error) });
          }
          return;
        }

        if (evt.type === "session.error") {
          const message = typeof evt["message"] === "string" ? evt["message"] : "session.error event";
          finish({ status: "error", detail: message });
        }
      })();
    });

    ws.addEventListener("error", () => finish(undefined));
    ws.addEventListener("close", () => finish(undefined));
  });
}

/** Converts a Bun/Node WebSocket message payload (Buffer/ArrayBuffer/Blob) to text. */
async function bufferLikeToText(data: unknown): Promise<string | undefined> {
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data as Uint8Array);
  if (data instanceof Blob) return data.text();
  // Bun delivers Node-style Buffer instances for text frames too.
  if (isRecord(data) && typeof (data as { toString?: unknown }).toString === "function") {
    return (data as { toString(encoding: string): string }).toString("utf8");
  }
  return undefined;
}

async function waitViaPolling(
  baseUrl: string,
  sessionId: string,
  deadline: number,
  pollIntervalMs: number,
  settleFromStatus: (status: SessionStatus) => Promise<WaitForCompletionResult | undefined>,
  cwd: string,
): Promise<WaitForCompletionResult> {
  for (;;) {
    let status: SessionStatus;
    try {
      status = await getStatus(baseUrl, sessionId, cwd);
    } catch (error) {
      if (Date.now() >= deadline) return { status: "error", detail: errorDetail(error) };
      await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
      continue;
    }

    const result = await settleFromStatus(status);
    if (result !== undefined) return result;

    if (Date.now() >= deadline) {
      return { status: "error", detail: `waitForCompletion timed out after ${String(deadline)}` };
    }
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
