"""Configuration for pi-web-session-watcher (M-111, multi-session in M-116).

All knobs are environment-variable overridable, matching the convention
already established by `docker/llm-inference-bench/app/config.py`.

How to add a new session to watch (M-116 — manual opt-in stays the model;
this is the whole procedure):
  1. Get the session ID you want watched from pi-web's own UI (visible in
     its URL/session list) or its API (`GET /api/machines/local/sessions`).
  2. Add it to the `PI_WEB_WATCHER_SESSION_IDS` env var in
     `docker/docker-compose.yml`'s `pi-web-session-watcher` service,
     comma-separated with whatever's already there, e.g.
     `PI_WEB_WATCHER_SESSION_IDS=<existing-id>,<new-id>`.
  3. Restart the container: `docker compose up -d pi-web-session-watcher`
     (or `docker restart pi-web-session-watcher`). No code/image rebuild
     needed — this is a pure env-var/config change.
Each configured session is polled, detected, and cooldown-rate-limited
completely independently (see `SessionState` in watcher.py) — one session
stalling and getting auto-continued has no effect on any other configured
session's own detection/cooldown state.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return int(raw)


def _env_str_list(name: str, default: str) -> list[str]:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        raw = default
    return [part.strip() for part in raw.split(",") if part.strip()]


# The one real session this watcher was originally built for (M-111 card).
# Still the default if PI_WEB_WATCHER_SESSION_IDS is unset, so existing
# single-session deployments keep working with no config change. Manual
# opt-in remains the model (M-116 decision) — do NOT widen this to "watch
# every session on the box" without a fresh, explicit ask.
DEFAULT_SESSION_ID = "019fdac9-e588-7922-b718-9e788a486f5a"

# The continuation text is deliberately distinguishable from anything Chris
# would type by hand, so the transcript stays auditable.
CONTINUE_MESSAGE = "keep going (auto-resumed after timeout)"


@dataclass
class Config:
    base_url: str = os.environ.get("PI_WEB_WATCHER_BASE_URL", "http://127.0.0.1:8080")
    # M-116: comma-separated list of session IDs to watch, e.g.
    # "id1,id2,id3". Adding/removing entries here (then restarting the
    # container) is the entire "opt a session in/out of auto-continue"
    # mechanism — see this module's docstring above for the full procedure.
    session_ids: list[str] = field(
        default_factory=lambda: _env_str_list("PI_WEB_WATCHER_SESSION_IDS", DEFAULT_SESSION_ID)
    )
    # cwd query param pi-web needs on GET session routes for this box's one
    # registered project/workspace (see piwebProject.ts pattern + confirmed
    # live: GET /api/projects/<id>/workspaces -> workspaces[0].path).
    cwd: str = os.environ.get("PI_WEB_WATCHER_CWD", "/work/local-ai-machine")
    poll_interval_s: int = _env_int("PI_WEB_WATCHER_POLL_INTERVAL_S", 45)
    cooldown_s: int = _env_int("PI_WEB_WATCHER_COOLDOWN_S", 60)
    messages_limit: int = _env_int("PI_WEB_WATCHER_MESSAGES_LIMIT", 20)
    continue_message: str = os.environ.get("PI_WEB_WATCHER_MESSAGE", CONTINUE_MESSAGE)
    http_timeout_s: int = _env_int("PI_WEB_WATCHER_HTTP_TIMEOUT_S", 15)
