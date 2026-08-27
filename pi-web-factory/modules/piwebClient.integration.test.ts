/**
 * Integration test: runs against the REAL, running `jmfederico-pi-web`
 * instance on `local-ai-machine` (http://192.168.1.21:8080/api), not a mock.
 * Exercises the full flow — start session, set model, prompt, wait for
 * completion — end to end, in one test case (this hits a real shared
 * server, so we keep it to one case rather than many redundant ones).
 *
 * Uses `/tmp` as the scratch cwd (confirmed to already work against this
 * server). Cleans up the session (archive + delete) when done so it doesn't
 * pollute the server's session history.
 *
 * This test takes real wall-clock time — a real local model has to actually
 * generate a reply (observed ~8s for a trivial one-word prompt during
 * manual curl verification) — that's expected, not a bug.
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_BASE_URL,
  getMessages,
  lastAssistantText,
  prompt,
  setModel,
  startSession,
  waitForCompletion,
} from "./piwebClient.ts";

const baseUrl = DEFAULT_BASE_URL;

describe("piwebClient integration (live pi-web server)", () => {
  test(
    "start session -> set model -> prompt -> waitForCompletion returns done with expected content",
    async () => {
      const session = await startSession(baseUrl, "/tmp", "m062-integration-test");
      expect(session.id).toBeTruthy();
      expect(session.cwd).toBe("/tmp");

      try {
        const afterModel = await setModel(baseUrl, session.id, "local-litellm", "medium-moe", "/tmp");
        expect(afterModel.model?.provider).toBe("local-litellm");
        expect(afterModel.model?.id).toBe("medium-moe");

        const promptResult = await prompt(baseUrl, session.id, "Reply with exactly the word: pong", "/tmp");
        expect(promptResult).toEqual({ accepted: true });

        const result = await waitForCompletion(baseUrl, session.id, { timeoutMs: 90_000 }, "/tmp");

        expect(result.status).toBe("done");
        if (result.status !== "done") throw new Error(`expected done, got ${result.status}`);

        const reply = lastAssistantText(result.messages);
        expect(reply).toBeTruthy();
        expect(reply?.toLowerCase()).toContain("pong");

        // Sanity check: getMessages independently agrees with what the wait-loop returned.
        const messagesAgain = await getMessages(baseUrl, session.id, "/tmp");
        expect(lastAssistantText(messagesAgain)?.toLowerCase()).toContain("pong");
      } finally {
        // Clean up: archive then delete so this scratch session doesn't
        // linger in the shared server's history.
        await fetch(`${baseUrl}/sessions/${session.id}/archive`, { method: "POST" }).catch(() => undefined);
        await fetch(`${baseUrl}/sessions/${session.id}?cwd=/tmp`, { method: "DELETE" }).catch(() => undefined);
      }
    },
    { timeout: 120_000 },
  );
});
