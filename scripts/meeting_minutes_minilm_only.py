#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

from meeting_minutes_minilm_experiment import (
    MiniLMBackend,
    build_minilm_only_output,
    collect_minilm_only_context,
)


def build_counts(payload: dict) -> dict[str, int]:
    return {
        "discussionPoints": len(payload.get("discussionPoints", [])),
        "decisions": len(payload.get("decisions", [])),
        "actions": len(payload.get("actions", [])),
    }


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python3 meeting_minutes_minilm_only.py <transcript_path>")

    transcript_path = Path(sys.argv[1])
    transcript_text = transcript_path.read_text(encoding="utf-8")

    context_start = time.perf_counter()
    intermediate = collect_minilm_only_context(transcript_text)
    context_runtime_ms = round((time.perf_counter() - context_start) * 1000, 2)

    backend = MiniLMBackend.load(enabled=True)
    diagnostics = {}
    output = None
    minilm_runtime_ms = 0.0

    if backend.available:
        minilm_start = time.perf_counter()
        output, diagnostics = build_minilm_only_output(transcript_text, intermediate, backend)
        minilm_runtime_ms = round((time.perf_counter() - minilm_start) * 1000, 2)
    else:
        _, diagnostics = build_minilm_only_output(transcript_text, intermediate, backend)

    payload = {
        "mode": "minilm_only",
        "executed": output is not None,
        "modelAvailable": backend.available,
        "modelName": backend.model_name,
        "modelReason": backend.reason,
        "output": output,
        "counts": build_counts(output or {}),
        "diagnostics": diagnostics,
        "timingMs": {
            "context": context_runtime_ms,
            "minilm": minilm_runtime_ms,
            "total": round(context_runtime_ms + minilm_runtime_ms, 2),
        },
    }

    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
