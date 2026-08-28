/**
 * Unit-level tests for the pure helpers in piwebClient.ts that don't need a
 * live server. The end-to-end HTTP/WebSocket flow is covered separately in
 * piwebClient.integration.test.ts against the real pi-web instance.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  lastAssistantText,
  MESSAGE_SETTLE_MAX_ATTEMPTS,
  roleMarker,
  roleMarkerPrompt,
  waitForCompletion,
  type SessionMessage,
} from "./piwebClient.ts";

describe("lastAssistantText", () => {
  test("returns undefined when there is no assistant message", () => {
    const messages: SessionMessage[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    expect(lastAssistantText(messages)).toBeUndefined();
  });

  test("concatenates only text parts, skipping thinking parts, from the last assistant message", () => {
    const messages: SessionMessage[] = [
      { role: "user", content: [{ type: "text", text: "Reply with exactly the word: pong" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "The user wants pong." },
          { type: "text", text: "pong" },
        ],
      },
    ];
    expect(lastAssistantText(messages)).toBe("pong");
  });

  test("picks the LAST assistant message when several are present (e.g. across turns)", () => {
    const messages: SessionMessage[] = [
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "first reply" }] },
      { role: "user", content: [{ type: "text", text: "second" }] },
      { role: "assistant", content: [{ type: "text", text: "second reply" }] },
    ];
    expect(lastAssistantText(messages)).toBe("second reply");
  });

  test("joins multiple text parts of one assistant message in order", () => {
    const messages: SessionMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "part one " },
          { type: "text", text: "part two" },
        ],
      },
    ];
    expect(lastAssistantText(messages)).toBe("part one part two");
  });
});

// M-069: role marker helpers — the counterpart of
// plugins/pi-web-factory-prompts/index.ts's parseRoleMarker. Keep these two
// tests' expectations in sync with that file's ROLE_MARKER_PREFIX/SUFFIX if
// either side's format ever changes.
describe("roleMarker / roleMarkerPrompt", () => {
  test("roleMarker wraps the role name in the exact bracket format the extension parses", () => {
    expect(roleMarker("build")).toBe("[[pi-web-factory:role=build]]");
  });

  test("roleMarkerPrompt prepends the marker on its own line, ahead of the prompt text", () => {
    expect(roleMarkerPrompt("plan", "Task: do the thing")).toBe(
      "[[pi-web-factory:role=plan]]\nTask: do the thing",
    );
  });
});

// waitForCompletion's status->messages race. Root cause: pi-web's own
// `/status` endpoint flips `isStreaming` to false a moment BEFORE the final
// assistant message's text is durably persisted/queryable via `/messages` —
// a caller that reads messages the instant isStreaming goes false can race
// ahead of pi-web's own persistence and get an incomplete/empty message.
// These tests simulate that race directly against a mocked `fetch`, using
// `forcePollOnly: true` so only the status-polling path (where the race was
// diagnosed) is exercised, per the same convention run.test.ts's own
// mockFetchSequence helper uses.
describe("waitForCompletion — settled-message race mitigation", () => {
  const baseUrl = "http://fake-pi-web.test/api";
  const sessionId = "sess_race";
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function textMessage(text: string): SessionMessage {
    return { role: "assistant", content: [{ type: "text", text }] };
  }

  function thinkingOnlyMessage(): SessionMessage {
    return { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] };
  }

  /** Installs a mocked fetch: one `/status` reply (done), then a scripted sequence of `/messages` replies, one per call (sticking on the last entry once exhausted). */
  function mockRaceFetch(messagesSequence: SessionMessage[][]): { messagesCallCount: () => number } {
    let messagesCalls = 0;
    globalThis.fetch = (async (input: string | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/status")) {
        return new Response(JSON.stringify({ isStreaming: false }), { status: 200 });
      }
      if (url.includes("/messages")) {
        const messages = messagesSequence[Math.min(messagesCalls, messagesSequence.length - 1)]!;
        messagesCalls += 1;
        // Real pi-web wraps this in a MessagePage envelope, not a bare
        // array — confirmed live.
        return new Response(JSON.stringify({ messages, start: 0, total: messages.length }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;
    return { messagesCallCount: () => messagesCalls };
  }

  test("retries when the first getMessages() returns empty text, and returns the complete result once it settles", async () => {
    const { messagesCallCount } = mockRaceFetch([
      [textMessage("")], // first read: races ahead, empty text
      [textMessage("the real, complete answer")], // second read: settled
    ]);

    const result = await waitForCompletion(baseUrl, sessionId, { forcePollOnly: true, messageSettleBaseDelayMs: 1 }, "/tmp");

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(lastAssistantText(result.messages)).toBe("the real, complete answer");
    expect(messagesCallCount()).toBe(2);
  });

  test("retries when the first getMessages() returns a thinking-only message with no text part at all", async () => {
    const { messagesCallCount } = mockRaceFetch([
      [thinkingOnlyMessage()], // first read: only a thinking part, no text part
      [textMessage("finished for real this time")],
    ]);

    const result = await waitForCompletion(baseUrl, sessionId, { forcePollOnly: true, messageSettleBaseDelayMs: 1 }, "/tmp");

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(lastAssistantText(result.messages)).toBe("finished for real this time");
    expect(messagesCallCount()).toBe(2);
  });

  test("gives up after the bounded retry budget and returns the last (still-empty) fetch rather than hanging forever", async () => {
    const { messagesCallCount } = mockRaceFetch([[textMessage("")]]); // every attempt returns empty

    // messageSettleBaseDelayMs: 1 — exercises the real MESSAGE_SETTLE_MAX_ATTEMPTS
    // exhaustion count without incurring the real exponential-backoff wall-clock
    // delay (up to ~21s at the real default) in this unit test.
    const result = await waitForCompletion(
      baseUrl,
      sessionId,
      { forcePollOnly: true, messageSettleBaseDelayMs: 1 },
      "/tmp",
    );

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(lastAssistantText(result.messages)).toBe("");
    expect(messagesCallCount()).toBe(MESSAGE_SETTLE_MAX_ATTEMPTS);
  });

  test("happy path: no retry/delay when the first getMessages() already has real text", async () => {
    const { messagesCallCount } = mockRaceFetch([[textMessage("pong")]]);

    const start = Date.now();
    const result = await waitForCompletion(baseUrl, sessionId, { forcePollOnly: true }, "/tmp");
    const elapsedMs = Date.now() - start;

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(lastAssistantText(result.messages)).toBe("pong");
    expect(messagesCallCount()).toBe(1);
    // No retry delay incurred — well under MESSAGE_SETTLE_RETRY_DELAY_MS.
    expect(elapsedMs).toBeLessThan(200);
  });
});
