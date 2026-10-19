#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

MODEL_NAME = os.environ.get("GLOBAL_MINILM_MODEL_NAME", "sentence-transformers/all-MiniLM-L6-v2")
HOST = os.environ.get("GLOBAL_MINILM_WORKER_HOST", "127.0.0.1")
PORT = int(os.environ.get("GLOBAL_MINILM_WORKER_PORT", "8768"))


class Backend:
    def __init__(self) -> None:
        self.available = False
        self.reason = "Not loaded."
        self.model_name = MODEL_NAME
        self.model: Any | None = None
        self.cache: dict[str, list[float]] = {}
        self.started_at = time.time()
        self.load()

    def load(self) -> None:
        try:
            from sentence_transformers import SentenceTransformer
            self.model = SentenceTransformer(self.model_name)
            self.available = True
            self.reason = ""
        except Exception as exc:
            self.available = False
            self.reason = f"Could not load {self.model_name}: {exc}"

    @staticmethod
    def clean(text: Any) -> str:
        return " ".join(str(text or "").strip().split())

    def encode_many(self, texts: list[Any]) -> dict[str, list[float]]:
        if not self.available or self.model is None:
            return {}
        # A reset swaps the cache. Requests already encoding finish against
        # their original cache, without losing hits or refilling the new one.
        cache = self.cache
        cleaned = [self.clean(text) for text in texts]
        cleaned = [text for text in cleaned if text]
        missing = [text for text in cleaned if text not in cache]
        if missing:
            embeddings = self.model.encode(missing, normalize_embeddings=True, show_progress_bar=False)
            for text, embedding in zip(missing, embeddings):
                cache[text] = embedding.tolist()
        return {text: cache[text] for text in cleaned if text in cache}

    def reset_cache(self) -> int:
        previous = self.cache
        self.cache = {}
        return len(previous)


BACKEND = Backend()


class Handler(BaseHTTPRequestHandler):
    server_version = "GlobalMiniLMWorker/1.0"

    def log_message(self, format: str, *args: Any) -> None:
        return

    def send_json(self, payload: dict[str, Any], status: int = 200) -> None:
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:
        if self.path != "/health":
            self.send_json({"ok": False, "reason": "Not found."}, 404)
            return
        self.send_json({
            "ok": BACKEND.available,
            "reason": BACKEND.reason,
            "modelName": BACKEND.model_name,
            "cacheSize": len(BACKEND.cache),
            "uptimeSeconds": round(time.time() - BACKEND.started_at, 2),
        }, 200 if BACKEND.available else 503)

    def do_POST(self) -> None:
        if self.path == "/cache/reset":
            if self.client_address[0] not in {"127.0.0.1", "::1"}:
                self.send_json({"ok": False, "reason": "Loopback access only."}, 403)
                return
            self.send_json({"ok": True, "cleared": BACKEND.reset_cache()})
            return
        if self.path != "/encode":
            self.send_json({"ok": False, "reason": "Not found."}, 404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length > 0 else b"{}"
            payload = json.loads(raw.decode("utf-8"))
        except Exception:
            self.send_json({"ok": False, "reason": "Invalid JSON body."}, 400)
            return
        texts = payload.get("texts", [])
        if not isinstance(texts, list):
            self.send_json({"ok": False, "reason": "`texts` must be a list."}, 400)
            return
        embeddings = BACKEND.encode_many(texts)
        self.send_json({
            "ok": BACKEND.available,
            "reason": BACKEND.reason,
            "modelName": BACKEND.model_name,
            "dimensions": len(next(iter(embeddings.values()), [])),
            "embeddings": embeddings,
        }, 200 if BACKEND.available else 503)


def main() -> int:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(json.dumps({"ok": BACKEND.available, "reason": BACKEND.reason, "host": HOST, "port": PORT, "modelName": BACKEND.model_name}), flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
