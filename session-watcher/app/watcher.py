"""Core poll-detect-act loop for pi-web-session-watcher.

Separated from `main.py` so the full loop (minus real network calls) is
unit-testable against a fake/mock client — see `test_watcher.py`.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from .config import Config
from .detect import is_explicit_stop_message, is_timeout_abort_message, last_substantive_message

GetMessagesFn = Callable[[str, str, str, int, float], list[dict[str, Any]]]
GetStatusFn = Callable[[str, str, str, float], dict[str, Any]]
SendPromptFn = Callable[[str, str, str, str, float], dict[str, Any]]


@dataclass
class SessionState:
    """Per-session cooldown bookkeeping."""

    last_continue_at: Optional[float] = None

    def in_cooldown(self, now: float, cooldown_s: int) -> bool:
        if self.last_continue_at is None:
            return False
        return (now - self.last_continue_at) < cooldown_s


@dataclass
class Watcher:
    config: Config
    get_messages: GetMessagesFn
    send_prompt: SendPromptFn
    get_status: GetStatusFn
    log: Callable[[str], None] = print
    clock: Callable[[], float] = time.time
    _state: dict[str, SessionState] = field(default_factory=dict)

    def _state_for(self, session_id: str) -> SessionState:
        return self._state.setdefault(session_id, SessionState())

    def poll_once(self, session_id: str) -> bool:
        """Runs a single poll-detect-act check for one session. Returns True
        iff a continuation was actually sent."""
        cfg = self.config
        state = self._state_for(session_id)
        now = self.clock()

        try:
            messages = self.get_messages(cfg.base_url, session_id, cfg.cwd, cfg.messages_limit, cfg.http_timeout_s)
        except Exception as exc:  # noqa: BLE001 - log and move on, next poll retries
            self.log(f"[{session_id}] poll FAILED: could not fetch messages: {exc}")
            return False

        target = last_substantive_message(messages)
        if target is None:
            self.log(f"[{session_id}] poll: no user/assistant messages found, nothing to do")
            return False

        if is_timeout_abort_message(target):
            self.log(
                f"[{session_id}] poll: latest substantive message MATCHES timeout-abort pattern "
                f"(stopReason={target.get('stopReason')!r}, errorMessage={target.get('errorMessage')!r})"
            )

            if state.in_cooldown(now, cfg.cooldown_s):
                elapsed = now - (state.last_continue_at or now)
                self.log(
                    f"[{session_id}] SKIPPING auto-continue: in cooldown "
                    f"({elapsed:.0f}s since last continue, cooldown={cfg.cooldown_s}s)"
                )
                return False

            # Confirmed live 2026-08-14: injecting a continuation while the
            # session is ALREADY mid-compaction (or still actively
            # streaming) can itself get aborted by that in-flight state
            # change, producing a FRESH timeout-abort message that looks
            # identical to the one that triggered this poll — the watcher
            # would then re-detect it, re-fire after cooldown, and loop
            # indefinitely (observed directly: repeated
            # detect->send->detect->cooldown-skip->detect->send cycles on
            # the same session). /messages alone can't distinguish "stuck,
            # needs a nudge" from "already recovering on its own, just not
            # visible in message history yet" — /status can. If the session
            # is busy, do nothing this tick; a future poll will see the
            # eventual real outcome once it settles.
            try:
                status = self.get_status(cfg.base_url, session_id, cfg.cwd, cfg.http_timeout_s)
            except Exception as exc:  # noqa: BLE001 - log and move on, next poll retries
                self.log(f"[{session_id}] poll FAILED: could not fetch status: {exc}")
                return False

            if status.get("isStreaming") or status.get("isCompacting"):
                self.log(
                    f"[{session_id}] SKIPPING auto-continue: session is currently busy "
                    f"(isStreaming={status.get('isStreaming')!r}, isCompacting={status.get('isCompacting')!r}) "
                    "— it may already be recovering on its own"
                )
                return False

            self.log(f"[{session_id}] ACTING: sending continuation: {cfg.continue_message!r}")
            try:
                self.send_prompt(cfg.base_url, session_id, cfg.continue_message, cfg.cwd, cfg.http_timeout_s)
            except Exception as exc:  # noqa: BLE001
                self.log(f"[{session_id}] poll FAILED: could not send continuation: {exc}")
                return False

            state.last_continue_at = now
            self.log(f"[{session_id}] continuation sent successfully")
            return True

        if is_explicit_stop_message(target):
            self.log(
                f"[{session_id}] poll: latest substantive message is an EXPLICIT USER STOP "
                f"(stopReason={target.get('stopReason')!r}) — never auto-continuing this, no action taken"
            )
            return False

        self.log(
            f"[{session_id}] poll: latest substantive message does not match timeout-abort pattern "
            f"(role={target.get('role')!r}, stopReason={target.get('stopReason')!r}) — no action taken"
        )
        return False

    def poll_all(self) -> None:
        for session_id in self.config.session_ids:
            self.poll_once(session_id)

    def run_forever(self) -> None:
        cfg = self.config
        self.log(
            f"pi-web-session-watcher starting: sessions={cfg.session_ids} base_url={cfg.base_url} "
            f"cwd={cfg.cwd} poll_interval_s={cfg.poll_interval_s} cooldown_s={cfg.cooldown_s} "
            f"message={cfg.continue_message!r}"
        )
        while True:
            self.poll_all()
            time.sleep(cfg.poll_interval_s)
