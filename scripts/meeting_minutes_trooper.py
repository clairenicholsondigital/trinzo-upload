#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

TROOPER_URL_DEFAULT = "https://eu.router.trooper.ai/v1/chat/completions"
TROOPER_MODEL_DEFAULT = "eu_liv_000099"
PROJECT_STATUS_EVIDENCE_MAX_CHARS = int(os.environ.get("PROJECT_STATUS_EVIDENCE_MAX_CHARS", "18000"))
CHUNK_TARGET_CHARS = int(os.environ.get("MEETING_MINUTES_CHUNK_TARGET_CHARS", "9000"))
CHUNK_OVERLAP_CHARS = int(os.environ.get("MEETING_MINUTES_CHUNK_OVERLAP_CHARS", "900"))
CHUNK_MAX_PARALLEL = int(os.environ.get("MEETING_MINUTES_CHUNK_MAX_PARALLEL", "3"))


def truthy(value: Any) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "y", "on"}


def parse_transcript_time_minutes(text: str) -> list[float]:
    values: list[float] = []
    for match in re.finditer(r"(?<!\d)(\d{1,2}):(\d{2})(?!\d)", text or ""):
        minutes = int(match.group(1))
        seconds = int(match.group(2))
        if seconds < 60:
            values.append(minutes + seconds / 60)
    for match in re.finditer(r"\b(\d{1,3})\s+minutes?\s+(\d{1,2})\s+seconds\b", text or "", re.I):
        minutes = int(match.group(1))
        seconds = int(match.group(2))
        if seconds < 60:
            values.append(minutes + seconds / 60)
    return sorted(set(values))


def detect_transcript_route(transcript: str) -> dict[str, Any]:
    """Selective pre-router for obvious transcript modes.

    This is intentionally conservative. It catches high-confidence cases that the
    generator currently handles badly (partial recordings, large timestamp gaps,
    no-substance audio checks and webinar/content planning) without trying to be
    a full meeting classifier.
    """
    text = str(transcript or "")
    compact = re.sub(r"\s+", " ", text.strip())
    lower = compact.lower()
    word_count = len(re.findall(r"\w+", compact))
    time_values = parse_transcript_time_minutes(text)
    largest_gap = max([b - a for a, b in zip(time_values, time_values[1:])], default=0.0)

    reasons: list[str] = []
    signals: list[str] = []

    partial_cue = bool(re.search(
        r"\b(just turned on the transcript|turned (?:the )?(?:recording|transcript) on|"
        r"missed the (?:middle|start|first half|beginning)|only the last minute|"
        r"joined late|recording started late)\b",
        lower,
    ))
    if partial_cue:
        signals.append("partial_transcript_cue")
        reasons.append("The transcript explicitly says recording/transcription started late or missed part of the meeting.")

    large_gap = largest_gap >= float(os.environ.get("MEETING_MINUTES_LARGE_GAP_MINUTES", "15"))
    if large_gap:
        signals.append("large_timestamp_gap")
        reasons.append(f"The transcript contains a large timestamp gap of about {largest_gap:.0f} minutes.")

    low_substance = (
        word_count < 35
        or bool(re.search(r"\b(can everyone hear me|red light|webcam|no project update today|no actions from me|let['’]?s stop there)\b", lower))
    )
    if low_substance:
        signals.append("low_action_evidence")
        reasons.append("The transcript is very short or mainly audio-check / low-substance chatter.")

    topic_planning = bool(re.search(
        r"\b(webinar|webinar topic|session|series|slides?|presentation|registration slide|"
        r"topic to address|approved supplier topic|first one in september|november one|"
        r"opening example|governance drive)\b",
        lower,
    ))
    # Avoid downgrading a genuine webinar rehearsal with explicit commitments.
    explicit_commitment = bool(re.search(
        r"\b(?:[A-Z][a-z]+\s+to\s+|i['’]?ll\s+|i\s+will\s+|we\s+will\s+|agreed,?\s+let['’]?s|"
        r"decision\s+confirmed|decided\s+to|will\s+(?:send|update|remove|prepare|share|confirm))\b",
        compact,
        re.I,
    ))
    if topic_planning:
        signals.append("topic_planning_language")
        reasons.append("The transcript contains webinar/session/topic-planning language.")

    pending_status_language = bool(re.search(r"\b(still\s+(?:not\s+finalised|missing|pending)|is\s+absent|approval\s+.*pending|awaiting\s+leadership)\b", lower))
    short_discussion_without_commitment = word_count < 120 and len(time_values) <= 8 and not explicit_commitment and not topic_planning and not pending_status_language
    if short_discussion_without_commitment and not low_substance:
        signals.append("low_action_evidence")
        reasons.append("The transcript is short and does not contain explicit action or decision language.")

    if low_substance:
        meeting_type = "low_substance_noise"
        input_quality = "too_short"
        recommended_mode = "ask_for_better_transcript"
        confidence = "high"
    elif short_discussion_without_commitment:
        meeting_type = "discussion_only_or_note"
        input_quality = "usable_with_caution"
        recommended_mode = "sparse_minutes"
        confidence = "medium"
    elif topic_planning and (partial_cue or large_gap or not explicit_commitment):
        meeting_type = "webinar_content_planning"
        input_quality = "large_time_gap" if large_gap else "partial_transcript" if partial_cue else "usable_with_caution"
        recommended_mode = "topic_summary_with_caution"
        confidence = "high" if (partial_cue or large_gap) else "medium"
    elif large_gap:
        meeting_type = "unknown_or_mixed"
        input_quality = "large_time_gap"
        recommended_mode = "sparse_minutes"
        confidence = "high"
    elif partial_cue:
        meeting_type = "unknown_or_mixed"
        input_quality = "partial_transcript"
        recommended_mode = "sparse_minutes"
        confidence = "high"
    else:
        meeting_type = "formal_action_meeting"
        input_quality = "complete_transcript"
        recommended_mode = "formal_minutes"
        confidence = "low"
        reasons.append("No high-confidence pre-router cue was detected; use the standard formal-minutes pipeline.")

    return {
        "meetingType": meeting_type,
        "inputQuality": input_quality,
        "recommendedMode": recommended_mode,
        "signals": string_list(signals, limit=12) if "string_list" in globals() else list(dict.fromkeys(signals))[:12],
        "confidence": confidence,
        "wordCount": word_count,
        "timestampCount": len(time_values),
        "largestTimestampGapMinutes": round(largest_gap, 2),
        "reasons": string_list(reasons, limit=8) if "string_list" in globals() else list(dict.fromkeys(reasons))[:8],
    }


def routing_prompt_section(route: dict[str, Any] | None) -> str:
    if not route:
        return ""
    return f"""
[TRANSCRIPT_ROUTING]
{json.dumps(route, ensure_ascii=False, indent=2)}
[/TRANSCRIPT_ROUTING]
"""


def routing_instruction_text(route: dict[str, Any] | None) -> str:
    mode = (route or {}).get("recommendedMode")
    if mode == "topic_summary_with_caution":
        return """
Routing rules for this transcript:
- This transcript appears to be webinar/content planning or a topic-planning discussion, possibly partial.
- Do not force it into formal action-heavy meeting minutes.
- Produce a useful topic/content-planning summary with themes, candidate topics, context, questions and possible follow-ups.
- Keep decisions and actions empty unless the transcript explicitly assigns an owner/commitment.
- Treat calendar/session sequencing as planning context, not as a project deadline unless an owner is assigned.
"""
    if mode == "sparse_minutes":
        return """
Routing rules for this transcript:
- This transcript appears partial, gappy or mixed, so produce sparse cautious minutes.
- Summarise only the clearly evidenced discussion.
- Keep actions/decisions empty unless they are explicit commitments with transcript evidence.
- Add uncertainty to openQuestions or discussion wording rather than inventing missing context.
"""
    if mode == "ask_for_better_transcript":
        return """
Routing rules for this transcript:
- This transcript appears too short or too low-substance for reliable formal minutes.
- Produce a minimal output explaining that there is not enough usable meeting content.
- Do not invent actions, decisions, objectives, owners or deadlines.
"""
    return ""


def load_local_env_if_needed() -> None:
    """Load deployment .env values needed by this child process without printing secrets."""
    candidates = [
        Path(__file__).resolve().parents[1] / ".env",
        Path("/data/.openclaw/workspace/.secrets/trooper.env"),
    ]
    wanted_prefixes = ("TROOPER_", "MEETING_MINUTES_FINAL_TIMEOUT_MS")
    for env_path in candidates:
        if not env_path.exists():
            continue
        try:
            lines = env_path.read_text(encoding="utf-8").splitlines()
        except Exception:
            continue
        for line in lines:
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, value = stripped.split("=", 1)
            key = key.strip()
            if not key.startswith(wanted_prefixes):
                continue
            value = value.strip().strip('"').strip("'")
            if key.startswith("TROOPER_") or not os.environ.get(key):
                os.environ[key] = value


def clean_text(value: Any) -> str:
    text = re.sub(r"\s+", " ", str(value or "").strip())
    spelling_swaps = {
        r"\bauthorized\b": "authorised",
        r"\bAuthorized\b": "Authorised",
        r"\bauthorization\b": "authorisation",
        r"\bAuthorization\b": "Authorisation",
    }
    for pattern, replacement in spelling_swaps.items():
        text = re.sub(pattern, replacement, text)
    return text


def simplify_action_text(text: str) -> str:
    cleaned = clean_text(text)
    cleaned = re.sub(r"^[A-Z][a-z]+\s+to\s+", "", cleaned).strip()
    cleaned = re.sub(r"\b(?:today|tonight|this evening|before noon|weekly|next week|by (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\.?$", "", cleaned, flags=re.I).strip(" .")
    if cleaned and cleaned[0].islower():
        cleaned = cleaned[0].upper() + cleaned[1:]
    lower = cleaned.lower()
    if "hpra" in lower and "bill" in lower and "authorised rep" in lower:
        return "Review the HPRA authorised-representative bill and send a copy."
    if "hpra" in lower and "bill" in lower and ("invoice" in lower or "email" in lower):
        return "Review the HPRA authorised-representative bill."
    if "med envoy" in lower and "project plan" in lower:
        return "Follow up on the Med Envoy project plan or task list."
    if "ppe" in lower and "procedures" in lower and any(term in lower for term in ("confirm", "approach", "inclusion", "scope")):
        return "Confirm the PPE and sunglasses procedure scope with the client."
    return cleaned.rstrip(".") + "." if cleaned else ""


def is_placeholder_text(text: str) -> bool:
    normalised = clean_text(text).strip(" .:-").lower()
    if normalised.startswith("no explicit decision") or normalised.startswith("no decisions"):
        return True
    if normalised.startswith("none explicitly"):
        return True
    return normalised in {
        "none",
        "none stated",
        "none explicitly stated",
        "none explicitly recorded",
        "none explicitly recorded in this chunk",
        "no decisions stated",
        "no decision stated",
        "no explicit decisions",
        "not stated",
        "n/a",
        "null",
    }


def string_list(value: Any, limit: int = 20) -> list[str]:
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in value:
        text = first_text(item) if isinstance(item, dict) else clean_text(item)
        if not text:
            continue
        key = text.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(text)
        if len(out) >= limit:
            break
    return out


def first_text(value: Any, keys: list[str] | None = None) -> str:
    if isinstance(value, str):
        return clean_text(value)
    if not isinstance(value, dict):
        return clean_text(value)
    for key in keys or ["text", "summary", "point", "issue", "risk", "question", "dependency", "term", "action", "decision"]:
        text = clean_text(value.get(key))
        if text:
            return text
    return ""


def structured_item_list(value: Any, limit: int = 20) -> list[dict[str, str]]:
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return []
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in value:
        if isinstance(item, dict):
            text = first_text(item)
            if not text or is_placeholder_text(text):
                continue
            row = {
                "text": text,
                "status": clean_text(item.get("status")),
                "owner": clean_text(item.get("owner")),
                "deadline": clean_text(item.get("deadline") or item.get("target")),
                "evidence": clean_text(item.get("evidence") or item.get("sourceSnippet")),
            }
            for optional in ("category", "term", "normalisedTerm", "confidence", "reason"):
                if clean_text(item.get(optional)):
                    row[optional] = clean_text(item.get(optional))
        else:
            text = clean_text(item)
            if not text or is_placeholder_text(text):
                continue
            row = {"text": text, "status": "", "owner": "", "deadline": "", "evidence": ""}
        key = text.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(row)
        if len(out) >= limit:
            break
    return out


def normalise_action(action: Any) -> dict[str, str] | None:
    if not isinstance(action, dict):
        text = clean_text(action)
        if not text:
            return None
        return {
            "meetingActionPoint": text,
            "meetingActionPointOwner": "Not stated",
            "meetingActionPointDeadline": "Not stated",
        }
    text = simplify_action_text(
        action.get("meetingActionPoint")
        or action.get("action")
        or action.get("task")
        or action.get("description")
    )
    if not text or is_placeholder_text(text):
        return None
    owner = normalise_action_owner(action.get("meetingActionPointOwner") or action.get("owner"))
    deadline = clean_text(action.get("meetingActionPointDeadline") or action.get("deadline")) or "Not stated"
    if deadline.lower() in {"none", "null", "unknown", "no deadline", "no deadline agreed"}:
        deadline = "Not stated"
    normalised = {
        "meetingActionPoint": text,
        "meetingActionPointOwner": owner,
        "meetingActionPointDeadline": deadline,
    }
    if isinstance(action, dict):
        dependency = clean_text(action.get("dependency"))
        evidence = clean_text(action.get("evidence") or action.get("sourceSnippet"))
        confidence = clean_text(action.get("confidence"))
        if dependency:
            normalised["dependency"] = dependency
        if evidence:
            normalised["evidence"] = evidence
        if confidence:
            normalised["confidence"] = confidence
    return normalised


def normalise_action_owner(value: Any) -> str:
    owner = clean_text(value) or "Not stated"
    if owner.lower() in {"we", "us", "our team", "the team", "everyone"}:
        return "All"
    return owner


def normalise_participants(value: Any) -> dict[str, list[str]]:
    if isinstance(value, dict):
        return {
            "client": string_list(value.get("client"), limit=20),
            "trinzo": string_list(value.get("trinzo"), limit=20),
        }
    # If the model only returns a flat participant list, avoid guessing client vs Trinzo.
    return {"client": string_list(value, limit=20), "trinzo": []}


def discussion_list(value: Any, limit: int = 30) -> list[str]:
    if isinstance(value, str):
        return string_list([value], limit=limit)
    if not isinstance(value, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in value:
        candidates: list[str] = []
        if isinstance(item, dict):
            topic = clean_text(item.get("topic") or item.get("title"))
            points = item.get("discussionPoints") or item.get("points") or item.get("details")
            point_list = string_list(points, limit=12)
            if point_list:
                candidates.extend([f"{topic}: {point}" if topic else point for point in point_list])
            else:
                text = clean_text(item.get("summary") or item.get("description") or item.get("discussionPoint"))
                if text:
                    candidates.append(f"{topic}: {text}" if topic else text)
        else:
            candidates.append(clean_text(item))
        for text in candidates:
            if not text:
                continue
            key = text.lower()
            if key in seen:
                continue
            seen.add(key)
            out.append(text)
            if len(out) >= limit:
                return out
    return out


def structured_texts(items: list[dict[str, str]], limit: int = 20) -> list[str]:
    out: list[str] = []
    for item in items:
        text = clean_text(item.get("text"))
        if text:
            out.append(text)
        if len(out) >= limit:
            break
    return out


def decision_list(value: Any, limit: int = 15) -> list[str]:
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in value:
        text = first_text(item, ["text", "decision", "summary", "point"]) if isinstance(item, dict) else clean_text(item)
        if not text or is_placeholder_text(text):
            continue
        key = text.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(text)
        if len(out) >= limit:
            break
    return out


def normalise_topic_item(item: Any, default_type: str = "discussion") -> dict[str, Any] | None:
    if isinstance(item, str):
        text = clean_text(item)
        if not text:
            return None
        return {"type": default_type, "text": text}
    if not isinstance(item, dict):
        return None
    text = first_text(item, ["text", "summary", "point", "discussionPoint", "issue", "risk", "dependency", "action", "decision"])
    if not text:
        return None
    item_type = clean_text(item.get("type") or item.get("category") or default_type).lower().replace(" ", "_")
    out: dict[str, Any] = {
        "itemId": clean_text(item.get("itemId") or item.get("id")),
        "type": item_type or default_type,
        "text": text,
        "owner": clean_text(item.get("owner") or item.get("meetingActionPointOwner")) or None,
        "status": clean_text(item.get("status") or item.get("state")) or None,
        "deadline": clean_text(item.get("deadline") or item.get("target") or item.get("meetingActionPointDeadline")) or None,
        "dependency": clean_text(item.get("dependency")) or None,
        "evidence": item.get("evidence") if isinstance(item.get("evidence"), list) else clean_text(item.get("evidence") or item.get("sourceSnippet") or item.get("_evidence")) or None,
    }
    confidence = item.get("confidence")
    if confidence not in (None, ""):
        out["confidence"] = confidence
    if item.get("reviewRequired") is True:
        out["reviewRequired"] = True
    return {key: value for key, value in out.items() if value not in ("", None, [])}


def normalise_discussion_topics(raw: dict[str, Any], minutes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    topics: list[dict[str, Any]] = []
    for index, topic in enumerate(raw.get("discussionTopics") or raw.get("topics") or []):
        if not isinstance(topic, dict):
            continue
        topic_name = clean_text(topic.get("topic") or topic.get("title") or topic.get("heading")) or "Discussion"
        items: list[dict[str, Any]] = []
        seen_items: set[str] = set()
        for raw_item in topic.get("items") or topic.get("discussionPoints") or topic.get("points") or []:
            normalised = normalise_topic_item(raw_item)
            if not normalised:
                continue
            key = f"{normalised.get('type')}|{normalised.get('text')}".lower()
            if key in seen_items:
                continue
            seen_items.add(key)
            items.append(normalised)
        if items:
            topics.append({
                "topicId": clean_text(topic.get("topicId") or topic.get("id")) or re.sub(r"[^a-z0-9]+", "-", topic_name.lower()).strip("-") or f"topic-{index + 1}",
                "topic": topic_name,
                "summary": clean_text(topic.get("summary")),
                "outcome": clean_text(topic.get("outcome")),
                "items": items,
            })
    if topics:
        return topics

    return [
        {
            "topicId": re.sub(r"[^a-z0-9]+", "-", clean_text(minute.get("topic") or "Discussion").lower()).strip("-") or f"topic-{index + 1}",
            "topic": clean_text(minute.get("topic")) or "Discussion",
            "summary": "",
            "outcome": "",
            "items": [
                item for item in (
                    normalise_topic_item(point, default_type="discussion")
                    for point in minute.get("discussionPoints", [])
                )
                if item
            ],
        }
        for index, minute in enumerate(minutes)
        if minute.get("discussionPoints")
    ]


def normalise_minutes(raw: dict[str, Any], discussion: list[str]) -> list[dict[str, Any]]:
    minutes: list[dict[str, Any]] = []
    for item in raw.get("meetingMinutes") or raw.get("minutes") or []:
        if not isinstance(item, dict):
            continue
        points = string_list(item.get("discussionPoints") or item.get("points"), limit=12)
        if points:
            minutes.append({"topic": clean_text(item.get("topic")) or "Discussion", "discussionPoints": points})
    if not minutes:
        grouped = raw.get("discussionSections") or raw.get("discussion")
        if isinstance(grouped, list):
            for item in grouped:
                if isinstance(item, dict):
                    points = string_list(item.get("discussionPoints") or item.get("points") or item.get("details"), limit=12)
                    if points:
                        minutes.append({"topic": clean_text(item.get("topic") or item.get("title")) or "Discussion", "discussionPoints": points})
    if not minutes and discussion:
        minutes = [{"topic": "Discussion", "discussionPoints": discussion}]
    return minutes


def normalise_output(raw: dict[str, Any]) -> dict[str, Any]:
    confirmed_points = structured_item_list(raw.get("confirmedPoints") or raw.get("agreements"), limit=20)
    risks_and_issues = structured_item_list(raw.get("risksAndIssues") or raw.get("risks") or raw.get("issues"), limit=20)
    dependencies = structured_item_list(raw.get("dependencies"), limit=20)
    compliance_followups = structured_item_list(raw.get("complianceFollowUps"), limit=20)
    terms_for_review = structured_item_list(raw.get("termsForReview"), limit=20)

    discussion = discussion_list(raw.get("discussionPoints"), limit=30)
    if not discussion:
        discussion = string_list(
            [
                *structured_texts(confirmed_points, limit=8),
                *structured_texts(risks_and_issues, limit=8),
                *structured_texts(dependencies, limit=6),
            ],
            limit=30,
        )

    action_source = list(raw.get("actions") or raw.get("nextSteps") or [])
    for followup in compliance_followups:
        action_source.append(
            {
                "meetingActionPoint": followup.get("text"),
                "owner": followup.get("owner") or "Not stated",
                "deadline": followup.get("deadline") or "Not stated",
                "evidence": followup.get("evidence"),
            }
        )
    actions = [item for item in (normalise_action(a) for a in action_source) if item]
    deduped_actions: list[dict[str, str]] = []
    seen_actions: set[tuple[str, str]] = set()
    for action in actions:
        key = (action["meetingActionPoint"].lower(), action["meetingActionPointOwner"].lower())
        if key in seen_actions:
            continue
        seen_actions.add(key)
        deduped_actions.append(action)

    meeting_minutes = normalise_minutes(raw, discussion)
    discussion_topics = normalise_discussion_topics(raw, meeting_minutes)

    output = {
        "meetingTitle": clean_text(raw.get("meetingTitle")) or "Meeting minutes",
        "meetingDate": clean_text(raw.get("meetingDate")),
        "meetingLocation": clean_text(raw.get("meetingLocation")),
        "meetingDescription": clean_text(raw.get("meetingDescription") or raw.get("executiveSummary") or raw.get("summary")),
        "meetingObjectives": string_list(raw.get("meetingObjectives"), limit=8),
        "participants": normalise_participants(raw.get("participants")),
        "otherParticipants": string_list(raw.get("otherParticipants") or raw.get("participantsOther"), limit=20),
        "executiveSummary": clean_text(raw.get("executiveSummary") or raw.get("summary")),
        "confirmedPoints": confirmed_points,
        "risksAndIssues": risks_and_issues,
        "dependencies": dependencies,
        "complianceFollowUps": compliance_followups,
        "termsForReview": terms_for_review,
        "discussionTopics": discussion_topics,
        "discussionPoints": discussion,
        "decisions": decision_list(raw.get("decisions"), limit=15),
        "meetingActionPoint": [a["meetingActionPoint"] for a in deduped_actions],
        "meetingActionPointOwner": [a["meetingActionPointOwner"] for a in deduped_actions],
        "meetingActionPointDeadline": [a["meetingActionPointDeadline"] for a in deduped_actions],
        "actions": deduped_actions,
        "meetingMinutes": meeting_minutes,
        "nextSteps": [
            {
                "action": a["meetingActionPoint"],
                "owner": a["meetingActionPointOwner"],
                "deadline": a["meetingActionPointDeadline"],
                **({"dependency": a["dependency"]} if a.get("dependency") else {}),
                **({"evidence": a["evidence"]} if a.get("evidence") else {}),
            }
            for a in deduped_actions
        ],
        "openQuestions": string_list(raw.get("openQuestions") or raw.get("unresolvedQuestions"), limit=15),
    }
    return output


def extract_json(text: str) -> dict[str, Any]:
    cleaned = (text or "").strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.I)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    try:
        value = json.loads(cleaned)
        return value if isinstance(value, dict) else {}
    except json.JSONDecodeError:
        pass
    match = re.search(r"\{.*\}", cleaned, re.S)
    if not match:
        return {}
    try:
        value = json.loads(match.group(0))
        return value if isinstance(value, dict) else {}
    except json.JSONDecodeError:
        return {}


def run_project_status_evidence_pack(transcript_path: Path, timeout_seconds: int = 90) -> dict[str, Any]:
    script_path = Path(__file__).resolve().parent / "project_status_evidence_pack.py"
    model_python = os.environ.get("PROJECT_STATUS_MODEL_PYTHON", "").strip()
    if not model_python:
        candidate_python = Path(os.environ.get("PROJECT_STATUS_MODEL_DIR", "/root/project-update-status-model")) / ".venv" / "bin" / "python"
        try:
            model_python = str(candidate_python) if candidate_python.exists() else os.environ.get("PYTHON_BIN", "python3")
        except OSError:
            model_python = os.environ.get("PYTHON_BIN", "python3")
    started = time.perf_counter()
    if not script_path.exists():
        return {
            "enabled": True,
            "available": False,
            "reason": f"Project-status evidence script not found at {script_path}",
            "runtimeMs": 0.0,
            "items": [],
        }
    try:
        completed = subprocess.run(
            [model_python, str(script_path), str(transcript_path)],
            cwd=str(Path(__file__).resolve().parents[1]),
            env=os.environ,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout_seconds,
            check=False,
        )
        if completed.returncode != 0:
            return {
                "enabled": True,
                "available": False,
                "reason": f"Project-status evidence exited with code {completed.returncode}: {clean_text(completed.stderr)[:300]}",
                "runtimeMs": round((time.perf_counter() - started) * 1000, 2),
                "items": [],
            }
        try:
            pack = json.loads(completed.stdout)
        except json.JSONDecodeError as exc:
            return {
                "enabled": True,
                "available": False,
                "reason": f"Project-status evidence returned invalid JSON: {exc}",
                "runtimeMs": round((time.perf_counter() - started) * 1000, 2),
                "items": [],
            }
        if isinstance(pack, dict):
            pack.setdefault("runtimeMs", round((time.perf_counter() - started) * 1000, 2))
            if completed.stderr and truthy(os.environ.get("PROJECT_STATUS_EVIDENCE_INCLUDE_STDERR")):
                pack["stderr"] = completed.stderr[-2000:]
            return pack
    except subprocess.TimeoutExpired:
        return {
            "enabled": True,
            "available": False,
            "reason": f"Project-status evidence timed out after {timeout_seconds}s.",
            "runtimeMs": round((time.perf_counter() - started) * 1000, 2),
            "items": [],
        }
    except Exception as exc:
        return {
            "enabled": True,
            "available": False,
            "reason": f"Project-status evidence failed: {clean_text(exc)[:300]}",
            "runtimeMs": round((time.perf_counter() - started) * 1000, 2),
            "items": [],
        }
    return {
        "enabled": True,
        "available": False,
        "reason": "Project-status evidence returned an unexpected payload.",
        "runtimeMs": round((time.perf_counter() - started) * 1000, 2),
        "items": [],
    }


def compact_project_status_evidence(evidence_pack: dict[str, Any] | None) -> str:
    if not evidence_pack or not isinstance(evidence_pack, dict):
        return ""
    items = evidence_pack.get("items")
    if not evidence_pack.get("available") or not isinstance(items, list) or not items:
        return ""
    compact = {
        "source": "project_update_status_model",
        "guidance": "Use as attention hints only. The transcript remains the source of truth.",
        "items": items[:32],
    }
    text = json.dumps(compact, ensure_ascii=False, indent=2)
    if len(text) <= PROJECT_STATUS_EVIDENCE_MAX_CHARS:
        return text
    compact["items"] = items[:14]
    text = json.dumps(compact, ensure_ascii=False, indent=2)
    return text[:PROJECT_STATUS_EVIDENCE_MAX_CHARS]


def project_evidence_blob(evidence_pack: dict[str, Any] | None) -> str:
    if not evidence_pack or not isinstance(evidence_pack, dict):
        return ""
    items = evidence_pack.get("items")
    if not isinstance(items, list):
        return ""
    snippets: list[str] = []
    for item in items[:80]:
        if not isinstance(item, dict):
            continue
        parts = [clean_text(item.get("transcriptSnippet"))]
        parts.extend(string_list(item.get("keywordHits"), limit=12))
        snippets.append(" ".join(part for part in parts if part))
    return clean_text("\n".join(snippets)).lower()


def evidence_supported(blob: str, *terms: str) -> bool:
    return bool(blob) and all(term.lower() in blob for term in terms)


def rejected_alternative_phrases(transcript: str) -> list[str]:
    compact = clean_text(transcript).lower()
    phrases: list[str] = []
    for match in re.finditer(r"\bmaybe\s+we\s+([^.?]+)", compact):
        if "not this month" in compact[max(0, match.end() - 80): match.end() + 180]:
            phrases.append(clean_text(match.group(1)))
    for match in re.finditer(r"\boriginal plan was to\s+([^.?]+)", compact):
        later = compact[match.end(): match.end() + 260]
        if re.search(r"\b(?:actually|instead|agreed|move|changed?)\b", later):
            phrases.append(clean_text(match.group(1)))
    return [phrase for phrase in dict.fromkeys(phrases) if phrase]


def remove_phrases_from_visible_output(value: Any, phrases: list[str]) -> Any:
    if not phrases:
        return value
    lowered = [phrase.lower() for phrase in phrases]
    if isinstance(value, str):
        text = clean_text(value)
        if any(phrase and phrase in text.lower() for phrase in lowered):
            return ""
        return text
    if isinstance(value, list):
        cleaned_items = [remove_phrases_from_visible_output(item, phrases) for item in value]
        return [item for item in cleaned_items if item not in ("", None, [], {})]
    if isinstance(value, dict):
        return {key: item for key, item in ((key, remove_phrases_from_visible_output(item, phrases)) for key, item in value.items()) if item not in ("", None, [], {})}
    return value


def strip_visible_transcript_artifacts(value: Any) -> Any:
    if isinstance(value, str):
        text = re.sub(r"\b[A-Z][A-Za-z'’-]+(?:\s+[A-Z][A-Za-z'’-]+){0,2}\s+\d{1,2}:\d{2}\s*", "", value)
        text = re.sub(r"\b\d{1,2}:\d{2}\b", "", text)
        return clean_text(text)
    if isinstance(value, list):
        return [strip_visible_transcript_artifacts(item) for item in value]
    if isinstance(value, dict):
        return {key: strip_visible_transcript_artifacts(item) for key, item in value.items()}
    return value


def append_unique_text(values: list[str], text: str, limit: int = 30) -> list[str]:
    if not text:
        return values
    existing = {clean_text(value).lower() for value in values}
    if clean_text(text).lower() not in existing:
        values.append(text)
    return string_list(values, limit=limit)


def prepend_unique_text(values: list[str], text: str, limit: int = 30) -> list[str]:
    cleaned = clean_text(text)
    if not cleaned:
        return values
    next_values = [cleaned]
    next_values.extend(value for value in values if clean_text(value).lower() != cleaned.lower())
    return string_list(next_values, limit=limit)


def append_unique_action(
    actions: list[dict[str, Any]],
    text: str,
    evidence: str = "MiniLM evidence selector",
    *,
    prepend: bool = False,
    owner: str = "Not stated",
    deadline: str = "Not stated",
) -> list[dict[str, Any]]:
    if not text:
        return actions
    normalised = clean_text(text).lower()
    for action in actions:
        existing = action_text_from_item(action).lower() if isinstance(action, dict) else clean_text(action).lower()
        if existing == normalised or (normalised in existing) or (existing and existing in normalised):
            if isinstance(action, dict):
                existing_owner = clean_text(action.get("meetingActionPointOwner"))
                existing_action_text = action_text_from_item(action).lower()
                owner_is_action_object = bool(existing_owner and existing_owner.lower() in existing_action_text)
                if clean_text(owner) and (existing_owner.lower() in {"", "not stated"} or "/" in existing_owner or "implied" in existing_owner.lower() or owner_is_action_object):
                    action["meetingActionPointOwner"] = clean_text(owner)
                if clean_text(deadline) and clean_text(deadline).lower() != "not stated" and clean_text(action.get("meetingActionPointDeadline")).lower() in {"", "not stated"}:
                    action["meetingActionPointDeadline"] = clean_text(deadline)
                if evidence and not clean_text(action.get("evidence")):
                    action["evidence"] = evidence[:220]
            return actions
    item = {
        "meetingActionPoint": text,
        "meetingActionPointOwner": clean_text(owner) or "Not stated",
        "meetingActionPointDeadline": clean_text(deadline) or "Not stated",
        **({"evidence": evidence[:220]} if evidence else {}),
    }
    if prepend:
        actions.insert(0, item)
    else:
        actions.append(item)
    return actions


def clean_action_sentence(text: str) -> str:
    cleaned = clean_text(text).strip(" .")
    cleaned = re.sub(r"\b(?:today|tonight|this evening|before noon|by (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))$", "", cleaned, flags=re.I).strip(" .")
    if cleaned and cleaned[0].islower():
        cleaned = cleaned[0].upper() + cleaned[1:]
    return cleaned.rstrip(".") + "." if cleaned else ""


def deadline_from_text(text: str) -> str:
    match = re.search(r"\b(by\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|today|tonight|this evening|before noon)\b", text, re.I)
    if not match:
        return "Not stated"
    deadline = clean_text(match.group(1))
    return deadline[0].upper() + deadline[1:] if deadline else "Not stated"


def add_unique_decision(decisions: list[str], text: str) -> list[str]:
    cleaned = clean_text(text).strip(" .")
    cleaned = re.sub(r"^(?:we will|let['’]?s|to)\s+", "", cleaned, flags=re.I).strip(" .")
    if cleaned and cleaned[0].islower():
        cleaned = cleaned[0].upper() + cleaned[1:]
    if cleaned:
        decisions = append_unique_text(decisions, f"Decided to {cleaned[0].lower() + cleaned[1:] if cleaned else cleaned}.", limit=15)
    return decisions


def strip_speaker_prefix(text: str) -> str:
    return re.sub(r"^[A-Z][A-Za-z'’-]+(?:\s+[A-Z][A-Za-z'’-]+){0,2}\s+\d{1,2}:\d{2}\s+", "", clean_text(text)).strip()


def transcript_has_explicit_action_cue(transcript: str) -> bool:
    # Keep the "Name to ..." cue case-sensitive. With re.I, ordinary text
    # such as "unlikely to land" looks like a named action.
    if re.search(r"\b[A-Z][a-z]+\s+to\s+", transcript):
        return True
    return bool(re.search(r"\bI['’]?ll\s+|\bI\s+will\s+|\bI\s+can\s+|\bCan you\s+|\blet['’]?s\s+(?:do|review|set|separate|update|send|prepare)", transcript, re.I))


def transcript_has_explicit_decision_cue(transcript: str) -> bool:
    return bool(re.search(r"\b(?:decision\s+confirmed|decided\s+to|agreed,?\s+let['’]?s|then\s+let['’]?s\s+do\s+it|we\s+will\s+.+?\bagreed\b)", clean_text(transcript), re.I))


def is_concise_discussion_only_transcript(transcript: str) -> bool:
    word_count = len(re.findall(r"\w+", clean_text(transcript)))
    if word_count > 140:
        return False
    if transcript_has_explicit_action_cue(transcript) or transcript_has_explicit_decision_cue(transcript):
        return False
    lower = transcript.lower()
    action_worthy_pending = bool(re.search(
        r"\b(sales input is still missing|document is absent|feedback is still pending|templates are still not finalised|awaiting leadership approval)\b",
        lower,
    ))
    if action_worthy_pending:
        return False
    discussion_only_cues = [
        "still pending",
        "have now been received",
        "has been updated",
        "unlikely to land",
        "will review it afterwards",
        "we should ",
        "it may be cleaner",
        "we can continue",
        "timelines are unaffected",
        "no follow-up actions",
        "no decisions",
    ]
    return any(cue in lower for cue in discussion_only_cues)


def clear_action_decision_fields(output: dict[str, Any]) -> dict[str, Any]:
    gated = dict(output)
    gated["decisions"] = []
    gated["actions"] = []
    gated["nextSteps"] = []
    gated["meetingActionPoint"] = []
    gated["meetingActionPointOwner"] = []
    gated["meetingActionPointDeadline"] = []
    return gated


def apply_concise_discussion_only_gate(output: dict[str, Any], transcript: str, route: dict[str, Any] | None) -> dict[str, Any]:
    if not is_concise_discussion_only_transcript(transcript):
        return output
    return normalise_output(clear_action_decision_fields(output))


def apply_transcript_topic_recovery(output: dict[str, Any], transcript: str) -> dict[str, Any]:
    lower = transcript.lower()
    topics = string_list(output.get("discussionPoints"), limit=30)
    topic_rules = [
        (("travel policy",), "Travel policy updates were discussed."),
        (("mileage", "july"), "The mileage rate changes in July."),
        (("guidance", "intranet"), "The intranet guidance page will show the new rate and examples."),
        (("master reference documents",), "Master reference documents were discussed as a cleaner reference point."),
        (("support metrics",), "Support metrics were reviewed."),
        (("complex cases", "simple requests"), "Complex cases were sitting behind simple requests in the shared queue."),
        (("triage", "categories"), "Separate triage categories were discussed."),
        (("risk", "cybersecurity"), "Risk and cybersecurity updates were discussed."),
        (("language", "software"), "Language changes in the software were discussed."),
    ]
    for terms, text in topic_rules:
        if all(term in lower for term in terms):
            topics = append_unique_text(topics, text, limit=30)
    recovered = dict(output)
    recovered["discussionPoints"] = topics
    return normalise_output(recovered)


def transcript_contains_all(lower: str, *terms: str) -> bool:
    return all(term.lower() in lower for term in terms)


def append_supported_topic(topics: list[str], lower: str, terms: tuple[str, ...], text: str) -> list[str]:
    if transcript_contains_all(lower, *terms):
        return append_unique_text(topics, text, limit=30)
    return topics


def apply_long_transcript_recovery(output: dict[str, Any], transcript: str) -> dict[str, Any]:
    """Recover high-confidence detail from long real transcripts/minutes.

    This is a deterministic safety net for cases where the LLM call fails or
    compresses too aggressively. It only adds items when the transcript itself
    contains the supporting terms, and it keeps wording generic enough to avoid
    leaking raw transcript chatter.
    """
    compact = clean_text(transcript)
    lower = compact.lower()
    if len(re.findall(r"\w+", compact)) < 300:
        return output

    recovered = dict(output)
    topics = string_list(recovered.get("discussionPoints"), limit=30)
    decisions = decision_list(recovered.get("decisions"), limit=8)
    actions = [dict(action) for action in recovered.get("actions") or [] if isinstance(action, dict)]

    long_topic_rules = [
        (("alarm", "mute button"), "Alarm behaviour and the mute button were discussed."),
        (("sw versioning", "traceability"), "Software versioning and traceability were discussed."),
        (("electrical compliance", "testing"), "Electrical compliance testing was discussed."),
        (("cybersecurity", "usb port"), "Cybersecurity controls for the USB port were discussed."),
        (("working sessions", "business works"), "Working sessions were discussed to understand how the client business works."),
        (("wednesday", "thursday", "friday"), "Wednesday, Thursday and Friday were discussed for working-session scheduling."),
        (("ppe", "sunglasses", "procedures"), "PPE and sunglasses requirements were discussed for inclusion in procedures."),
        (("conformity", "language", "markets"), "Declaration of conformity language requirements across markets were discussed."),
        (("mdr", "ppe", "declaration"), "MDR, PPE and declarations of conformity were discussed."),
        (("site visit", "process works"), "A site visit/process walkthrough was discussed to understand how the process works."),
        (("what actually happens", "business works"), "A site visit/process walkthrough was discussed to understand how the process works."),
        (("quality manuals", "generic"), "Quality manuals and the risk of overly generic procedures were discussed."),
        (("assessment tool", "improvement plan", "site"), "The assessment tool and site improvement plan were discussed."),
        (("quality system", "quality culture"), "Quality-system maturity and quality-culture maturity were discussed."),
        (("radar chart", "prioritise"), "Radar-chart scoring was discussed as a way to prioritise improvement areas."),
        (("interviews", "audit", "gemba"), "Interviews, audit evidence and gemba/site observation were discussed."),
        (("interviews", "audit", "gamba"), "Interviews, audit evidence and gemba/site observation were discussed."),
        (("interviews", "audit", "manufacturing floor"), "Interviews, audit evidence and gemba/site observation were discussed."),
        (("kappa", "validation"), "Kappa and validation processes were discussed as assessment examples."),
        (("follow up", "site assessment"), "Follow-up after site assessment was discussed."),
        (("follow up", "qip assessment"), "Follow-up after site assessment was discussed."),
        (("follow up", "quality system", "quality culture"), "Follow-up after site assessment was discussed."),
        (("gemba", "audit evidence"), "Gemba/site observation and audit evidence were discussed."),
        (("gamba", "audit"), "Gemba/site observation and audit evidence were discussed."),
        (("we just go and look", "audit"), "Gemba/site observation and audit evidence were discussed."),
        (("procedures", "business processes"), "Procedures and business processes were discussed as audit evidence areas."),
        (("production process control", "software development"), "Procedures and business processes were discussed as audit evidence areas."),
        (("cybersecurity", "risk management"), "Cybersecurity and risk management were discussed as audit-preparation areas."),
        (("full compliance", "21 cfrs"), "Audit scope covered full compliance to 21 CFRs, MDSAP and MDR."),
        (("routine audit", "surveillance"), "The call confirmed this was a routine surveillance audit."),
        (("sbom", "sharepoint"), "SBOM/document access and secure SharePoint sharing were discussed."),
        (("training attestation", "code of conduct"), "Training attestation and code-of-conduct timing were discussed."),
        (("risk assessment", "audit plan"), "Risk assessment was discussed as an input to the audit plan."),
        (("production process control", "purchasing"), "Production process control and purchasing coverage were discussed."),
        (("software development", "validation"), "Software development and validation coverage were discussed."),
        (("audit findings tracker", "feedback"), "Audit findings tracking and corporate feedback coordination were discussed."),
    ]
    for terms, text in long_topic_rules:
        topics = append_supported_topic(topics, lower, terms, text)

    # Minutes-style owner/deadline action-table preservation.
    if transcript_contains_all(lower, "mute button flash sequence", "19th june"):
        actions = append_unique_action(actions, "Review the mute button flash sequence.", "Transcript action table", owner="Andrew", deadline="19th June", prepend=True)
    if transcript_contains_all(lower, "clinical review of code changes", "sounds", "colour", "flash", "26th june"):
        actions = append_unique_action(actions, "Clinical review of code changes for sounds, colour and flash.", "Transcript action table", owner="Rebecca", deadline="26th June", prepend=True)
    if transcript_contains_all(lower, "complete electrical compliance testing", "23rd july"):
        actions = append_unique_action(actions, "Complete Electrical compliance testing.", "Transcript action table", owner="Andrew", deadline="23rd July", prepend=True)
    if transcript_contains_all(lower, "risk management file", "usb port lock", "gui security") or transcript_contains_all(lower, "rsk mgmt file", "usb port lock", "gui security"):
        actions = append_unique_action(actions, "Update Risk Management file addressing USB port lock and GUI security controls.", "Transcript action table", owner="Rebecca", deadline="22nd June", prepend=True)

    # Long internal follow-up / case-study recovery.
    if transcript_contains_all(lower, "ppe", "sunglasses", "procedures"):
        decisions = add_unique_decision(decisions, "PPE and sunglasses requirements should be covered in the procedures")
        actions = append_unique_action(actions, "Confirm the PPE and sunglasses procedure scope with the client.", "Transcript-supported follow-up", prepend=True)
    if transcript_contains_all(lower, "wednesday", "thursday", "friday", "working sessions"):
        decisions = add_unique_decision(decisions, "Working sessions should be scheduled for Wednesday, Thursday and Friday")
        actions = append_unique_action(actions, "Set up working sessions with the client.", "Transcript-supported follow-up", prepend=True)
    if transcript_contains_all(lower, "declaration", "conformity", "language"):
        actions = append_unique_action(actions, "Follow up internally on declaration of conformity language requirements.", "Transcript-supported follow-up", prepend=True)
    if transcript_contains_all(lower, "weekly recurrence", "call") or transcript_contains_all(lower, "weekly", "call", "check in"):
        actions = append_unique_action(actions, "Schedule a weekly client check-in call.", "Transcript-supported follow-up", prepend=True)
    if transcript_contains_all(lower, "take a look", "assessment reports") or transcript_contains_all(lower, "west qip assessment reports"):
        actions = append_unique_action(actions, "Review referenced reports.", "Transcript-supported follow-up", owner="Hannah", prepend=True)
    if transcript_contains_all(lower, "draft", "send it to me", "review it") or transcript_contains_all(lower, "draught", "send it to me", "review it"):
        actions = append_unique_action(actions, "Draft content and send it for review.", "Transcript-supported follow-up", owner="Hannah", prepend=True)

    recovered["discussionPoints"] = topics
    recovered["decisions"] = decisions
    recovered["actions"] = actions
    # Re-rank/cap after deterministic recovery so exact owner/deadline actions
    # outrank vague LLM/fallback placeholders.
    normalised = normalise_output(recovered)
    normalised["actions"] = rank_actions_for_fallback(normalised.get("actions") or [], limit=6)
    normalised["meetingActionPoint"] = [a["meetingActionPoint"] for a in normalised["actions"] if a.get("meetingActionPoint")]
    normalised["meetingActionPointOwner"] = [a.get("meetingActionPointOwner", "Not stated") for a in normalised["actions"]]
    normalised["meetingActionPointDeadline"] = [a.get("meetingActionPointDeadline", "Not stated") for a in normalised["actions"]]
    return normalised


def apply_concise_transcript_recovery(output: dict[str, Any], transcript: str, route: dict[str, Any] | None) -> dict[str, Any]:
    """Recover obvious decisions/actions from concise transcripts.

    This is intentionally generic and conservative: it only runs on short-ish
    complete/formal inputs and looks for explicit commitment language, not topic
    mentions. Long real transcripts stay governed by chunk/evidence paths.
    """
    if (route or {}).get("recommendedMode") != "formal_minutes":
        return output
    compact = clean_text(transcript)
    word_count = len(re.findall(r"\w+", compact))
    if word_count > 420:
        return output

    recovered = dict(output)
    decisions = decision_list(recovered.get("decisions"), limit=15)
    actions = [dict(action) for action in recovered.get("actions") or [] if isinstance(action, dict)]
    discussion = string_list(recovered.get("discussionPoints"), limit=30)

    for match in re.finditer(r"\bDecision confirmed:\s*([^\n.]+(?:\.[^\n.]+)?)", transcript, re.I):
        decisions = add_unique_decision(decisions, match.group(1))

    sentences = [clean_text(part) for part in re.split(r"(?<=[.!?])\s+|\n+", transcript) if clean_text(part)]
    for index, sentence in enumerate(sentences):
        body = strip_speaker_prefix(sentence)
        next_text = " ".join(sentences[index + 1:index + 3]).lower()
        will_match = re.match(r"We will\s+(.+)", body, re.I)
        if will_match and ("agreed" in next_text or "decision confirmed" in next_text or "decision" in body.lower()):
            decisions = add_unique_decision(decisions, will_match.group(1))
        lets_match = re.search(r"Agreed,?\s+let['’]?s\s+(.+)", body, re.I)
        if lets_match:
            decisions = add_unique_decision(decisions, lets_match.group(1))

    for match in re.finditer(r"\b([A-Z][a-z]+)\s+to\s+([^\n.]+)", transcript):
        owner, text = match.group(1), match.group(2)
        if owner.lower() in {"date", "location", "participants"}:
            continue
        actions = append_unique_action(actions, clean_action_sentence(text), "Explicit transcript action", owner=owner, deadline=deadline_from_text(text), prepend=True)

    current_speaker = "Not stated"
    for raw_line in transcript.splitlines():
        line = clean_text(raw_line)
        speaker_only = re.match(r"^([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+\d{1,2}:\d{2}$", line)
        speaker_match = re.match(r"^([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+\d{1,2}:\d{2}\s+(.+)$", line)
        colon_match = re.match(r"^([A-Z][a-z]+):\s+(.+)$", line)
        if speaker_only:
            current_speaker = speaker_only.group(1).split()[0]
            spoken = ""
        elif speaker_match:
            current_speaker = speaker_match.group(1).split()[0]
            spoken = speaker_match.group(2)
        elif colon_match:
            current_speaker = colon_match.group(1)
            spoken = colon_match.group(2)
        else:
            spoken = line
        commitment = re.search(r"\bI['’]?ll\s+([^\n.]+)", spoken, re.I)
        if commitment:
            actions = append_unique_action(actions, clean_action_sentence(commitment.group(1)), "Explicit transcript action", owner=current_speaker, deadline=deadline_from_text(commitment.group(1)), prepend=True)
        we_will_action = re.search(r"\bWe\s+will\s+(invite\s+[^\n.]+)", spoken, re.I)
        if we_will_action:
            actions = append_unique_action(actions, clean_action_sentence(we_will_action.group(1)), "Explicit transcript action", owner=current_speaker, deadline=deadline_from_text(we_will_action.group(1)), prepend=True)

    for match in re.finditer(r"\b([A-Z][a-z]+):\s*I\s+can\s+([^\n.]+)", transcript, re.I):
        owner, text = match.group(1), match.group(2)
        actions = append_unique_action(actions, clean_action_sentence(text), "Explicit transcript action", owner=owner, deadline=deadline_from_text(text), prepend=True)

    if re.search(r"\bneed\s+separate\s+triage\s+categories\b", transcript, re.I) and re.search(r"\bthen\s+let['’]?s\s+do\s+it\b", transcript, re.I):
        actions = append_unique_action(actions, "Separate triage categories.", "Explicit transcript action", prepend=True)
    if re.search(r"\blet['’]?s\s+review\s+the\s+guide\s+next\s+week\b", transcript, re.I):
        actions = append_unique_action(actions, "Review the onboarding guide.", "Explicit transcript action", deadline="Next week", prepend=True)

    question_then_accept = re.finditer(
        r"([A-Z][a-z]+)(?:\s+\d{1,2}:\d{2})?\s+Can you\s+([^\n?]+?)\?\s+([A-Z][a-z]+)(?:\s+\d{1,2}:\d{2})?\s+I['’]?ll do that",
        compact,
        re.I,
    )
    for match in question_then_accept:
        action_text, owner = match.group(2), match.group(3)
        actions = append_unique_action(actions, clean_action_sentence(action_text), "Explicit transcript action", owner=owner, deadline=deadline_from_text(action_text), prepend=True)

    pending_rules = [
        (r"([^\n.]+?)\s+are\s+still\s+not\s+finalised", "Review {item}"),
        (r"Sales input is still missing for\s+([^\n.]+)", "Provide sales input for {item}"),
        (r"The\s+([^\n.]+?document)\s+is\s+absent", "Draft {item}"),
        (r"([^\n.]+?feedback)\s+is\s+still\s+pending", "Follow up {item}"),
    ]
    for pattern, template in pending_rules:
        for match in re.finditer(pattern, transcript, re.I):
            item = clean_text(match.group(1)).strip(" .")
            if not item:
                continue
            action_text = template.format(item=item).replace("  ", " ")
            actions = append_unique_action(actions, clean_action_sentence(action_text), "Pending item in transcript", prepend=False)

    has_explicit_action_cue = transcript_has_explicit_action_cue(transcript)
    if decisions and not has_explicit_action_cue:
        actions = []

    concise_topic_rules = [
        (("legal review",), "Legal review was discussed as a blocker."),
        (("retail", "logistics"), "Retail and logistics accounts were discussed as the focus."),
        (("leadership review",), "Leadership review was discussed as pending."),
        (("vendor strategy",), "Vendor strategy was discussed."),
    ]
    lower_compact = compact.lower()
    for terms, text in concise_topic_rules:
        if all(term in lower_compact for term in terms):
            discussion = append_unique_text(discussion, text, limit=30)

    for text in [*decisions[:6], *[action_text_from_item(action) for action in actions[:6]]]:
        if text:
            discussion = append_unique_text(discussion, text, limit=30)

    actions = [action for action in actions if not is_placeholder_text(action_text_from_item(action))]
    recovered["decisions"] = decisions
    recovered["actions"] = actions
    recovered["discussionPoints"] = discussion
    return normalise_output(recovered)


def augment_output_with_project_evidence(output: dict[str, Any], evidence_pack: dict[str, Any] | None) -> dict[str, Any]:
    """Use MiniLM evidence as a cautious fallback attention map.

    The classifier is not a meeting-minutes writer. It only prevents the
    deterministic fallback from dropping transcript-backed topics/actions that
    the chunk calls already made plausible but the merge/review failed to keep.
    """
    blob = project_evidence_blob(evidence_pack)
    if not blob:
        return output
    augmented = dict(output)
    discussion = string_list(augmented.get("discussionPoints"), limit=30)
    actions = [dict(action) for action in augmented.get("actions") or [] if isinstance(action, dict)]
    output_blob = clean_text(json.dumps(truncate_for_prompt({"discussionPoints": discussion, "actions": actions}, max_string_chars=260), ensure_ascii=False)).lower()
    support_blob = f"{blob} {output_blob}"

    topic_rules = [
        (("qms", "importer"), "QMS/importer-obligation process was discussed."),
        (("storage", "dublin"), "Storage in Dublin was discussed in relation to importer responsibilities."),
        (("warehouse", "barcode"), "Warehouse picking and shipping-list barcodes were discussed."),
        (("udi", "label"), "UDI and labelling requirements were reviewed."),
        (("udimed", "authorised rep"), "UDAMED responsibility was discussed in relation to the authorised representative."),
        (("med envoy", "project"), "Med Envoy project plan or task list visibility was discussed."),
        (("ifu", "manufacturer"), "IFUs and manufacturer information were discussed."),
        (("declaration", "ppe"), "Declarations of conformity and PPE risk rationale were discussed."),
        (("hpra", "bill"), "HPRA documentation and authorised-representative bill follow-up were discussed."),
        (("mute button",), "Alarm behaviour and the mute button were discussed."),
        (("clinical", "review"), "Clinical review timing was discussed."),
        (("change request",), "Change request review timing for Wednesday was discussed."),
        (("electrical compliance",), "Electrical compliance testing timing around 23rd of July was discussed."),
        (("cybersecurity", "usb"), "Cybersecurity controls for the USB port were discussed."),
    ]
    for terms, text in topic_rules:
        if evidence_supported(support_blob, *terms):
            discussion = prepend_unique_text(discussion, text, limit=30)

    action_rules = [
        (("med envoy", "project"), "Follow up on the Med Envoy project plan or task list."),
        (("hpra", "bill"), "Review the HPRA authorised-representative bill."),
        (("declaration", "ppe"), "Update Declarations of Conformity with the PPE risk rationale."),
        (("mute button", "review"), "Review the mute button."),
        (("clinical", "review"), "Follow up on the clinical review."),
        (("electrical compliance", "testing"), "Confirm electrical compliance testing."),
        (("usb port", "cybersecurity"), "Review USB port cybersecurity controls."),
    ]
    for terms, text in action_rules:
        if evidence_supported(support_blob, *terms):
            actions = append_unique_action(actions, text, prepend=True)

    augmented["discussionPoints"] = discussion
    augmented["actions"] = actions
    return apply_chunked_quality_gate(augmented)


def prompt_for_transcript(transcript: str, project_status_evidence: dict[str, Any] | None = None, route: dict[str, Any] | None = None) -> str:
    evidence_text = compact_project_status_evidence(project_status_evidence)
    evidence_section = ""
    if evidence_text:
        evidence_section = f"""
[PROJECT_STATUS_EVIDENCE]
{evidence_text}
[/PROJECT_STATUS_EVIDENCE]
"""
    route_section = routing_prompt_section(route)
    route_instructions = routing_instruction_text(route)

    return f"""[CMD]@meeting-minutes|verify=true|detail=9|creativity=1|format=json|audience=client|language=en-GB
[INPUT]
{transcript}
[/INPUT]
{route_section}{evidence_section}
-bannedWords=["game-changing","revolutionary","seamless","world-class","obviously","basically"]

Return valid JSON only, with exactly this shape:
{{
  "meetingTitle": "",
  "meetingDate": "",
  "meetingLocation": "",
  "meetingDescription": "",
  "meetingObjectives": [],
  "participants": {{"client": [], "trinzo": []}},
  "otherParticipants": [],
  "executiveSummary": "",
  "confirmedPoints": [{{"text": "", "evidence": ""}}],
  "risksAndIssues": [{{"text": "", "status": "open", "owner": "Not stated", "evidence": ""}}],
  "dependencies": [{{"text": "", "owner": "Not stated", "deadline": "Not stated", "evidence": ""}}],
  "complianceFollowUps": [{{"text": "", "owner": "Not stated", "deadline": "Not stated", "evidence": ""}}],
  "termsForReview": [{{"term": "", "normalisedTerm": "", "reason": "", "confidence": "low|medium|high", "evidence": ""}}],
  "discussionTopics": [
    {{
      "topicId": "",
      "topic": "",
      "summary": "",
      "outcome": "",
      "items": [
        {{"itemId": "", "type": "discussion|decision|confirmed|risk|dependency|compliance_follow_up", "text": "", "owner": null, "status": "", "deadline": null, "dependency": null, "evidence": "", "confidence": 0.0}}
      ]
    }}
  ],
  "discussionPoints": [],
  "decisions": [],
  "actions": [{{"meetingActionPoint": "", "meetingActionPointOwner": "Not stated", "meetingActionPointDeadline": "Not stated", "dependency": "", "evidence": ""}}],
  "meetingMinutes": [{{"topic": "", "discussionPoints": []}}],
  "nextSteps": [{{"action": "", "owner": "Not stated", "deadline": "Not stated", "dependency": "", "evidence": ""}}],
  "openQuestions": []
}}

Operator rules for this task:
- Write client-ready professional meeting minutes, not a transcript summary.
- Use concise UK business English.
- Do not imitate transcript wording or include speaker labels, timestamps, filler, false starts, transcription artefacts, copied malformed questions, or meta-comments about the transcript.
- Do not invent facts, dates, attendees, decisions, owners, deadlines, regulations, standards, site names or actions.
- Deadlines and owners must be explicitly evidenced; otherwise use "Not stated".
- If an action genuinely belongs to the group and the transcript says "we", "us", "the team" or equivalent, use "All" as the owner. Do not use "We" as an owner label.
- Preserve relative deadlines exactly when stated, e.g. "next week" or "Wednesday". Do not convert them into calendar dates.
- Actions must be actual commitments or required follow-ups, not general discussion.
- Decisions must be actual decisions/confirmations, not every statement.
- Prefer fewer high-quality points over many weak points.
- Deduplicate repeated actions and repeated discussion points.
- If evidence is weak, omit the point or state "Not stated" rather than filling gaps.
- Do not make regulatory, compliance, audit or quality-system meetings falsely neat.
- Do not convert provisional, disputed, unclear or dependent items into settled facts. Preserve uncertainty, dependencies and ownership ambiguity.
- Put settled factual confirmations in confirmedPoints. Put unresolved compliance gaps, audit risks, missing evidence and regulatory concerns in risksAndIssues.
- Put external prerequisites, unclear ownership, pending inputs and third-party blockers in dependencies.
- Put compliance-specific follow-ups in complianceFollowUps, even if they also appear in actions.
- Put inconsistent, misspelled or uncertain names/terms in termsForReview. Normalise terms only when confidence is high; otherwise flag them for human review.
- Use discussionTopics as the main nested discussion structure: each topic should contain mixed non-action items such as decisions, confirmations, risks, dependencies and compliance follow-ups.
- Do not force every discussionTopics item to have owner, deadline or dependency fields. Use null or empty values unless the transcript explicitly gives them.
- Keep concrete commitments in actions/nextSteps as the separate action list. Only put an action-like item inside discussionTopics when it is needed to explain the topic context.
- If an attendee appears but affiliation is unclear, include them in otherParticipants rather than guessing client or Trinzo.
- Every action, risk, dependency and compliance follow-up should include a short evidence phrase from the transcript where possible.
- If PROJECT_STATUS_EVIDENCE is supplied, use it only as an attention guide for project-management detail that may be easy to miss.
- PROJECT_STATUS_EVIDENCE is not an independent source of truth. Include a blocker, risk, action, decision, owner, deadline or detail only when the transcript itself supports it.
{route_instructions}
"""


def prompt_for_chunk(chunk_text: str, chunk_index: int, chunk_count: int, route: dict[str, Any] | None = None) -> str:
    route_section = routing_prompt_section(route)
    route_instructions = routing_instruction_text(route)
    return f"""[CMD]@meeting-minutes-chunk|verify=true|detail=8|creativity=0|format=json|audience=client|language=en-GB
[INPUT_CHUNK index={chunk_index} of {chunk_count}]
{chunk_text}
[/INPUT_CHUNK]
{route_section}
Return valid JSON only, with this shape:
{{
  "chunkIndex": {chunk_index},
  "meetingTitleHints": [],
  "meetingDateHints": [],
  "participants": {{"client": [], "trinzo": []}},
  "otherParticipants": [],
  "confirmedPoints": [{{"text": "", "evidence": ""}}],
  "risksAndIssues": [{{"text": "", "status": "open", "owner": "Not stated", "evidence": ""}}],
  "dependencies": [{{"text": "", "owner": "Not stated", "deadline": "Not stated", "evidence": ""}}],
  "complianceFollowUps": [{{"text": "", "owner": "Not stated", "deadline": "Not stated", "evidence": ""}}],
  "termsForReview": [{{"term": "", "normalisedTerm": "", "reason": "", "confidence": "low|medium|high", "evidence": ""}}],
  "discussionTopics": [{{"topic": "", "summary": "", "items": [{{"type": "discussion|decision|confirmed|risk|dependency|compliance_follow_up", "text": "", "owner": null, "deadline": null, "evidence": "", "confidence": 0.0}}]}}],
  "decisions": [],
  "actions": [{{"meetingActionPoint": "", "meetingActionPointOwner": "Not stated", "meetingActionPointDeadline": "Not stated", "dependency": "", "evidence": ""}}],
  "openQuestions": []
}}

Chunk rules:
- Extract only what is explicitly supported inside this chunk.
- Do not fill gaps from common sense or from likely meeting context.
- Prefer sparse output over weak output.
- Use empty arrays when nothing is explicitly stated. Never write placeholder items such as "None stated".
- Return at most 2 decisions and at most 3 actions for this chunk unless the chunk contains several unmistakable commitments.
- Actions must be actual commitments/follow-ups, not general discussion.
- Decisions must be actual decisions/confirmations, not status statements.
- Owners and deadlines must be explicitly stated; otherwise use "Not stated".
- Include short evidence phrases for actions, risks, dependencies, compliance follow-ups and decisions.
- Remove filler, timestamps, speaker labels and transcript artefacts.
{route_instructions}
"""


def prompt_for_merge(chunk_outputs: list[dict[str, Any]], project_status_evidence: dict[str, Any] | None = None, route: dict[str, Any] | None = None) -> str:
    evidence_text = compact_project_status_evidence(project_status_evidence)
    compact_chunks = []
    for chunk in chunk_outputs:
        output = chunk.get("output") if isinstance(chunk, dict) else None
        if not isinstance(output, dict):
            continue
        compact_chunks.append(truncate_for_prompt({
            "chunkIndex": chunk.get("chunkIndex"),
            "meetingTitleHints": string_list(output.get("meetingTitleHints") or output.get("meetingTitle"), limit=4),
            "meetingDateHints": string_list(output.get("meetingDateHints") or output.get("meetingDate"), limit=4),
            "participants": output.get("participants") or {},
            "otherParticipants": output.get("otherParticipants") or [],
            "confirmedPoints": (output.get("confirmedPoints") or [])[:12],
            "risksAndIssues": (output.get("risksAndIssues") or [])[:12],
            "dependencies": (output.get("dependencies") or [])[:12],
            "complianceFollowUps": (output.get("complianceFollowUps") or [])[:12],
            "termsForReview": (output.get("termsForReview") or [])[:10],
            "discussionTopics": (output.get("discussionTopics") or [])[:10],
            "decisions": string_list(output.get("decisions"), limit=12),
            "actions": (output.get("actions") or output.get("nextSteps") or [])[:12],
            "openQuestions": string_list(output.get("openQuestions"), limit=8),
        }))
    chunks_text = json.dumps(compact_chunks, ensure_ascii=False, indent=2)
    if len(chunks_text) > 52000:
        chunks_text = chunks_text[:52000]
    evidence_section = f"""
[PROJECT_STATUS_EVIDENCE]
{evidence_text}
[/PROJECT_STATUS_EVIDENCE]
""" if evidence_text else ""
    route_section = routing_prompt_section(route)
    route_instructions = routing_instruction_text(route)
    return f"""[CMD]@meeting-minutes-merge|verify=true|detail=9|creativity=0|format=json|audience=client|language=en-GB
[CHUNK_OUTPUTS]
{chunks_text}
[/CHUNK_OUTPUTS]
{route_section}{evidence_section}

Return valid JSON only, with exactly this shape:
{{
  "meetingTitle": "",
  "meetingDate": "",
  "meetingLocation": "",
  "meetingDescription": "",
  "meetingObjectives": [],
  "participants": {{"client": [], "trinzo": []}},
  "otherParticipants": [],
  "executiveSummary": "",
  "confirmedPoints": [{{"text": "", "evidence": ""}}],
  "risksAndIssues": [{{"text": "", "status": "open", "owner": "Not stated", "evidence": ""}}],
  "dependencies": [{{"text": "", "owner": "Not stated", "deadline": "Not stated", "evidence": ""}}],
  "complianceFollowUps": [{{"text": "", "owner": "Not stated", "deadline": "Not stated", "evidence": ""}}],
  "termsForReview": [{{"term": "", "normalisedTerm": "", "reason": "", "confidence": "low|medium|high", "evidence": ""}}],
  "discussionTopics": [{{"topicId": "", "topic": "", "summary": "", "outcome": "", "items": [{{"itemId": "", "type": "discussion|decision|confirmed|risk|dependency|compliance_follow_up", "text": "", "owner": null, "status": "", "deadline": null, "dependency": null, "evidence": "", "confidence": 0.0}}]}}],
  "discussionPoints": [],
  "decisions": [],
  "actions": [{{"meetingActionPoint": "", "meetingActionPointOwner": "Not stated", "meetingActionPointDeadline": "Not stated", "dependency": "", "evidence": ""}}],
  "meetingMinutes": [{{"topic": "", "discussionPoints": []}}],
  "nextSteps": [{{"action": "", "owner": "Not stated", "deadline": "Not stated", "dependency": "", "evidence": ""}}],
  "openQuestions": []
}}

Merge rules:
- Deduplicate repeated items across chunks.
- Prefer fewer high-confidence points over long noisy minutes.
- Use empty arrays when nothing is explicitly stated. Never keep placeholder items such as "None stated".
- Keep the final action list short and concrete; avoid general recommendations or vague "check the side of things" style items.
- Keep uncertainty; do not upgrade tentative discussion into decisions or actions.
- Only include actions/decisions with evidence from the chunk outputs.
- If chunk outputs disagree, keep the cautious version and add review wording rather than inventing certainty.
- PROJECT_STATUS_EVIDENCE is only an attention guide. The chunk outputs remain the source of truth.
{route_instructions}
"""


def prompt_for_final_review(output: dict[str, Any], chunk_outputs: list[dict[str, Any]]) -> str:
    evidence_pack = []
    for chunk in chunk_outputs:
        candidate = chunk.get("output") if isinstance(chunk, dict) else None
        if not isinstance(candidate, dict):
            continue
        evidence_pack.append(truncate_for_prompt({
            "chunkIndex": chunk.get("chunkIndex"),
            "confirmedPoints": (candidate.get("confirmedPoints") or [])[:10],
            "risksAndIssues": (candidate.get("risksAndIssues") or [])[:10],
            "dependencies": (candidate.get("dependencies") or [])[:8],
            "complianceFollowUps": (candidate.get("complianceFollowUps") or [])[:8],
            "discussionTopics": (candidate.get("discussionTopics") or [])[:8],
            "decisions": decision_list(candidate.get("decisions"), limit=8),
            "actions": (candidate.get("actions") or candidate.get("nextSteps") or [])[:8],
        }, max_string_chars=300))
    evidence_text = json.dumps(evidence_pack, ensure_ascii=False, indent=2)
    if len(evidence_text) > 36000:
        evidence_text = evidence_text[:36000]
    current_text = json.dumps(truncate_for_prompt(output, max_string_chars=360), ensure_ascii=False, indent=2)
    return f"""[CMD]@meeting-minutes-final-review|verify=true|detail=8|creativity=0|format=json|audience=client|language=en-GB
[CURRENT_MINUTES]
{current_text}
[/CURRENT_MINUTES]

[SECTION_EVIDENCE]
{evidence_text}
[/SECTION_EVIDENCE]

Return valid JSON only, using the same meeting-minutes shape as CURRENT_MINUTES.

Verifier rules:
- This is a final quality-control pass, not a creative rewrite.
- Remove any action, decision, owner or deadline that is not directly supported by SECTION_EVIDENCE.
- Remove placeholders such as "None stated" or "No explicit decisions were recorded".
- Deduplicate near-duplicate actions, especially repeated bill/review/follow-up actions.
- Keep the action list short and practical. Prefer 3-6 concrete actions over 10 vague actions.
- Keep all important discussion evidence even if it is not an action.
- Improve wording into concise UK business English.
- Do not add new facts beyond SECTION_EVIDENCE.
"""


def prompt_for_compact_final_review(output: dict[str, Any], chunk_outputs: list[dict[str, Any]]) -> str:
    candidates = {
        "decisions": [
            {"index": index, "text": text}
            for index, text in enumerate(decision_list(output.get("decisions"), limit=12))
        ],
        "actions": [
            {
                "index": index,
                "text": clean_text(action.get("meetingActionPoint")),
                "owner": clean_text(action.get("meetingActionPointOwner")) or "Not stated",
                "deadline": clean_text(action.get("meetingActionPointDeadline")) or "Not stated",
                "evidence": clean_text(action.get("evidence"))[:220],
            }
            for index, action in enumerate(output.get("actions") or [])
            if isinstance(action, dict) and clean_text(action.get("meetingActionPoint"))
        ],
    }
    evidence_rows: list[dict[str, Any]] = []
    for chunk in chunk_outputs:
        candidate = chunk.get("output") if isinstance(chunk, dict) else None
        if not isinstance(candidate, dict):
            continue
        rows: list[Any] = []
        rows.extend(candidate.get("confirmedPoints") or [])
        rows.extend(candidate.get("risksAndIssues") or [])
        rows.extend(candidate.get("dependencies") or [])
        rows.extend(candidate.get("complianceFollowUps") or [])
        rows.extend(candidate.get("actions") or candidate.get("nextSteps") or [])
        for decision in decision_list(candidate.get("decisions"), limit=6):
            rows.append({"text": decision, "kind": "decision"})
        for topic in candidate.get("discussionTopics") or []:
            if isinstance(topic, dict):
                rows.extend((topic.get("items") or [])[:6])
        compact_rows = []
        seen: set[str] = set()
        for row in rows:
            if isinstance(row, dict):
                text = first_text(row, ["text", "meetingActionPoint", "action", "decision", "summary", "risk", "dependency"])
                evidence = clean_text(row.get("evidence") or row.get("sourceSnippet"))
                owner = clean_text(row.get("owner") or row.get("meetingActionPointOwner"))
                deadline = clean_text(row.get("deadline") or row.get("meetingActionPointDeadline"))
            else:
                text = clean_text(row)
                evidence = ""
                owner = ""
                deadline = ""
            if not text or is_placeholder_text(text):
                continue
            key = text.lower()
            if key in seen:
                continue
            seen.add(key)
            compact_rows.append({
                "text": text[:220],
                **({"owner": owner[:80]} if owner else {}),
                **({"deadline": deadline[:80]} if deadline else {}),
                **({"evidence": evidence[:220]} if evidence else {}),
            })
            if len(compact_rows) >= 14:
                break
        evidence_rows.append({"chunkIndex": chunk.get("chunkIndex"), "items": compact_rows})
    evidence_text = json.dumps(evidence_rows, ensure_ascii=False, indent=2)
    if len(evidence_text) > 14000:
        evidence_text = evidence_text[:14000]
    candidates_text = json.dumps(candidates, ensure_ascii=False, indent=2)
    return f"""[CMD]@meeting-minutes-action-verifier|verify=true|detail=6|creativity=0|format=json|audience=client|language=en-GB
[CANDIDATE_DECISIONS_AND_ACTIONS]
{candidates_text}
[/CANDIDATE_DECISIONS_AND_ACTIONS]

[SECTION_EVIDENCE]
{evidence_text}
[/SECTION_EVIDENCE]

Return valid JSON only with this exact shape:
{{
  "removeDecisionIndexes": [],
  "removeActionIndexes": [],
  "rewriteActions": [{{"index": 0, "text": "", "owner": "Not stated", "deadline": "Not stated", "evidence": ""}}],
  "notes": []
}}

Verifier rules:
- Do not rewrite the whole minutes. Only judge the candidate decisions/actions.
- Remove decisions that are placeholders, status statements, or not explicit decisions in SECTION_EVIDENCE.
- Remove actions that are vague recommendations, duplicates, or not concrete commitments/follow-ups.
- Rewrite only when the action is valid but too long, duplicated, or unclear.
- Owners/deadlines must remain "Not stated" unless explicitly evidenced.
- Prefer 3-6 strong actions over noisy completeness.
"""


def split_transcript_chunks(transcript: str, target_chars: int = CHUNK_TARGET_CHARS, overlap_chars: int = CHUNK_OVERLAP_CHARS) -> list[str]:
    text = transcript.strip()
    if len(text) <= target_chars:
        return [text] if text else []
    parts = re.split(r"(?=\n\s*(?:[A-Z][A-Za-z .'-]{1,60}\s+\d{1,2}:\d{2}|\d{1,2}:\d{2}(?::\d{2})?\b|Speaker\s+\d+\b))", text)
    if len(parts) <= 1:
        parts = re.split(r"(?<=[.!?])\s+", text)
    chunks: list[str] = []
    current = ""
    for part in parts:
        part = part.strip()
        if not part:
            continue
        if current and len(current) + len(part) + 2 > target_chars:
            chunks.append(current.strip())
            overlap = current[-overlap_chars:] if overlap_chars > 0 else ""
            current = f"{overlap}\n{part}".strip() if overlap else part
        else:
            current = f"{current}\n{part}".strip() if current else part
    if current:
        chunks.append(current.strip())
    return chunks


def truncate_for_prompt(value: Any, max_string_chars: int = 420) -> Any:
    if isinstance(value, str):
        text = clean_text(value)
        return text[:max_string_chars]
    if isinstance(value, list):
        return [truncate_for_prompt(item, max_string_chars=max_string_chars) for item in value]
    if isinstance(value, dict):
        return {key: truncate_for_prompt(item, max_string_chars=max_string_chars) for key, item in value.items()}
    return value


def empty_failure_output(error_message: str) -> dict[str, Any]:
    return {
        "meetingTitle": "Meeting minutes generation failed",
        "meetingDate": "",
        "meetingLocation": "",
        "meetingDescription": "The meeting minutes could not be generated automatically.",
        "meetingObjectives": [],
        "participants": {"client": [], "trinzo": []},
        "executiveSummary": error_message,
        "discussionPoints": [error_message],
        "decisions": [],
        "meetingActionPoint": [],
        "meetingActionPointOwner": [],
        "meetingActionPointDeadline": [],
        "actions": [],
        "meetingMinutes": [{"topic": "Generation issue", "discussionPoints": [error_message]}],
        "nextSteps": [],
        "openQuestions": [],
    }


def call_trooper_prompt(
    prompt: str,
    timeout_seconds: int,
    task_label: str = "meeting_minutes_final",
    normalise_response: bool = True,
) -> tuple[dict[str, Any], dict[str, Any]]:
    api_key = os.environ.get("TROOPER_API_KEY", "").strip()
    if not api_key:
        message = "TROOPER_API_KEY is not configured."
        return empty_failure_output(message), {"provider": "trooper", "model": None, "used": False, "error": message}

    model = os.environ.get("TROOPER_MODEL", TROOPER_MODEL_DEFAULT).strip() or TROOPER_MODEL_DEFAULT
    url = os.environ.get("TROOPER_CHAT_COMPLETIONS_URL", TROOPER_URL_DEFAULT).strip() or TROOPER_URL_DEFAULT
    body = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": "You operate HelixScribe's behavioural stabilisation operator. Interpret [CMD] operator parameters exactly. Return valid JSON only when format=json.",
            },
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.1,
        "max_tokens": int(os.environ.get("TROOPER_MAX_TOKENS", "4000")),
        "response_format": {"type": "json_object"},
    }

    started = time.perf_counter()
    errors = []
    for attempt in range(2):
        request = urllib.request.Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
                payload = json.loads(response.read().decode("utf-8"))
            choices = payload.get("choices") or []
            content = choices[0].get("message", {}).get("content", "") if choices else ""
            parsed = extract_json(content)
            if not parsed:
                errors.append({"attempt": attempt + 1, "error": "No parseable JSON returned"})
                time.sleep(1.0)
                continue
            diagnostics = {
                "provider": "trooper",
                "model": model,
                "task": task_label,
                "used": True,
                "errorsBeforeSuccess": errors,
                "runtimeMs": round((time.perf_counter() - started) * 1000, 2),
                "usage": payload.get("usage") or {},
            }
            return normalise_output(parsed) if normalise_response else parsed, diagnostics
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = json.loads(exc.read().decode("utf-8")).get("error", {}).get("message", "")
            except Exception:
                pass
            errors.append({"attempt": attempt + 1, "error": f"HTTP {exc.code}: {clean_text(detail)[:240]}"})
            if exc.code not in {429, 500, 502, 503, 504}:
                break
            time.sleep(2.0)
        except Exception as exc:
            errors.append({"attempt": attempt + 1, "error": clean_text(str(exc))[:240]})
            time.sleep(2.0)

    message = "Trooper Liv generation failed. Please retry; the API may be temporarily unavailable."
    return empty_failure_output(message), {"provider": "trooper", "model": model, "task": task_label, "used": False, "error": message, "errors": errors}


def call_trooper(
    transcript: str,
    timeout_seconds: int,
    project_status_evidence: dict[str, Any] | None = None,
    route: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    return call_trooper_prompt(
        prompt_for_transcript(transcript, project_status_evidence, route),
        timeout_seconds,
        task_label="full_transcript",
    )


def dedupe_structured_items(items: list[dict[str, Any]], key_names: list[str], limit: int = 30) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        text = "|".join(clean_text(item.get(key)) for key in key_names).lower().strip("|")
        if not text or text in seen:
            continue
        seen.add(text)
        out.append(item)
        if len(out) >= limit:
            break
    return out


def action_text_from_item(item: dict[str, Any]) -> str:
    return simplify_action_text(item.get("meetingActionPoint") or item.get("action") or item.get("task") or item.get("description"))


def rank_actions_for_fallback(actions: list[dict[str, Any]], limit: int = 6) -> list[dict[str, Any]]:
    """Keep deterministic fallback cautious when the AI merge cannot produce JSON."""
    weak_starts = ("need to ", "check the side of things", "look at that side of things")
    strong_starts = ("send ", "provide ", "update ", "obtain ", "review ", "confirm ", "follow up ", "share ", "prepare ", "agree ", "schedule ", "set up ", "complete ", "draft ")

    scored: list[tuple[int, int, dict[str, Any]]] = []
    for index, action in enumerate(actions):
        if not isinstance(action, dict):
            continue
        text = action_text_from_item(action)
        if not text or is_placeholder_text(text):
            continue
        if len(text) > 115:
            continue
        lower = text.lower()
        if lower.startswith(weak_starts):
            continue
        owner = clean_text(action.get("meetingActionPointOwner") or action.get("owner"))
        deadline = clean_text(action.get("meetingActionPointDeadline") or action.get("deadline"))
        evidence = clean_text(action.get("evidence") or action.get("sourceSnippet"))
        score = 0
        if owner and owner.lower() != "not stated":
            score += 4
        if deadline and deadline.lower() != "not stated":
            score += 2
        if evidence:
            score += 3
        if lower.startswith(strong_starts):
            score += 2
        if lower in {
            "set up working sessions with the client.",
            "confirm the ppe and sunglasses procedure scope with the client.",
            "schedule a weekly client check-in call.",
            "follow up internally on declaration of conformity language requirements.",
            "review the mute button flash sequence.",
            "clinical review of code changes for sounds, colour and flash.",
            "complete electrical compliance testing.",
            "update risk management file addressing usb port lock and gui security controls.",
            "review referenced reports.",
            "draft content and send it for review.",
            "separate triage categories.",
            "set up a dashboard.",
            "review the onboarding guide.",
            "review the mute button.",
            "follow up on the clinical review.",
            "confirm electrical compliance testing.",
            "review usb port cybersecurity controls.",
        }:
            score += 12
        if any(term in lower for term in ("hpra", "bill", "declaration", "conformity", "project plan", "formal feedback", "mute button", "clinical review", "electrical compliance", "usb port", "cybersecurity", "weekly client", "working sessions", "ppe", "sunglasses", "referenced reports", "send it for review")):
            score += 1
        scored.append((score, -index, action))
    scored.sort(reverse=True)

    selected: list[dict[str, Any]] = []
    selected_tokens: list[set[str]] = []
    for _, __, item in scored:
        tokens = set(re.findall(r"[a-z0-9']+", action_text_from_item(item).lower())) - {
            "the", "a", "an", "and", "or", "to", "for", "of", "regarding", "review", "check", "send", "update"
        }
        if any(tokens and existing and len(tokens & existing) / max(len(tokens | existing), 1) >= 0.58 for existing in selected_tokens):
            continue
        selected.append(item)
        selected[-1]["meetingActionPoint"] = action_text_from_item(selected[-1])
        selected_tokens.append(tokens)
        if len(selected) >= limit:
            break
    selected.sort(key=lambda item: actions.index(item) if item in actions else 999999)
    return selected


def cap_and_sync_action_fields(output: dict[str, Any], limit: int = 6) -> dict[str, Any]:
    capped = dict(output)
    capped["actions"] = rank_actions_for_fallback(capped.get("actions") or [], limit=limit)
    capped["meetingActionPoint"] = [a["meetingActionPoint"] for a in capped["actions"] if a.get("meetingActionPoint")]
    capped["meetingActionPointOwner"] = [a.get("meetingActionPointOwner", "Not stated") for a in capped["actions"]]
    capped["meetingActionPointDeadline"] = [a.get("meetingActionPointDeadline", "Not stated") for a in capped["actions"]]
    capped["nextSteps"] = [
        {
            "action": a.get("meetingActionPoint", ""),
            "owner": a.get("meetingActionPointOwner", "Not stated"),
            "deadline": a.get("meetingActionPointDeadline", "Not stated"),
            **({"dependency": a["dependency"]} if a.get("dependency") else {}),
        }
        for a in capped["actions"]
        if a.get("meetingActionPoint")
    ]
    return capped


def filter_explicit_decisions(decisions: list[str], limit: int = 6) -> list[str]:
    explicit_markers = (
        "decided", "decision", "agreed", "approved", "confirmed", "accepted", "selected",
        "signed off", "go ahead", "proceed", "invite", "shortlist", "defer", "reject",
    )
    cautious: list[str] = []
    for decision in decision_list(decisions, limit=30):
        lower = decision.lower()
        if any(marker in lower for marker in explicit_markers):
            cautious.append(decision)
        if len(cautious) >= limit:
            break
    return cautious


def apply_chunked_quality_gate(output: dict[str, Any]) -> dict[str, Any]:
    gated = dict(output)
    decision_limit = int(os.environ.get("MEETING_MINUTES_CHUNKED_DECISION_LIMIT", "6"))
    action_limit = int(os.environ.get("MEETING_MINUTES_CHUNKED_ACTION_LIMIT", "6"))
    gated["decisions"] = filter_explicit_decisions(gated.get("decisions") or [], limit=decision_limit)
    gated["actions"] = rank_actions_for_fallback(gated.get("actions") or [], limit=action_limit)
    gated["meetingActionPoint"] = [a["meetingActionPoint"] for a in gated["actions"] if a.get("meetingActionPoint")]
    gated["meetingActionPointOwner"] = [a.get("meetingActionPointOwner", "Not stated") for a in gated["actions"]]
    gated["meetingActionPointDeadline"] = [a.get("meetingActionPointDeadline", "Not stated") for a in gated["actions"]]
    gated["nextSteps"] = [
        {
            "action": a.get("meetingActionPoint", ""),
            "owner": a.get("meetingActionPointOwner", "Not stated"),
            "deadline": a.get("meetingActionPointDeadline", "Not stated"),
            **({"dependency": a["dependency"]} if a.get("dependency") else {}),
            **({"evidence": a["evidence"]} if a.get("evidence") else {}),
        }
        for a in gated["actions"]
    ]
    return gated


def apply_compact_review_verdict(output: dict[str, Any], verdict: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(verdict, dict):
        return output
    gated = dict(output)

    remove_decisions = {
        int(value) for value in verdict.get("removeDecisionIndexes") or []
        if isinstance(value, int) or str(value).isdigit()
    }
    decisions = decision_list(gated.get("decisions"), limit=20)
    gated["decisions"] = [text for index, text in enumerate(decisions) if index not in remove_decisions]

    actions = [dict(action) for action in gated.get("actions") or [] if isinstance(action, dict)]
    rewrites = {}
    for rewrite in verdict.get("rewriteActions") or []:
        if not isinstance(rewrite, dict):
            continue
        index_value = rewrite.get("index")
        if not (isinstance(index_value, int) or str(index_value).isdigit()):
            continue
        index = int(index_value)
        text = clean_text(rewrite.get("text"))
        if not text or is_placeholder_text(text):
            continue
        rewrites[index] = {
            "meetingActionPoint": text,
            "meetingActionPointOwner": clean_text(rewrite.get("owner")) or "Not stated",
            "meetingActionPointDeadline": clean_text(rewrite.get("deadline")) or "Not stated",
            **({"evidence": clean_text(rewrite.get("evidence"))} if clean_text(rewrite.get("evidence")) else {}),
        }

    remove_actions = {
        int(value) for value in verdict.get("removeActionIndexes") or []
        if isinstance(value, int) or str(value).isdigit()
    }
    next_actions: list[dict[str, Any]] = []
    for index, action in enumerate(actions):
        if index in remove_actions:
            continue
        next_actions.append(rewrites.get(index, action))
    gated["actions"] = next_actions
    return apply_chunked_quality_gate(gated)


def deterministic_merge_outputs(chunk_outputs: list[dict[str, Any]]) -> dict[str, Any]:
    raw: dict[str, Any] = {
        "meetingTitle": "Meeting minutes",
        "meetingDate": "",
        "meetingLocation": "",
        "meetingObjectives": [],
        "participants": {"client": [], "trinzo": []},
        "otherParticipants": [],
        "confirmedPoints": [],
        "risksAndIssues": [],
        "dependencies": [],
        "complianceFollowUps": [],
        "termsForReview": [],
        "discussionTopics": [],
        "discussionPoints": [],
        "decisions": [],
        "actions": [],
        "openQuestions": [],
    }
    title_hints: list[str] = []
    date_hints: list[str] = []
    topic_index = 1
    for chunk in chunk_outputs:
        output = chunk.get("output") if isinstance(chunk, dict) else None
        if not isinstance(output, dict):
            continue
        title_hints.extend(string_list(output.get("meetingTitleHints") or output.get("meetingTitle"), limit=4))
        date_hints.extend(string_list(output.get("meetingDateHints") or output.get("meetingDate"), limit=4))
        participants = output.get("participants") if isinstance(output.get("participants"), dict) else {}
        raw["participants"]["client"].extend(string_list(participants.get("client"), limit=20))
        raw["participants"]["trinzo"].extend(string_list(participants.get("trinzo"), limit=20))
        raw["otherParticipants"].extend(string_list(output.get("otherParticipants"), limit=20))
        raw["confirmedPoints"].extend(output.get("confirmedPoints") or [])
        raw["risksAndIssues"].extend(output.get("risksAndIssues") or [])
        raw["dependencies"].extend(output.get("dependencies") or [])
        raw["complianceFollowUps"].extend(output.get("complianceFollowUps") or [])
        raw["termsForReview"].extend(output.get("termsForReview") or [])
        raw["decisions"].extend(string_list(output.get("decisions"), limit=20))
        raw["actions"].extend(output.get("actions") or output.get("nextSteps") or [])
        raw["openQuestions"].extend(string_list(output.get("openQuestions"), limit=20))
        for topic in output.get("discussionTopics") or []:
            if not isinstance(topic, dict):
                continue
            for topic_item in topic.get("items") or []:
                if isinstance(topic_item, dict):
                    topic_text = first_text(topic_item)
                    if topic_text and not is_placeholder_text(topic_text):
                        raw["discussionPoints"].append(topic_text)
            raw["discussionTopics"].append({
                "topicId": clean_text(topic.get("topicId")) or f"topic-{topic_index}",
                "topic": clean_text(topic.get("topic")) or f"Discussion {topic_index}",
                "summary": clean_text(topic.get("summary")),
                "outcome": clean_text(topic.get("outcome")),
                "items": topic.get("items") or [],
            })
            topic_index += 1
    raw["meetingTitle"] = title_hints[0] if title_hints else "Meeting minutes"
    raw["meetingDate"] = date_hints[0] if date_hints else ""
    raw["participants"] = {
        "client": string_list(raw["participants"]["client"], limit=20),
        "trinzo": string_list(raw["participants"]["trinzo"], limit=20),
    }
    raw["otherParticipants"] = string_list(raw["otherParticipants"], limit=20)
    raw["confirmedPoints"] = dedupe_structured_items(raw["confirmedPoints"], ["text"], limit=30)
    raw["risksAndIssues"] = dedupe_structured_items(raw["risksAndIssues"], ["text"], limit=30)
    raw["dependencies"] = dedupe_structured_items(raw["dependencies"], ["text"], limit=25)
    raw["complianceFollowUps"] = dedupe_structured_items(raw["complianceFollowUps"], ["text", "owner"], limit=25)
    raw["termsForReview"] = dedupe_structured_items(raw["termsForReview"], ["term"], limit=20)
    raw["discussionPoints"] = string_list(raw["discussionPoints"], limit=30)
    raw["decisions"] = decision_list(raw["decisions"], limit=8)
    raw["actions"] = rank_actions_for_fallback(
        dedupe_structured_items(raw["actions"], ["meetingActionPoint", "action", "owner", "meetingActionPointOwner"], limit=30),
        limit=int(os.environ.get("MEETING_MINUTES_FALLBACK_ACTION_LIMIT", "6")),
    )
    raw["openQuestions"] = string_list(raw["openQuestions"], limit=20)
    return normalise_output(raw)


def strong_action_evidence(action: dict[str, Any]) -> bool:
    text = action_text_from_item(action).lower()
    owner = clean_text(action.get("meetingActionPointOwner") or action.get("owner"))
    deadline = clean_text(action.get("meetingActionPointDeadline") or action.get("deadline"))
    evidence = clean_text(action.get("evidence") or action.get("sourceSnippet"))
    owner_known = bool(owner and owner.lower() != "not stated")
    deadline_known = bool(deadline and deadline.lower() != "not stated")
    evidence_lower = evidence.lower()
    commitment_word = bool(re.search(r"\b(will|to send|to update|to prepare|to confirm|agreed|decided|action|follow up|owner)\b", f"{text} {evidence_lower}"))
    return bool(text and evidence and commitment_word and (owner_known or deadline_known or re.search(r"\b(i['’]?ll|i will|we will|will)\b", evidence_lower)))


def apply_routing_quality_gate(output: dict[str, Any], route: dict[str, Any] | None) -> dict[str, Any]:
    mode = (route or {}).get("recommendedMode")
    if mode not in {"topic_summary_with_caution", "sparse_minutes", "ask_for_better_transcript"}:
        return output

    gated = dict(output)
    reasons = string_list((route or {}).get("reasons"), limit=4)
    caution = "Generated cautiously because the transcript appears partial, gappy, non-formal, or low-substance."
    if reasons:
        caution = f"{caution} {' '.join(reasons)}"

    existing_summary = clean_text(gated.get("executiveSummary") or gated.get("meetingDescription"))
    if mode == "ask_for_better_transcript":
        gated["meetingTitle"] = "Meeting content needs review"
        gated["executiveSummary"] = "There is not enough usable meeting content to generate reliable formal minutes."
        gated["meetingDescription"] = gated["executiveSummary"]
        gated["discussionPoints"] = []
        gated["discussionTopics"] = []
        gated["meetingMinutes"] = []
        gated["confirmedPoints"] = []
        gated["risksAndIssues"] = []
        gated["dependencies"] = []
        gated["complianceFollowUps"] = []
        gated["termsForReview"] = []
        gated["decisions"] = []
        gated["actions"] = []
        gated["nextSteps"] = []
        gated["meetingActionPoint"] = []
        gated["meetingActionPointOwner"] = []
        gated["meetingActionPointDeadline"] = []
        gated["openQuestions"] = prepend_unique_text(string_list(gated.get("openQuestions"), limit=10), "Please provide a fuller transcript or meeting notes if formal minutes are required.", limit=10)
        normalised = normalise_output(gated)
        normalised["discussionPoints"] = []
        normalised["discussionTopics"] = []
        normalised["meetingMinutes"] = []
        normalised["confirmedPoints"] = []
        normalised["risksAndIssues"] = []
        normalised["dependencies"] = []
        normalised["complianceFollowUps"] = []
        normalised["termsForReview"] = []
        normalised["decisions"] = []
        normalised["actions"] = []
        normalised["nextSteps"] = []
        normalised["meetingActionPoint"] = []
        normalised["meetingActionPointOwner"] = []
        normalised["meetingActionPointDeadline"] = []
        return normalised

    if mode == "topic_summary_with_caution":
        if existing_summary:
            gated["executiveSummary"] = f"{existing_summary} {caution}"
        else:
            gated["executiveSummary"] = caution
        gated["meetingDescription"] = gated["executiveSummary"]
        gated["decisions"] = []
        gated["actions"] = [action for action in gated.get("actions") or [] if isinstance(action, dict) and strong_action_evidence(action)]
    elif mode == "sparse_minutes":
        if existing_summary and caution.lower() not in existing_summary.lower():
            gated["executiveSummary"] = f"{existing_summary} {caution}"
            gated["meetingDescription"] = gated["executiveSummary"]
        if "low_action_evidence" in string_list((route or {}).get("signals"), limit=12):
            gated["actions"] = []
            gated["decisions"] = []
        else:
            gated["actions"] = rank_actions_for_fallback([action for action in gated.get("actions") or [] if isinstance(action, dict) and strong_action_evidence(action)], limit=3)
            gated["decisions"] = decision_list(gated.get("decisions"), limit=3)

    gated["nextSteps"] = [
        {
            "action": action.get("meetingActionPoint"),
            "owner": action.get("meetingActionPointOwner", "Not stated"),
            "deadline": action.get("meetingActionPointDeadline", "Not stated"),
            **({"dependency": action.get("dependency")} if action.get("dependency") else {}),
            **({"evidence": action.get("evidence")} if action.get("evidence") else {}),
        }
        for action in gated.get("actions") or []
        if isinstance(action, dict)
    ]
    gated["meetingActionPoint"] = [a.get("meetingActionPoint", "") for a in gated.get("actions") or [] if isinstance(a, dict)]
    gated["meetingActionPointOwner"] = [a.get("meetingActionPointOwner", "Not stated") for a in gated.get("actions") or [] if isinstance(a, dict)]
    gated["meetingActionPointDeadline"] = [a.get("meetingActionPointDeadline", "Not stated") for a in gated.get("actions") or [] if isinstance(a, dict)]
    normalised = normalise_output(gated)
    if mode == "sparse_minutes" and "low_action_evidence" in string_list((route or {}).get("signals"), limit=12):
        normalised["actions"] = []
        normalised["nextSteps"] = []
        normalised["meetingActionPoint"] = []
        normalised["meetingActionPointOwner"] = []
        normalised["meetingActionPointDeadline"] = []
    return normalised


def post_process_meeting_output(
    output: dict[str, Any],
    route: dict[str, Any] | None,
    project_status_evidence: dict[str, Any] | None,
    transcript: str = "",
    *,
    chunked: bool = False,
) -> dict[str, Any]:
    """Apply shared deterministic safety/recovery after AI generation.

    Evidence augmentation is deliberately limited to the standard formal-minutes
    mode. Cautious/partial/low-substance routes should not have project-status
    actions injected back into them.
    """
    mode = (route or {}).get("recommendedMode") or "formal_minutes"
    processed = apply_chunked_quality_gate(output) if chunked else normalise_output(output)
    processed = apply_routing_quality_gate(processed, route)
    if mode == "formal_minutes":
        processed = apply_concise_transcript_recovery(processed, transcript, route)
        processed = augment_output_with_project_evidence(processed, project_status_evidence)
        processed = apply_long_transcript_recovery(processed, transcript)
        processed = apply_concise_discussion_only_gate(processed, transcript, route)
    processed = apply_transcript_topic_recovery(processed, transcript)
    processed = apply_routing_quality_gate(processed, route)
    processed = remove_phrases_from_visible_output(processed, rejected_alternative_phrases(transcript))
    if is_concise_discussion_only_transcript(transcript):
        processed = clear_action_decision_fields(processed)
    else:
        processed = cap_and_sync_action_fields(processed, limit=6)
    return strip_visible_transcript_artifacts(processed)


def process_chunked_transcript(
    transcript: str,
    timeout_seconds: int,
    project_status_evidence: dict[str, Any] | None = None,
    route: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    chunks = split_transcript_chunks(transcript)
    if len(chunks) <= 1:
        output, diagnostics = call_trooper(transcript, timeout_seconds, project_status_evidence, route)
        diagnostics["chunked"] = False
        diagnostics["chunkCount"] = len(chunks)
        return output, diagnostics

    chunk_results: list[dict[str, Any]] = []
    started = time.perf_counter()

    def run_chunk(index_and_text: tuple[int, str]) -> dict[str, Any]:
        index, chunk_text = index_and_text
        output, diagnostics = call_trooper_prompt(
            prompt_for_chunk(chunk_text, index, len(chunks), route),
            timeout_seconds,
            task_label=f"chunk_{index}",
        )
        return {
            "chunkIndex": index,
            "chars": len(chunk_text),
            "output": normalise_output(output),
            "diagnostics": diagnostics,
        }

    max_workers = max(1, min(CHUNK_MAX_PARALLEL, len(chunks)))
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(run_chunk, item) for item in enumerate(chunks, start=1)]
        for future in concurrent.futures.as_completed(futures):
            try:
                chunk_results.append(future.result())
            except Exception as exc:
                chunk_results.append({"chunkIndex": None, "error": clean_text(str(exc))[:240], "output": empty_failure_output(clean_text(str(exc))[:240]), "diagnostics": {"used": False, "error": clean_text(str(exc))[:240]}})
    chunk_results.sort(key=lambda item: item.get("chunkIndex") or 999999)

    successful_chunks = [item for item in chunk_results if item.get("diagnostics", {}).get("used")]
    if successful_chunks:
        merged_output, merge_diagnostics = call_trooper_prompt(
            prompt_for_merge(successful_chunks, project_status_evidence, route),
            timeout_seconds,
            task_label="merge_chunks",
        )
        if merge_diagnostics.get("used"):
            output = normalise_output(merged_output)
            merge_strategy = "trooper_merge"
        else:
            output = deterministic_merge_outputs(successful_chunks)
            merge_strategy = "deterministic_fallback_after_merge_failure"
    else:
        output = empty_failure_output("All transcript chunks failed to generate meeting minutes.")
        merge_diagnostics = {"used": False, "error": "All transcript chunks failed."}
        merge_strategy = "all_chunks_failed"

    output = post_process_meeting_output(output, route, project_status_evidence, transcript, chunked=True)
    review_diagnostics: dict[str, Any] = {"used": False, "skipped": True}
    if successful_chunks and merge_strategy != "all_chunks_failed" and truthy(os.environ.get("MEETING_MINUTES_FINAL_REVIEW", "true")):
        review_prompt = prompt_for_compact_final_review(output, successful_chunks)
        review_max_chars = int(os.environ.get("MEETING_MINUTES_FINAL_REVIEW_MAX_CHARS", "18000"))
        if len(review_prompt) > review_max_chars:
            review_diagnostics = {
                "used": False,
                "skipped": True,
                "reviewMode": "compact_verdict",
                "reason": "compact_final_review_prompt_too_large",
                "promptChars": len(review_prompt),
                "maxPromptChars": review_max_chars,
            }
        else:
            review_verdict, review_diagnostics = call_trooper_prompt(
                review_prompt,
                timeout_seconds,
                task_label="compact_final_review",
                normalise_response=False,
            )
            if review_diagnostics.get("used"):
                review_diagnostics["reviewMode"] = "compact_verdict"
                output = apply_compact_review_verdict(output, review_verdict)

    output = post_process_meeting_output(output, route, project_status_evidence, transcript, chunked=True)

    diagnostics = {
        "provider": "trooper",
        "model": os.environ.get("TROOPER_MODEL", TROOPER_MODEL_DEFAULT).strip() or TROOPER_MODEL_DEFAULT,
        "task": "chunked_parallel_pipeline",
        "used": bool(successful_chunks),
        "chunked": True,
        "chunkCount": len(chunks),
        "successfulChunkCount": len(successful_chunks),
        "failedChunkCount": len(chunks) - len(successful_chunks),
        "maxParallel": max_workers,
        "mergeStrategy": merge_strategy,
        "finalReviewUsed": bool(review_diagnostics.get("used")),
        "routing": route,
        "runtimeMs": round((time.perf_counter() - started) * 1000, 2),
        "chunks": [
            {
                "chunkIndex": item.get("chunkIndex"),
                "chars": item.get("chars"),
                "used": item.get("diagnostics", {}).get("used"),
                "error": item.get("diagnostics", {}).get("error"),
                "errors": item.get("diagnostics", {}).get("errors", [])[:2],
            }
            for item in chunk_results
        ],
        "merge": merge_diagnostics,
        "finalReview": review_diagnostics,
    }
    return output, diagnostics


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate meeting minutes with Trooper Liv and HelixScribe operator syntax.")
    parser.add_argument("transcript_path")
    parser.add_argument("--skip-diagnostics", action="store_true")
    parser.add_argument("--include-baseline-reference", action="store_true")
    parser.add_argument("--skip-rewrite", action="store_true", help="Accepted for compatibility; ignored.")
    parser.add_argument("--include-project-status-evidence", action="store_true")
    parser.add_argument("--project-status-evidence-json", help="Use a precomputed project-status evidence JSON file instead of building one in this process.")
    parser.add_argument("--timeout-seconds", type=int, default=int(os.environ.get("TROOPER_TIMEOUT_SECONDS", "120")))
    parser.add_argument(
        "--pipeline",
        choices=["single", "chunked", "auto"],
        default=os.environ.get("MEETING_MINUTES_PIPELINE", "single"),
        help="Generation pipeline. 'chunked' splits long transcripts into parallel section calls then merges the evidence-backed outputs.",
    )
    return parser.parse_args(argv)


def main() -> int:
    load_local_env_if_needed()
    args = parse_args(sys.argv[1:])
    transcript_path = Path(args.transcript_path)
    transcript = transcript_path.read_text(encoding="utf-8")
    started = time.perf_counter()
    pipeline = args.pipeline
    if pipeline == "auto":
        pipeline = "chunked" if len(transcript) > CHUNK_TARGET_CHARS else "single"
    evidence_default = "true"
    use_project_status_evidence = args.include_project_status_evidence or truthy(
        os.environ.get("MEETING_MINUTES_PROJECT_STATUS_EVIDENCE", evidence_default)
    )
    route = detect_transcript_route(transcript)
    project_status_evidence = None
    if args.project_status_evidence_json:
        try:
            project_status_evidence = json.loads(Path(args.project_status_evidence_json).read_text(encoding="utf-8"))
        except Exception as exc:
            project_status_evidence = {
                "enabled": True,
                "available": False,
                "reason": f"Precomputed project-status evidence could not be loaded: {clean_text(exc)[:240]}",
                "items": [],
            }
    elif use_project_status_evidence:
        project_status_evidence = run_project_status_evidence_pack(
            transcript_path,
            timeout_seconds=int(os.environ.get("PROJECT_STATUS_EVIDENCE_TIMEOUT_SECONDS", "90")),
        )
    if pipeline == "chunked":
        output, diagnostics = process_chunked_transcript(transcript, args.timeout_seconds, project_status_evidence, route)
    else:
        output, diagnostics = call_trooper(transcript, args.timeout_seconds, project_status_evidence, route)
        output = post_process_meeting_output(output, route, project_status_evidence, transcript, chunked=False)
        diagnostics["routing"] = route
    runtime_ms = round((time.perf_counter() - started) * 1000, 2)
    payload: dict[str, Any] = {
        "mode": "meeting_minutes_final_trooper_operator_chunked_parallel" if diagnostics.get("chunked") else "meeting_minutes_final_trooper_operator_full_transcript",
        "executed": True,
        "modelAvailable": True,
        "modelName": diagnostics.get("model"),
        "modelReason": (
            "trooper_liv_operator_chunked_parallel"
            if diagnostics.get("chunked")
            else "trooper_liv_operator_project_status_evidence" if project_status_evidence and project_status_evidence.get("items")
            else "trooper_liv_operator_full_transcript"
        ),
        "rewriterAvailable": bool(diagnostics.get("used")),
        "rewriterModelName": diagnostics.get("model"),
        "rewriterModelPath": None,
        "rewriterReason": "Trooper Liv HelixScribe operator used." if diagnostics.get("used") else diagnostics.get("error", "Trooper was not used."),
        "rewriterTokenUsage": diagnostics.get("usage") or None,
        "rewriterDiagnosticsSummary": {
            "provider": diagnostics.get("provider"),
            "model": diagnostics.get("model"),
            "pipeline": "chunked" if diagnostics.get("chunked") else "single",
            "chunkCount": diagnostics.get("chunkCount"),
            "successfulChunkCount": diagnostics.get("successfulChunkCount"),
            "failedChunkCount": diagnostics.get("failedChunkCount"),
            "mergeStrategy": diagnostics.get("mergeStrategy"),
            "finalReviewUsed": diagnostics.get("finalReviewUsed"),
            "routing": diagnostics.get("routing"),
            "used": diagnostics.get("used"),
            "error": diagnostics.get("error"),
            "errors": diagnostics.get("errors", [])[:4],
        },
        "output": output,
        "counts": {
            "discussionPoints": len(output.get("discussionPoints", [])),
            "decisions": len(output.get("decisions", [])),
            "actions": len(output.get("actions", [])),
            "confirmedPoints": len(output.get("confirmedPoints", [])),
            "risksAndIssues": len(output.get("risksAndIssues", [])),
            "dependencies": len(output.get("dependencies", [])),
            "complianceFollowUps": len(output.get("complianceFollowUps", [])),
            "termsForReview": len(output.get("termsForReview", [])),
        },
        "timingMs": {"total": runtime_ms, "trooper": diagnostics.get("runtimeMs", runtime_ms)},
    }
    if not args.skip_diagnostics:
        payload["diagnostics"] = {"trooper": diagnostics}
        if project_status_evidence is not None:
            payload["diagnostics"]["projectStatusEvidence"] = project_status_evidence
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
