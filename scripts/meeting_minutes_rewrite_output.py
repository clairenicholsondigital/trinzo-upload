#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from meeting_minutes_minilm_experiment import LocalMinutesRewriter, rewrite_minutes_output_payload
from meeting_minutes_text import apply_british_english_to_payload


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Rewrite a meeting-minutes output payload using the local Qwen rewriter.")
    parser.add_argument("output_json_path", help="Path to the extracted output JSON file.")
    parser.add_argument(
        "--skip-diagnostics",
        action="store_true",
        help="Omit per-item rewrite diagnostics from the final JSON response.",
    )
    return parser.parse_args(argv)


def build_counts(payload: dict) -> dict[str, int]:
    return {
        "discussionPoints": len(payload.get("discussionPoints", [])),
        "decisions": len(payload.get("decisions", [])),
        "actions": len(payload.get("actions", [])),
    }


def main() -> int:
    args = parse_args(sys.argv[1:])
    output_path = Path(args.output_json_path)
    output = json.loads(output_path.read_text(encoding="utf-8"))
    rewriter = LocalMinutesRewriter.load(enabled=True)
    include_diagnostics = not args.skip_diagnostics

    rewritten_output, diagnostics = rewrite_minutes_output_payload(
        output,
        rewriter=rewriter,
        include_diagnostics=include_diagnostics,
    )
    rewritten_output = apply_british_english_to_payload(rewritten_output)

    payload = {
        "mode": "meeting_minutes_final_rewrite",
        "executed": diagnostics.get("rewriterAvailable", False),
        "rewriterAvailable": rewriter.available,
        "rewriterModelName": rewriter.model_name,
        "rewriterModelPath": rewriter.model_path,
        "rewriterReason": rewriter.reason,
        "output": rewritten_output,
        "counts": build_counts(rewritten_output or {}),
        "timingMs": {
            "rewrite": round(float(diagnostics.get("rewriteRuntimeMs", 0.0)), 2),
            "total": round(float(diagnostics.get("rewriteRuntimeMs", 0.0)), 2),
        },
    }
    if include_diagnostics:
        payload["diagnostics"] = diagnostics

    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
