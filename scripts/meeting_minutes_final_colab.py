#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path
from typing import Any

from meeting_minutes_final_colab_core import generate_polished_minutes_pass
from meeting_minutes_text import apply_british_english_to_payload


def section(markdown: str, heading: str) -> str:
    pattern = re.compile(rf"^##\s+{re.escape(heading)}\s*$", re.IGNORECASE | re.MULTILINE)
    match = pattern.search(markdown)
    if not match:
        return ""
    rest = markdown[match.end() :]
    next_heading = re.search(r"^##\s+", rest, re.MULTILINE)
    return rest[: next_heading.start()] if next_heading else rest


def clean_line(value: str) -> str:
    value = re.sub(r"_\(Sources?:.*?\)_", "", value)
    return value.strip(" -")


def bullets(section_text: str) -> list[str]:
    values: list[str] = []
    for line in section_text.splitlines():
        stripped = line.strip()
        lowered = stripped.lower()
        if not stripped.startswith("- "):
            continue
        if lowered.startswith(("- none", "- no decisions", "- no action", "- no substantive")):
            continue
        values.append(clean_line(stripped))
    return values


def table_rows(section_text: str) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    headers: list[str] = []
    for line in section_text.splitlines():
        stripped = line.strip()
        if not stripped.startswith("|") or not stripped.endswith("|"):
            continue
        cells = [cell.strip() for cell in stripped.strip("|").split("|")]
        if not cells or all(set(cell) <= {"-"} for cell in cells):
            continue
        if not headers:
            headers = [cell.lower() for cell in cells]
            continue
        rows.append({headers[index]: cell for index, cell in enumerate(cells) if index < len(headers)})
    return rows


def parse_colab_minutes(markdown: str) -> dict[str, Any]:
    summary = bullets(section(markdown, "Summary"))
    discussion = bullets(section(markdown, "Discussion Points"))
    follow_up = bullets(section(markdown, "Follow-up / Open Questions"))
    decisions = bullets(section(markdown, "Decisions"))
    rows = table_rows(section(markdown, "Action Items"))
    actions = [
        {
            "meetingActionPoint": row.get("action", ""),
            "meetingActionPointOwner": row.get("owner", ""),
            "meetingActionPointDeadline": row.get("due / status", "")
            or row.get("deadline / status", "")
            or row.get("deadline", ""),
        }
        for row in rows
        if row.get("action")
    ]
    meeting_action_points = [action["meetingActionPoint"] for action in actions]
    meeting_action_owners = [action["meetingActionPointOwner"] for action in actions]
    meeting_action_deadlines = [action["meetingActionPointDeadline"] for action in actions]
    return {
        "meetingTitle": "",
        "meetingDate": "",
        "meetingLocation": "",
        "meetingDescription": "",
        "meetingObjectives": [],
        "participants": {"client": [], "trinzo": []},
        "executiveSummary": " ".join(summary),
        "discussionPoints": discussion + follow_up,
        "decisions": decisions,
        "meetingActionPoint": meeting_action_points,
        "meetingActionPointOwner": meeting_action_owners,
        "meetingActionPointDeadline": meeting_action_deadlines,
        "actions": actions,
        "meetingMinutes": [{"topic": "Discussion", "discussionPoints": discussion + follow_up}],
        "nextSteps": [
            {
                "action": action["meetingActionPoint"],
                "owner": action["meetingActionPointOwner"],
                "deadline": action["meetingActionPointDeadline"],
            }
            for action in actions
        ],
    }


def build_counts(payload: dict[str, Any]) -> dict[str, int]:
    return {
        "discussionPoints": len(payload.get("discussionPoints", [])),
        "decisions": len(payload.get("decisions", [])),
        "actions": len(payload.get("actions", [])),
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the Colab-style meeting-minutes-final extractor.")
    parser.add_argument("transcript_path", help="Path to the transcript file.")
    parser.add_argument("--include-baseline-reference", action="store_true")
    parser.add_argument("--skip-diagnostics", action="store_true")
    parser.add_argument("--skip-rewrite", action="store_true")
    return parser.parse_args(argv)


def main() -> int:
    args = parse_args(sys.argv[1:])
    transcript_text = Path(args.transcript_path).read_text(encoding="utf-8")

    start = time.perf_counter()
    result = generate_polished_minutes_pass(transcript_text=transcript_text)
    runtime_ms = round((time.perf_counter() - start) * 1000, 2)
    output = apply_british_english_to_payload(parse_colab_minutes(result["minutes"]))

    payload: dict[str, Any] = {
        "mode": "meeting_minutes_final_colab",
        "executed": True,
        "modelAvailable": True,
        "modelName": "MiniLM evidence graph / Colab runner",
        "modelReason": "local_colab_runner",
        "rewriterAvailable": False,
        "rewriterModelName": None,
        "rewriterModelPath": None,
        "rewriterReason": "rewrite skipped for Colab runner",
        "output": output,
        "counts": build_counts(output),
        "timingMs": {
            "baseline": 0.0,
            "context": 0.0,
            "minilm": runtime_ms,
            "rewrite": 0.0,
            "total": runtime_ms,
        },
    }

    if not args.skip_diagnostics:
        payload["diagnostics"] = {
            "scorecard": result.get("scorecard", {}),
            "evaluation": result.get("evaluation", {}),
            "markdownMinutes": result.get("minutes", ""),
        }

    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
