"""Real captured fixtures for pi-web-session-watcher's tests.

Pulled from the ACTUAL historical session file on local-ai-machine:
  ~/.pi-web/sessions/--work-local-ai-machine--/2026-08-07T05-54-52-424Z_019fdac9-e588-7922-b718-9e788a486f5a.jsonl

`TIMEOUT_ABORT_MESSAGE` is JSONL line 220 (`errorMessage: "This operation was
aborted"`, `stopReason: "error"`) — the pi-web-internal 5-minute idle-timeout
failure that SHOULD trigger auto-continue.

`EXPLICIT_STOP_MESSAGE` is JSONL line 223 (`errorMessage: "Request aborted"`,
`stopReason: "aborted"`) — a deliberate human Stop-button click, confirmed via
its distinct stopReason and errorMessage wording. Must NEVER trigger
auto-continue.

`EXPLICIT_STOP_WITH_CONTENT_MESSAGE` is JSONL line 156 — the same
explicit-stop pattern, but landing mid-generation so `content` is non-empty
(a partial "thinking" part). Included to prove the detector doesn't
accidentally key off "empty content" alone.

Shapes match exactly what `GET /api/machines/local/sessions/<id>/messages`
returns live (confirmed: the API's per-message projection is the JSONL
`.message` object, flattened, with no extra wrapper — verified by diffing a
live curl against these same three messages by timestamp).
"""

from __future__ import annotations

from typing import Any

TIMEOUT_ABORT_MESSAGE: dict[str, Any] = {
    "role": "assistant",
    "content": [],
    "api": "openai-completions",
    "provider": "local-litellm",
    "model": "big-moe",
    "usage": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "totalTokens": 0,
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
    },
    "stopReason": "error",
    "errorMessage": "This operation was aborted",
    "timestamp": 1786577252640,
}

EXPLICIT_STOP_MESSAGE: dict[str, Any] = {
    "role": "assistant",
    "content": [],
    "api": "openai-completions",
    "provider": "local-litellm",
    "model": "big-moe",
    "usage": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "totalTokens": 0,
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
    },
    "stopReason": "aborted",
    "timestamp": 1786625947663,
    "errorMessage": "Request aborted",
}

EXPLICIT_STOP_WITH_CONTENT_MESSAGE: dict[str, Any] = {
    "role": "assistant",
    "content": [
        {
            "type": "thinking",
            "thinking": (
                "The factory.db doesn't have a `projects` table — project registration is "
                "handled by pi-web's own data model, not the factory DB."
            ),
            "thinkingSignature": "reasoning_content",
        }
    ],
    "api": "openai-completions",
    "provider": "local-litellm",
    "model": "big-moe",
    "usage": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "totalTokens": 0,
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
    },
    "stopReason": "aborted",
    "timestamp": 1786575236826,
    "responseId": "chatcmpl-trtybkXpkQUT6x8xRYx7m1gySd2DXInv",
    "errorMessage": "Request was aborted",
}

# A separate real litellm-connection-error variant also observed in the same
# session history (JSONL lines 134-137): stopReason "error", empty content,
# but a DIFFERENT errorMessage shape (litellm 500 JSON blob mentioning
# "Connection error", not "aborted"/"timeout"). This one should NOT match
# the detector's text-marker check — it's a distinct failure (litellm/model
# backend unreachable), out of scope for this watcher, and firing an
# auto-continue at it would not help (the backend is down, not just slow).
CONNECTION_ERROR_MESSAGE: dict[str, Any] = {
    "role": "assistant",
    "content": [],
    "api": "openai-completions",
    "provider": "local-litellm",
    "model": "big-moe",
    "usage": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "totalTokens": 0,
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
    },
    "stopReason": "error",
    "timestamp": 1786086139856,
    "errorMessage": (
        '500: {"message":"litellm.InternalServerError: InternalServerError: OpenAIException - '
        'Connection error.. Received Model Group=big-moe\\nAvailable Model Group Fallbacks=None",'
        '"type":null,"param":null,"code":"500"}'
    ),
}

NORMAL_TOOL_USE_MESSAGE: dict[str, Any] = {
    "role": "assistant",
    "content": [
        {"type": "text", "text": "Let me check that."},
        {"type": "toolCall", "id": "abc123", "name": "bash", "arguments": {"command": "ls"}},
    ],
    "api": "openai-completions",
    "provider": "local-litellm",
    "model": "big-moe",
    "stopReason": "toolUse",
    "timestamp": 1786630527375,
}

TOOL_RESULT_MESSAGE: dict[str, Any] = {
    "role": "toolResult",
    "toolCallId": "abc123",
    "toolName": "bash",
    "content": [{"type": "text", "text": "(no output)"}],
    "isError": False,
    "timestamp": 1786630613985,
}

COMPACTION_SYSTEM_MESSAGE: dict[str, Any] = {
    "role": "system",
    "source": "compaction",
    "content": "Compacted history:\n\n<continuation>\n## Task\n...\n</continuation>",
}

USER_KEEP_GOING_MESSAGE: dict[str, Any] = {
    "role": "user",
    "content": [{"type": "text", "text": "keep going"}],
    "timestamp": 1786630527373,
}


def watcher_continuation_message(text: str) -> dict[str, Any]:
    return {
        "role": "user",
        "content": [{"type": "text", "text": text}],
        "timestamp": 1786632200000,
    }
