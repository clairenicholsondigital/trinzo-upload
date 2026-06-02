#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

from meeting_minutes_minilm_experiment import (
    MiniLMBackend,
    build_minilm_variant,
    collect_experiment_context,
)


def build_counts(payload: dict) -> dict[str, int]:
    return {
        "discussionPoints": len(payload.get("discussionPoints", [])),
        "decisions": len(payload.get("decisions", [])),
        "actions": len(payload.get("actions", [])),
    }


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python3 meeting_minutes_minilm_compare_single.py <transcript_path>")

    transcript_path = Path(sys.argv[1])
    transcript_text = transcript_path.read_text(encoding="utf-8")

    baseline_start = time.perf_counter()
    baseline_output, intermediate = collect_experiment_context(transcript_text)
    baseline_runtime_ms = round((time.perf_counter() - baseline_start) * 1000, 2)

    backend = MiniLMBackend.load(enabled=True)
    diagnostics = {}
    minilm_output = None
    minilm_runtime_ms = 0.0

    if backend.available:
        minilm_start = time.perf_counter()
        minilm_output, diagnostics = build_minilm_variant(baseline_output, intermediate, backend)
        minilm_runtime_ms = round((time.perf_counter() - minilm_start) * 1000, 2)
    else:
        _, diagnostics = build_minilm_variant(baseline_output, intermediate, backend)

    payload = {
        "baseline": baseline_output,
        "minilm": {
            "executed": minilm_output is not None,
            "modelAvailable": backend.available,
            "modelName": backend.model_name,
            "modelReason": backend.reason,
            "output": minilm_output,
            "diagnostics": diagnostics,
        },
        "comparison": {
            "baselineCounts": build_counts(baseline_output),
            "minilmCounts": build_counts(minilm_output or {}),
            "addedDiscussionPoints": diagnostics.get("addedDiscussionPoints", []),
            "addedDecisions": diagnostics.get("addedDecisions", []),
            "addedActions": diagnostics.get("addedActions", []),
        },
        "timingMs": {
            "baseline": baseline_runtime_ms,
            "minilm": minilm_runtime_ms,
            "total": round(baseline_runtime_ms + minilm_runtime_ms, 2),
        },
    }

    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
