#!/usr/bin/env python3
"""Python-only transcript-to-meeting-minutes test analyser.

This intentionally uses deterministic parsing heuristics only. It does not call
LLMs, OpenAI, model APIs, or external inference services.
"""

from __future__ import annotations

import argparse
import json
import os
import re
from dataclasses import dataclass
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

TIMESTAMP = r"(?:\d{1,2}:)?\d{1,2}:\d{2}"
TIMESTAMPED_SPEAKER_RE = re.compile(
    rf"^\s*(?P<speaker>[A-Z][A-Za-z .'-]{{1,70}}?)\s+(?P<timestamp>{TIMESTAMP})(?P<text>.*)$"
)
COLON_SPEAKER_RE = re.compile(r"^\s*(?P<speaker>[A-Z][A-Za-z .'-]{1,70})(?:\s*\((?P<role>[^)]*)\))?\s*[:\-–]\s+(?P<text>.+)$")
METADATA_SPEAKERS = {"date", "location", "participants", "attendees", "title", "meeting title", "venue"}

CLIENT_HINTS = re.compile(r"\b(client|customer|site|external|vendor)\b", re.IGNORECASE)
TRINZO_HINTS = re.compile(r"\b(trinzo|consultant|internal|facilitator)\b", re.IGNORECASE)
OBJECTIVE_WORDS = re.compile(r"\b(objective|agenda|goal|purpose|aim|cover|review|discuss)\b", re.IGNORECASE)
DISCUSSION_SIGNAL = re.compile(
    r"\b(risk|issue|decision|agreed|discussed|question|update|status|blocker|timeline|scope|workshop|webinar|validation|training|process|approach|plan|feedback|concern|confirmed)\b",
    re.IGNORECASE,
)
ACTION_PHRASE_RE = re.compile(
    r"\b(i will|i'll|we need to|can you|let's|need to|should|follow up|send|add|change|update|check|confirm|prepare)\b",
    re.IGNORECASE,
)
DEADLINE_RE = re.compile(
    r"\b("
    r"by\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next\s+week|the\s+end\s+of\s+the\s+week|\d{1,2}(?::\d{2})?\s*(?:am|pm)?|[A-Z][a-z]+\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?)|"
    r"before\s+(?:the\s+)?[A-Za-z][A-Za-z ]{2,40}|"
    r"after\s+(?:the\s+)?[A-Za-z][A-Za-z ]{2,40}|"
    r"next\s+(?:week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|"
    r"tomorrow|today|this\s+week|end\s+of\s+(?:day|week|month)|"
    r"(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?"
    r")\b",
    re.IGNORECASE,
)
FILLER_PREFIX_RE = re.compile(
    r"^(?:and\s+then|and|so|yeah|yes|no|okay|ok|right|i think|just|basically|actually|um|uh)[,\s]+",
    re.IGNORECASE,
)


@dataclass
class TranscriptTurn:
    speaker: str
    timestamp: str
    text: str
    role: str = ""

    def to_json(self) -> dict[str, str]:
        return {"speaker": self.speaker, "timestamp": self.timestamp, "text": self.text}


def read_transcript(path: str) -> str:
    return Path(path).read_text(encoding="utf-8", errors="replace")


def compact_lines(text: str) -> list[str]:
    return [line.strip() for line in text.replace("\r\n", "\n").split("\n") if line.strip()]


def normalise_space(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def clean_speaker_name(value: str) -> str:
    value = normalise_space(value).strip(" -–:")
    value = re.sub(r"\b(?:speaker|participant)\s*\d+\b", "", value, flags=re.IGNORECASE).strip()
    return value


def clean_turn_text(value: str) -> str:
    value = normalise_space(value)
    value = re.sub(rf"^\s*{TIMESTAMP}\s*", "", value)
    return value.strip(" -–")


def parse_speaker_turns(text: str) -> list[TranscriptTurn]:
    """Parse Teams/Zoom style transcript lines into speaker/timestamp/text turns.

    Supports timestamped lines where the transcript exporter places no space
    between the timestamp and text, for example ``Jack Cunningham   0:03And``.
    Non-speaker continuation lines are appended to the previous turn.
    """

    turns: list[TranscriptTurn] = []

    for line in compact_lines(text):
        timestamped = TIMESTAMPED_SPEAKER_RE.match(line)
        if timestamped:
            speaker = clean_speaker_name(timestamped.group("speaker"))
            turn_text = clean_turn_text(timestamped.group("text"))
            if speaker and speaker.lower() not in METADATA_SPEAKERS:
                turns.append(TranscriptTurn(speaker=speaker, timestamp=timestamped.group("timestamp"), text=turn_text))
                continue

        colon = COLON_SPEAKER_RE.match(line)
        if colon:
            speaker = clean_speaker_name(colon.group("speaker"))
            turn_text = clean_turn_text(colon.group("text"))
            role = normalise_space(colon.group("role") or "")
            if speaker and speaker.lower() not in METADATA_SPEAKERS:
                turns.append(TranscriptTurn(speaker=speaker, timestamp="", text=turn_text, role=role))
                continue

        if turns and not re.search(r"\b(date|location|participants|attendees|title)\s*[:\-]", line, re.IGNORECASE):
            turns[-1].text = normalise_space(f"{turns[-1].text} {line}")

    return [turn for turn in turns if turn.text]


def first_match(patterns: list[re.Pattern[str]], text: str) -> str:
    for pattern in patterns:
        match = pattern.search(text)
        if match:
            return match.group(1).strip()
    return ""


def first_non_turn_title(lines: list[str], turns: list[TranscriptTurn]) -> str:
    turn_starts = {f"{turn.speaker} {turn.timestamp}".strip().lower() for turn in turns[:10]}
    for line in lines[:12]:
        lowered = line.lower()
        if any(lowered.startswith(start) for start in turn_starts if start):
            continue
        if re.search(r"\b(date|location|participants|attendees)\s*[:\-]", line, re.IGNORECASE):
            continue
        if len(line) <= 120:
            cleaned = re.sub(r"^(title|meeting title)\s*[:\-]\s*", "", line, flags=re.IGNORECASE).strip()
            if cleaned:
                return cleaned
    return "Meeting minutes"


def infer_location(text: str) -> str:
    match = re.search(r"\b(location|venue)\s*[:\-]\s*([^\n]+)", text, re.IGNORECASE)
    if match:
        return match.group(2).strip()[:120]
    if re.search(r"\b(teams|zoom|webex|online|virtual)\b", text, re.IGNORECASE):
        return "Virtual meeting"
    return ""


def add_unique(target: list[str], name: str) -> None:
    cleaned = clean_speaker_name(name)
    if cleaned and cleaned.lower() not in {item.lower() for item in target}:
        target.append(cleaned)


def configured_names(env_name: str) -> set[str]:
    return {clean_speaker_name(name).lower() for name in os.getenv(env_name, "").split(",") if clean_speaker_name(name)}


def infer_participants(lines: list[str], turns: list[TranscriptTurn]) -> dict[str, list[str]]:
    client: list[str] = []
    trinzo: list[str] = []
    unknown: list[str] = []
    known_client = configured_names("MEETING_MINUTES_CLIENT_SPEAKERS")
    known_trinzo = configured_names("MEETING_MINUTES_TRINZO_SPEAKERS")

    participant_line = re.compile(r"\b(participants|attendees|client attendees|trinzo participants)\s*[:\-]\s*(.+)", re.IGNORECASE)
    for line in lines[:80]:
        listed = participant_line.search(line)
        if not listed:
            continue
        bucket = trinzo if "trinzo" in listed.group(1).lower() else client if "client" in listed.group(1).lower() else unknown
        for name in re.split(r",|;|\band\b", listed.group(2)):
            add_unique(bucket, name)

    for turn in turns:
        context = f"{turn.speaker} {turn.role}"
        lowered = turn.speaker.lower()
        if lowered in known_trinzo or TRINZO_HINTS.search(context):
            add_unique(trinzo, turn.speaker)
        elif lowered in known_client or CLIENT_HINTS.search(context):
            add_unique(client, turn.speaker)
        elif turn.speaker.lower() not in {name.lower() for name in client + trinzo}:
            add_unique(unknown, turn.speaker)

    return {"client": client[:30], "trinzo": trinzo[:30], "unknown": unknown[:30]}


def infer_objectives(lines: list[str], turns: list[TranscriptTurn]) -> list[str]:
    objectives: list[str] = []
    capture = False
    for line in lines[:120]:
        if re.search(r"\b(objective|agenda|goal|purpose)\b", line, re.IGNORECASE):
            capture = True
            item = re.sub(r"^(objectives?|agenda|goals?|purpose)\s*[:\-]\s*", "", line, flags=re.IGNORECASE).strip()
            if item and item != line:
                objectives.append(summarise_text(item, max_words=22))
            continue
        if capture:
            if re.match(r"^[-*•]\s+", line):
                objectives.append(summarise_text(re.sub(r"^[-*•]\s+", "", line), max_words=22))
            elif objectives:
                break

    if not objectives:
        for turn in turns[:12]:
            if OBJECTIVE_WORDS.search(turn.text):
                objectives.append(summarise_text(turn.text, max_words=22))
                break

    if not objectives:
        objectives.append("Review the discussion and capture key decisions, discussion points, and agreed next steps.")
    return dedupe_preserve_order(objectives)[:8]


def split_sentences(text: str) -> list[str]:
    return [normalise_space(part) for part in re.split(r"(?<=[.!?])\s+|\s+-\s+", text) if normalise_space(part)]


def strip_filler(text: str) -> str:
    updated = normalise_space(text)
    previous = None
    while updated != previous:
        previous = updated
        updated = FILLER_PREFIX_RE.sub("", updated).strip()
    return updated


def truncate_words(text: str, max_words: int) -> str:
    words = text.split()
    if len(words) <= max_words:
        return text
    return " ".join(words[:max_words]).rstrip(",;:") + "…"


def summarise_text(text: str, max_words: int = 28) -> str:
    sentences = split_sentences(text)
    selected = ""
    for sentence in sentences:
        cleaned = strip_filler(sentence)
        if len(cleaned) < 12:
            continue
        if DISCUSSION_SIGNAL.search(cleaned) or OBJECTIVE_WORDS.search(cleaned):
            selected = cleaned
            break
        if not selected:
            selected = cleaned
    selected = selected or strip_filler(text)
    selected = re.sub(r"\b(?:you know|kind of|sort of)\b", "", selected, flags=re.IGNORECASE)
    selected = normalise_space(selected).strip(" ,;:-")
    return truncate_words(selected, max_words)


def dedupe_preserve_order(items: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        key = re.sub(r"[^a-z0-9]+", " ", item.lower()).strip()
        if not key or key in seen:
            continue
        seen.add(key)
        result.append(item)
    return result


def infer_minutes(turns: list[TranscriptTurn], lines: list[str]) -> list[dict[str, Any]]:
    bullets: list[str] = []
    for turn in turns:
        if ACTION_PHRASE_RE.search(turn.text) and len(turn.text.split()) <= 18:
            continue
        bullet = summarise_text(turn.text)
        if len(bullet) >= 12:
            bullets.append(bullet)

    bullets = dedupe_preserve_order(bullets)[:16]
    if not bullets:
        fallback = [summarise_text(line) for line in lines if len(line) >= 12 and not COLON_SPEAKER_RE.match(line)]
        bullets = dedupe_preserve_order(fallback)[:8]

    return [{"itemTopic": "General discussion", "discussionPoints": bullets}]


def infer_named_owner(text: str, speakers: list[str]) -> str:
    for speaker in speakers:
        first = speaker.split()[0]
        if re.search(rf"\b{re.escape(speaker)}\b", text, re.IGNORECASE) or re.search(rf"\b{re.escape(first)}\b", text, re.IGNORECASE):
            return speaker
    return ""


def infer_deadline(text: str) -> str:
    match = DEADLINE_RE.search(text)
    if not match:
        return ""
    deadline = normalise_space(match.group(1))
    # Avoid grabbing broad activity phrases after words like "before" unless they look deadline-like.
    if len(deadline.split()) > 6 and not re.search(r"\b(webinar|workshop|meeting|session|call|demo)\b", deadline, re.IGNORECASE):
        return ""
    return deadline.rstrip(" .")[:80]


def clean_action_text(text: str) -> str:
    action = summarise_text(text, max_words=24)
    action = re.sub(r"^(?:action item|next step)\s*[:\-]\s*", "", action, flags=re.IGNORECASE).strip()
    return action


def infer_actions(turns: list[TranscriptTurn]) -> list[dict[str, str]]:
    actions: list[dict[str, str]] = []
    speakers = dedupe_preserve_order([turn.speaker for turn in turns])

    for turn in turns:
        if not ACTION_PHRASE_RE.search(turn.text):
            continue

        owner = ""
        if re.search(r"\b(i will|i'll)\b", turn.text, re.IGNORECASE):
            owner = turn.speaker
        else:
            owner = infer_named_owner(turn.text, [speaker for speaker in speakers if speaker != turn.speaker])

        action = clean_action_text(turn.text)
        if len(action) < 8:
            continue

        actions.append(
            {
                "meetingActionPoint": action[:300],
                "meetingActionPointOwner": owner[:80],
                "meetingActionPointDeadline": infer_deadline(turn.text),
            }
        )

    unique_actions: list[dict[str, str]] = []
    seen: set[str] = set()
    for action in actions:
        key = re.sub(r"[^a-z0-9]+", " ", action["meetingActionPoint"].lower()).strip()
        if key and key not in seen:
            seen.add(key)
            unique_actions.append(action)
    return unique_actions[:20]


def analyse(text: str) -> dict[str, Any]:
    lines = compact_lines(text)
    turns = parse_speaker_turns(text)
    return {
        "meetingTitle": first_non_turn_title(lines, turns),
        "meetingDate": first_match(DATE_PATTERNS, text),
        "meetingLocation": infer_location(text),
        "meetingObjectives": infer_objectives(lines, turns),
        "participants": infer_participants(lines, turns),
        "meetingItems": infer_minutes(turns, lines),
        "nextSteps": infer_actions(turns),
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
