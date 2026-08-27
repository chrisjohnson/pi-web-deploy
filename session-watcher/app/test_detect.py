"""Unit tests for detect.py against REAL captured pi-web session fixtures
(M-111). See fixtures.py for provenance of each fixture."""

from __future__ import annotations

from . import fixtures
from .detect import (
    is_explicit_stop_message,
    is_timeout_abort_message,
    is_watcher_continuation,
    last_substantive_message,
    should_continue,
)


class TestIsTimeoutAbortMessage:
    def test_real_timeout_abort_fixture_matches(self):
        assert is_timeout_abort_message(fixtures.TIMEOUT_ABORT_MESSAGE) is True

    def test_real_explicit_stop_fixture_does_not_match(self):
        assert is_timeout_abort_message(fixtures.EXPLICIT_STOP_MESSAGE) is False

    def test_real_explicit_stop_with_content_fixture_does_not_match(self):
        assert is_timeout_abort_message(fixtures.EXPLICIT_STOP_WITH_CONTENT_MESSAGE) is False

    def test_connection_error_variant_does_not_match(self):
        # Same stopReason + empty content, but a differently-worded failure
        # (litellm backend unreachable) — must not be conflated with the
        # timeout-abort pattern this watcher targets.
        assert is_timeout_abort_message(fixtures.CONNECTION_ERROR_MESSAGE) is False

    def test_normal_tool_use_does_not_match(self):
        assert is_timeout_abort_message(fixtures.NORMAL_TOOL_USE_MESSAGE) is False

    def test_tool_result_does_not_match(self):
        assert is_timeout_abort_message(fixtures.TOOL_RESULT_MESSAGE) is False

    def test_user_message_does_not_match(self):
        assert is_timeout_abort_message(fixtures.USER_KEEP_GOING_MESSAGE) is False

    def test_system_compaction_message_does_not_match(self):
        assert is_timeout_abort_message(fixtures.COMPACTION_SYSTEM_MESSAGE) is False

    def test_non_dict_input_does_not_match(self):
        assert is_timeout_abort_message("not a dict") is False  # type: ignore[arg-type]
        assert is_timeout_abort_message(None) is False  # type: ignore[arg-type]

    def test_case_insensitive_text_match(self):
        msg = dict(fixtures.TIMEOUT_ABORT_MESSAGE)
        msg["errorMessage"] = "REQUEST TIMED OUT after 300000ms"
        assert is_timeout_abort_message(msg) is True

    def test_missing_error_message_does_not_match(self):
        msg = dict(fixtures.TIMEOUT_ABORT_MESSAGE)
        del msg["errorMessage"]
        assert is_timeout_abort_message(msg) is False

    def test_non_empty_content_with_error_stop_reason_does_not_match(self):
        msg = dict(fixtures.TIMEOUT_ABORT_MESSAGE)
        msg["content"] = [{"type": "text", "text": "partial output"}]
        assert is_timeout_abort_message(msg) is False

    def test_unrelated_error_message_text_does_not_match(self):
        msg = dict(fixtures.TIMEOUT_ABORT_MESSAGE)
        msg["errorMessage"] = "model produced invalid JSON"
        assert is_timeout_abort_message(msg) is False


class TestIsExplicitStopMessage:
    def test_real_explicit_stop_fixture_matches(self):
        assert is_explicit_stop_message(fixtures.EXPLICIT_STOP_MESSAGE) is True

    def test_real_explicit_stop_with_content_fixture_matches(self):
        assert is_explicit_stop_message(fixtures.EXPLICIT_STOP_WITH_CONTENT_MESSAGE) is True

    def test_real_timeout_abort_fixture_does_not_match(self):
        assert is_explicit_stop_message(fixtures.TIMEOUT_ABORT_MESSAGE) is False


class TestLastSubstantiveMessage:
    def test_skips_trailing_system_compaction_message(self):
        # Confirmed live: session 019fdac9's real current tail is exactly
        # this shape — a compaction system message landing right after an
        # un-continued timeout-abort. The watcher must see through it.
        messages = [
            fixtures.TOOL_RESULT_MESSAGE,
            fixtures.TIMEOUT_ABORT_MESSAGE,
            fixtures.COMPACTION_SYSTEM_MESSAGE,
        ]
        assert last_substantive_message(messages) == fixtures.TIMEOUT_ABORT_MESSAGE

    def test_returns_last_user_or_assistant_message(self):
        messages = [
            fixtures.USER_KEEP_GOING_MESSAGE,
            fixtures.NORMAL_TOOL_USE_MESSAGE,
            fixtures.TOOL_RESULT_MESSAGE,
        ]
        assert last_substantive_message(messages) == fixtures.TOOL_RESULT_MESSAGE or True
        # toolResult isn't user/assistant, so the real last substantive
        # message should be the assistant tool-use message.
        assert last_substantive_message(messages) == fixtures.NORMAL_TOOL_USE_MESSAGE

    def test_empty_list_returns_none(self):
        assert last_substantive_message([]) is None

    def test_only_system_messages_returns_none(self):
        assert last_substantive_message([fixtures.COMPACTION_SYSTEM_MESSAGE]) is None


class TestIsWatcherContinuation:
    def test_matches_own_injected_text(self):
        msg = fixtures.watcher_continuation_message("keep going (auto-resumed after timeout)")
        assert is_watcher_continuation(msg, "keep going (auto-resumed after timeout)") is True

    def test_does_not_match_different_text(self):
        assert is_watcher_continuation(fixtures.USER_KEEP_GOING_MESSAGE, "keep going (auto-resumed after timeout)") is False

    def test_does_not_match_assistant_role(self):
        msg = {"role": "assistant", "content": [{"type": "text", "text": "keep going (auto-resumed after timeout)"}]}
        assert is_watcher_continuation(msg, "keep going (auto-resumed after timeout)") is False


class TestShouldContinue:
    CONTINUE_MSG = "keep going (auto-resumed after timeout)"

    def test_true_when_latest_substantive_message_is_timeout_abort(self):
        messages = [fixtures.NORMAL_TOOL_USE_MESSAGE, fixtures.TIMEOUT_ABORT_MESSAGE]
        assert should_continue(messages, self.CONTINUE_MSG) is True

    def test_false_when_latest_substantive_message_is_explicit_stop(self):
        messages = [fixtures.NORMAL_TOOL_USE_MESSAGE, fixtures.EXPLICIT_STOP_MESSAGE]
        assert should_continue(messages, self.CONTINUE_MSG) is False

    def test_false_when_already_continued(self):
        # Watcher's own continuation already sent after the abort — must not
        # double-inject on an overlapping poll tick.
        messages = [
            fixtures.TIMEOUT_ABORT_MESSAGE,
            fixtures.watcher_continuation_message(self.CONTINUE_MSG),
        ]
        assert should_continue(messages, self.CONTINUE_MSG) is False

    def test_false_on_normal_successful_completion(self):
        messages = [fixtures.USER_KEEP_GOING_MESSAGE, fixtures.NORMAL_TOOL_USE_MESSAGE]
        assert should_continue(messages, self.CONTINUE_MSG) is False

    def test_true_through_trailing_compaction_message(self):
        # The exact real-world shape confirmed live against Chris's session.
        messages = [
            fixtures.TOOL_RESULT_MESSAGE,
            fixtures.TIMEOUT_ABORT_MESSAGE,
            fixtures.COMPACTION_SYSTEM_MESSAGE,
        ]
        assert should_continue(messages, self.CONTINUE_MSG) is True

    def test_false_on_empty_messages(self):
        assert should_continue([], self.CONTINUE_MSG) is False
