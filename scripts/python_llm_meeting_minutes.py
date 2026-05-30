#!/usr/bin/env python3
"""Generate structured meeting-minutes JSON from a transcript using the python-llm analyzer."""

from __future__ import annotations

import argparse
from datetime import datetime
import importlib.util
import json
import re
from pathlib import Path
import sys
from typing import Any


REPO_DIR = Path(__file__).resolve().parent.parent
PYTHON_LLM_SCRIPT = REPO_DIR / "scripts" / "python_llm.py"
MINUTES_CONFIG = REPO_DIR / "config" / "meeting_minutes_rules.json"
TURN_RE = re.compile(r"^(?P<speaker>.+?)\s+(?P<timestamp>\d+:\d{2})$")
RAW_SPEAKER_RE = re.compile(r"^([A-Z][A-Za-z ]+?)\s+\d+:\d{2}", re.MULTILINE)
INLINE_TURN_RE = re.compile(
    r"(?m)^(?P<speaker>[A-Z][A-Za-z ]+?)\s+\d+:\d{2}(?P<content>.*?)(?=^[A-Z][A-Za-z ]+?\s+\d+:\d{2}|\Z)",
    re.DOTALL,
)


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def load_analyzer_module():
    script_path = PYTHON_LLM_SCRIPT
    spec = importlib.util.spec_from_file_location("python_llm_analyzer", script_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load analyzer module from {script_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate meeting-minutes JSON from a transcript.")
    parser.add_argument("path", help="Path to a UTF-8 transcript file")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON output")
    return parser.parse_args()


def normalize_title(raw_title: str) -> str:
    raw_title = raw_title.strip()
    match = re.match(r"^(.*?)(?:-\d{8}_\d{6})?-Meeting Transcript$", raw_title)
    if match:
        return match.group(1).strip()
    return raw_title.replace("Meeting Transcript", "").strip(" -")


def parse_meeting_date(line: str) -> str:
    line = line.strip()
    line = re.sub(r"^date\s*:\s*", "", line, flags=re.IGNORECASE).strip()
    for fmt in (
        "%d %B %Y, %I:%M%p",
        "%d %B %Y, %I:%M %p",
        "%d %B %Y",
        "%B %d, %Y",
        "%B %d %Y",
    ):
        try:
            return datetime.strptime(line, fmt).strftime("%-d %B %Y")
        except ValueError:
            continue
    return line.split(",")[0].strip()


def extract_header_fields(text: str, config: dict[str, Any]) -> tuple[str, str, str]:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    meeting_title = normalize_title(lines[0]) if lines else "Meeting"
    date_value = ""
    location_value = config["meeting_location_default"]
    for line in lines[1:6]:
        if line.lower().startswith("location:"):
            location_value = line.split(":", 1)[1].strip() or location_value
        if line.lower().startswith("date:") or re.search(r"\d{1,2}\s+\w+\s+\d{4}", line) or re.search(r"\b\w+\s+\d{1,2},\s+\d{4}\b", line):
            date_value = parse_meeting_date(line)
    return meeting_title, date_value or "", location_value


def extract_participants(segments: list[dict[str, Any]], config: dict[str, Any]) -> dict[str, list[str]]:
    participants = {"participants.client": [], "participants.trinzo": []}
    seen = set()
    speaker_map = config["participant_groups"]
    for segment in segments:
        for speaker in segment.get("speakers", []):
            if speaker in seen:
                continue
            seen.add(speaker)
            bucket = speaker_map.get(speaker)
            if bucket == "client":
                participants["participants.client"].append(speaker)
            elif bucket == "trinzo":
                participants["participants.trinzo"].append(speaker)
    return participants


def extract_participants_from_turns(turns: list[Any], config: dict[str, Any]) -> dict[str, list[str]]:
    participants = {"participants.client": [], "participants.trinzo": []}
    seen = set()
    speaker_map = config["participant_groups"]
    for turn in turns:
        speaker = turn.speaker
        if speaker in seen:
            continue
        seen.add(speaker)
        bucket = speaker_map.get(speaker)
        if bucket == "client":
            participants["participants.client"].append(speaker)
        elif bucket == "trinzo":
            participants["participants.trinzo"].append(speaker)
    return participants


def extract_participants_from_text(text: str, config: dict[str, Any]) -> dict[str, list[str]]:
    participants = {"participants.client": [], "participants.trinzo": []}
    speaker_map = config["participant_groups"]
    seen = set()
    for speaker in RAW_SPEAKER_RE.findall(text):
        speaker = speaker.strip()
        if speaker in seen:
            continue
        seen.add(speaker)
        bucket = speaker_map.get(speaker)
        if bucket == "client":
            participants["participants.client"].append(speaker)
        elif bucket == "trinzo":
            participants["participants.trinzo"].append(speaker)
    return participants


def normalize_inline_text(text: str) -> str:
    text = re.sub(r"\s+", " ", text.strip())
    text = re.sub(r"(?<=[a-z])(?=[A-Z])", ". ", text)
    return text.strip()


def extract_raw_turn_entries(text: str) -> list[dict[str, str]]:
    entries: list[dict[str, str]] = []
    for match in INLINE_TURN_RE.finditer(text):
        content = normalize_inline_text(match.group("content"))
        if not content:
            continue
        entries.append({"speaker": match.group("speaker").strip(), "content": content})
    return entries


def extract_participants_from_raw_turns(raw_turns: list[dict[str, str]], config: dict[str, Any]) -> dict[str, list[str]]:
    participants = {"participants.client": [], "participants.trinzo": []}
    speaker_map = config["participant_groups"]
    seen = set()
    for turn in raw_turns:
        speaker = turn["speaker"]
        if speaker in seen:
            continue
        seen.add(speaker)
        bucket = speaker_map.get(speaker)
        if bucket == "client":
            participants["participants.client"].append(speaker)
        elif bucket == "trinzo":
            participants["participants.trinzo"].append(speaker)
    return participants


def sentence_case(text: str) -> str:
    text = text.strip().rstrip(".")
    if not text:
        return text
    return text[0].upper() + text[1:]


def finalize_sentence(text: str) -> str:
    cleaned = text.strip()
    if not cleaned:
        return cleaned
    if cleaned[-1] in ".!?":
        return cleaned
    return cleaned + "."


def is_plural_label(label: str) -> bool:
    lowered = label.lower().strip()
    return lowered.endswith("s") and not lowered.endswith("ss")


def status_phrase(label: str, status: str) -> str:
    plural = is_plural_label(label)
    mapping = {
        "complete": "were marked complete" if plural else "was marked complete",
        "in_progress": "are in progress" if plural else "is in progress",
        "scheduled": "are scheduled" if plural else "is scheduled",
        "awaiting_input": "are awaiting input" if plural else "is awaiting input",
        "needs_review": "need review" if plural else "needs review",
        "delayed": "are delayed" if plural else "is delayed",
        "paused": "are paused" if plural else "is paused",
        "blocked": "are blocked" if plural else "is blocked"
    }
    return mapping.get(status, f"{'are' if plural else 'is'} {status.replace('_', ' ')}")


def reason_phrase(segment: dict[str, Any]) -> str:
    reasons = segment.get("status_reasons", [])
    blockers = segment.get("blocking_factors", [])
    if blockers:
        cleaned = blockers[0].strip().rstrip(".")
        if cleaned.lower().startswith("we "):
            cleaned = cleaned[3:]
        return f" due to {cleaned[0].lower() + cleaned[1:]}" if cleaned else ""
    if reasons:
        joined = ", ".join(reasons[:3])
        return f" because of {joined}"
    return ""


def build_discussion_points(segments: list[dict[str, Any]], config: dict[str, Any]) -> list[str]:
    labels = config["milestone_labels"]
    points = []
    for segment in segments:
        if segment.get("milestone") == "unclassified" and segment.get("analysis_status") == "unknown":
            continue
        label = labels.get(segment["milestone"], segment["milestone"].replace("_", " "))
        point = f"{label} {status_phrase(label, segment['analysis_status'])}{reason_phrase(segment)}."
        points.append(sentence_case(point))
    return points


def split_sentences(text: str) -> list[str]:
    text = re.sub(r"(?<=\w)(?=[A-Z][a-z])", ". ", text)
    return [part.strip() for part in re.split(r"(?<=[.!?])\s+", text) if part.strip()]


def find_rule_hits(text: str, rules: list[dict[str, Any]], field: str) -> list[str]:
    lowered = text.lower()
    hits = []
    for rule in rules:
        if any(term in lowered for term in rule["contains_any"]):
            hits.append(rule[field])
    return hits


def find_rule_matches(text: str, rules: list[dict[str, Any]]) -> list[dict[str, Any]]:
    lowered = text.lower()
    return [rule for rule in rules if any(term in lowered for term in rule["contains_any"])]


def dedupe(items: list[str]) -> list[str]:
    seen = set()
    output = []
    for item in items:
        key = item.strip().lower()
        if not item or key in seen:
            continue
        seen.add(key)
        output.append(item)
    return output


def infer_item_topic(text: str, config: dict[str, Any]) -> str:
    lowered = text.lower()
    for rule in config.get("item_topic_rules", []):
        if any(term in lowered for term in rule["contains_any"]):
            return rule["topic"]
    return config["item_topic_default"]


def extract_generic_objectives(text: str, raw_turns: list[dict[str, str]], config: dict[str, Any]) -> list[str]:
    focus_text = " ".join(turn["content"] for turn in raw_turns[:10]) if raw_turns else text
    objectives = find_rule_hits(focus_text, config.get("generic_objective_rules", []), "objective")
    objectives.extend(find_rule_hits(text, config.get("generic_objective_rules", []), "objective"))
    return dedupe(objectives) or config["meeting_objectives_default"]


def extract_generic_discussion_points(text: str, raw_turns: list[dict[str, str]], config: dict[str, Any]) -> list[str]:
    points: list[str] = []
    source_turns = raw_turns or [{"speaker": "", "content": text}]
    for turn in source_turns:
        for rule in find_rule_matches(turn["content"], config.get("generic_discussion_rules", [])):
            points.append(rule["point"])
    return dedupe(points)


def extract_turn_level_discussion_points(raw_turns: list[dict[str, str]]) -> list[str]:
    points: list[str] = []
    for turn in raw_turns:
        content = turn["content"].strip()
        lowered = content.lower()
        if not content:
            continue
        if any(term in lowered for term in ("risk", "issue", "timeline", "scope", "plan", "workshop", "webinar", "update")):
            points.append(finalize_sentence(sentence_case(content.rstrip("."))))
        if len(points) >= 5:
            break
    return dedupe(points)


def extract_action_block(text: str) -> tuple[list[str], str]:
    lines = text.splitlines()
    actions: list[str] = []
    block_deadline = ""
    collecting = False
    for raw_line in lines:
        line = raw_line.strip()
        if not line:
            continue
        if line.lower().startswith("actions before next week"):
            collecting = True
            block_deadline = "Before next week"
            tail = line.split(":", 1)[1].strip() if ":" in line else ""
            if tail:
                actions.extend([part.strip().rstrip(".") for part in tail.split(".") if part.strip()])
            continue
        if collecting and TURN_RE.match(line):
            break
        if collecting:
            lowered = line.lower()
            if "stopped transcription" in lowered:
                break
            actions.append(line.rstrip("."))
    return actions, block_deadline


def find_named_owner(text: str, config: dict[str, Any]) -> str | None:
    for name in config.get("participant_groups", {}):
        first_name = name.split()[0]
        if re.search(rf"\b{re.escape(first_name)}\b", text, flags=re.IGNORECASE):
            return name
    return None


def infer_action_owner(turn: dict[str, str], rule: dict[str, Any], config: dict[str, Any]) -> str:
    mode = rule.get("owner_mode", "static")
    if mode == "speaker":
        return turn["speaker"]
    if mode == "mentioned_or_speaker":
        return find_named_owner(turn["content"], config) or turn["speaker"]
    return rule["owner"]


def infer_action_deadline(text: str, rule: dict[str, Any], config: dict[str, Any]) -> str:
    lowered = text.lower()
    explicit_match = re.search(r"\bby\s+([A-Z][a-z]+)\b", text)
    if explicit_match:
        return f"by {explicit_match.group(1)}"
    if "before the webinar" in lowered:
        return "Before the webinar"
    for deadline_rule in config.get("action_deadline_rules", []):
        if any(term in lowered for term in deadline_rule["contains_any"]):
            return deadline_rule["deadline"]
    return rule["deadline"]


def extract_generic_actions(
    text: str,
    raw_turns: list[dict[str, str]],
    config: dict[str, Any],
) -> tuple[list[str], list[str], list[str]]:
    actions = []
    owners = []
    deadlines = []
    seen = set()
    source_turns = raw_turns or [{"speaker": "Unknown", "content": text}]
    for turn in source_turns:
        for rule in find_rule_matches(turn["content"], config.get("generic_action_rules", [])):
            action = rule["action"]
            key = action.lower()
            if key in seen:
                continue
            seen.add(key)
            actions.append(action)
            owners.append(infer_action_owner(turn, rule, config))
            deadlines.append(infer_action_deadline(turn["content"], rule, config))
    return actions, owners, deadlines


def extract_fallback_actions(raw_turns: list[dict[str, str]], config: dict[str, Any]) -> tuple[list[str], list[str], list[str]]:
    actions: list[str] = []
    owners: list[str] = []
    deadlines: list[str] = []
    seen = set()
    for turn in raw_turns:
        content = turn["content"].strip()
        lowered = content.lower()
        if not content:
            continue
        if not any(term in lowered for term in ("i will", "we should", "can you", "check", "confirm", "send", "update")):
            continue
        action_text = re.sub(r"^(no,\s*that's fine\.?\s*)", "", content, flags=re.IGNORECASE).strip()
        action_text = action_text.rstrip(".")
        key = action_text.lower()
        if key in seen:
            continue
        seen.add(key)
        actions.append(finalize_sentence(action_text))
        if lowered.startswith("i will"):
            owners.append(turn["speaker"])
        elif lowered.startswith("can you"):
            owners.append(find_named_owner(content, config) or turn["speaker"])
        else:
            owners.append(turn["speaker"])
        deadlines.append(infer_action_deadline(content, {"deadline": ""}, config))
    return actions, owners, deadlines


def owner_for_action(action: str, config: dict[str, Any]) -> str:
    lowered = action.lower()
    for rule in config["action_owner_rules"]:
        if any(term in lowered for term in rule["contains_any"]):
            return rule["owner"]
    return "Ciara Griffin / Conor Flynn"


def deadline_for_action(action: str, block_deadline: str, config: dict[str, Any]) -> str:
    lowered = action.lower()
    for rule in config["action_deadline_rules"]:
        if any(term in lowered for term in rule["contains_any"]):
            return rule["deadline"]
    return block_deadline or ""


def build_template_values(text: str, analysis: dict[str, Any], turns: list[Any], config: dict[str, Any]) -> dict[str, Any]:
    meeting_title, meeting_date, meeting_location = extract_header_fields(text, config)
    raw_turns = extract_raw_turn_entries(text)
    participants = extract_participants(analysis["segments"], config)
    if not participants["participants.client"] and not participants["participants.trinzo"]:
        participants = extract_participants_from_turns(turns, config)
    if not participants["participants.client"] and not participants["participants.trinzo"]:
        participants = extract_participants_from_raw_turns(raw_turns, config)
    if not participants["participants.client"] and not participants["participants.trinzo"]:
        participants = extract_participants_from_text(text, config)
    actions, block_deadline = extract_action_block(text)
    if not actions:
        actions, action_owners, action_deadlines = extract_generic_actions(text, raw_turns, config)
    if not actions:
        actions, action_owners, action_deadlines = extract_fallback_actions(raw_turns, config)
    else:
        action_owners = [owner_for_action(action, config) for action in actions]
        action_deadlines = [deadline_for_action(action, block_deadline, config) for action in actions]

    discussion_points = build_discussion_points(analysis["segments"], config)
    if not discussion_points:
        discussion_points = extract_generic_discussion_points(text, raw_turns, config)
    if not discussion_points:
        discussion_points = extract_turn_level_discussion_points(raw_turns)

    template_values = {
        "meetingTitle": meeting_title,
        "meetingDate": meeting_date,
        "meetingLocation": meeting_location,
        "meetingObjectives": extract_generic_objectives(text, raw_turns, config),
        "participants.client": participants["participants.client"],
        "participants.trinzo": participants["participants.trinzo"],
        "itemTopic": infer_item_topic(text, config),
        "discussionPoints": discussion_points,
        "meetingActionPoint": actions,
        "meetingActionPointOwner": action_owners,
        "meetingActionPointDeadline": action_deadlines
    }
    return template_values


def parse_speaker_turns(text: str) -> list[Any]:
    analyzer = load_analyzer_module()
    return analyzer.parse_turns(text)


def analyse(text: str) -> dict[str, Any]:
    config = load_json(MINUTES_CONFIG)
    analyzer = load_analyzer_module()
    turns = analyzer.parse_turns(text)
    analysis = analyzer.analyze(turns, analyzer.load_rules(REPO_DIR))
    return build_template_values(text, analysis, turns, config)


def main() -> int:
    args = parse_args()
    text = Path(args.path).read_text(encoding="utf-8")
    template_values = analyse(text)
    if args.pretty:
        print(json.dumps(template_values, indent=2, ensure_ascii=False))
    else:
        print(json.dumps(template_values, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
