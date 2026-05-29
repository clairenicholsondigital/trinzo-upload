#!/usr/bin/env python3
"""Python-only project update / milestone status analyser.

Deterministic heuristics only; no LLM, OpenAI, API model, or external
inference service calls are made.
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter, OrderedDict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

SPEAKER_RE = re.compile(r"^\s*([A-Z][A-Za-z .'-]{1,60})\s*[:\-–]\s+(.+)$")
MILESTONE_RE = re.compile(r"\b(?:milestone|workstream|stream|phase|deliverable|project|epic|module|feature)\s*[:#\-]?\s*([A-Za-z0-9][A-Za-z0-9 /_.&-]{2,80})", re.IGNORECASE)
STATUS_RE = re.compile(r"\b(status|rag|health)\s*[:\-]\s*(red|amber|yellow|green|on track|at risk|blocked|complete|done|delayed)", re.IGNORECASE)

RED_WORDS = re.compile(r"\b(red|blocked|blocker|stuck|critical|late|overdue|missed|cannot|dependency|risk is high|escalat)\b", re.IGNORECASE)
AMBER_WORDS = re.compile(r"\b(amber|yellow|at risk|risk|delay|delayed|slip|concern|watch|partial|behind|issue|gap)\b", re.IGNORECASE)
GREEN_WORDS = re.compile(r"\b(green|on track|complete|completed|done|ready|delivered|resolved|no issues|progressing well|finished)\b", re.IGNORECASE)
NEXT_WORDS = re.compile(r"\b(next|follow up|action|will|plan|todo|to do|need to|needs to)\b", re.IGNORECASE)
CHANGE_WORDS = re.compile(r"\b(changed|moved|was red|was amber|was green|from red|from amber|from green|improved|worsened|now red|now amber|now green)\b", re.IGNORECASE)


def read_transcript(path: str) -> str:
    return Path(path).read_text(encoding="utf-8", errors="replace")


def compact_lines(text: str) -> list[str]:
    return [line.strip() for line in text.replace("\r\n", "\n").split("\n") if line.strip()]


def clean_milestone(value: str) -> str:
    value = re.split(r"\s{2,}|[.;|]", value.strip())[0]
    value = re.sub(r"\b(status|rag|health)\b.*$", "", value, flags=re.IGNORECASE).strip(" -–:")
    return value[:90] or "General project update"


def infer_status(text: str) -> tuple[str, list[str]]:
    scores = Counter()
    tags: list[str] = []

    explicit = STATUS_RE.search(text)
    if explicit:
        raw = explicit.group(2).lower()
        if raw in {"red", "blocked"}:
            return "red", ["explicit_red_status"]
        if raw in {"amber", "yellow", "at risk", "delayed"}:
            return "amber", ["explicit_amber_status"]
        if raw in {"green", "on track", "complete", "done"}:
            return "green", ["explicit_green_status"]

    for pattern, status, tag in (
        (RED_WORDS, "red", "blocking_or_critical_language"),
        (AMBER_WORDS, "amber", "risk_or_delay_language"),
        (GREEN_WORDS, "green", "positive_progress_language"),
    ):
        matches = pattern.findall(text)
        if matches:
            scores[status] += len(matches)
            tags.append(tag)

    if not scores:
        return "amber", ["insufficient_status_signal"]
    if scores["red"]:
        return "red", tags
    if scores["amber"] >= scores["green"]:
        return "amber", tags
    return "green", tags


def split_segments(lines: list[str]) -> OrderedDict[str, list[str]]:
    segments: OrderedDict[str, list[str]] = OrderedDict()
    current = "General project update"
    segments[current] = []

    for line in lines:
        speaker = SPEAKER_RE.match(line)
        if speaker and speaker.group(1).strip().lower() in {"milestone", "workstream", "stream", "phase", "deliverable", "project", "epic", "module", "feature", "status", "rag"}:
            speaker = None
        content = speaker.group(2).strip() if speaker else line
        milestone = MILESTONE_RE.search(content)
        if milestone:
            current = clean_milestone(milestone.group(1))
            segments.setdefault(current, [])
        if content:
            segments[current].append(content)

    if len(segments) == 1:
        # Try to split long transcripts into sentence-level milestones when no headings exist.
        original_general = list(segments.get(current, []))
        sentences = re.split(r"(?<=[.!?])\s+", " ".join(lines))
        for sentence in sentences:
            milestone = MILESTONE_RE.search(sentence)
            if milestone:
                current = clean_milestone(milestone.group(1))
                segments.setdefault(current, [])
            if sentence.strip():
                segments[current].append(sentence.strip())
        if len(segments) > 1 and original_general == segments.get("General project update", []):
            segments.pop("General project update", None)
    return segments


def status_reasons(text: str, status: str) -> list[str]:
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+|\n+", text) if s.strip()]
    selected: list[str] = []
    matcher = {"red": RED_WORDS, "amber": AMBER_WORDS, "green": GREEN_WORDS}.get(status, AMBER_WORDS)
    for sentence in sentences:
        if matcher.search(sentence):
            selected.append(sentence[:240])
    return selected[:5]


def blocking_factors(text: str) -> list[str]:
    return [
        s.strip()[:220]
        for s in re.split(r"(?<=[.!?])\s+|\n+", text)
        if RED_WORDS.search(s) or re.search(r"\b(dependency|waiting|blocked by|cannot)\b", s, re.IGNORECASE)
    ][:5]


def next_steps(text: str) -> list[str]:
    return [
        s.strip()[:220]
        for s in re.split(r"(?<=[.!?])\s+|\n+", text)
        if NEXT_WORDS.search(s)
    ][:5]


def raw_status(text: str, rag: str) -> str:
    explicit = STATUS_RE.search(text)
    return explicit.group(2) if explicit else rag


def analyse(text: str) -> dict[str, Any]:
    lines = compact_lines(text)
    segments_map = split_segments(lines)
    milestones: list[dict[str, Any]] = []
    changes: list[dict[str, str]] = []

    for name, items in segments_map.items():
        if name == "General project update" and len(segments_map) > 1 and not any((RED_WORDS.search(item) or AMBER_WORDS.search(item) or GREEN_WORDS.search(item)) for item in items):
            continue
        evidence_text = "\n".join(items)
        rag, tags = infer_status(evidence_text)
        changed = CHANGE_WORDS.search(evidence_text)
        if changed:
            changes.append({"milestone": name, "evidence": changed.group(0)})
        milestones.append(
            {
                "milestone": name,
                "analysis_status": rag,
                "raw_status": raw_status(evidence_text, rag),
                "rag_status": rag,
                "signal_summary": f"Detected {rag} status from deterministic transcript signals.",
                "reason_tags": tags,
                "status_reasons": status_reasons(evidence_text, rag),
                "evidence": items[:8],
                "blocking_factors": blocking_factors(evidence_text),
                "next_steps": next_steps(evidence_text),
            }
        )

    counts = Counter(item["rag_status"] for item in milestones)
    return {
        "segments": milestones,
        "summary": {
            "milestone_count": len(milestones),
            "rag_status_counts": {"red": counts["red"], "amber": counts["amber"], "green": counts["green"]},
            "changed_count": len(changes),
        },
        "changes": changes,
        "generatedBy": "python-llm deterministic project parser",
        "generatedAt": datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z"),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("transcript_path")
    args = parser.parse_args()
    print(json.dumps(analyse(read_transcript(args.transcript_path)), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
