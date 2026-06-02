#!/usr/bin/env python3
from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from meeting_minutes_minilm_experiment import MiniLMBackend


HOST = os.environ.get("MINUTES_MINILM_WORKER_HOST", "127.0.0.1")
PORT = int(os.environ.get("MINUTES_MINILM_WORKER_PORT", "8767"))


BACKEND = MiniLMBackend.load(enabled=True, prefer_remote=False)


class MiniLMWorkerHandler(BaseHTTPRequestHandler):
    server_version = "MinutesMiniLMWorker/1.0"

    def log_message(self, format: str, *args) -> None:  # pragma: no cover
        return

    def _send_json(self, payload: dict, status: int = 200) -> None:
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:  # pragma: no cover - exercised in real envs
        if self.path != "/health":
            self._send_json({"ok": False, "reason": "Not found."}, status=404)
            return
        self._send_json(
            {
                "ok": BACKEND.available,
                "reason": BACKEND.reason,
                "modelName": BACKEND.model_name,
            }
        )

    def do_POST(self) -> None:  # pragma: no cover - exercised in real envs
        if self.path != "/encode":
            self._send_json({"ok": False, "reason": "Not found."}, status=404)
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            content_length = 0
        raw_body = self.rfile.read(content_length) if content_length > 0 else b"{}"
        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except Exception:
            self._send_json({"ok": False, "reason": "Invalid JSON body."}, status=400)
            return

        texts = payload.get("texts", [])
        if not isinstance(texts, list):
            self._send_json({"ok": False, "reason": "`texts` must be a list."}, status=400)
            return

        embeddings = BACKEND.encode_many([str(text) for text in texts])
        self._send_json(
            {
                "ok": BACKEND.available,
                "embeddings": embeddings,
                "modelName": BACKEND.model_name,
            },
            status=200 if BACKEND.available else 503,
        )


def main() -> int:  # pragma: no cover - exercised in real envs
    server = ThreadingHTTPServer((HOST, PORT), MiniLMWorkerHandler)
    print(json.dumps({"ok": True, "host": HOST, "port": PORT, "modelName": BACKEND.model_name}))
    server.serve_forever()
    return 0


if __name__ == "__main__":  # pragma: no cover - exercised in real envs
    raise SystemExit(main())
