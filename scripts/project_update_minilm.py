#!/usr/bin/env python3
"""Project-update analyser that reuses the existing MiniLM/Qwen backends.

This script intentionally stays separate from the meeting-minutes final
workflow. It keeps the rule-based project analyser as the source of structured
project status data, then adds a project-specific semantic evidence pass and an
optional Qwen cleanup pass for report prose.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
from pathlib import Path
import re
import sys
import time
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

try:
    from meeting_minutes_minilm_experiment import LocalMinutesRewriter, MiniLMBackend
    from python_llm import analyse as analyse_project_update
except ModuleNotFoundError:  # pragma: no cover - defensive fallback for unusual import paths
    from scripts.meeting_minutes_minilm_experiment import LocalMinutesRewriter, MiniLMBackend  # type: ignore
    from scripts.python_llm import analyse as analyse_project_update  # type: ignore


HEALTH_AREA_PROTOTYPES = {
    "scope": [
        "scope has changed or requirements are unclear",
        "deliverables, acceptance criteria, or requirements need attention",
        "work is complete against the agreed scope",
    ],
    "schedule": [
        "timeline, deadlines, milestones, or forecast dates are slipping",
        "delivery remains on schedule and milestones are progressing",
        "work is blocked or delayed by a dependency",
    ],
    "financial": [
        "budget, commercial impact, revenue, cost, or financial benefit is discussed",
        "funding or financial approval is required",
    ],
    "resources": [
        "capacity, staffing, ownership, or workload is a risk",
        "owners have actions and enough resource to continue",
    ],
    "other_issue_risk": [
        "a risk, blocker, dependency, or issue needs attention",
        "there is a decision, assumption, or unresolved project risk",
    ],
}

RISK_PROTOTYPES = [
    "This project update contains a new risk or unresolved blocker.",
    "A dependency is preventing progress.",
    "There is a delivery risk that needs mitigation.",
    "A workstream is delayed, blocked, or awaiting external input.",
]


@dataclass
class EvidenceWindow:
    text: str
    speaker: str = ""
    turn_index: int | None = None
    source: str = "transcript"


def read_input(path: str | None) -> str:
    if path:
        return Path(path).read_text(encoding="utf-8")
    return sys.stdin.read()


def clean_text(value: Any) -> str:
    return " ".join(str(value or "").split()).strip()


def cosine_from_lookup(lookup: dict[str, list[float]], left: str, right: str) -> float:
    left_vec = lookup.get(clean_text(left))
    right_vec = lookup.get(clean_text(right))
    if not left_vec or not right_vec:
        return 0.0
    return round(sum(a * b for a, b in zip(left_vec, right_vec)), 4)


def collect_evidence_windows(result: dict[str, Any]) -> list[EvidenceWindow]:
    windows: list[EvidenceWindow] = []
    for index, turn in enumerate(result.get("cleaned_turns", [])):
        speaker = clean_text(turn.get("speaker", ""))
        sentences = turn.get("sentences", [])
        if not isinstance(sentences, list):
            sentences = []
        for sentence in sentences:
            text = clean_text(sentence)
            if text:
                windows.append(EvidenceWindow(text=text, speaker=speaker, turn_index=index))
    for segment in result.get("segments", []):
        for field in ("normalised_evidence_summary", "excerpt"):
            text = clean_text(segment.get(field, ""))
            if text:
                windows.append(EvidenceWindow(text=text, source=f"segment.{field}"))
        for text in segment.get("evidence", []):
            cleaned = clean_text(text)
            if cleaned:
                windows.append(EvidenceWindow(text=cleaned, source="segment.evidence"))
    seen: set[str] = set()
    unique = []
    for window in windows:
        key = window.text.lower()
        if key in seen:
            continue
        seen.add(key)
        unique.append(window)
    return unique


def semantic_lookup(backend: MiniLMBackend, windows: list[EvidenceWindow], targets: list[str]) -> dict[str, list[float]]:
    if not backend.available:
        return {}
    texts = [window.text for window in windows] + [clean_text(target) for target in targets if clean_text(target)]
    return backend.encode_many(texts)


def top_matches(
    lookup: dict[str, list[float]],
    windows: list[EvidenceWindow],
    targets: list[str],
    limit: int = 3,
) -> list[dict[str, Any]]:
    scored = []
    for window in windows:
        best = max((cosine_from_lookup(lookup, window.text, target) for target in targets), default=0.0)
        if best <= 0:
            continue
        scored.append(
            {
                "text": window.text,
                "speaker": window.speaker,
                "turnIndex": window.turn_index,
                "source": window.source,
                "score": best,
            }
        )
    scored.sort(key=lambda item: item["score"], reverse=True)
    return scored[:limit]


def enrich_segments(result: dict[str, Any], backend: MiniLMBackend) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    windows = collect_evidence_windows(result)
    segment_targets = []
    for segment in result.get("segments", []):
        segment_targets.append(str(segment.get("milestone", "")).replace("_", " "))
        segment_targets.extend(segment.get("evidence", [])[:2])
    health_targets = [text for group in HEALTH_AREA_PROTOTYPES.values() for text in group]
    risk_targets = RISK_PROTOTYPES
    lookup = semantic_lookup(backend, windows, segment_targets + health_targets + risk_targets)

    enriched = []
    for segment in result.get("segments", []):
        targets = [
            str(segment.get("milestone", "")).replace("_", " "),
            clean_text(segment.get("normalised_evidence_summary", "")),
            clean_text(segment.get("excerpt", "")),
        ] + [clean_text(item) for item in segment.get("evidence", [])[:2]]
        matches = top_matches(lookup, windows, [target for target in targets if target], limit=3)
        enriched.append(
            {
                **segment,
                "semantic_evidence": matches,
                "semantic_confidence": matches[0]["score"] if matches else 0.0,
            }
        )

    health_area_matches = {
        area: top_matches(lookup, windows, prototypes, limit=3)
        for area, prototypes in HEALTH_AREA_PROTOTYPES.items()
    }
    risk_matches = top_matches(lookup, windows, risk_targets, limit=5)
    diagnostics = {
        "minilmAvailable": backend.available,
        "minilmModelName": backend.model_name,
        "minilmReason": backend.reason,
        "evidenceWindowCount": len(windows),
        "healthAreaMatches": health_area_matches,
        "riskEvidenceMatches": risk_matches,
    }
    return enriched, diagnostics


def health_to_report_status(value: str) -> str:
    value = (value or "unknown").lower()
    if value == "green":
        return "on_track"
    if value == "amber":
        return "at_risk"
    if value == "red":
        return "off_track"
    if value == "blue":
        return "completed"
    return "unknown"


def friendly_milestone_label(value: str) -> str:
    words = re.sub(r"[_-]+", " ", str(value or "")).strip().split()
    labels = []
    for word in words:
        lower = word.lower()
        if lower in {"ai", "rag", "sow", "ei"}:
            labels.append(lower.upper())
        else:
            labels.append(lower.capitalize())
    return " ".join(labels) or "Workstream"


def blank_unknown_status(value: Any) -> Any:
    return "" if str(value or "").strip().lower() == "unknown" else value


def combine_blockers_and_next_steps(segment: dict[str, Any]) -> list[str]:
    combined: list[str] = []
    for field in ("blocking_factors", "next_steps"):
        raw_items = segment.get(field, [])
        if isinstance(raw_items, str):
            raw_items = [raw_items]
        if not isinstance(raw_items, list):
            continue
        for item in raw_items:
            text = clean_text(item)
            if text and text.lower() not in {existing.lower() for existing in combined}:
                combined.append(text)
    return combined


def build_report_payload(result: dict[str, Any], enriched_segments: list[dict[str, Any]], diagnostics: dict[str, Any]) -> dict[str, Any]:
    summary = result.get("project_health_summary", {})
    overall = summary.get("overall_health", "unknown")
    key_updates = [
        segment.get("normalised_evidence_summary") or segment.get("excerpt")
        for segment in enriched_segments
        if segment.get("normalised_evidence_summary") or segment.get("excerpt")
    ][:8]
    risk_suggestions = []
    for segment in enriched_segments:
        if segment.get("delivery_status") in {"blocked", "awaiting_input", "delayed"} or segment.get("agreed_rag_status") in {"amber", "red"}:
            risk_suggestions.append(
                {
                    "riskTitle": f"{friendly_milestone_label(segment.get('milestone', 'Workstream'))} needs attention",
                    "description": segment.get("normalised_evidence_summary") or segment.get("status_resolution_note") or segment.get("excerpt", ""),
                    "suggestedMitigation": "; ".join(segment.get("next_steps", [])[:2]) or "Review owner, dependency, and next action.",
                    "confidence": segment.get("semantic_confidence") or segment.get("health_assessment_confidence") or 0.5,
                    "relatedMilestone": segment.get("milestone", ""),
                }
            )

    report_milestones = []
    for segment in enriched_segments:
        item = dict(segment)
        item["delivery_status"] = blank_unknown_status(item.get("delivery_status"))
        item["health_assessment"] = blank_unknown_status(item.get("health_assessment"))
        item["next_steps"] = combine_blockers_and_next_steps(item)
        item["blocking_factors"] = []
        report_milestones.append(item)

    return {
        "reportStatus": "draft",
        "overallHealth": health_to_report_status(overall),
        "overallHealthRag": overall,
        "summary": summary.get("overall_health_reason", "Project update analysed from transcript."),
        "keyUpdates": [clean_text(item) for item in key_updates if clean_text(item)],
        "healthAreas": {
            area: {
                "status": blank_unknown_status(health_to_report_status(overall if area == "schedule" else "unknown")),
                "trend": "stable",
                "evidence": matches,
            }
            for area, matches in diagnostics.get("healthAreaMatches", {}).items()
        },
        "milestones": report_milestones,
        "risks": risk_suggestions,
        "actions": result.get("actions", []),
        "comparisonSnapshot": result.get("comparison_snapshot", {}),
    }


def rewrite_report_summary(report: dict[str, Any], rewriter: LocalMinutesRewriter) -> tuple[dict[str, Any], dict[str, Any]]:
    diagnostics = {
        "rewriterAvailable": rewriter.available,
        "rewriterModelName": rewriter.model_name,
        "rewriterModelPath": rewriter.model_path,
        "rewriterReason": rewriter.reason,
        "rewriteEdits": [],
        "rewriteRuntimeMs": 0.0,
    }
    if not rewriter.available:
        return report, diagnostics

    rewrite_plan = [{"field": "summary", "category": "discussion", "text": report.get("summary", "")}]
    rewrite_plan.extend(
        {"field": "keyUpdates", "index": index, "category": "discussion", "text": text}
        for index, text in enumerate(report.get("keyUpdates", [])[:5])
    )
    started = time.perf_counter()
    results = rewriter.rewrite_items([{"category": item["category"], "text": item["text"]} for item in rewrite_plan])
    diagnostics["rewriteRuntimeMs"] = round((time.perf_counter() - started) * 1000, 2)

    rewritten = {**report, "keyUpdates": list(report.get("keyUpdates", []))}
    for item, result_item in zip(rewrite_plan, results):
        after = clean_text(result_item.get("rewritten", "")) or item["text"]
        meta = result_item.get("meta", {})
        diagnostics["rewriteEdits"].append({"field": item["field"], "before": item["text"], "after": after, **meta})
        if item["field"] == "summary":
            rewritten["summary"] = after
        elif item["field"] == "keyUpdates":
            rewritten["keyUpdates"][item["index"]] = after
    return rewritten, diagnostics


def build_project_update_output(transcript_text: str, use_minilm: bool = True, use_rewrite: bool = True) -> dict[str, Any]:
    started = time.perf_counter()
    baseline = analyse_project_update(transcript_text)
    backend = MiniLMBackend.load(enabled=use_minilm)
    enriched_segments, semantic_diagnostics = enrich_segments(baseline, backend)
    report = build_report_payload(baseline, enriched_segments, semantic_diagnostics)

    rewriter = LocalMinutesRewriter.load(enabled=use_rewrite)
    report, rewrite_diagnostics = rewrite_report_summary(report, rewriter)
    timing_total = round((time.perf_counter() - started) * 1000, 2)

    return {
        **baseline,
        "segments": enriched_segments,
        "mode": "project_update_minilm",
        "projectReport": report,
        "modelDiagnostics": {
            **semantic_diagnostics,
            **rewrite_diagnostics,
            "totalRuntimeMs": timing_total,
        },
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Analyse a project-update transcript with project-specific MiniLM/Qwen enrichment.")
    parser.add_argument("path", nargs="?", help="Optional path to UTF-8 transcript text.")
    parser.add_argument("--skip-minilm", action="store_true", help="Run the project workflow without MiniLM enrichment.")
    parser.add_argument("--skip-rewrite", action="store_true", help="Skip the Qwen cleanup pass.")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON output.")
    return parser.parse_args(argv)


def main() -> int:
    args = parse_args(sys.argv[1:])
    text = read_input(args.path).strip()
    if not text:
        print("No input text provided.", file=sys.stderr)
        return 1
    output = build_project_update_output(text, use_minilm=not args.skip_minilm, use_rewrite=not args.skip_rewrite)
    print(json.dumps(output, indent=2 if args.pretty else None, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
