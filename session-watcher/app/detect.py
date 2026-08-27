"""Detection logic for the timeout-abort failure pattern (M-111).

Two textually-distinct failure shapes exist in real pi-web session history
(confirmed against session 019fdac9-e588-7922-b718-9e788a486f5a's own JSONL,
see the card's decision log for the exact fixtures pulled):

  1. Timeout-abort (pi-web's own outbound litellm call gives up after its
     internal 5-minute idle timeout on a legitimately-still-generating
     request):
         {"role": "assistant", "stopReason": "error", "content": [],
          "errorMessage": "This operation was aborted"}

  2. Explicit user stop (Chris deliberately clicked Stop in the UI):
         {"role": "assistant", "stopReason": "aborted", "content": [],
          "errorMessage": "Request aborted"}
     (also observed with non-empty content, e.g. a partial "thinking" part,
     when the stop lands mid-generation.)

Only (1) should ever trigger an auto-continue. (2) must NEVER trigger one —
firing on an explicit user stop would fight the user.

Match on `stopReason == "error"` (not "aborted") AND empty content AND an
errorMessage that looks abort/timeout-flavored (case-insensitive substring
check, not a brittle exact-string match — pi-web's own wording could shift
slightly, e.g. "This operation was aborted" vs a differently-phrased litellm
timeout in the future).
"""

from __future__ import annotations

from typing import Any, Optional

TIMEOUT_ABORT_STOP_REASON = "error"
EXPLICIT_STOP_STOP_REASON = "aborted"

# Case-insensitive substrings that, combined with stopReason == "error" and
# empty content, identify the timeout-abort pattern. Deliberately broad
# ("abort" alone covers "This operation was aborted", "timed out", etc. —
# but not so broad it would ever match on stopReason == "aborted" cases,
# which are filtered out by the stopReason check first, before this text
# check is even consulted).
ABORT_TEXT_MARKERS = ("abort", "timed out", "timeout")


def is_timeout_abort_message(message: dict[str, Any]) -> bool:
    """True iff `message` is an assistant message matching the timeout-abort
    pattern (pattern 1 above). False for explicit-stop (pattern 2), normal
    completions, tool calls, user/system messages, or anything else."""
    if not isinstance(message, dict):
        return False
    if message.get("role") != "assistant":
        return False
    if message.get("stopReason") != TIMEOUT_ABORT_STOP_REASON:
        return False
    content = message.get("content")
    if content:  # non-empty list (or any other truthy value) disqualifies it
        return False
    error_message = message.get("errorMessage")
    if not isinstance(error_message, str) or not error_message.strip():
        return False
    lowered = error_message.lower()
    return any(marker in lowered for marker in ABORT_TEXT_MARKERS)


def is_explicit_stop_message(message: dict[str, Any]) -> bool:
    """True iff `message` is an assistant message matching the explicit
    user-stop pattern (pattern 2). Provided mainly for tests/logging —
    the core decision only needs `is_timeout_abort_message` to be correct,
    but this makes "why didn't it fire" explicit in logs."""
    if not isinstance(message, dict):
        return False
    if message.get("role") != "assistant":
        return False
    return message.get("stopReason") == EXPLICIT_STOP_STOP_REASON


def is_watcher_continuation(message: dict[str, Any], continue_message: str) -> bool:
    """True iff `message` is a user message carrying exactly this watcher's
    own injected continuation text (used to avoid double-injecting)."""
    if not isinstance(message, dict):
        return False
    if message.get("role") != "user":
        return False
    content = message.get("content")
    if not isinstance(content, list):
        return False
    for part in content:
        if isinstance(part, dict) and part.get("type") == "text" and part.get("text") == continue_message:
            return True
    return False


def last_substantive_message(messages: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
    """Returns the last message with role "user" or "assistant", skipping
    over trailing "system"/informational messages (e.g. pi-web's own
    compaction summaries, which can land after a still-unresolved failure
    and would otherwise mask it — confirmed live: session
    019fdac9-e588-7922-b718-9e788a486f5a's actual current tail is exactly
    this shape, a compaction message sitting after an un-continued
    timeout-abort). Returns None if no such message exists."""
    for message in reversed(messages):
        if not isinstance(message, dict):
            continue
        if message.get("role") in ("user", "assistant"):
            return message
    return None


def should_continue(messages: list[dict[str, Any]], continue_message: str) -> bool:
    """Core decision: should the watcher POST a continuation right now?

    True iff the last substantive (user/assistant) message in the transcript
    is a timeout-abort message. If the watcher's own continuation is already
    the latest message (or anything else), do nothing — this both avoids
    double-injecting on overlapping poll ticks and avoids re-firing once a
    human (or the watcher itself) has already responded.
    """
    target = last_substantive_message(messages)
    if target is None:
        return False
    return is_timeout_abort_message(target)
