"""End-to-end tests: full poll-detect-act loop against a real (mock) HTTP
server, exercising the actual `piweb_client.py` request/response code path
(not a stubbed-out client) — per M-111's verification requirements.
"""

from __future__ import annotations

from . import fixtures
from .config import Config
from .mock_piweb_server import MockPiWebServer
from .piweb_client import get_messages, get_status, send_prompt
from .watcher import Watcher

SESSION_ID = "019fdac9-e588-7922-b718-9e788a486f5a"
SECOND_SESSION_ID = "0299bee1-a111-7abc-9f22-1234567890ab"


def _make_watcher(base_url: str, clock=None, log=None, session_ids=None, **overrides) -> Watcher:
    config = Config(
        base_url=base_url,
        session_ids=session_ids if session_ids is not None else [SESSION_ID],
        cwd="/work/local-ai-machine",
        poll_interval_s=1,
        cooldown_s=overrides.pop("cooldown_s", 60),
        messages_limit=20,
        continue_message="keep going (auto-resumed after timeout)",
        http_timeout_s=5,
    )
    kwargs = dict(config=config, get_messages=get_messages, send_prompt=send_prompt, get_status=get_status)
    if log is not None:
        kwargs["log"] = log
    if clock is not None:
        kwargs["clock"] = clock
    return Watcher(**kwargs)


class TestEndToEndPromptOnTimeoutAbort:
    def test_posts_continuation_on_timeout_abort_fixture(self):
        messages = [fixtures.NORMAL_TOOL_USE_MESSAGE, fixtures.TIMEOUT_ABORT_MESSAGE]
        with MockPiWebServer({SESSION_ID: messages}) as server:
            watcher = _make_watcher(server.base_url)
            acted = watcher.poll_once(SESSION_ID)

            assert acted is True
            assert len(server.prompts_received) == 1
            sent_session_id, payload = server.prompts_received[0]
            assert sent_session_id == SESSION_ID
            assert payload["text"] == "keep going (auto-resumed after timeout)"
            assert payload["cwd"] == "/work/local-ai-machine"

    def test_posts_continuation_through_trailing_compaction_message(self):
        # Exactly the real live shape confirmed against Chris's session:
        # timeout-abort followed by a system compaction message.
        messages = [
            fixtures.TOOL_RESULT_MESSAGE,
            fixtures.TIMEOUT_ABORT_MESSAGE,
            fixtures.COMPACTION_SYSTEM_MESSAGE,
        ]
        with MockPiWebServer({SESSION_ID: messages}) as server:
            watcher = _make_watcher(server.base_url)
            acted = watcher.poll_once(SESSION_ID)

            assert acted is True
            assert len(server.prompts_received) == 1


class TestEndToEndNoActionOnExplicitStop:
    def test_does_not_post_on_explicit_stop_fixture(self):
        messages = [fixtures.NORMAL_TOOL_USE_MESSAGE, fixtures.EXPLICIT_STOP_MESSAGE]
        with MockPiWebServer({SESSION_ID: messages}) as server:
            watcher = _make_watcher(server.base_url)
            acted = watcher.poll_once(SESSION_ID)

            assert acted is False
            assert server.prompts_received == []

    def test_does_not_post_on_explicit_stop_with_content_fixture(self):
        messages = [fixtures.NORMAL_TOOL_USE_MESSAGE, fixtures.EXPLICIT_STOP_WITH_CONTENT_MESSAGE]
        with MockPiWebServer({SESSION_ID: messages}) as server:
            watcher = _make_watcher(server.base_url)
            acted = watcher.poll_once(SESSION_ID)

            assert acted is False
            assert server.prompts_received == []


class TestEndToEndNoActionOnNormalCompletion:
    def test_does_not_post_on_successful_completion(self):
        messages = [fixtures.USER_KEEP_GOING_MESSAGE, fixtures.NORMAL_TOOL_USE_MESSAGE]
        with MockPiWebServer({SESSION_ID: messages}) as server:
            watcher = _make_watcher(server.base_url)
            acted = watcher.poll_once(SESSION_ID)

            assert acted is False
            assert server.prompts_received == []

    def test_does_not_post_on_connection_error_variant(self):
        messages = [fixtures.NORMAL_TOOL_USE_MESSAGE, fixtures.CONNECTION_ERROR_MESSAGE]
        with MockPiWebServer({SESSION_ID: messages}) as server:
            watcher = _make_watcher(server.base_url)
            acted = watcher.poll_once(SESSION_ID)

            assert acted is False
            assert server.prompts_received == []

    def test_does_not_double_inject_when_already_continued(self):
        messages = [
            fixtures.TIMEOUT_ABORT_MESSAGE,
            fixtures.watcher_continuation_message("keep going (auto-resumed after timeout)"),
        ]
        with MockPiWebServer({SESSION_ID: messages}) as server:
            watcher = _make_watcher(server.base_url)
            acted = watcher.poll_once(SESSION_ID)

            assert acted is False
            assert server.prompts_received == []


class TestPiWebClientPromptContract:
    """Regression guard for the real /prompt request-body contract, caught
    the hard way during M-111's own live deployment verification (two
    successive real 400s): the route requires exactly `{"text": ...,
    "cwd": ...}` — not the browser-UI-shaped `{"role", "content": [...]}`
    body initially assumed. Confirmed authoritatively by reading pi-web's
    own compiled server source (sessionRoutes.js's `sessionRefFromBody` +
    piSessionService.js's `requirePromptText`) inside the live container.
    The mock server enforces the same two checks so a regression here is
    caught by the test suite, not just in prod against a real session."""

    def _post_raw(self, base_url: str, payload: dict) -> int:
        import json
        import urllib.error
        import urllib.request

        url = f"{base_url}/api/machines/local/sessions/{SESSION_ID}/prompt"
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        try:
            urllib.request.urlopen(req, timeout=5)
            return 200
        except urllib.error.HTTPError as exc:
            return exc.code

    def test_send_prompt_without_cwd_is_rejected_by_the_real_api_contract(self):
        with MockPiWebServer({SESSION_ID: []}) as server:
            status = self._post_raw(server.base_url, {"text": "x"})
            assert status == 400
            assert server.prompts_received == []

    def test_send_prompt_without_text_is_rejected_by_the_real_api_contract(self):
        with MockPiWebServer({SESSION_ID: []}) as server:
            status = self._post_raw(server.base_url, {"cwd": "/work/local-ai-machine"})
            assert status == 400
            assert server.prompts_received == []

    def test_send_prompt_with_browser_ui_shaped_body_is_rejected(self):
        # The initially (wrongly) assumed shape — proves the mock genuinely
        # enforces the real contract rather than accepting anything.
        with MockPiWebServer({SESSION_ID: []}) as server:
            status = self._post_raw(
                server.base_url,
                {"role": "user", "content": [{"type": "text", "text": "x"}]},
            )
            assert status == 400
            assert server.prompts_received == []

    def test_send_prompt_includes_cwd_and_text_and_succeeds(self):
        with MockPiWebServer({SESSION_ID: []}) as server:
            send_prompt(server.base_url, SESSION_ID, "hello", "/work/local-ai-machine", 5)
            assert len(server.prompts_received) == 1
            _, payload = server.prompts_received[0]
            assert payload["cwd"] == "/work/local-ai-machine"
            assert payload["text"] == "hello"


class TestSkipsWhenSessionAlreadyBusy:
    """Confirmed live 2026-08-14: injecting a continuation while the session
    is already mid-compaction (or still streaming) can itself get aborted by
    that in-flight state change, producing a fresh timeout-abort message
    that looks identical to the one that triggered the poll — without a
    status check, the watcher would re-detect it and loop
    (detect->send->detect->cooldown-skip->detect->send...) indefinitely."""

    def test_does_not_post_when_session_is_streaming(self):
        messages = [fixtures.NORMAL_TOOL_USE_MESSAGE, fixtures.TIMEOUT_ABORT_MESSAGE]
        with MockPiWebServer({SESSION_ID: messages}) as server:
            server.set_status(SESSION_ID, {"isStreaming": True, "isCompacting": False})
            watcher = _make_watcher(server.base_url)
            acted = watcher.poll_once(SESSION_ID)

            assert acted is False
            assert server.prompts_received == []

    def test_does_not_post_when_session_is_compacting(self):
        messages = [fixtures.NORMAL_TOOL_USE_MESSAGE, fixtures.TIMEOUT_ABORT_MESSAGE]
        with MockPiWebServer({SESSION_ID: messages}) as server:
            server.set_status(SESSION_ID, {"isStreaming": False, "isCompacting": True})
            watcher = _make_watcher(server.base_url)
            acted = watcher.poll_once(SESSION_ID)

            assert acted is False
            assert server.prompts_received == []

    def test_does_not_consume_cooldown_when_skipped_for_busy_session(self):
        # A busy-skip must not count as a "continue attempt" — once the
        # session settles, the very next poll should still be free to act,
        # not stuck waiting out a cooldown window for a continuation that
        # was never actually sent.
        messages = [fixtures.NORMAL_TOOL_USE_MESSAGE, fixtures.TIMEOUT_ABORT_MESSAGE]
        with MockPiWebServer({SESSION_ID: messages}) as server:
            server.set_status(SESSION_ID, {"isStreaming": True, "isCompacting": False})
            fake_now = [1_000_000.0]
            watcher = _make_watcher(server.base_url, clock=lambda: fake_now[0], cooldown_s=60)

            assert watcher.poll_once(SESSION_ID) is False
            assert server.prompts_received == []

            # Session settles a moment later, still well inside what would
            # have been the cooldown window if a send had actually happened.
            fake_now[0] += 5
            server.set_status(SESSION_ID, {"isStreaming": False, "isCompacting": False})
            assert watcher.poll_once(SESSION_ID) is True
            assert len(server.prompts_received) == 1

    def test_posts_normally_when_session_is_not_busy(self):
        # Explicit not-busy control case, distinct from the other tests'
        # implicit default (mock server defaults to not-busy when
        # set_status was never called) -- proves the status check itself is
        # actually being consulted, not just always passing.
        messages = [fixtures.NORMAL_TOOL_USE_MESSAGE, fixtures.TIMEOUT_ABORT_MESSAGE]
        with MockPiWebServer({SESSION_ID: messages}) as server:
            server.set_status(SESSION_ID, {"isStreaming": False, "isCompacting": False})
            watcher = _make_watcher(server.base_url)
            acted = watcher.poll_once(SESSION_ID)

            assert acted is True
            assert len(server.prompts_received) == 1


class TestCooldown:
    def test_only_one_post_across_two_detections_within_cooldown_window(self):
        messages = [fixtures.NORMAL_TOOL_USE_MESSAGE, fixtures.TIMEOUT_ABORT_MESSAGE]
        with MockPiWebServer({SESSION_ID: messages}) as server:
            fake_now = [1_000_000.0]
            watcher = _make_watcher(server.base_url, clock=lambda: fake_now[0], cooldown_s=60)

            first = watcher.poll_once(SESSION_ID)
            assert first is True
            assert len(server.prompts_received) == 1

            # Simulate a second poll tick 5s later — well inside the 60s
            # cooldown — with the pattern still (spuriously) detected again
            # (e.g. the mock server's message list wasn't advanced, mimicking
            # an overlapping/late poll tick).
            fake_now[0] += 5
            second = watcher.poll_once(SESSION_ID)
            assert second is False
            assert len(server.prompts_received) == 1  # still just the one

    def test_fires_again_after_cooldown_elapses(self):
        messages = [fixtures.NORMAL_TOOL_USE_MESSAGE, fixtures.TIMEOUT_ABORT_MESSAGE]
        with MockPiWebServer({SESSION_ID: messages}) as server:
            fake_now = [1_000_000.0]
            watcher = _make_watcher(server.base_url, clock=lambda: fake_now[0], cooldown_s=60)

            assert watcher.poll_once(SESSION_ID) is True
            assert len(server.prompts_received) == 1

            # A second, genuinely NEW timeout-abort after the cooldown
            # window has fully elapsed (a fresh continuation replied, then
            # the box hit the same timeout again on its own retry).
            server.set_messages(
                SESSION_ID,
                [fixtures.NORMAL_TOOL_USE_MESSAGE, fixtures.TIMEOUT_ABORT_MESSAGE],
            )
            fake_now[0] += 61
            assert watcher.poll_once(SESSION_ID) is True
            assert len(server.prompts_received) == 2


class TestMultiSessionIndependence:
    """M-116: watching 2+ sessions must monitor each fully independently —
    a stall (and its resulting cooldown) in one session must have zero
    effect on detection/cooldown for any other configured session."""

    def test_poll_all_acts_on_every_stalled_session_in_the_configured_list(self):
        messages_by_session = {
            SESSION_ID: [fixtures.NORMAL_TOOL_USE_MESSAGE, fixtures.TIMEOUT_ABORT_MESSAGE],
            SECOND_SESSION_ID: [fixtures.NORMAL_TOOL_USE_MESSAGE, fixtures.TIMEOUT_ABORT_MESSAGE],
        }
        with MockPiWebServer(messages_by_session) as server:
            watcher = _make_watcher(server.base_url, session_ids=[SESSION_ID, SECOND_SESSION_ID])
            watcher.poll_all()

            assert len(server.prompts_received) == 2
            acted_sessions = {session_id for session_id, _ in server.prompts_received}
            assert acted_sessions == {SESSION_ID, SECOND_SESSION_ID}

    def test_cooldown_on_one_session_does_not_affect_the_other(self):
        # SESSION_ID stalls and gets continued first; SECOND_SESSION_ID is
        # healthy at that point. Once SESSION_ID is in cooldown and
        # SECOND_SESSION_ID *also* stalls moments later, SECOND_SESSION_ID
        # must still act normally — the two sessions must not share a
        # single global cooldown timer.
        messages_by_session = {
            SESSION_ID: [fixtures.NORMAL_TOOL_USE_MESSAGE, fixtures.TIMEOUT_ABORT_MESSAGE],
            SECOND_SESSION_ID: [fixtures.NORMAL_TOOL_USE_MESSAGE],
        }
        with MockPiWebServer(messages_by_session) as server:
            fake_now = [1_000_000.0]
            watcher = _make_watcher(
                server.base_url,
                clock=lambda: fake_now[0],
                session_ids=[SESSION_ID, SECOND_SESSION_ID],
                cooldown_s=60,
            )

            # First tick: only SESSION_ID is stalled, so only it gets acted on.
            watcher.poll_all()
            assert len(server.prompts_received) == 1
            assert server.prompts_received[0][0] == SESSION_ID

            # A few seconds later (well inside SESSION_ID's 60s cooldown),
            # SECOND_SESSION_ID independently stalls too.
            fake_now[0] += 5
            server.set_messages(
                SECOND_SESSION_ID,
                [fixtures.NORMAL_TOOL_USE_MESSAGE, fixtures.TIMEOUT_ABORT_MESSAGE],
            )
            watcher.poll_all()

            # SESSION_ID must still be skipped (its own cooldown is active);
            # SECOND_SESSION_ID must act despite SESSION_ID's cooldown.
            assert len(server.prompts_received) == 2
            assert server.prompts_received[1][0] == SECOND_SESSION_ID

            # Re-detecting SESSION_ID's still-unresolved stall on this same
            # tick must not have produced a second prompt for it.
            session_ids_acted = [session_id for session_id, _ in server.prompts_received]
            assert session_ids_acted.count(SESSION_ID) == 1
