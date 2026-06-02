#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
import time
import argparse
from pathlib import Path

from meeting_minutes_minilm_experiment import (
    LocalMinutesRewriter,
    MiniLMBackend,
    build_minilm_only_output,
    collect_experiment_context,
    collect_minilm_only_context,
    summarize_objectives_for_output,
)
from meeting_minutes_text import apply_british_english_to_payload


def build_counts(payload: dict) -> dict[str, int]:
    return {
        "discussionPoints": len(payload.get("discussionPoints", [])),
        "decisions": len(payload.get("decisions", [])),
        "actions": len(payload.get("actions", [])),
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the MiniLM-only meeting minutes lab.")
    parser.add_argument("transcript_path", help="Path to the transcript file.")
    parser.add_argument(
        "--include-baseline-reference",
        action="store_true",
        help="Also run the baseline extractor and include comparison counts.",
    )
    parser.add_argument(
        "--skip-diagnostics",
        action="store_true",
        help="Omit diagnostics payload fields from the final JSON response.",
    )
    parser.add_argument(
        "--skip-rewrite",
        action="store_true",
        help="Skip the Qwen rewrite pass and return raw MiniLM-selected output only.",
    )
    parser.add_argument(
        "--rewrite-objectives-only",
        action="store_true",
        help="Use Qwen only to summarise meeting objectives before returning the MiniLM-selected output.",
    )
    return parser.parse_args(argv)


def main() -> int:
    args = parse_args(sys.argv[1:])
    transcript_path = Path(args.transcript_path)
    transcript_text = transcript_path.read_text(encoding="utf-8")

    baseline_output = None
    baseline_runtime_ms = 0.0
    if args.include_baseline_reference:
        baseline_start = time.perf_counter()
        baseline_output, _baseline_intermediate = collect_experiment_context(transcript_text)
        baseline_runtime_ms = round((time.perf_counter() - baseline_start) * 1000, 2)

    context_start = time.perf_counter()
    intermediate = collect_minilm_only_context(transcript_text)
    context_runtime_ms = round((time.perf_counter() - context_start) * 1000, 2)

    backend = MiniLMBackend.load(enabled=True)
    rewriter = LocalMinutesRewriter.load(enabled=(not args.skip_rewrite) or args.rewrite_objectives_only)
    diagnostics = {}
    output = None
    minilm_runtime_ms = 0.0
    rewrite_runtime_ms = 0.0
    objective_summary_runtime_ms = 0.0

    include_diagnostics = not args.skip_diagnostics

    if backend.available:
        minilm_start = time.perf_counter()
        output, diagnostics = build_minilm_only_output(
            transcript_text,
            intermediate,
            backend,
            rewriter=rewriter,
            include_diagnostics=include_diagnostics,
        )
        elapsed_ms = round((time.perf_counter() - minilm_start) * 1000, 2)
        minilm_runtime_ms = elapsed_ms
        rewrite_runtime_ms = round(float(diagnostics.get("rewriteRuntimeMs", 0.0)), 2)
        if output is not None and args.rewrite_objectives_only:
            objective_start = time.perf_counter()
            objectives, objective_diag = summarize_objectives_for_output(output, rewriter=rewriter)
            output["meetingObjectives"] = objectives
            objective_runtime_ms = round((time.perf_counter() - objective_start) * 1000, 2)
            objective_summary_runtime_ms = objective_runtime_ms
            diagnostics["objectiveSummary"] = objective_diag
            diagnostics["objectiveSummaryRuntimeMs"] = objective_runtime_ms
            rewrite_runtime_ms = round(rewrite_runtime_ms + objective_runtime_ms, 2)
    else:
        _, diagnostics = build_minilm_only_output(
            transcript_text,
            intermediate,
            backend,
            rewriter=rewriter,
            include_diagnostics=include_diagnostics,
        )

    payload = {
        "mode": "minilm_only",
        "executed": output is not None,
        "modelAvailable": backend.available,
        "modelName": backend.model_name,
        "modelReason": backend.reason,
        "rewriterAvailable": rewriter.available,
        "rewriterModelName": rewriter.model_name,
        "rewriterModelPath": rewriter.model_path,
        "rewriterReason": rewriter.reason,
        "output": apply_british_english_to_payload(output),
        "counts": build_counts(output or {}),
        "timingMs": {
            "baseline": baseline_runtime_ms,
            "context": context_runtime_ms,
            "minilm": minilm_runtime_ms,
            "rewrite": rewrite_runtime_ms,
            "total": round(baseline_runtime_ms + context_runtime_ms + minilm_runtime_ms + objective_summary_runtime_ms, 2),
        },
    }
    if args.include_baseline_reference and baseline_output is not None:
        baseline_output = apply_british_english_to_payload(baseline_output)
        payload["baselineReference"] = {
            "counts": build_counts(baseline_output),
            "discussionPoints": baseline_output.get("discussionPoints", []),
            "decisions": baseline_output.get("decisions", []),
            "meetingActionPoint": baseline_output.get("meetingActionPoint", []),
        }
    if include_diagnostics:
        payload["diagnostics"] = diagnostics

    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
