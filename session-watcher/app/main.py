"""Entrypoint for pi-web-session-watcher (M-111; multi-session in M-116).

Standing service: polls a manually-configured list of real, live pi-web
interactive chat sessions (`PI_WEB_WATCHER_SESSION_IDS`) and auto-sends a
continuation message when it detects the "pi-web's own 5-minute idle-timeout
gave up on a legitimately-still-generating request" failure pattern, on a
per-session basis. See `app/detect.py`'s module docstring for the exact
pattern this does (and does NOT) match, and `app/config.py` for every
env-var knob and for the "how do I add a session to watch" procedure.
"""

from __future__ import annotations

from .config import Config
from .piweb_client import get_messages, get_status, send_prompt
from .watcher import Watcher


def main() -> None:
    config = Config()
    watcher = Watcher(
        config=config,
        get_messages=get_messages,
        send_prompt=send_prompt,
        get_status=get_status,
    )
    watcher.run_forever()


if __name__ == "__main__":
    main()
