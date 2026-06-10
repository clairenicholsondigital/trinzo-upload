#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from meeting_minutes_minilm_experiment import LocalMinutesRewriter, normalize_text_fragment
from meeting_minutes_text import apply_british_english_to_payload


MAX_SNIPPET_CHARS = 4000


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Rewrite one selected meeting-minutes snippet using the local Qwen rewriter.")
    parser.add_argument("payload_json_path", help="Path to JSON payload containing snippet and optional category.")
    return parser.parse_args(argv)


def main() -> int:
    args = parse_args(sys.argv[1:])
    payload = json.loads(Path(args.payload_json_path).read_text(encoding="utf-8"))
    snippet = normalize_text_fragment(payload.get("snippet", ""))
    category = normalize_text_fragment(payload.get("category", "discussion")) or "discussion"

    if len(snippet) > MAX_SNIPPET_CHARS:
        print(json.dumps({"ok": False, "error": f"Snippet must be {MAX_SNIPPET_CHARS:,} characters or fewer."}, ensure_ascii=False))
        return 2

    start = time.perf_counter()
    rewriter = LocalMinutesRewriter.load(enabled=True)
    rewritten, meta = rewriter.rewrite_item(category, snippet)
    rewritten_payload = apply_british_english_to_payload({"snippet": rewritten})
    rewritten = normalize_text_fragment(rewritten_payload.get("snippet", rewritten))
    runtime_ms = round((time.perf_counter() - start) * 1000, 2)

    print(json.dumps({
        "ok": True,
        "mode": "meeting_minutes_final_snippet_rewrite",
        "executed": bool(rewriter.available),
        "rewriterAvailable": bool(rewriter.available),
        "rewriterModelName": rewriter.model_name,
        "rewriterReason": rewriter.reason,
        "category": category,
        "original": snippet,
        "rewritten": rewritten,
        "changed": rewritten.lower() != snippet.lower(),
        "meta": meta,
        "timingMs": {"rewrite": runtime_ms, "total": runtime_ms},
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
