"""Project knowledge chunking and MiniLM embedding helpers."""
from __future__ import annotations

import os
from pathlib import Path
import re
import sys
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

try:
    from meeting_minutes_minilm_experiment import MiniLMBackend
except Exception:  # pragma: no cover
    from scripts.meeting_minutes_minilm_experiment import MiniLMBackend  # type: ignore


def chunk_text(text: str, chunk_size: int = 1200, overlap: int = 150) -> list[str]:
    cleaned = re.sub(r"[ \t]+", " ", str(text or "").replace("\r\n", "\n")).strip()
    if not cleaned:
        return []
    chunk_size = max(int(chunk_size or 1200), 400)
    overlap = min(max(int(overlap or 0), 0), chunk_size // 2)
    if len(cleaned) <= chunk_size:
        return [cleaned]

    chunks: list[str] = []
    start = 0
    while start < len(cleaned):
        end = min(start + chunk_size, len(cleaned))
        if end < len(cleaned):
            window = cleaned[start:end]
            paragraph_break = max(window.rfind("\n\n"), window.rfind("\n"))
            sentence_break = max(window.rfind(". "), window.rfind("? "), window.rfind("! "))
            boundary = -1
            if paragraph_break > chunk_size * 0.55:
                boundary = paragraph_break + 1
            elif sentence_break > chunk_size * 0.55:
                boundary = sentence_break + 1
            if boundary > 0:
                end = start + boundary
        chunk = cleaned[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end >= len(cleaned):
            break
        start = max(end - overlap, start + 1)
    return chunks


def load_backend() -> MiniLMBackend:
    prefer_remote = os.getenv("PROJECT_KNOWLEDGE_MINILM_PREFER_REMOTE", "1") != "0"
    if prefer_remote and not os.getenv("MINUTES_MINILM_WORKER_URL"):
        os.environ["MINUTES_MINILM_WORKER_URL"] = os.getenv("PROJECT_KNOWLEDGE_MINILM_WORKER_URL", "http://127.0.0.1:8767")
    return MiniLMBackend.load(enabled=True, prefer_remote=prefer_remote)


def embed_texts(texts: list[str]) -> tuple[dict[str, list[float]], dict[str, Any]]:
    backend = load_backend()
    diagnostics: dict[str, Any] = {
        "available": bool(getattr(backend, "available", False)),
        "reason": getattr(backend, "reason", ""),
    }
    if not getattr(backend, "available", False):
        return {}, diagnostics
    embeddings = backend.encode_many(texts)
    diagnostics["embedded"] = len(embeddings)
    return embeddings, diagnostics
