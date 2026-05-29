#!/usr/bin/env python3
"""Python-only transcript-to-meeting-minutes test analyser.

This intentionally uses deterministic parsing heuristics only. It does not call
LLMs, OpenAI, model APIs, or external inference services.
"""

from __future__ import annotations

import argparse
import json
import re
from collections import OrderedDict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

DATE_PATTERNS = [
    re.compile(r"\b(\d{4}-\d{2}-\d{2})\b"),
    re.compile(r"\b(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b"),
    re.compile(
        r"\b((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|"
        r"Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)"
        r"\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?)\b",
        re.IGNORECASE,
    ),
]

ACTION_WORDS = re.compile(
    r"\b(action|action item|follow up|next step|owner|due|deadline|will|to do|todo|assign(?:ed)?|responsible)\b",
    re.IGNORECASE,
)
CLIENT_HINTS = re.compile(r"\b(client|customer|site|external|vendor)\b", re.IGNORECASE)
TRINZO_HINTS = re.compile(r"\b(trinzo|consultant|internal|facilitator)\b", re.IGNORECASE)
SPEAKER_RE = re.compile(r"^\s*([A-Z][A-Za-z .'-]{1,60})(?:\s*\(([^)]*)\))?\s*[:\-–]\s+(.+)$")


def read_transcript(path: str) -> str:
    return Path(path).read_text(encoding="utf-8", errors="replace")


def compact_lines(text: str) -> list[str]:
    return [line.strip() for line in text.replace("\r\n", "\n").split("\n") if line.strip()]


def first_match(patterns: list[re.Pattern[str]], text: str) -> str:
    for pattern in patterns:
        match = pattern.search(text)
        if match:
            return match.group(1).strip()
    return ""


def infer_title(lines: list[str]) -> str:
    for line in lines[:12]:
        lowered = line.lower()
        if any(key in lowered for key in ("transcript", "meeting", "webinar", "workshop", "check in", "minutes")):
            cleaned = re.sub(r"^(title|meeting title)\s*[:\-]\s*", "", line, flags=re.IGNORECASE)
            return cleaned[:120]
    for line in lines[:5]:
        if len(line) <= 120 and not SPEAKER_RE.match(line):
            return line
    return "Meeting minutes"


def infer_location(text: str) -> str:
    match = re.search(r"\b(location|venue)\s*[:\-]\s*([^\n]+)", text, re.IGNORECASE)
    if match:
        return match.group(2).strip()[:120]
    if re.search(r"\b(teams|zoom|webex|online|virtual)\b", text, re.IGNORECASE):
        return "Virtual meeting"
    return ""


def add_unique(target: list[str], name: str) -> None:
    cleaned = re.sub(r"\s+", " ", name).strip(" -–:")
    if cleaned and cleaned.lower() not in {item.lower() for item in target}:
        target.append(cleaned)


def infer_participants(lines: list[str]) -> dict[str, list[str]]:
    client: list[str] = []
    trinzo: list[str] = []
    unknown: list[str] = []

    participant_line = re.compile(r"\b(participants|attendees|client attendees|trinzo participants)\s*[:\-]\s*(.+)", re.IGNORECASE)
    for line in lines[:80]:
        listed = participant_line.search(line)
        if listed:
            bucket = trinzo if "trinzo" in listed.group(1).lower() else client if "client" in listed.group(1).lower() else unknown
            for name in re.split(r",|;|\band\b", listed.group(2)):
                add_unique(bucket, name)

        speaker = SPEAKER_RE.match(line)
        if not speaker or speaker.group(1).strip().lower() in {"date", "location", "participants", "attendees", "title"}:
            continue
        name, role = speaker.group(1).strip(), (speaker.group(2) or "")
        context = f"{name} {role}"
        if TRINZO_HINTS.search(context):
            add_unique(trinzo, name)
        elif CLIENT_HINTS.search(context):
            add_unique(client, name)
        else:
            add_unique(unknown, name)

    for index, name in enumerate(unknown):
        add_unique(client if index % 2 == 0 else trinzo, name)

    return {"client": client[:20], "trinzo": trinzo[:20]}


def infer_objectives(lines: list[str]) -> list[str]:
    objectives: list[str] = []
    capture = False
    for line in lines[:120]:
        if re.search(r"\b(objective|agenda|goal|purpose)\b", line, re.IGNORECASE):
            capture = True
            item = re.sub(r"^(objectives?|agenda|goals?|purpose)\s*[:\-]\s*", "", line, flags=re.IGNORECASE).strip()
            if item and item != line:
                objectives.append(item)
            continue
        if capture:
            if re.match(r"^[-*•]\s+", line):
                objectives.append(re.sub(r"^[-*•]\s+", "", line))
            elif len(objectives) >= 1:
                break
    if not objectives:
        objectives.append("Review transcript discussion and capture decisions, actions, and next steps.")
    return objectives[:8]


def infer_minutes(lines: list[str]) -> list[dict[str, Any]]:
    topics: OrderedDict[str, list[str]] = OrderedDict()
    current_topic = "General discussion"
    topics[current_topic] = []

    for line in lines:
        heading = re.match(r"^(?:topic|agenda item|section)\s*[:\-]\s*(.+)$", line, re.IGNORECASE)
        if heading:
            current_topic = heading.group(1).strip()[:100]
            topics.setdefault(current_topic, [])
            continue

        speaker = SPEAKER_RE.match(line)
        point = speaker.group(3).strip() if speaker else line
        if len(point) < 12:
            continue

        if re.search(r"\b(risk|issue|decision|agreed|discussed|question|update|status|blocker|timeline|scope)\b", point, re.IGNORECASE):
            topics[current_topic].append(point)
        elif len(topics[current_topic]) < 4:
            topics[current_topic].append(point)

    minutes = [
        {"itemTopic": topic, "discussionPoints": points[:10]}
        for topic, points in topics.items()
        if points
    ]
    return minutes or [{"itemTopic": "General discussion", "discussionPoints": lines[:5]}]


def infer_actions(lines: list[str]) -> list[dict[str, str]]:
    actions: list[dict[str, str]] = []
    for line in lines:
        if not ACTION_WORDS.search(line):
            continue
        speaker = SPEAKER_RE.match(line)
        text = speaker.group(3).strip() if speaker else line
        owner = ""
        deadline = ""
        owner_match = re.search(r"\bowner\s*[:\-]\s*([^,;|.]+)", text, re.IGNORECASE)
        if owner_match:
            owner = owner_match.group(1).strip()
        elif speaker:
            owner = speaker.group(1).strip()
        due_match = re.search(r"\b(?:due|deadline|by)\s*[:\-]?\s*([^,;|.]+)", text, re.IGNORECASE)
        if due_match:
            deadline = due_match.group(1).strip()
        actions.append(
            {
                "meetingActionPoint": text[:300],
                "meetingActionPointOwner": owner[:80],
                "meetingActionPointDeadline": deadline[:80],
            }
        )
    return actions[:25]


def analyse(text: str) -> dict[str, Any]:
    lines = compact_lines(text)
    return {
        "meetingTitle": infer_title(lines),
        "meetingDate": first_match(DATE_PATTERNS, text),
        "meetingLocation": infer_location(text),
        "meetingObjectives": infer_objectives(lines),
        "participants": infer_participants(lines),
        "meetingItems": infer_minutes(lines),
        "nextSteps": infer_actions(lines),
        "generatedBy": "python-llm-meeting-minutes deterministic parser",
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
