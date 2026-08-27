"""Minimal pi-web HTTP client for the session watcher (M-111).

Confirmed live against the real running pi-web instance during this card's
investigation:

  GET  /api/machines/local/sessions/<sessionId>/messages?cwd=<cwd>&limit=<n>
       -> {"messages": [...]} (a `MessagePage`-shaped object; NOT a bare
          array on this route — differs from `piwebProject.ts`'s bare
          `getMessages`, which hits a different, non-machines-prefixed route)

  POST /api/machines/local/sessions/<sessionId>/prompt
       body: {"text": "...", "cwd": "<workspace cwd>"}
       -> confirmed authoritatively by reading the real, running pi-web
          package's own compiled source
          (@jmfederico/pi-web/dist/server/sessions/sessionRoutes.js +
          piSessionService.js, inside the live `pi-web` container) after two
          rounds of live 400s revealed the initially-assumed
          `{"role": "user", "content": [...]}` browser-UI-shaped body was
          wrong for this specific route. The route handler is:
          `sessions.prompt(sessionRefFromBody(sessionId, body), body["text"],
          body["streamingBehavior"], body["attachments"])` —
          `sessionRefFromBody` requires `body["cwd"]` to be a non-empty
          string (else 400 "cwd field must be a string"/"...must not be
          empty"), and `requirePromptText` requires `body["text"]` to be a
          string (else 400 "Prompt text is required"). No `role`/`content`
          array fields exist on this route at all; `streamingBehavior` and
          `attachments` are optional and omitted here.

Deliberately stdlib-only (urllib) — this is a tiny, single-purpose service;
no need for httpx/requests here.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


class PiWebClientError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


def get_messages(
    base_url: str,
    session_id: str,
    cwd: str,
    limit: int,
    timeout_s: float,
) -> list[dict[str, Any]]:
    """Returns the messages list for a session, most-recent-last (matches
    the API's own natural order)."""
    query = urllib.parse.urlencode({"cwd": cwd, "limit": limit})
    url = f"{base_url}/api/machines/local/sessions/{urllib.parse.quote(session_id)}/messages?{query}"
    req = urllib.request.Request(url, method="GET")
    body = _request(req, timeout_s)
    if isinstance(body, dict) and isinstance(body.get("messages"), list):
        return body["messages"]
    if isinstance(body, list):
        return body
    raise PiWebClientError(f"unexpected /messages response shape: {type(body)!r}")


def get_status(
    base_url: str,
    session_id: str,
    cwd: str,
    timeout_s: float,
) -> dict[str, Any]:
    """Returns the session's live status object (`isStreaming`,
    `isCompacting`, etc.) — confirmed live shape via
    `/api/machines/local/sessions/<id>/status?cwd=<cwd>`, same route family
    as `get_messages` above."""
    query = urllib.parse.urlencode({"cwd": cwd})
    url = f"{base_url}/api/machines/local/sessions/{urllib.parse.quote(session_id)}/status?{query}"
    req = urllib.request.Request(url, method="GET")
    body = _request(req, timeout_s)
    if not isinstance(body, dict):
        raise PiWebClientError(f"unexpected /status response shape: {type(body)!r}")
    return body


def send_prompt(
    base_url: str,
    session_id: str,
    text: str,
    cwd: str,
    timeout_s: float,
) -> dict[str, Any]:
    """POSTs a continuation message, matching the real route's required body
    shape: `{"text": ..., "cwd": ...}` (confirmed against pi-web's own
    server source — see module docstring)."""
    url = f"{base_url}/api/machines/local/sessions/{urllib.parse.quote(session_id)}/prompt"
    payload = {"text": text, "cwd": cwd}
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    return _request(req, timeout_s)


def _request(req: urllib.request.Request, timeout_s: float) -> Any:
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise PiWebClientError(f"pi-web request failed ({exc.code}): {detail}", exc.code) from exc
    except urllib.error.URLError as exc:
        raise PiWebClientError(f"pi-web request failed: {exc.reason}") from exc

    if not raw:
        return None
    try:
        return json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise PiWebClientError(f"pi-web returned non-JSON response: {raw[:200]!r}") from exc
