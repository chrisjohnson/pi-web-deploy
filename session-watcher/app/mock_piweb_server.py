"""Tiny stdlib-only mock pi-web HTTP server for end-to-end watcher tests.
Serves canned `/messages` responses matching pi-web's real API shape and
records every `/prompt` POST it receives, so tests can assert on exactly
what the watcher sent (and how many times).

No third-party deps — `http.server` + `json`.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any
from urllib.parse import urlparse


class MockPiWebServer:
    """Runs a real HTTP server on a background thread bound to 127.0.0.1 and
    an OS-assigned free port. `messages_by_session` maps sessionId -> the
    list of messages to serve for /messages. `prompts_received` accumulates
    every POST /prompt body, in order, as (session_id, payload) tuples."""

    def __init__(self, messages_by_session: dict[str, list[dict[str, Any]]]):
        self.messages_by_session = messages_by_session
        self.prompts_received: list[tuple[str, dict[str, Any]]] = []
        # Defaults to "not busy" so every existing test (which never calls
        # set_status) continues to exercise the send path unchanged.
        self.status_by_session: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()

        handler = _make_handler(self)
        self._httpd = HTTPServer(("127.0.0.1", 0), handler)
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        host, port = self._httpd.server_address[:2]
        return f"http://{host}:{port}"

    def __enter__(self) -> "MockPiWebServer":
        self._thread.start()
        return self

    def __exit__(self, *exc_info: Any) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()
        self._thread.join(timeout=5)

    def set_messages(self, session_id: str, messages: list[dict[str, Any]]) -> None:
        with self._lock:
            self.messages_by_session[session_id] = messages

    def set_status(self, session_id: str, status: dict[str, Any]) -> None:
        with self._lock:
            self.status_by_session[session_id] = status

    def append_message(self, session_id: str, message: dict[str, Any]) -> None:
        with self._lock:
            self.messages_by_session.setdefault(session_id, []).append(message)

    def _record_prompt(self, session_id: str, payload: dict[str, Any]) -> None:
        with self._lock:
            self.prompts_received.append((session_id, payload))
            # Mirror the real pi-web behavior loosely enough for e2e tests:
            # appending the sent prompt as a new user message (in the real
            # /messages projection's shape — content is a list of text
            # parts) so a subsequent poll sees it (proves the
            # double-injection guard).
            self.messages_by_session.setdefault(session_id, []).append(
                {
                    "role": "user",
                    "content": [{"type": "text", "text": payload.get("text", "")}],
                    "timestamp": 0,
                }
            )


def _make_handler(server: "MockPiWebServer") -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            pass  # keep test output quiet

        def _send_json_error(self, status: int, message: str) -> None:
            body = json.dumps({"error": message}).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            parts = parsed.path.strip("/").split("/")
            # /api/machines/local/sessions/<id>/messages
            if len(parts) >= 6 and parts[:4] == ["api", "machines", "local", "sessions"] and parts[5] == "messages":
                session_id = parts[4]
                with server._lock:
                    messages = list(server.messages_by_session.get(session_id, []))
                body = json.dumps({"messages": messages}).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            # /api/machines/local/sessions/<id>/status
            if len(parts) >= 6 and parts[:4] == ["api", "machines", "local", "sessions"] and parts[5] == "status":
                session_id = parts[4]
                with server._lock:
                    status = dict(server.status_by_session.get(session_id, {"isStreaming": False, "isCompacting": False}))
                body = json.dumps(status).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            self.send_response(404)
            self.end_headers()

        def do_POST(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            parts = parsed.path.strip("/").split("/")
            # /api/machines/local/sessions/<id>/prompt
            if len(parts) >= 6 and parts[:4] == ["api", "machines", "local", "sessions"] and parts[5] == "prompt":
                session_id = parts[4]
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length) if length else b"{}"
                payload = json.loads(raw.decode("utf-8")) if raw else {}

                # Mirrors the REAL pi-web API's own validation, confirmed by
                # reading @jmfederico/pi-web's own compiled server source
                # (sessionRoutes.js's sessionRefFromBody +
                # piSessionService.js's requirePromptText) — catches a
                # client-side regression against this exact contract in
                # tests, not just in prod.
                if not isinstance(payload.get("cwd"), str) or payload.get("cwd") == "":
                    self._send_json_error(400, "cwd field must be a string")
                    return
                if not isinstance(payload.get("text"), str):
                    self._send_json_error(400, "Prompt text is required")
                    return

                server._record_prompt(session_id, payload)
                body = json.dumps({"accepted": True}).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            self.send_response(404)
            self.end_headers()

    return Handler
