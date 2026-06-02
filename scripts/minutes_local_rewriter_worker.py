#!/usr/bin/env python3
from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from meeting_minutes_minilm_experiment import LocalMinutesRewriter


HOST = os.environ.get("MINUTES_LOCAL_REWRITER_HOST", "127.0.0.1")
PORT = int(os.environ.get("MINUTES_LOCAL_REWRITER_PORT", "8765"))


REWRITER = LocalMinutesRewriter.load(enabled=True, prefer_remote=False)


class MinutesRewriterHandler(BaseHTTPRequestHandler):
    server_version = "MinutesLocalRewriter/1.0"

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
                "ok": REWRITER.available,
                "reason": REWRITER.reason,
                "modelName": REWRITER.model_name,
                "modelPath": REWRITER.model_path,
            }
        )

    def do_POST(self) -> None:  # pragma: no cover - exercised in real envs
        if self.path != "/rewrite":
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

        category = str(payload.get("category") or "discussion")
        text = str(payload.get("text") or "")
        rewritten, meta = REWRITER.rewrite_item(category, text)
        self._send_json(
            {
                "ok": REWRITER.available,
                "rewritten": rewritten,
                "meta": meta,
                "modelName": REWRITER.model_name,
                "modelPath": REWRITER.model_path,
            },
            status=200 if REWRITER.available else 503,
        )


def main() -> int:  # pragma: no cover - exercised in real envs
    server = ThreadingHTTPServer((HOST, PORT), MinutesRewriterHandler)
    print(json.dumps({"ok": True, "host": HOST, "port": PORT, "modelPath": REWRITER.model_path}))
    server.serve_forever()
    return 0


if __name__ == "__main__":  # pragma: no cover - exercised in real envs
    raise SystemExit(main())
