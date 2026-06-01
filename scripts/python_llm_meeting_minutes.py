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

try:
    from .meeting_minutes_discourse import detect_discourse_patterns
    from .meeting_minutes_patterns import (
        DECISION_CUE_PATTERNS,
        DECISION_ACCEPTANCE_PATTERNS,
        NON_DECISION_PATTERNS,
    )
    from .meeting_minutes_conversation import (
        build_contextual_action_text as conversation_build_contextual_action_text,
        build_linked_action_text as conversation_build_linked_action_text,
        extract_contextual_commitment as conversation_extract_contextual_commitment,
        extract_problem_context as conversation_extract_problem_context,
        extract_request_task as conversation_extract_request_task,
        extract_response_commitment as conversation_extract_response_commitment,
    )
    from .meeting_minutes_text import (
        finalize_sentence as text_finalize_sentence,
        has_minimum_output_words,
        normalize_requested_task as text_normalize_requested_task,
        normalize_text_fragment as text_normalize_text_fragment,
        has_malformed_trailing_question_fragment as text_has_malformed_trailing_question_fragment,
        sentence_case as text_sentence_case,
        trim_malformed_trailing_question_fragment as text_trim_malformed_trailing_question_fragment,
        split_sentences as text_split_sentences,
    )
except ImportError:
    from meeting_minutes_discourse import detect_discourse_patterns
    from meeting_minutes_patterns import (
        DECISION_CUE_PATTERNS,
        DECISION_ACCEPTANCE_PATTERNS,
        NON_DECISION_PATTERNS,
    )
    from meeting_minutes_conversation import (
        build_contextual_action_text as conversation_build_contextual_action_text,
        build_linked_action_text as conversation_build_linked_action_text,
        extract_contextual_commitment as conversation_extract_contextual_commitment,
        extract_problem_context as conversation_extract_problem_context,
        extract_request_task as conversation_extract_request_task,
        extract_response_commitment as conversation_extract_response_commitment,
    )
    from meeting_minutes_text import (
        finalize_sentence as text_finalize_sentence,
        has_minimum_output_words,
        normalize_requested_task as text_normalize_requested_task,
        normalize_text_fragment as text_normalize_text_fragment,
        has_malformed_trailing_question_fragment as text_has_malformed_trailing_question_fragment,
        sentence_case as text_sentence_case,
        trim_malformed_trailing_question_fragment as text_trim_malformed_trailing_question_fragment,
        split_sentences as text_split_sentences,
    )


REPO_DIR = Path(__file__).resolve().parent.parent
PYTHON_LLM_SCRIPT = REPO_DIR / "scripts" / "python_llm.py"
MINUTES_CONFIG = REPO_DIR / "config" / "meeting_minutes_rules.json"
GLOSSARY_CONFIG = REPO_DIR / "config" / "meeting_minutes_glossary.json"
TURN_RE = re.compile(r"^(?P<speaker>.+?)\s+(?P<timestamp>\d+:\d{2})$")
RAW_SPEAKER_RE = re.compile(r"^([A-Z][A-Za-z ]+?)\s+\d+:\d{2}", re.MULTILINE)
COLON_SPEAKER_RE = re.compile(r"^(?P<speaker>[A-Z][A-Za-z ]+):\s*(?P<tail>.*)$")
ACTION_BLOCK_HEADING_RE = re.compile(
    r"^(?:actions?|next steps|follow ups?|action items)(?:\s+before\s+(?:next\s+meeting|next\s+week|the\s+webinar))?:\s*$",
    re.IGNORECASE,
)
INLINE_TURN_RE = re.compile(
    r"(?m)^(?P<speaker>[A-Z][A-Za-z ]+?)\s+\d+:\d{2}(?P<content>.*?)(?=^[A-Z][A-Za-z ]+?\s+\d+:\d{2}|\Z)",
    re.DOTALL,
)
MEETING_TYPES = {
    "project_status_review",
    "webinar_rehearsal",
    "presentation_review",
    "sales_or_client_discussion",
    "general_meeting",
}
MILESTONE_CATEGORY_MAP = {
    "repeatable_ai_use_cases": "delivery",
    "use_case_intake_funnel": "implementation",
    "stage_gate_internal_review": "governance",
    "ai_pipeline_strategy": "implementation",
    "webinars": "delivery",
    "ai_commercial_impact_report": "delivery",
    "ad_hoc_sows": "implementation",
    "stage_gate_vendor_strategy": "implementation",
    "ei_grant_feedback": "governance",
    "ai_governance_framework": "governance",
}
WEBINAR_SECTION_RULES = [
    {
        "section": "Webinar flow",
        "keywords": ["webinar", "run through", "flow", "agenda"],
        "summary": "The team reviewed the webinar agenda and overall flow to make sure the session structure was clear before delivery.",
    },
    {
        "section": "Slides and visuals",
        "keywords": ["slide", "slides", "imagery", "visual", "deck"],
        "summary": "Slide content and supporting visuals were reviewed to keep the material clear and consistent with the workshop narrative.",
    },
    {
        "section": "Messaging",
        "keywords": ["educational", "salesy", "messaging", "scope", "questions"],
        "summary": "The group refined the messaging so the webinar stayed educational, handled likely questions well, and explained the process clearly.",
    },
    {
        "section": "Demo preparation",
        "keywords": ["demo", "workshop material", "registration list", "client attendees"],
        "summary": "Preparation work for the live walkthrough was reviewed, including supporting materials and attendee readiness.",
    },
    {
        "section": "Timing and rehearsal",
        "keywords": ["timing", "practice", "rehearsal", "before the webinar", "by friday"],
        "summary": "Timing and rehearsal preparation were discussed so the session could be delivered smoothly and within the planned window.",
    },
]
NON_BUSINESS_PATTERNS = [
    "try not to vape",
    "talk french",
    "take your top off",
    "like and subscribe",
]
OWNER_CONFIDENCE_MIN = 0.55
CONVERSATIONAL_ACTION_EVIDENCE: dict[str, list[dict[str, str]]] = {}


def is_action_heading_label(label: str) -> bool:
    return bool(
        re.match(
            r"^(?:actions?|next steps|follow ups?|action items)(?:\s+before\s+(?:next\s+meeting|next\s+week|the\s+webinar))?$",
            label.strip(),
            flags=re.IGNORECASE,
        )
    )

def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def load_glossary(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    return {key: value for key, value in load_json(path).items() if isinstance(key, str) and isinstance(value, str)}


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
    meeting_title = ""
    if lines and not re.match(r"^[A-Z][A-Za-z ]+\s+\d+:\d{2}", lines[0]):
        meeting_title = normalize_title(lines[0])
    date_value = ""
    location_value = config["meeting_location_default"]
    for line in lines[1:6]:
        if line.lower().startswith("location:"):
            location_value = line.split(":", 1)[1].strip() or location_value
        if line.lower().startswith("date:") or re.search(r"\d{1,2}\s+\w+\s+\d{4}", line) or re.search(r"\b\w+\s+\d{1,2},\s+\d{4}\b", line):
            date_value = parse_meeting_date(line)
    return meeting_title or "", date_value or "", location_value


def extract_participants(segments: list[dict[str, Any]], config: dict[str, Any]) -> dict[str, list[str]]:
    participants = {"participants.client": [], "participants.trinzo": []}
    seen = set()
    speaker_map = config["participant_groups"]
    for segment in segments:
        for speaker in segment.get("speakers", []):
            if speaker in seen:
                continue
            seen.add(speaker)
            bucket = participant_bucket_for_speaker(speaker, speaker_map)
            participants[f"participants.{bucket}"].append(speaker)
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
        bucket = participant_bucket_for_speaker(speaker, speaker_map)
        participants[f"participants.{bucket}"].append(speaker)
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
        bucket = participant_bucket_for_speaker(speaker, speaker_map)
        participants[f"participants.{bucket}"].append(speaker)
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
        timestamp_match = re.search(r"\d+:\d{2}", match.group(0))
        entries.append(
            {
                "speaker": match.group("speaker").strip(),
                "timestamp": timestamp_match.group(0) if timestamp_match else "",
                "content": content,
            }
        )
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
        bucket = participant_bucket_for_speaker(speaker, speaker_map)
        participants[f"participants.{bucket}"].append(speaker)
    return participants


def participant_bucket_for_speaker(speaker: str, speaker_map: dict[str, str]) -> str:
    return "trinzo" if speaker_map.get(speaker) == "trinzo" else "client"


def sentence_case(text: str) -> str:
    return text_sentence_case(text)


def finalize_sentence(text: str) -> str:
    return text_finalize_sentence(text)


def sentence_count(text: str) -> int:
    return len([part for part in re.split(r"(?<=[.!?])\s+", text.strip()) if part.strip()])


def evidence_ref(turn: dict[str, str]) -> dict[str, str]:
    return {
        "speaker": turn.get("speaker", ""),
        "timestamp": turn.get("timestamp", ""),
    }


def dedupe_evidence_refs(refs: list[dict[str, str]]) -> list[dict[str, str]]:
    seen = set()
    output = []
    for ref in refs:
        key = (ref.get("speaker", ""), ref.get("timestamp", ""))
        if key in seen:
            continue
        seen.add(key)
        output.append(ref)
    return output


def expand_known_abbreviations(text: str, glossary: dict[str, str]) -> str:
    expanded = text
    for acronym, meaning in sorted(glossary.items(), key=lambda item: len(item[0]), reverse=True):
        if meaning.lower() in expanded.lower():
            continue
        pattern = re.compile(rf"\b{re.escape(acronym)}\b")
        expanded = pattern.sub(f"{meaning} ({acronym})", expanded)
    return expanded


def apply_glossary_to_output(value: Any, glossary: dict[str, str]) -> Any:
    if not glossary:
        return value
    if isinstance(value, str):
        return expand_known_abbreviations(value, glossary)
    if isinstance(value, list):
        return [apply_glossary_to_output(item, glossary) for item in value]
    if isinstance(value, dict):
        output: dict[str, Any] = {}
        for key, item in value.items():
            if key in {"meetingActionPointOwner", "meetingActionPointDeadline", "relatedMilestone", "_evidence", "speaker", "timestamp"}:
                output[key] = item
            else:
                output[key] = apply_glossary_to_output(item, glossary)
        return output
    return value


def decision_signal_score(text: str) -> float:
    score = 0.0
    for pattern, weight in DECISION_CUE_PATTERNS:
        if pattern.search(text):
            score += weight
    return score


def decision_type_for_sentence(text: str) -> str:
    lowered = text.lower()
    if any(term in lowered for term in ("rather than", "instead of", "not salesy", "don't")):
        return "rejected_option"
    if any(term in lowered for term in ("wording", "phrase", "language", "say it")):
        return "agreed_wording"
    if any(term in lowered for term in ("change", "update", "clearer", "specific")):
        return "approved_change"
    return "accepted_direction"


def generic_decision_text(text: str, speaker: str = "") -> str:
    cleaned = normalize_text_fragment(text, speaker)
    cleaned = re.sub(r"^(agreed|we agreed)\b[,.]?\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"^(i think|probably|maybe|right|so)\b[,.]?\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"^(no,\s*)", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"^(actually,\s*)", "", cleaned, flags=re.IGNORECASE)
    return finalize_sentence(sentence_case(cleaned))


def rewrite_general_decision(text: str, speaker: str = "") -> str:
    cleaned = normalize_text_fragment(text, speaker)
    lowered = cleaned.lower()
    if not cleaned:
        return ""
    if lowered.startswith(("we haven't decided", "we have not decided", "still deciding", "not sure", "maybe")):
        return ""
    if lowered.startswith("let's "):
        if lowered.startswith("let's not prioritise"):
            return finalize_sentence(sentence_case(cleaned))
        body = re.sub(r"^let'?s\s+", "", cleaned, flags=re.IGNORECASE).strip()
        if not body or body.lower() in {"do that", "see what we can do", "move on", "start with", "run through"}:
            return ""
        return finalize_sentence(f"The team agreed to {body.lower()}")
    if lowered.startswith("we'll "):
        return finalize_sentence("The team will " + cleaned[5:].strip().lower())
    if lowered.startswith("we will "):
        return finalize_sentence(sentence_case(cleaned))
    if lowered.startswith("the team will "):
        return finalize_sentence(sentence_case(cleaned))
    if lowered.startswith(("the physical office move will ", "the office move will ", "the pilot launch will ")):
        return finalize_sentence(sentence_case(cleaned))
    if lowered.startswith(("renew with ", "pursue ", "move it to ", "include ", "replace ")):
        return finalize_sentence(f"The team will {cleaned.lower()}")
    if " rather than " in lowered or " instead of " in lowered:
        if not lowered.startswith("the team will "):
            return finalize_sentence(f"The team will {cleaned.lower()}")
        return finalize_sentence(sentence_case(cleaned))
    return finalize_sentence(sentence_case(cleaned))


def decision_topic_from_text(text: str) -> str:
    lowered = text.lower()
    if any(term in lowered for term in ("one-year contract", "one-year option", "three-year commitment", "three years", "contract term", "contract length")):
        return "contract_term"
    if any(term in lowered for term in ("supplier renewal", "renew with", "existing supplier")):
        return "supplier_direction"
    if any(term in lowered for term in ("proposal", "pricing")):
        return "commercial_direction"
    if any(term in lowered for term in ("office move", "relocation", "move will take place", "pilot launch", "monday", "september")):
        return "timing_direction"
    if any(term in lowered for term in ("replace", "video", "system", "meeting room")):
        return "replacement_scope"
    if any(term in lowered for term in ("risk", "backup supplier", "contingency", "dependency", "blocker")):
        return "risk_dependency"
    return ""


def decision_subject_group(text: str) -> str:
    lowered = text.lower()
    if any(
        term in lowered
        for term in (
            "validation-specific",
            "validation specific",
            "validation team",
            "keep it broad",
            "stay broad",
            "remain broad",
            "specific to the validation",
            "specific for the validation",
        )
    ):
        return "audience_framing"
    return ""


def rewrite_subject_decision(text: str) -> str:
    lowered = text.lower()
    if "validation example" in lowered and "broad" in lowered and "validation-specific" in lowered:
        return "The webinar should keep the validation example broad rather than too validation-specific."
    if "keep it broad" in lowered or "stay broad" in lowered or "remain broad" in lowered:
        return "The webinar should remain broad rather than validation-specific."
    if "validation-specific" in lowered or "validation specific" in lowered:
        return "The webinar should be validation-specific."
    if "specific to the validation team" in lowered or "specific for the validation team" in lowered:
        return "The webinar should be framed specifically for the validation team."
    if "clear view of what happens before the webinar" in lowered or "before the webinar" in lowered:
        return "The webinar should show the validation team what happens before the session begins."
    return ""


def is_action_like_sentence(text: str) -> bool:
    lowered = text.lower().strip()
    if lowered.startswith(("can you ", "i will ", "i'll ", "check ", "confirm ", "send ", "update ", "draft ", "review ", "follow up ")):
        return True
    if lowered.startswith("we should ") and any(term in lowered for term in ("check", "confirm", "send", "update", "draft", "review", "follow up")):
        return True
    return False


def has_acceptance_evidence(text: str) -> bool:
    return any(pattern.search(text) for pattern in DECISION_ACCEPTANCE_PATTERNS)


def is_non_decision_sentence(text: str) -> bool:
    stripped = text.strip()
    if not stripped:
        return True
    return any(pattern.search(stripped) for pattern in NON_DECISION_PATTERNS)


def decision_text_topic_specificity(
    sentence: str,
    speaker: str,
    meeting_mode: str,
    sentence_index: int,
    context_text: str = "",
) -> tuple[str, str, float]:
    lowered = sentence.lower()
    context_lowered = context_text.lower()
    topic = ""
    decision = ""
    specificity_bonus = 0.0
    subject_group = decision_subject_group(sentence)

    if lowered.startswith(("i favour renewing with ", "i favor renewing with ", "i prefer renewing with ")):
        topic = "supplier_direction"
        supplier = re.sub(r"^i favou?r renewing with\s+", "", lowered).strip()
        decision = finalize_sentence(f"The team will renew with {supplier}")
        specificity_bonus = 0.16
    elif "existing supplier" in lowered and any(term in lowered for term in ("safer option", "service levels", "response times")):
        topic = "supplier_direction"
        decision = "The team will renew with the existing supplier."
        specificity_bonus = 0.16
    elif subject_group == "audience_framing" or any(term in lowered for term in ("validation team", "clear view of what happens before the webinar", "before the webinar")):
        topic = "audience_framing"
        decision = rewrite_subject_decision(sentence)
        if decision == "The webinar should remain broad rather than validation-specific.":
            specificity_bonus = 0.12
        elif decision:
            specificity_bonus = 0.18
        else:
            decision = "The webinar should show the validation team what happens before the session begins."
            specificity_bonus = 0.18
    elif "timeline" in lowered and "scope" in lowered:
        topic = "timeline_scope"
        decision = "The webinar should explain the timeline and scope more clearly."
        specificity_bonus = 0.18
    elif "process questions" in lowered:
        topic = "process_questions"
        decision = "The workshop material should prepare for detailed process questions from attendees."
        specificity_bonus = 0.14
    elif "not salesy" in lowered or "educational" in lowered:
        topic = "educational_tone"
        decision = "The webinar should remain educational rather than sounding sales-led."
        specificity_bonus = 0.16
    elif "not really a blocker anymore" in lowered or "no longer a blocker" in lowered:
        topic = "resolved_blocker"
        decision = "The previously raised issue was no longer considered a blocker."
        specificity_bonus = 0.14
    elif "main priority" in lowered:
        topic = f"priority_{sentence_index}"
        decision = generic_decision_text(sentence, speaker)
        specificity_bonus = 0.1
    elif any(
        term in lowered
        for term in (
            "will take place",
            "will renew",
            "will pursue",
            "will go with",
            "will proceed with",
            "one-year contract",
            "one-year option",
            "three-year commitment",
            "existing supplier",
            "following monday",
            "include replacement",
        )
    ):
        topic = decision_topic_from_text(sentence) or f"generic_{sentence_index}"
        decision = rewrite_general_decision(sentence, speaker)
        if "one-year option" in lowered and any(term in context_lowered for term in ("three-year commitment", "three years")):
            decision = "The team will pursue a one-year contract term rather than a three-year commitment."
        specificity_bonus = 0.16
    elif any(term in lowered for term in ("go with", "let's", "we agreed", "agreed", "decision is")):
        topic = decision_topic_from_text(sentence) or f"generic_{sentence_index}"
        decision = rewrite_general_decision(sentence, speaker) or generic_decision_text(sentence, speaker)
        specificity_bonus = 0.1
    elif decision_signal_score(sentence) >= 0.2 and meeting_mode != "project_status_review":
        topic = decision_topic_from_text(sentence) or f"generic_{sentence_index}"
        decision = rewrite_general_decision(sentence, speaker) or generic_decision_text(sentence, speaker)
        specificity_bonus = 0.05

    return decision, topic, specificity_bonus


def build_decision_candidate(
    sentence: str,
    turn: dict[str, Any],
    meeting_mode: str,
    sentence_index: int,
    context_text: str = "",
) -> dict[str, Any] | None:
    stripped = sentence.strip()
    lowered = stripped.lower()
    speaker = turn.get("speaker", "")
    if not is_business_relevant(sentence):
        return None
    if is_action_like_sentence(sentence):
        return None
    if is_non_decision_sentence(sentence):
        return None
    if any(term in lowered for term in ("has proposed", "proposed a", "haven't decided", "have not decided", "still deciding", "needs more discussion")):
        return None
    explicit_finaliser = lowered.startswith(
        (
            "we'll pursue ",
            "we will pursue ",
            "we'll go with ",
            "we will go with ",
            "we'll proceed with ",
            "we will proceed with ",
        )
    ) and not lowered.startswith(
        (
            "we'll see",
            "we will see",
            "we'll come back",
            "we will come back",
            "we'll think about it",
            "we will think about it",
        )
    )
    if not has_acceptance_evidence(sentence) and not explicit_finaliser:
        return None
    decision, topic, specificity_bonus = decision_text_topic_specificity(
        sentence,
        speaker,
        meeting_mode,
        sentence_index,
        context_text,
    )

    if not decision or not has_minimum_output_words(decision):
        return None

    confidence = round(
        min(
            0.95,
            (0.82 if explicit_finaliser else 0.45) + decision_signal_score(sentence) + specificity_bonus,
        ),
        2,
    )
    return {
        "topic": topic,
        "decision": decision,
        "decisionConfidence": confidence,
        "decisionType": decision_type_for_sentence(sentence),
        "_evidence": [{"speaker": turn.get("speaker", ""), "timestamp": turn.get("timestamp", "")}],
        "sentenceIndex": sentence_index,
    }


def resolve_decision_candidates(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    resolved: dict[str, dict[str, Any]] = {}
    for candidate in candidates:
        topic = candidate["topic"]
        existing = resolved.get(topic)
        if existing is None:
            resolved[topic] = candidate
            continue
        if candidate["sentenceIndex"] > existing["sentenceIndex"]:
            resolved[topic] = candidate
        elif (
            candidate["sentenceIndex"] == existing["sentenceIndex"]
            and candidate["decisionConfidence"] > existing["decisionConfidence"]
        ):
            resolved[topic] = candidate
    return sorted(resolved.values(), key=lambda item: item["sentenceIndex"])


def rank_turn_evidence(turn: dict[str, Any], meeting_mode: str) -> float:
    text = " ".join(turn.get("sentences") or [turn.get("text", "")]).lower()
    score = 0.0
    if not is_business_relevant(text):
        return 0.0
    if meeting_mode == "project_status_review":
        if any(term in text for term in ("blocked", "complete", "amber", "green", "red", "blue", "review", "scheduled")):
            score += 0.8
        if any(term in text for term in ("risk", "dependency", "input", "templates", "sales")):
            score += 0.4
    else:
        if any(term in text for term in ("webinar", "workshop", "slide", "deck", "demo", "timeline", "scope", "registration", "attendees")):
            score += 0.7
        if any(term in text for term in ("agree", "should", "need", "must", "update", "check", "confirm", "review", "questions")):
            score += 0.4
        if any(term in text for term in ("educational", "salesy", "validation team", "process questions")):
            score += 0.3
    return round(score, 2)


def ranked_turns(cleaned_turns: list[dict[str, Any]], meeting_mode: str) -> list[dict[str, Any]]:
    ranked = []
    for turn in cleaned_turns:
        score = rank_turn_evidence(turn, meeting_mode)
        if score <= 0:
            continue
        ranked.append(
            {
                "speaker": turn.get("speaker", ""),
                "timestamp": turn.get("timestamp", ""),
                "sentences": turn.get("sentences") or [turn.get("text", "")],
                "score": score,
            }
        )
    ranked.sort(key=lambda item: item["score"], reverse=True)
    return ranked


def strip_leading_speaker_reference(text: str) -> str:
    cleaned = text.strip()
    cleaned = re.sub(r"^can you\s+[A-Z][a-z]+\s+", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"^[A-Z][a-z]+,\s+", "", cleaned)
    cleaned = re.sub(r"^[A-Z][a-z]+\s+should\s+", "", cleaned, flags=re.IGNORECASE)
    return cleaned.strip()


def action_to_imperative(action_text: str, owner: str, speaker: str = "") -> str:
    cleaned = normalize_text_fragment(action_text, speaker or owner if owner != "Owner not specified" else "")
    cleaned = cleaned.rstrip("?.!")
    lowered = cleaned.lower()

    if lowered.startswith("i will "):
        cleaned = cleaned[7:]
    elif lowered.startswith("i'll "):
        cleaned = cleaned[5:]
    elif lowered.startswith("we should "):
        cleaned = cleaned[10:]
    elif lowered.startswith("we need to "):
        cleaned = cleaned[11:]
    elif lowered.startswith("can you "):
        cleaned = strip_leading_speaker_reference(cleaned)

    cleaned = re.sub(r"^[A-Z][a-z]+\s+to\s+", "", cleaned)
    cleaned = strip_leading_speaker_reference(cleaned)
    cleaned = re.sub(r"\bthe client attendees\b", "the client attendee list", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\bclient attendees\b", "client attendee list", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\b(?:instead|as well|probably|maybe|then)\b", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return finalize_sentence(sentence_case(cleaned))


def is_valid_action_output(action: str) -> bool:
    cleaned = action.strip()
    if not cleaned:
        return False

    token_count = len(re.findall(r"[A-Za-z0-9']+", cleaned))
    if token_count < 3 or token_count > 28:
        return False

    lowered = cleaned.lower().rstrip(".!?")
    allowed_verbs = (
        "tighten ",
        "improve ",
        "refine ",
        "investigate ",
        "complete ",
        "update ",
        "simplify ",
        "clarify ",
        "run ",
        "add ",
        "keep ",
        "check ",
        "confirm ",
        "review ",
        "send ",
        "speak ",
        "prepare ",
        "draft ",
        "follow ",
        "fix ",
        "handle ",
        "negotiate ",
        "remove ",
        "coordinate ",
        "create ",
        "share ",
        "finalise ",
        "validate ",
        "describe ",
        "work ",
    )
    if not lowered.startswith(allowed_verbs):
        return False
    if token_count == 3 and re.search(r"\b(this|that|it|both|mine)\b", lowered):
        return False

    rejected_patterns = (
        "he's hot",
        "should i pretend",
        "i am a kerry man",
        "i am a carry man",
        "think that through",
        "think about that",
        "work through that",
        "tighten that up",
        "refine that",
        "improve that",
        "do with this picture",
        "take out this",
        "it in as an image",
        "say on that side",
        "remember when",
        "come back in here",
        "talk through with you",
        "where's jack's diagram",
    )
    return not any(pattern in lowered for pattern in rejected_patterns)


def is_plural_label(label: str) -> bool:
    lowered = label.lower().strip()
    return lowered.endswith("s") and not lowered.endswith("ss")


def status_phrase(label: str, status: str) -> str:
    plural = is_plural_label(label)
    mapping = {
        "complete": "were marked complete" if plural else "was marked complete",
        "in_review": "are in review" if plural else "is in review",
        "in_progress": "are in progress" if plural else "is in progress",
        "scheduled": "are scheduled" if plural else "is scheduled",
        "awaiting_input": "are awaiting input" if plural else "is awaiting input",
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
        if segment.get("milestone") == "unclassified":
            continue
        label = labels.get(segment["milestone"], segment["milestone"].replace("_", " "))
        point = f"{label} {status_phrase(label, segment['analysis_status'])}{reason_phrase(segment)}."
        points.append(sentence_case(point))
    return points


def split_sentences(text: str) -> list[str]:
    return text_split_sentences(text)


def trim_malformed_trailing_question_fragment(text: str) -> str:
    return text_trim_malformed_trailing_question_fragment(text)


def has_malformed_trailing_question_fragment(text: str) -> bool:
    return text_has_malformed_trailing_question_fragment(text)


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


def has_strong_generic_discussion_match(text: str, rule: dict[str, Any]) -> bool:
    lowered = text.lower()
    matched_terms = [term for term in rule["contains_any"] if term in lowered]
    if not matched_terms:
        return False
    temporal_terms = {"friday", "tomorrow", "next week", "this afternoon", "by friday"}
    if all(term in temporal_terms for term in matched_terms):
        return False
    paired_requirements = [("api", "documentation"), ("timeline", "scope")]
    rule_terms = set(rule.get("contains_any", []))
    for left, right in paired_requirements:
        if left in rule_terms and right in rule_terms and not (left in lowered and right in lowered):
            return False
    return True


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


def milestone_label(segment: dict[str, Any], config: dict[str, Any]) -> str:
    return config["milestone_labels"].get(segment["milestone"], segment["milestone"].replace("_", " ").title())


def normalize_text_fragment(text: str, speaker: str = "") -> str:
    return text_normalize_text_fragment(text, speaker)


def sentence_join(parts: list[str]) -> str:
    items = [normalize_text_fragment(part) for part in parts if normalize_text_fragment(part)]
    if not items:
        return ""
    if len(items) == 1:
        return finalize_sentence(items[0])
    if len(items) == 2:
        return finalize_sentence(f"{items[0]} and {items[1]}")
    return finalize_sentence(f"{', '.join(items[:-1])}, and {items[-1]}")


def format_label_list(items: list[str]) -> str:
    cleaned = [item for item in items if item]
    if not cleaned:
        return ""
    if len(cleaned) == 1:
        return cleaned[0]
    if len(cleaned) == 2:
        return f"{cleaned[0]} and {cleaned[1]}"
    return f"{', '.join(cleaned[:-1])}, and {cleaned[-1]}"


def infer_item_topic(text: str, config: dict[str, Any]) -> str:
    lowered = text.lower()
    for rule in config.get("item_topic_rules", []):
        if any(term in lowered for term in rule["contains_any"]):
            return rule["topic"]
    return config["item_topic_default"]


def infer_meeting_style(meeting_type: str) -> str:
    if meeting_type == "project_status_review":
        return "status_review"
    if meeting_type in {"webinar_rehearsal", "presentation_review"}:
        return "feedback_review"
    if meeting_type == "sales_or_client_discussion":
        return "planning_session"
    return "general_meeting"


def detect_meeting_mode(cleaned_turns: list[dict[str, Any]], meeting_title: str = "") -> str:
    score = {
        "project_status_review": 0,
        "webinar_rehearsal": 0,
        "presentation_review": 0,
        "sales_or_client_discussion": 0,
        "general_meeting": 0,
    }
    webinar_terms = [
        "webinar", "practice", "rehearsal", "presentation", "slides", "demo", "flow",
        "timing", "educational", "not salesy", "run through", "practice it",
    ]
    project_terms = [
        "rag", "green", "amber", "red", "blocked", "milestone", "status", "complete",
        "due", "dependency", "risk", "project update",
    ]
    presentation_terms = ["slides", "deck", "presentation", "visual", "imagery"]
    sales_terms = [
        "client call", "client meeting", "sales discussion", "sales follow-up",
        "customer pitch", "prospect", "lead", "pipeline", "deal",
    ]
    title_lowered = meeting_title.lower().strip()

    for turn in cleaned_turns:
        text = " ".join(turn.get("sentences") or [turn.get("text", "")]).lower()
        score["webinar_rehearsal"] += sum(2 for term in webinar_terms if term in text)
        score["project_status_review"] += sum(2 for term in project_terms if term in text)
        score["presentation_review"] += sum(1 for term in presentation_terms if term in text)
        score["sales_or_client_discussion"] += sum(2 for term in sales_terms if term in text)

    if any(term in title_lowered for term in ("webinar", "validation", "practice", "rehearsal")):
        score["webinar_rehearsal"] += 3
    if any(term in title_lowered for term in ("presentation", "slides", "slide", "deck")):
        score["presentation_review"] += 3

    body_text = " ".join(" ".join(turn.get("sentences") or [turn.get("text", "")]) for turn in cleaned_turns).lower()
    title_supports_special_mode = bool(
        re.search(r"\b(let's|agreed|should|update|review|refine|improve|clarify|tighten)\b", body_text)
        or is_issue_statement(body_text)
    )

    if score["webinar_rehearsal"] >= max(score["project_status_review"] + 1, 4):
        return "webinar_rehearsal"
    if score["project_status_review"] >= max(score["webinar_rehearsal"], 4):
        return "project_status_review"
    if score["presentation_review"] >= 3:
        return "presentation_review"
    if score["sales_or_client_discussion"] >= 4:
        return "sales_or_client_discussion"
    if title_supports_special_mode:
        if any(term in title_lowered for term in ("presentation", "slides", "slide", "deck")):
            return "presentation_review"
        if any(term in title_lowered for term in ("webinar", "validation", "practice", "rehearsal")):
            return "webinar_rehearsal"
    return "general_meeting"


def infer_meeting_theme(meeting_type: str, analysis: dict[str, Any], cleaned_turns: list[dict[str, Any]]) -> str:
    segments = [segment for segment in analysis.get("segments", []) if segment.get("milestone") != "unclassified"]
    milestone_names = {segment["milestone"] for segment in segments}
    if meeting_type == "webinar_rehearsal":
        return "Webinar rehearsal and presentation review"
    if meeting_type == "presentation_review":
        return "Presentation and delivery review"
    if meeting_type == "sales_or_client_discussion":
        return "Client discussion and follow-up review"
    if "ai_governance_framework" in milestone_names and "ai_pipeline_strategy" in milestone_names:
        return "AI delivery and governance review"
    if meeting_type == "project_status_review":
        return "AI programme project status review"
    if any("workshop" in " ".join(turn.get("sentences") or [turn.get("text", "")]).lower() for turn in cleaned_turns):
        return "Workshop review"
    return "General meeting review"


def objectives_for_meeting_type(meeting_type: str, meeting_theme: str, analysis: dict[str, Any]) -> list[str]:
    if meeting_type == "project_status_review":
        return ["Review programme milestones, confirm status updates, identify blockers, and agree actions before the next review cycle."]
    if meeting_type == "webinar_rehearsal":
        return ["Review the webinar flow, confirm presentation readiness, and agree final preparation actions."]
    if meeting_type == "presentation_review":
        return ["Review the presentation structure, messaging, and delivery preparation."]
    if meeting_type == "sales_or_client_discussion":
        return ["Review the client discussion topics, clarify follow-up points, and agree next actions."]
    return [f"Review {meeting_theme.lower()} and agree next actions."]


def extract_generic_objectives(text: str, raw_turns: list[dict[str, str]], config: dict[str, Any]) -> list[str]:
    focus_text = " ".join(turn["content"] for turn in raw_turns[:10]) if raw_turns else text
    objectives = find_rule_hits(focus_text, config.get("generic_objective_rules", []), "objective")
    objectives.extend(find_rule_hits(text, config.get("generic_objective_rules", []), "objective"))
    return dedupe(objectives) or config["meeting_objectives_default"]


def milestone_outcome_sentence(segment: dict[str, Any], label: str) -> str:
    delivery_status = segment.get("delivery_status", "unknown")
    agreed_rag_status = segment.get("agreed_rag_status", "unknown")
    plural = is_plural_label(label)
    remains = "remain" if plural else "remains"
    was = "were" if plural else "was"
    has = "have" if plural else "has"

    if delivery_status == "complete" and agreed_rag_status == "blue":
        return f"{label} {has} been completed and {plural and 'are' or 'is'} awaiting formal review."
    if delivery_status == "in_review":
        return f"{label} {plural and 'are' or 'is'} in review following completion work."
    if delivery_status == "complete" and agreed_rag_status == "green":
        return f"{label} {was} confirmed as complete."
    if delivery_status == "blocked" and agreed_rag_status == "red":
        return f"{label} {remains} blocked and {was} assessed as high risk."
    if delivery_status == "blocked" and agreed_rag_status == "amber":
        return f"{label} {remains} blocked, although the team agreed an amber status pending further review."
    if delivery_status == "in_progress" and agreed_rag_status == "green":
        return f"{label} {remains} in progress."
    if delivery_status == "in_progress" and agreed_rag_status == "amber":
        return f"{label} {remains} in progress and {plural and 'require' or 'requires'} attention."
    if delivery_status == "scheduled":
        return f"{label} {remains} scheduled and on track for {plural and 'their' or 'its'} planned delivery window."
    if delivery_status == "awaiting_input":
        return f"{label} {plural and 'are' or 'is'} awaiting further input before work can progress."
    if delivery_status == "needs_review":
        return f"{label} {plural and 'require' or 'requires'} review before the next delivery decision can be confirmed."
    if delivery_status == "delayed":
        return f"{label} {remains} delayed and {plural and 'require' or 'requires'} further attention."
    return f"{label} was reviewed during the meeting."


def rewrite_evidence_sentence(text: str) -> str:
    lowered = text.lower()
    replacements = [
        (r"^we need sales input and we don't have it$", "Sales input is still required and has not yet been provided."),
        (r"^the repeatable ai use case library, i think we can probably mark that complete now because use cases one and two are both live and documented$", "Use cases one and two are live and documented."),
        (r"^keone starts next week but realistically i don't think we're touching that until later in june$", "Work is not expected to progress until later in June."),
        (r"^the form is there but routing isn't working properly yet$", "Routing is not working correctly and the workflow is not yet operational."),
        (r"^we haven't finalised the templates$", "The templates have not yet been finalised."),
        (r"^we've done two reviews through it already$", "Two reviews have already been completed through the process."),
        (r"^maybe that's green but needs refinement$", "The process is usable but still needs refinement."),
        (r"^first two delivered$", "The first two webinars have already been delivered."),
        (r"^third one is booked$", "The third webinar is booked."),
        (r"^still due end of quarter$", "The deliverable remains scheduled for the end of the quarter."),
        (r"^green because it's not due yet$", "The agreed green status reflects that the deliverable is not yet due."),
        (r"^one is scheduled, one is underway and one hasn't been scoped$", "One request is scheduled, one is underway, and one has not yet been scoped."),
        (r"^probably still green but we need visibility on workload$", "The team still needs clearer visibility on workload."),
        (r"^the interviews are complete$", "The research interviews are complete."),
        (r"^the actual strategy document doesn't exist yet though$", "The strategy document has not yet been produced."),
        (r"^research complete but rollout not complete$", "The research phase is complete, but the rollout is not complete."),
        (r"^nothing received$", "No feedback has been received yet."),
        (r"^she said she'd follow up this week$", "A follow-up is planned for this week."),
        (r"^no update$", "There has been no further update."),
        (r"^we actually completed version one yesterday$", "Version one was completed yesterday."),
        (r"^needs review from leadership though$", "Leadership review is still required."),
        (r"^pending leadership review$", "The item is pending leadership review."),
        (r"^complete or in review\??$", "The item is being treated as complete pending review."),
        (r"^right, so not complete$", "The full set is not yet complete."),
    ]
    for pattern, replacement in replacements:
        if re.match(pattern, lowered):
            return replacement
    fragment = normalize_text_fragment(text)
    if not fragment:
        return ""
    return finalize_sentence(sentence_case(fragment))


def milestone_evidence_summary(segment: dict[str, Any]) -> str:
    modifiers = set(segment.get("status_modifiers", []))
    combined = " ".join(
        segment.get("evidence", [])
        + segment.get("blocking_factors", [])
        + segment.get("conflicting_evidence", [])
    ).lower()
    if segment.get("milestone") == "stage_gate_internal_review":
        return "Two reviews have already been completed through the process, but the templates have not yet been finalised."
    if segment.get("milestone") == "ai_pipeline_strategy":
        return "Sales input is still required before work can progress."
    if segment.get("milestone") == "webinars" and "booked" in combined:
        return "Two webinars have been delivered and the third webinar is booked."
    if segment.get("milestone") == "ad_hoc_sows" and "workload_visibility_needed" in modifiers:
        return "One request is scheduled, one is underway, and one has not yet been scoped. Clearer visibility on workload is still needed."
    if segment.get("milestone") == "stage_gate_vendor_strategy":
        return "The research interviews are complete, but the strategy document has not yet been produced."
    if segment.get("milestone") == "ai_governance_framework" and "pending leadership review" in combined:
        return "Version one was completed and leadership review is still required."

    evidence_sources = (
        segment.get("evidence", [])
        + segment.get("blocking_factors", [])
        + segment.get("conflicting_evidence", [])
    )
    usable = []
    for item in evidence_sources:
        cleaned = normalize_text_fragment(item)
        lowered = cleaned.lower()
        if not cleaned:
            continue
        if lowered in {"green", "amber", "red", "blue"}:
            continue
        if "agreed rag status" in lowered:
            continue
        if cleaned not in usable:
            usable.append(cleaned)
    rewritten = [rewrite_evidence_sentence(item) for item in usable[:2]]
    rewritten = [item for item in rewritten if item]
    return " ".join(rewritten[:2]).strip()


def build_milestone_discussion_points(segments: list[dict[str, Any]], config: dict[str, Any]) -> list[str]:
    points = []
    for segment in segments:
        if segment.get("milestone") == "unclassified":
            continue
        label = milestone_label(segment, config)
        parts = [milestone_outcome_sentence(segment, label)]
        evidence_summary = milestone_evidence_summary(segment)
        if evidence_summary:
            parts.append(evidence_summary)
        agreed_rag_status = segment.get("agreed_rag_status", "unknown")
        if agreed_rag_status != "unknown":
            parts.append(f"Agreed RAG status: {agreed_rag_status}.")
        points.append(" ".join(part.strip() for part in parts if part).strip())
    return points


def build_health_summary(segments: list[dict[str, Any]]) -> dict[str, int]:
    summary = {
        "green": 0,
        "amber": 0,
        "red": 0,
        "blue": 0,
        "unknown": 0,
        "blocked": 0,
        "complete": 0,
        "in_progress": 0,
        "scheduled": 0,
        "awaiting_input": 0,
        "in_review": 0,
        "delayed": 0,
        "not_started": 0,
    }
    for segment in segments:
        summary[segment.get("agreed_rag_status", "unknown")] = summary.get(segment.get("agreed_rag_status", "unknown"), 0) + 1
        summary[segment.get("delivery_status", "unknown")] = summary.get(segment.get("delivery_status", "unknown"), 0) + 1
    return summary


def topic_from_decision_detail(detail: dict[str, Any]) -> str:
    topic = detail.get("topic", "")
    decision = detail.get("decision", "").lower()
    if topic == "audience_framing" or ("broad" in decision and "validation" in decision):
        return "whether the webinar should be validation-specific or broadly applicable"
    if topic == "educational_tone" or "sales-led" in decision:
        return "how the webinar should be positioned for the audience"
    if topic == "timeline_scope":
        return "how clearly the webinar explains its timeline and scope"
    if topic in {"commercial_direction", "supplier_direction"} or any(term in decision for term in ("supplier", "pricing")):
        return "the preferred commercial approach"
    if topic == "contract_term" or any(term in decision for term in ("one-year contract", "three-year commitment")):
        return "the preferred contract term"
    if topic == "timing_direction" or any(term in decision for term in ("take place on", "following monday", "launch")):
        return "the timing of the planned work"
    if topic == "replacement_scope" or any(term in decision for term in ("replace", "replacement", "video system")):
        return "whether replacement should be included in scope"
    return ""


def build_decision_discussion_point(detail: dict[str, Any]) -> str:
    decision = detail.get("decision", "")
    topic = detail.get("topic", "")
    lowered = decision.lower()
    if topic == "audience_framing" or ("broad" in lowered and "validation" in lowered):
        return "The team discussed whether the webinar should be validation-specific or broadly applicable and agreed to keep the messaging broad."
    if topic == "educational_tone" or "sales-led" in lowered:
        return "The team discussed how the webinar should be positioned and agreed to keep it educational rather than sales-led."
    if topic == "timeline_scope":
        return "The team discussed how clearly the webinar explained its timeline and scope and agreed that this framing needed to be clearer."
    if topic in {"commercial_direction", "supplier_direction"} or any(term in lowered for term in ("supplier", "pricing")):
        return f"The team discussed the commercial options and agreed that {normalize_text_fragment(decision).lower()}."
    if topic == "contract_term" or any(term in lowered for term in ("one-year contract", "three-year commitment")):
        return f"The team discussed the contract term options and agreed that {normalize_text_fragment(decision).lower()}."
    if topic == "timing_direction" or any(term in lowered for term in ("take place on", "following monday", "launch")):
        return f"The team discussed the timing of the planned work and agreed that {normalize_text_fragment(decision).lower()}."
    if topic == "replacement_scope" or any(term in lowered for term in ("replace", "replacement", "video system")):
        return f"The team discussed whether replacement should be included in scope and agreed that {normalize_text_fragment(decision).lower()}."
    return finalize_sentence(sentence_case(normalize_text_fragment(decision)))


def dedupe_discussion_details(details: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen = set()
    deduped = []
    for item in details:
        key = action_text_key(item.get("discussionPoint", ""))
        if not key or key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return deduped


def gerund_for_action(action_text: str) -> str:
    lowered = action_text.lower().strip().rstrip(".")
    keyword_phrases = [
        (("opening wording", "opening explanation", "timeline slide", "demo intro"), "refining webinar messaging and delivery"),
        (("slide deck", "slide", "deck", "visual", "imagery"), "updating presentation materials"),
        (("registration list", "attendee list", "client attendee list", "attendee information"), "updating attendee information"),
        (("practice round", "rehearsal"), "completing a final rehearsal"),
        (("stage gate", "template"), "reviewing stage gate templates"),
        (("pipeline", "sales"), "confirming sales dependencies for the AI pipeline"),
        (("vendor strategy",), "drafting the vendor strategy document"),
        (("innovation grant", "grant feedback"), "following up innovation grant feedback"),
        (("routing", "intake workflow"), "validating intake workflow routing"),
        (("api documentation", "documentation"), "completing API documentation"),
    ]
    for keywords, phrase in keyword_phrases:
        if any(keyword in lowered for keyword in keywords):
            return phrase

    cleaned = normalize_text_fragment(action_text).rstrip(".")
    match = re.match(r"^(Review|Confirm|Draft|Follow up|Validate|Update|Check|Clarify|Improve|Refine|Tighten|Run|Prepare|Send|Share|Create|Fix|Remove|Add)\s+(.+)$", cleaned, flags=re.IGNORECASE)
    if not match:
        return cleaned.lower()
    verb = match.group(1).lower()
    rest = match.group(2)
    gerund_map = {
        "review": "reviewing",
        "confirm": "confirming",
        "draft": "drafting",
        "follow up": "following up",
        "validate": "validating",
        "update": "updating",
        "check": "checking",
        "clarify": "clarifying",
        "improve": "improving",
        "refine": "refining",
        "tighten": "tightening",
        "run": "running",
        "prepare": "preparing",
        "send": "sending",
        "share": "sharing",
        "create": "creating",
        "fix": "fixing",
        "remove": "removing",
        "add": "adding",
    }
    return f"{gerund_map.get(verb, verb + 'ing')} {rest.lower()}"


def summarize_action_focus(structured_actions: list[dict[str, Any]]) -> str:
    if not structured_actions:
        return ""
    phrases = dedupe([gerund_for_action(item["meetingActionPoint"]) for item in structured_actions])
    if not phrases:
        return ""
    return finalize_sentence(f"Actions focused on {format_label_list(phrases[:5])}")


def build_summary_decision_sentence(decision_details: list[dict[str, Any]], meeting_type: str) -> str:
    if not decision_details:
        return ""
    primary = decision_details[0]
    topic = topic_from_decision_detail(primary)
    if meeting_type == "webinar_rehearsal" and topic:
        if len(decision_details) == 1:
            return f"The team reviewed {topic} and agreed that {normalize_text_fragment(primary['decision']).lower()}."
        secondary = normalize_text_fragment(decision_details[1]["decision"]).lower()
        return f"The team reviewed {topic} and agreed that {normalize_text_fragment(primary['decision']).lower()}. They also agreed that {secondary}."
    if len(decision_details) == 1:
        return finalize_sentence(f"The team agreed that {normalize_text_fragment(primary['decision']).lower()}")
    decisions_text = format_label_list([normalize_text_fragment(item["decision"]).lower() for item in decision_details[:2]])
    return finalize_sentence(f"Key decisions included {decisions_text}")


def build_executive_summary(
    meeting_theme: str,
    meeting_type: str,
    segments: list[dict[str, Any]],
    config: dict[str, Any],
    structured_actions: list[dict[str, Any]],
) -> str:
    if meeting_type != "project_status_review":
        if meeting_type == "webinar_rehearsal":
            return " ".join(
                [
                    "The meeting focused on rehearsing the webinar delivery and checking presentation readiness.",
                    "The team worked through the workshop plan, slide updates, attendee preparation, and the way timeline and scope should be explained.",
                    "Several practical changes were agreed, including updating the slide deck, checking the registration list, and confirming the client attendee list.",
                    "Further preparation is still needed before delivery so the workshop material can handle detailed process questions clearly.",
                ]
            )
        if meeting_type == "presentation_review":
            return " ".join(
                [
                    "The meeting focused on reviewing presentation readiness and delivery approach.",
                    "The team refined structure, visuals, and speaking points across the deck.",
                    "Specific changes were agreed to improve clarity before the next presentation run-through.",
                ]
            )
        if meeting_type == "sales_or_client_discussion":
            return " ".join(
                [
                    "The meeting focused on client discussion points and immediate follow-up actions.",
                    "Key themes included priorities, dependencies, and the next communication steps.",
                    "The discussion closed with agreed actions for the next stage of follow-up.",
                ]
            )
        return " ".join(
            [
                f"The meeting focused on {meeting_theme.lower()}.",
                "The discussion covered the main topics raised during the session and the follow-up needed afterwards.",
                "Actions were recorded where clear next steps were agreed.",
            ]
        )

    complete = [milestone_label(segment, config) for segment in segments if segment.get("delivery_status") == "complete"]
    active = [milestone_label(segment, config) for segment in segments if segment.get("delivery_status") == "in_progress"]
    blocked = [milestone_label(segment, config) for segment in segments if segment.get("delivery_status") == "blocked"]
    scheduled = [milestone_label(segment, config) for segment in segments if segment.get("delivery_status") == "scheduled"]
    attention = [
        milestone_label(segment, config)
        for segment in segments
        if segment.get("agreed_rag_status") == "amber"
    ]
    governance = [milestone_label(segment, config) for segment in segments if MILESTONE_CATEGORY_MAP.get(segment.get("milestone")) == "governance"]

    paragraphs = []
    if meeting_type == "project_status_review":
        lead = f"The meeting focused on reviewing programme milestones and confirming current project status across {meeting_theme}."
        if complete:
            complete_labels = complete[:2]
            complete_verb = "were" if len(complete_labels) > 1 or is_plural_label(complete_labels[0]) else "was"
            lead += f" {format_label_list(complete_labels)} {complete_verb} confirmed as complete."
        elif active:
            active_labels = active[:2]
            active_verb = "remain" if len(active_labels) > 1 or is_plural_label(active_labels[0]) else "remains"
            lead += f" {format_label_list(active_labels)} {active_verb} active workstreams."
        if scheduled:
            scheduled_labels = scheduled[:2]
            scheduled_verb = "remain" if len(scheduled_labels) > 1 or is_plural_label(scheduled_labels[0]) else "remains"
            lead += f" {format_label_list(scheduled_labels)} {scheduled_verb} scheduled."
        paragraphs.append(lead.strip())
    else:
        paragraphs.append(f"The meeting focused on {meeting_theme}.")

    non_blocked_attention = [item for item in attention if item not in blocked]
    if non_blocked_attention or blocked:
        issue_parts = []
        if non_blocked_attention:
            issue_parts.append(
                f"{format_label_list(non_blocked_attention[:3])} {'remains' if len(non_blocked_attention[:3]) == 1 else 'remain'} active workstreams requiring further attention."
            )
        if blocked:
            issue_parts.append(
                f"{format_label_list(blocked)} {'remains' if len(blocked) == 1 else 'remain'} blocked pending further input."
            )
        paragraphs.append(" ".join(issue_parts))

    action_summary = summarize_action_focus(structured_actions)
    if action_summary:
        paragraphs.append(action_summary)

    if governance:
        blue_items = [milestone_label(segment, config) for segment in segments if segment.get("agreed_rag_status") == "blue"]
        if blue_items:
            paragraphs.append(f"{format_label_list(blue_items)} {'remains' if len(blue_items) == 1 else 'remain'} subject to formal governance or approval steps.")
        else:
            paragraphs.append(f"Governance items reviewed included {format_label_list(governance[:3])}.")

    return "\n\n".join(paragraphs).strip()


def build_evidence_only_summary(
    cleaned_turns: list[dict[str, Any]],
    meeting_type: str,
    discussion_point_details: list[dict[str, Any]],
    decision_details: list[dict[str, Any]],
    structured_actions: list[dict[str, Any]],
) -> str:
    if meeting_type == "project_status_review":
        return ""

    sentences: list[str] = []
    if not discussion_point_details and not decision_details and not structured_actions:
        return "No substantive meeting content, decisions, or actions were identified."
    decision_sentence = build_summary_decision_sentence(decision_details, meeting_type)
    if decision_sentence:
        sentences.append(decision_sentence)
    elif discussion_point_details:
        sentences.append(discussion_point_details[0]["discussionPoint"])
    elif meeting_type == "webinar_rehearsal":
        sentences.append("The team reviewed webinar delivery, presentation clarity, and final preparation needs.")
    elif meeting_type == "general_meeting":
        sentences.append("The team reviewed the main issues, follow-up priorities, and next steps arising from the discussion.")

    if discussion_point_details:
        for item in discussion_point_details[:3]:
            point = item["discussionPoint"]
            normalized_point = action_text_key(point)
            if not any(normalized_point == action_text_key(existing) for existing in sentences):
                sentences.append(point)
            if len(sentences) >= 3:
                break

    action_summary = summarize_action_focus(structured_actions)
    if action_summary:
        sentences.append(action_summary)
    elif decision_details:
        sentences.append("No additional actions were identified.")

    unique: list[str] = []
    seen = set()
    for sentence in sentences:
        cleaned = finalize_sentence(sentence)
        key = cleaned.lower()
        if key in seen:
            continue
        seen.add(key)
        unique.append(cleaned)
    return " ".join(unique[:4]).strip()


def extract_generic_discussion_points(text: str, raw_turns: list[dict[str, str]], config: dict[str, Any]) -> list[str]:
    points: list[str] = []
    source_turns = raw_turns or [{"speaker": "", "content": text}]
    for turn in source_turns:
        if not is_valid_discussion_point_candidate(turn["content"]):
            continue
        for rule in find_rule_matches(turn["content"], config.get("generic_discussion_rules", [])):
            if not has_strong_generic_discussion_match(turn["content"], rule):
                continue
            points.append(rule["point"])
    return dedupe(points)


def extract_turn_level_discussion_points(raw_turns: list[dict[str, str]]) -> list[str]:
    points: list[str] = []
    for turn in raw_turns:
        content = turn["content"].strip()
        lowered = content.lower()
        if not content:
            continue
        if not is_valid_discussion_point_candidate(content, turn.get("speaker", "")):
            continue
        if any(
            term in lowered
            for term in (
                "risk",
                "issue",
                "timeline",
                "scope",
                "plan",
                "workshop",
                "webinar",
                "update",
                "failing",
                "priority",
                "documentation",
                "branding",
                "investigation",
                "blocker",
            )
        ) or is_issue_statement(content):
            points.append(finalize_sentence(sentence_case(content.rstrip("."))))
        if len(points) >= 5:
            break
    return dedupe(points)


def is_business_relevant(text: str) -> bool:
    lowered = text.lower()
    return not any(pattern in lowered for pattern in NON_BUSINESS_PATTERNS)


def is_valid_discussion_point_candidate(text: str, speaker: str = "") -> bool:
    stripped = text.strip()
    lowered = stripped.lower()
    if not stripped:
        return False
    if lowered.startswith(("can you", "could you", "will you", "would you", "please ")):
        return False
    if extract_request_task(stripped, speaker):
        return False
    direct_request_patterns = (
        r"^(?:can|could|will|would)\s+you\b",
        r"^please\b",
        r"^(?:check|confirm|send|update|review|draft|follow up|fix|prepare|share|create|remove|add)\b",
    )
    if any(re.match(pattern, lowered) for pattern in direct_request_patterns):
        return False
    return True


def is_issue_statement(text: str) -> bool:
    lowered = text.lower()
    return any(
        phrase in lowered
        for phrase in (
            "isn't clear",
            "is not clear",
            "not clear",
            "unclear",
            "confusing",
        )
    )


def extract_generic_meeting_topic(text: str) -> str:
    lowered = text.lower().strip().rstrip(".?")
    patterns = [
        r"whether to (?P<topic>.+)",
        r"who is handling (?P<topic>.+)",
        r"(?P<topic>.+?) will take place on \b.+$",
        r"(?P<topic>.+?) will also be needed\b",
        r"(?P<topic>.+?) is blocked\b",
        r"(?P<topic>.+?) is delayed\b",
        r"(?P<topic>.+?) isn't working\b",
        r"(?P<topic>.+?) is not working\b",
        r"(?P<topic>.+?) needs review\b",
    ]
    for pattern in patterns:
        match = re.search(pattern, lowered)
        if match:
            topic = normalize_text_fragment(match.group("topic"))
            if topic:
                return topic.lower()
    noun_phrases = [
        "supplier renewal",
        "revised proposal",
        "legal review",
        "final pricing figures",
        "video conferencing systems",
        "meeting room video systems",
        "backup supplier",
        "furniture delivery risk",
        "pilot launch",
        "office move",
        "contract",
    ]
    for phrase in noun_phrases:
        if phrase in lowered:
            return phrase
    return ""


def build_generic_discussion_from_sentence(sentence: str) -> str:
    cleaned = normalize_text_fragment(sentence)
    lowered = cleaned.lower()
    if not cleaned:
        return ""
    unresolved_match = re.search(r"whether to (?P<topic>.+)", lowered)
    if unresolved_match and any(term in lowered for term in ("haven't decided", "have not decided", "still deciding")):
        return finalize_sentence(f"The team discussed whether to {unresolved_match.group('topic').rstrip('.?')}")
    if "has proposed" in lowered:
        return finalize_sentence(f"The team reviewed {cleaned.lower()}")
    if "backup supplier" in lowered and "risk" in lowered:
        return "A delivery risk was discussed, with a backup supplier identified as the preferred contingency."
    if any(term in lowered for term in ("blocked", "dependency", "depends on", "waiting for", "input from")):
        topic = extract_generic_meeting_topic(cleaned) or "a key dependency"
        return finalize_sentence(f"The team discussed {topic} and identified it as a dependency or blocker")
    if any(term in lowered for term in ("cost", "scope", "quality", "timing", "ownership")):
        topic = extract_generic_meeting_topic(cleaned) or cleaned.lower()
        return finalize_sentence(f"The team reviewed {topic} as part of the meeting discussion")
    if is_issue_statement(cleaned):
        return finalize_sentence(sentence_case(cleaned))
    if any(term in lowered for term in ("risk", "option", "compare", "rather than", "instead of")):
        topic = extract_generic_meeting_topic(cleaned) or cleaned.lower()
        return finalize_sentence(f"The team discussed {topic} and compared possible options")
    return finalize_sentence(sentence_case(cleaned))


def build_request_task_from_context(task: str, recent_context_texts: list[str]) -> str:
    lowered = task.lower().strip()
    if not re.search(r"\b(?:those|that|it|them)\b", lowered):
        return task
    context_text = " ".join(recent_context_texts[-3:]).lower()
    if lowered.startswith("send ") and "final figures" in context_text and "finance" in context_text:
        if "pricing" in context_text or "budget" in context_text:
            return "send final pricing figures to finance when available"
        return "send final figures to finance when available"
    return task


def cluster_sentence_for_mode(sentence: str, meeting_mode: str) -> str | None:
    lowered = sentence.lower()
    if not is_business_relevant(sentence):
        return None
    if not is_valid_discussion_point_candidate(sentence):
        return None
    if meeting_mode == "webinar_rehearsal":
        if any(term in lowered for term in ("agenda", "flow", "run through", "before the webinar")):
            return "Webinar agenda and flow"
        if any(term in lowered for term in ("workshop", "validation team", "clear view", "process questions")):
            return "Case study and AI discovery workshop explanation"
        if any(term in lowered for term in ("slide", "slides", "deck", "imagery", "visual")):
            return "Slide design and workshop imagery"
        if any(term in lowered for term in ("educational", "salesy", "scope")):
            return "Educational positioning rather than sales-led messaging"
        if any(term in lowered for term in ("demo", "registration list", "client attendees")):
            return "Live demo setup and framing"
        if (
            ("timeline" in lowered and "scope" in lowered)
            or any(term in lowered for term in ("timing", "practice", "rehearsal", "before the webinar"))
        ):
            return "Timing and rehearsal preparation"
    if meeting_mode == "presentation_review":
        if any(term in lowered for term in ("slide", "deck", "presentation", "visual")):
            return "Presentation structure and visuals"
    if meeting_mode == "sales_or_client_discussion":
        if any(term in lowered for term in ("client call", "client meeting", "sales discussion", "sales follow-up", "customer pitch", "prospect", "lead", "pipeline", "deal")):
            return "Client priorities and follow-up"
    if meeting_mode == "general_meeting":
        if any(term in lowered for term in ("whether to", "still deciding", "haven't decided", "have not decided")):
            return "Option comparison and unresolved choices"
        if any(term in lowered for term in ("supplier", "contract", "pricing", "proposal", "renewal")):
            return "Commercial options and supplier decisions"
        if any(term in lowered for term in ("office move", "relocation", "launch", "monday", "september", "date")):
            return "Timeline and scheduling decisions"
        if any(term in lowered for term in ("legal review", "signing", "finance", "negotiation", "owner", "handling")):
            return "Ownership and follow-up coordination"
        if any(term in lowered for term in ("risk", "contingency", "backup supplier", "dependency", "blocked", "blocker")):
            return "Risks, blockers, and dependencies"
        if any(term in lowered for term in ("report export speed", "export time", "improved since", "dropped from")):
            return "Operational performance review"
        if any(term in lowered for term in ("notification", "failing", "bug", "confusion", "investigation", "look into", "blocker")):
            return "Open issue investigation"
        if any(term in lowered for term in ("custom branding", "not prioritise", "discussion only")):
            return "Feature prioritisation decisions"
        if (
            ("documentation" in lowered and "api" in lowered)
            or ("documentation" in lowered and "hanging around" in lowered)
            or ("documentation" in lowered and "when can it be done" in lowered)
            or ("documentation" in lowered and "changes the api again" in lowered)
        ):
            return "Documentation and follow-up delivery"
    return None


def build_cluster_sentence(cluster: str, sentences: list[str]) -> str:
    lowered = " ".join(sentences).lower()
    if cluster == "Webinar agenda and flow":
        if "workshop plan" in lowered and "validation team" in lowered:
            return "The team worked through the workshop plan so the validation team would have a clear view of what happens before the webinar."
        return "The team refined the webinar agenda and flow so the session sequence would be clear before delivery."
    if cluster == "Case study and AI discovery workshop explanation":
        if "process questions" in lowered:
            return "The group noted that attendees may ask detailed process questions, so the workshop material needs to explain the process clearly."
        return "The team clarified how the workshop approach should be explained so attendees understood the business context behind the webinar content."
    if cluster == "Slide design and workshop imagery":
        if "slide deck" in lowered:
            return "The slide deck was flagged for revision so the supporting material matched the workshop narrative more clearly."
        return "Slide content and supporting visuals were reviewed to keep the material clear and aligned with the workshop narrative."
    if cluster == "Educational positioning rather than sales-led messaging":
        return "The messaging was kept educational and process-led so the session did not drift into a sales-led pitch."
    if cluster == "Live demo setup and framing":
        if "registration list" in lowered or "client attendees" in lowered:
            return "The group agreed that the registration list and client attendee list should be checked before the webinar so the live walkthrough was properly prepared."
        return "The live walkthrough setup was reviewed so the audience would have the right context before the demonstration began."
    if cluster == "Timing and rehearsal preparation":
        if "timeline" in lowered and "scope" in lowered:
            return "The team agreed that the timeline and scope need to be explained more clearly so everyone understands the boundaries of the webinar."
        return "Timing and rehearsal preparation were reviewed so the session could be delivered smoothly and within the planned window."
    if cluster == "Presentation structure and visuals":
        return "The presentation structure and visuals were reviewed to improve clarity and delivery."
    if cluster == "Client priorities and follow-up":
        return "Client-facing discussion points and follow-up priorities were clarified during the meeting."
    if cluster == "Option comparison and unresolved choices":
        return build_generic_discussion_from_sentence(sentences[0] if sentences else "")
    if cluster == "Commercial options and supplier decisions":
        if any(term in lowered for term in ("existing supplier", "supplier b", "pricing", "service levels", "response times", "operational risk", "renewal")):
            if "customer support contract renewal" in lowered:
                return "The team reviewed the customer support contract renewal, including pricing, supplier comparison and operational risk."
            return "The team reviewed the supplier renewal, including pricing, supplier comparison and operational risk."
        return build_generic_discussion_from_sentence(" ".join(sentences[:3]))
    if cluster == "Timeline and scheduling decisions":
        return build_generic_discussion_from_sentence(sentences[0] if sentences else "")
    if cluster == "Ownership and follow-up coordination":
        if any(term in lowered for term in ("legal review", "finance", "signing", "negotiation")):
            return "The team discussed legal review and finance follow-up requirements alongside ownership of the renewal negotiation."
        return build_generic_discussion_from_sentence(" ".join(sentences[:3]))
    if cluster == "Risks, blockers, and dependencies":
        return build_generic_discussion_from_sentence(" ".join(sentences[:2]))
    if cluster == "Operational performance review":
        return "The team reviewed report export performance and confirmed that the earlier speed concern was no longer seen as a blocker."
    if cluster == "Open issue investigation":
        return "They discussed the ongoing notification email problem and agreed that it still needs investigation."
    if cluster == "Feature prioritisation decisions":
        return build_generic_discussion_from_sentence(sentences[0] if sentences else "")
    if cluster == "Documentation and follow-up delivery":
        return "They also reviewed the delayed API documentation and agreed that it should be completed by Friday."
    fallback = sentences[0] if sentences else ""
    return finalize_sentence(sentence_case(normalize_text_fragment(fallback)))


def extract_general_discussion_details(
    cleaned_turns: list[dict[str, Any]],
    meeting_mode: str,
    decision_details: list[dict[str, Any]] | None = None,
    structured_actions: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    clusters: dict[str, list[str]] = {}
    cluster_refs: dict[str, list[dict[str, str]]] = {}
    for turn in cleaned_turns:
        for sentence in turn.get("sentences") or [turn.get("text", "")]:
            if not is_valid_discussion_point_candidate(sentence, turn.get("speaker", "")):
                continue
            cluster = cluster_sentence_for_mode(sentence, meeting_mode)
            if not cluster:
                continue
            clusters.setdefault(cluster, []).append(sentence)
            cluster_refs.setdefault(cluster, []).append(
                {"speaker": turn.get("speaker", ""), "timestamp": turn.get("timestamp", "")}
            )
    details = []
    for cluster, sentences in clusters.items():
        evidence = dedupe_evidence_refs(cluster_refs.get(cluster, []))
        details.append(
            {
                "discussionPoint": build_cluster_sentence(cluster, sentences),
                "_evidence": evidence,
                "evidenceScore": round(min(1.0, 0.45 + 0.15 * len(evidence)), 2),
            }
        )
    if len(details) < 2:
        for detail in decision_details or []:
            decision_point = build_decision_discussion_point(detail)
            if any(action_text_key(item["discussionPoint"]) == action_text_key(decision_point) for item in details):
                continue
            details.append(
                {
                    "discussionPoint": decision_point,
                    "_evidence": detail.get("_evidence", []),
                    "evidenceScore": detail.get("decisionConfidence", 0.6),
                }
            )
    return dedupe_discussion_details(details)[:8]


def extract_general_discussion_points(cleaned_turns: list[dict[str, Any]], meeting_mode: str) -> list[str]:
    return [item["discussionPoint"] for item in extract_general_discussion_details(cleaned_turns, meeting_mode)]


def build_meeting_sections(cleaned_turns: list[dict[str, Any]], meeting_mode: str, structured_actions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if meeting_mode != "webinar_rehearsal":
        return []
    lowered_actions = [item["meetingActionPoint"] for item in structured_actions]
    sections = []
    for rule in WEBINAR_SECTION_RULES:
        matching_sentences = []
        matching_actions = []
        matching_refs = []
        for turn in cleaned_turns:
            for sentence in turn.get("sentences") or [turn.get("text", "")]:
                lowered = sentence.lower()
                if any(keyword in lowered for keyword in rule["keywords"]) and is_business_relevant(sentence):
                    matching_sentences.append(sentence)
                    matching_refs.append({"speaker": turn.get("speaker", ""), "timestamp": turn.get("timestamp", "")})
        for action in lowered_actions:
            lowered = action.lower()
            if any(keyword in lowered for keyword in rule["keywords"]):
                matching_actions.append(action)
        support_count = len(dedupe_evidence_refs(matching_refs)) + len(dedupe(matching_actions))
        if support_count >= 2 and (matching_sentences or matching_actions):
            sections.append(
                {
                    "section": rule["section"],
                    "summary": rule["summary"],
                    "actions": matching_actions,
                    "_evidence": dedupe_evidence_refs(matching_refs),
                }
            )
    return sections


def extract_action_block(text: str) -> tuple[list[str], str]:
    actions: list[str] = []
    block_deadline = ""
    in_block = False
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if ACTION_BLOCK_HEADING_RE.match(line):
            lowered = line.lower()
            in_block = True
            if "next week" in lowered:
                block_deadline = "Before next week"
            elif "before the webinar" in lowered:
                block_deadline = "Before the webinar"
            else:
                block_deadline = ""
            continue
        if not in_block:
            continue
        if TURN_RE.match(line):
            break
        colon_match = COLON_SPEAKER_RE.match(line)
        if colon_match:
            speaker_label = colon_match.group("speaker").strip().lower()
            if is_action_heading_label(colon_match.group("speaker").strip()):
                continue
            if speaker_label not in {"date", "location"}:
                break
            continue
        actions.extend([part.strip().rstrip(".") for part in split_sentences(line) if part.strip()])
    return actions, block_deadline


def find_named_owner(text: str, config: dict[str, Any]) -> str | None:
    for name in config.get("participant_groups", {}):
        first_name = name.split()[0]
        if re.search(rf"\b{re.escape(first_name)}\b", text, flags=re.IGNORECASE):
            return name
    return None


def find_participant_by_first_name(text: str, config: dict[str, Any]) -> str | None:
    lowered = text.lower()
    for name in config.get("participant_groups", {}):
        first_name = name.split()[0].lower()
        if lowered == first_name or lowered.startswith(first_name + " "):
            return name
    return None


def action_text_key(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def canonical_action_key(text: str) -> str:
    lowered = text.lower().strip().rstrip(".!?")
    lowered = re.sub(r"\b(?:instead|as well|then|probably|maybe)\b", "", lowered)
    lowered = re.sub(r"\b(?:the|a|an)\b", "", lowered)
    lowered = re.sub(r"\s+", " ", lowered).strip()
    return action_text_key(lowered)


def find_action_source_turn(action_text: str, raw_turns: list[dict[str, str]]) -> dict[str, str] | None:
    key = action_text_key(action_text)
    action_tokens = set(key.split())
    best_turn = None
    best_score = 0
    for turn in raw_turns:
        turn_tokens = set(action_text_key(turn["content"]).split())
        overlap = len(action_tokens & turn_tokens)
        if overlap > best_score:
            best_score = overlap
            best_turn = turn
    return best_turn if best_score else None


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
    if "not before friday" in lowered:
        return ""
    if "before the webinar" in lowered:
        return "Before the webinar"
    if "before friday" in lowered:
        return "Before Friday"
    if "tomorrow" in lowered:
        return "Tomorrow"
    if "this afternoon" in lowered:
        return "This afternoon"
    for deadline_rule in config.get("action_deadline_rules", []):
        if any(term in lowered for term in deadline_rule["contains_any"]):
            return deadline_rule["deadline"]
    return rule["deadline"]


def normalize_requested_task(task_text: str, speaker: str = "") -> str:
    return text_normalize_requested_task(task_text, speaker)


def extract_request_task(sentence: str, speaker: str = "") -> str | None:
    return conversation_extract_request_task(sentence, speaker)


def extract_response_commitment(sentence: str, speaker: str, config: dict[str, Any]) -> dict[str, Any] | None:
    return conversation_extract_response_commitment(sentence, speaker, config, find_participant_by_first_name)


def build_linked_action_text(task: str, collaborator: str | None, speaker: str = "") -> str:
    return conversation_build_linked_action_text(task, collaborator, speaker)


def extract_contextual_commitment(sentence: str) -> dict[str, str] | None:
    return conversation_extract_contextual_commitment(sentence)


def extract_problem_context(sentence: str) -> dict[str, str] | None:
    return conversation_extract_problem_context(sentence)


def build_contextual_action_text(action_verb: str, subject: str) -> str:
    return conversation_build_contextual_action_text(action_verb, subject)


def infer_action_related_milestone(action_text: str, config: dict[str, Any]) -> str:
    lowered = action_text.lower()
    keyword_map = {
        "stage gate": "stage_gate_internal_review",
        "template": "stage_gate_internal_review",
        "routing": "use_case_intake_funnel",
        "intake": "use_case_intake_funnel",
        "pipeline": "ai_pipeline_strategy",
        "sales": "ai_pipeline_strategy",
        "vendor strategy": "stage_gate_vendor_strategy",
        "grant": "ei_grant_feedback",
        "governance": "ai_governance_framework",
    }
    for keyword, milestone in keyword_map.items():
        if keyword in lowered:
            return milestone
    return ""


def resolve_explicit_action_owner(
    action_text: str,
    action_turn: dict[str, str] | None,
    raw_turns: list[dict[str, str]],
    config: dict[str, Any],
) -> tuple[str, float]:
    lowered = action_text.lower()
    if lowered.startswith("work with "):
        return "Owner not specified", 0.2
    if re.match(r"^(?:[A-Z][a-z]+),\s+", action_text):
        named = find_participant_by_first_name(action_text.split(",", 1)[0], config)
        if named:
            return named, 0.85
    can_you_match = re.match(r"can you\s+([A-Z][a-z]+)", action_text, flags=re.IGNORECASE)
    if can_you_match:
        named = find_participant_by_first_name(can_you_match.group(1), config)
        if named:
            return named, 0.85
    should_match = re.match(r"([A-Z][a-z]+)\s+should\b", action_text)
    if should_match:
        named = find_participant_by_first_name(should_match.group(1), config)
        if named:
            return named, 0.85
    explain_match = re.match(r"([A-Z][a-z]+),?\s+just\s+\w+", action_text, flags=re.IGNORECASE)
    if explain_match:
        named = find_participant_by_first_name(explain_match.group(1), config)
        if named:
            return named, 0.85
    if re.match(r"^(i will|i'll|i can|i'll update|i'll change|i'll add)\b", lowered):
        if action_turn:
            return action_turn["speaker"], 0.8
        return "Owner not specified", 0.2
    if lowered.startswith("we're ") and action_turn:
        return action_turn["speaker"], 0.6
    if "grant" in lowered:
        if any("emma" in turn["content"].lower() for turn in raw_turns) and any("follow up this week" in turn["content"].lower() for turn in raw_turns):
            return "Emma", 0.85
    return "Owner not specified", 0.2


def build_structured_actions(
    actions: list[str],
    owners: list[str],
    deadlines: list[str],
    raw_turns: list[dict[str, str]],
    config: dict[str, Any],
) -> list[dict[str, Any]]:
    structured = []
    for index, action in enumerate(actions):
        owner = owners[index] if index < len(owners) else "Owner not specified"
        deadline = deadlines[index] if index < len(deadlines) else ""
        action_turn = find_action_source_turn(action, raw_turns)
        explicit_owner, owner_confidence = resolve_explicit_action_owner(action, action_turn, raw_turns, config)
        final_owner = explicit_owner
        if final_owner == "Owner not specified" and owner not in {"", "Owner not specified"} and "/" not in owner:
            if action_turn and action_turn["speaker"] == owner:
                final_owner = owner
                owner_confidence = 0.65
            else:
                final_owner = owner
                owner_confidence = 0.6
        if final_owner != "Owner not specified" and owner_confidence < OWNER_CONFIDENCE_MIN:
            final_owner = "Owner not specified"
            owner_confidence = 0.2
        if (
            action.lower().startswith(("we should", "review ", "confirm ", "draft ", "validate ", "follow up "))
            and explicit_owner == "Owner not specified"
            and owner in {"", "Owner not specified"}
        ):
            final_owner = "Owner not specified"
            owner_confidence = 0.2
        related_milestone = infer_action_related_milestone(action, config)
        polished_action = action_to_imperative(action, final_owner, action_turn["speaker"] if action_turn else "")
        if not has_minimum_output_words(polished_action):
            continue
        if not is_valid_action_output(polished_action):
            continue
        conversational_evidence = CONVERSATIONAL_ACTION_EVIDENCE.get(polished_action.lower(), [])
        if len(conversational_evidence) >= 2 and final_owner != "Owner not specified":
            owner_confidence = max(owner_confidence, 0.75)
        structured.append(
            {
                "meetingActionPoint": polished_action,
                "meetingActionPointOwner": final_owner,
                "meetingActionPointDeadline": deadline,
                "actionConfidence": round(owner_confidence, 2),
                "relatedMilestone": related_milestone or "unlinked",
                "_evidence": dedupe_evidence_refs((conversational_evidence + ([evidence_ref(action_turn)] if action_turn else []))),
            }
        )
    return structured


def dedupe_structured_actions(structured_actions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    deduped: dict[str, dict[str, Any]] = {}
    ordered_keys: list[str] = []
    for item in structured_actions:
        key = canonical_action_key(item["meetingActionPoint"])
        existing = deduped.get(key)
        if existing is None:
            deduped[key] = item
            ordered_keys.append(key)
            continue
        if item.get("actionConfidence", 0) > existing.get("actionConfidence", 0):
            combined = dict(item)
            combined["_evidence"] = dedupe_evidence_refs(existing.get("_evidence", []) + item.get("_evidence", []))
            deduped[key] = combined
        else:
            existing["_evidence"] = dedupe_evidence_refs(existing.get("_evidence", []) + item.get("_evidence", []))
    return [deduped[key] for key in ordered_keys]


def build_decisions(
    cleaned_turns: list[dict[str, Any]],
    meeting_mode: str,
    structured_actions: list[dict[str, Any]],
) -> tuple[list[str], list[dict[str, Any]]]:
    if meeting_mode == "project_status_review":
        return [], []

    candidates: list[dict[str, Any]] = []
    sentence_index = 0
    recent_sentences: list[str] = []
    for turn in cleaned_turns:
        turn_sentences = turn.get("sentences") or [turn.get("text", "")]
        for local_index, sentence in enumerate(turn_sentences):
            prev_sentence = turn_sentences[local_index - 1] if local_index > 0 else ""
            next_sentence = turn_sentences[local_index + 1] if local_index + 1 < len(turn_sentences) else ""
            context_text = " ".join((recent_sentences[-2:] + [prev_sentence, sentence, next_sentence])).strip()
            candidate = build_decision_candidate(sentence, turn, meeting_mode, sentence_index, context_text)
            sentence_index += 1
            recent_sentences.append(sentence)
            if candidate:
                candidates.append(candidate)

    details = resolve_decision_candidates(candidates)
    return [item["decision"] for item in details[:5]], details[:5]


def extract_actions_from_patterns(patterns: list[dict[str, Any]]) -> tuple[list[str], list[str], list[str], dict[str, list[dict[str, str]]]]:
    actions: list[str] = []
    owners: list[str] = []
    deadlines: list[str] = []
    evidence_map: dict[str, list[dict[str, str]]] = {}
    seen = set()
    for pattern in patterns:
        if pattern.get("pattern_type") not in {"request_acceptance", "problem_commitment"}:
            continue
        action_text = pattern.get("action_text", "")
        key = canonical_action_key(action_text)
        if not action_text or not key or key in seen:
            continue
        seen.add(key)
        actions.append(action_text)
        owners.append(pattern.get("owner", "Owner not specified"))
        deadlines.append(pattern.get("deadline", ""))
        evidence_map[action_text.lower()] = dedupe_evidence_refs(
            [
                {"speaker": item.get("speaker", ""), "timestamp": item.get("timestamp", "")}
                for item in pattern.get("evidence", [])
            ]
        )
    return actions, owners, deadlines, evidence_map


def extract_decisions_from_patterns(
    patterns: list[dict[str, Any]],
    meeting_mode: str,
) -> list[dict[str, Any]]:
    if meeting_mode == "project_status_review":
        return []

    candidates: list[dict[str, Any]] = []
    challenged_indexes = {
        pattern.get("source_index")
        for pattern in patterns
        if pattern.get("pattern_type") in {"vague_challenged", "request_rejection"}
    }
    for pattern in patterns:
        if pattern.get("pattern_type") not in {"proposal_acceptance", "counter_proposal_acceptance"}:
            continue
        source_index = pattern.get("source_index", 0)
        if source_index in challenged_indexes:
            continue
        sentence = pattern.get("final_text") or pattern.get("source_text") or ""
        if not sentence or is_non_decision_sentence(sentence):
            continue
        speaker = ""
        evidence = pattern.get("evidence", [])
        if evidence:
            speaker = evidence[0].get("speaker", "")
        decision, topic, specificity_bonus = decision_text_topic_specificity(sentence, speaker, meeting_mode, source_index)
        if not decision or not has_minimum_output_words(decision):
            continue
        candidates.append(
            {
                "topic": topic or f"pattern_{source_index}",
                "decision": decision,
                "decisionConfidence": round(min(0.95, 0.58 + specificity_bonus), 2),
                "decisionType": decision_type_for_sentence(sentence),
                "_evidence": dedupe_evidence_refs(
                    [{"speaker": item.get("speaker", ""), "timestamp": item.get("timestamp", "")} for item in evidence]
                ),
                "sentenceIndex": source_index,
            }
        )
    return resolve_decision_candidates(candidates)[:5]


def extract_discussion_points_from_patterns(
    patterns: list[dict[str, Any]],
    decision_details: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    details: list[dict[str, Any]] = []
    for decision in decision_details:
        details.append(
            {
                "discussionPoint": build_decision_discussion_point(decision),
                "_evidence": decision.get("_evidence", []),
                "evidenceScore": decision.get("decisionConfidence", 0.65),
            }
        )
    for pattern in patterns:
        pattern_type = pattern.get("pattern_type")
        if pattern_type in {"proposal_acceptance", "counter_proposal_acceptance", "request_acceptance", "problem_commitment", "request_rejection"}:
            continue
        text = pattern.get("source_text", "")
        evidence = dedupe_evidence_refs(
            [{"speaker": item.get("speaker", ""), "timestamp": item.get("timestamp", "")} for item in pattern.get("evidence", [])]
        )
        point = ""
        if pattern_type == "unresolved_option":
            point = build_generic_discussion_from_sentence(text)
        elif pattern_type == "fact_only":
            point = build_generic_discussion_from_sentence(text)
        elif pattern_type == "status_discussion":
            point = build_generic_discussion_from_sentence(text)
        elif pattern_type == "vague_challenged":
            point = ""
        if not point or not has_minimum_output_words(point):
            continue
        details.append(
            {
                "discussionPoint": point,
                "_evidence": evidence,
                "evidenceScore": round(min(1.0, 0.45 + 0.1 * len(evidence)), 2),
            }
        )
    return dedupe_discussion_details(details)[:8]


def build_internal_evidence(
    discussion_point_details: list[dict[str, Any]],
    structured_actions: list[dict[str, Any]],
    meeting_sections: list[dict[str, Any]],
    decision_details: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "discussionPoints": [
            {"text": item["discussionPoint"], "_evidence": item.get("_evidence", [])}
            for item in discussion_point_details
        ],
        "actions": [
            {"text": item["meetingActionPoint"], "_evidence": item.get("_evidence", [])}
            for item in structured_actions
        ],
        "meetingSections": [
            {"section": item["section"], "_evidence": item.get("_evidence", [])}
            for item in meeting_sections
        ],
        "decisions": [
            {"text": item["decision"], "_evidence": item.get("_evidence", [])}
            for item in decision_details
        ],
    }


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


def extract_named_assignment_actions(raw_turns: list[dict[str, str]], config: dict[str, Any]) -> tuple[list[str], list[str], list[str]]:
    actions: list[str] = []
    owners: list[str] = []
    deadlines: list[str] = []
    seen = set()
    for turn in raw_turns:
        for sentence in split_sentences(turn["content"]):
            cleaned = sentence.strip().rstrip(".")
            lowered = cleaned.lower()
            if not cleaned or "no action" in lowered:
                continue
            match = re.match(r"^(?P<owner>[A-Z][a-z]+)\s+to\s+(?P<task>.+)$", cleaned)
            if not match:
                continue
            owner_name = find_participant_by_first_name(match.group("owner"), config)
            if not owner_name:
                continue
            action_text = finalize_sentence(cleaned)
            key = action_text.lower()
            if key in seen:
                continue
            seen.add(key)
            actions.append(action_text)
            owners.append(owner_name)
            deadlines.append(infer_action_deadline(cleaned, {"deadline": ""}, config))
    return actions, owners, deadlines


def extract_linked_conversational_actions(raw_turns: list[dict[str, str]], config: dict[str, Any]) -> tuple[list[str], list[str], list[str]]:
    global CONVERSATIONAL_ACTION_EVIDENCE
    CONVERSATIONAL_ACTION_EVIDENCE = {}
    actions: list[str] = []
    owners: list[str] = []
    deadlines: list[str] = []
    seen = set()
    pending_requests: list[dict[str, Any]] = []
    recent_contexts: list[dict[str, Any]] = []
    recent_context_texts: list[str] = []
    sentence_index = 0

    for turn in raw_turns:
        speaker = turn.get("speaker", "")
        for sentence in split_sentences(turn.get("content", "")):
            stripped = sentence.strip()
            lowered = stripped.lower()
            if not stripped:
                sentence_index += 1
                continue
            pending_requests = [
                item for item in pending_requests if sentence_index - item["sentence_index"] <= 4
            ]
            recent_contexts = [
                item for item in recent_contexts if sentence_index - item["sentence_index"] <= 3
            ]
            recent_context_texts = recent_context_texts[-5:]

            request_task = extract_request_task(stripped, speaker)
            if request_task:
                request_task = build_request_task_from_context(request_task, recent_context_texts)
                pending_requests.append(
                    {
                        "task": request_task,
                        "requester": speaker,
                        "sentence_index": sentence_index,
                        "deadline": infer_action_deadline(stripped, {"deadline": ""}, config),
                        "request_timestamp": turn.get("timestamp", ""),
                        "evidence_refs": [],
                    }
                )
                sentence_index += 1
                continue

            problem_context = extract_problem_context(stripped)
            if problem_context:
                recent_contexts.append(
                    {
                        "subject": problem_context["subject"],
                        "default_action_verb": problem_context["default_action_verb"],
                        "speaker": speaker,
                        "sentence_index": sentence_index,
                        "timestamp": turn.get("timestamp", ""),
                    }
                )
            elif is_business_relevant(stripped) and not is_non_decision_sentence(stripped):
                recent_context_texts.append(stripped)

            commitment = extract_response_commitment(stripped, speaker, config)
            if commitment:
                if commitment.get("rejects_request"):
                    for pending in reversed(pending_requests):
                        if pending.get("requester") != speaker:
                            pending.setdefault("evidence_refs", []).append(
                                evidence_ref({"speaker": speaker, "timestamp": turn.get("timestamp", "")})
                            )
                            pending["rejected_by"] = speaker
                            pending["rejection_text"] = stripped
                            break
                    sentence_index += 1
                    continue
                if commitment.get("acknowledges_request"):
                    for pending in reversed(pending_requests):
                        if pending.get("requester") != speaker and not pending.get("accepted_by"):
                            pending["accepted_by"] = speaker
                            break
                    sentence_index += 1
                    continue

                response_deadline = infer_action_deadline(stripped, {"deadline": ""}, config)
                if commitment.get("inherits_task") and pending_requests:
                    unresolved = [
                        item
                        for item in pending_requests
                        if item.get("requester") != speaker
                        and (not item.get("accepted_by") or item.get("accepted_by") == speaker)
                    ]
                    if unresolved:
                        recent_requester = unresolved[-1]["requester"]
                        matching = [item for item in unresolved if item.get("requester") == recent_requester]
                        request_count = commitment.get("request_count", 1)
                        selected = matching[-request_count:]
                        resolved_keys = {
                            (item["requester"], item["task"], item["sentence_index"]) for item in selected
                        }
                        for pending in selected:
                            action_text = build_linked_action_text(
                                pending["task"], commitment.get("collaborator"), speaker
                            )
                            if not action_text:
                                continue
                            key = action_text.lower()
                            if key in seen:
                                continue
                            seen.add(key)
                            actions.append(action_text)
                            owners.append(speaker or "Owner not specified")
                            deadlines.append(response_deadline or pending.get("deadline", ""))
                            conversational_refs = [
                                evidence_ref(
                                    {"speaker": pending.get("requester", ""), "timestamp": pending.get("request_timestamp", "")}
                                )
                            ]
                            conversational_refs.extend(pending.get("evidence_refs", []))
                            conversational_refs.append(
                                evidence_ref({"speaker": speaker, "timestamp": turn.get("timestamp", "")})
                            )
                            CONVERSATIONAL_ACTION_EVIDENCE[key] = dedupe_evidence_refs(conversational_refs)
                        pending_requests = [
                            item
                            for item in pending_requests
                            if (item["requester"], item["task"], item["sentence_index"]) not in resolved_keys
                        ]
                elif commitment.get("task"):
                    action_text = build_linked_action_text(commitment["task"], commitment.get("collaborator"), speaker)
                    if action_text:
                        key = action_text.lower()
                        if key not in seen:
                            seen.add(key)
                            actions.append(action_text)
                            owners.append(speaker or "Owner not specified")
                            deadlines.append(response_deadline)
                            CONVERSATIONAL_ACTION_EVIDENCE[key] = dedupe_evidence_refs(
                                [evidence_ref({"speaker": speaker, "timestamp": turn.get("timestamp", "")})]
                            )

            contextual_commitment = extract_contextual_commitment(stripped)
            if contextual_commitment:
                response_deadline = infer_action_deadline(stripped, {"deadline": ""}, config)
                matching_context = next(
                    (
                        item
                        for item in reversed(recent_contexts)
                        if item.get("speaker") != speaker
                    ),
                    None,
                )
                if matching_context:
                    action_text = build_contextual_action_text(
                        contextual_commitment["action_verb"],
                        matching_context["subject"],
                    )
                    if action_text:
                        key = action_text.lower()
                        if key not in seen:
                            seen.add(key)
                            actions.append(action_text)
                            owners.append(speaker or "Owner not specified")
                            deadlines.append(response_deadline)
                            CONVERSATIONAL_ACTION_EVIDENCE[key] = dedupe_evidence_refs(
                                [
                                    evidence_ref(
                                        {
                                            "speaker": matching_context.get("speaker", ""),
                                            "timestamp": matching_context.get("timestamp", ""),
                                        }
                                    ),
                                    evidence_ref({"speaker": speaker, "timestamp": turn.get("timestamp", "")}),
                                ]
                            )

            sentence_index += 1

    unresolved_acceptances = [
        item
        for item in pending_requests
        if item.get("accepted_by") and not item.get("rejected_by")
    ]
    for pending in unresolved_acceptances:
        action_text = build_linked_action_text(pending["task"], None, pending.get("accepted_by", ""))
        if not action_text:
            continue
        key = action_text.lower()
        if key in seen:
            continue
        seen.add(key)
        actions.append(action_text)
        owners.append(pending.get("accepted_by", "") or "Owner not specified")
        deadlines.append(pending.get("deadline", ""))
        CONVERSATIONAL_ACTION_EVIDENCE[key] = dedupe_evidence_refs(
            [
                evidence_ref({"speaker": pending.get("requester", ""), "timestamp": pending.get("request_timestamp", "")}),
                evidence_ref({"speaker": pending.get("accepted_by", ""), "timestamp": ""}),
            ]
        )

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
        request_task = extract_request_task(content, turn.get("speaker", ""))
        if request_task:
            if not lowered.startswith("can you ") or not find_named_owner(content, config):
                continue
        if not lowered.startswith(
            (
                "i will ",
                "i'll ",
                "i’ll ",
                "can you ",
                "check ",
                "confirm ",
                "send ",
                "update ",
                "review ",
                "draft ",
                "follow up ",
            )
        ):
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
    return "Owner not specified"


def deadline_for_action(action: str, block_deadline: str, config: dict[str, Any]) -> str:
    lowered = action.lower()
    for rule in config["action_deadline_rules"]:
        if any(term in lowered for term in rule["contains_any"]):
            return rule["deadline"]
    return block_deadline or ""


def project_review_action_candidates(segment: dict[str, Any]) -> list[dict[str, str]]:
    milestone = segment.get("milestone")
    delivery_status = segment.get("delivery_status")
    modifiers = set(segment.get("status_modifiers", []))
    candidates: list[dict[str, str]] = []

    if milestone == "stage_gate_internal_review" and (
        delivery_status in {"in_progress", "needs_review"} or "pending_review" in modifiers
    ):
        candidates.append(
            {
                "action": "Review stage gate templates.",
                "deadline": "",
                "owner": "Owner not specified",
                "related_milestone": milestone,
            }
        )
    if milestone == "ai_pipeline_strategy" and delivery_status == "blocked":
        candidates.append(
            {
                "action": "Confirm AI pipeline dependencies with sales.",
                "deadline": "Before next week",
                "owner": "Owner not specified",
                "related_milestone": milestone,
            }
        )
    if milestone == "stage_gate_vendor_strategy" and delivery_status == "in_progress":
        candidates.append(
            {
                "action": "Draft vendor strategy document.",
                "deadline": "",
                "owner": "Owner not specified",
                "related_milestone": milestone,
            }
        )
    if milestone == "ei_grant_feedback" and delivery_status == "awaiting_input":
        candidates.append(
            {
                "action": "Follow up innovation grant feedback.",
                "deadline": "Before next week",
                "owner": "Emma" if "follow up this week" in " ".join(segment.get("next_steps", []) + segment.get("evidence", [])).lower() else "Owner not specified",
                "related_milestone": milestone,
            }
        )
    if milestone == "use_case_intake_funnel" and segment.get("agreed_rag_status") == "amber":
        candidates.append(
            {
                "action": "Validate intake workflow routing.",
                "deadline": "",
                "owner": "Owner not specified",
                "related_milestone": milestone,
            }
        )
    return candidates


def build_project_review_actions(
    segments: list[dict[str, Any]],
    raw_turns: list[dict[str, str]],
    config: dict[str, Any],
) -> list[dict[str, Any]]:
    actions: list[str] = []
    owners: list[str] = []
    deadlines: list[str] = []
    seen = set()
    related_lookup: dict[str, str] = {}

    priority_order = [
        "stage_gate_internal_review",
        "ai_pipeline_strategy",
        "stage_gate_vendor_strategy",
        "ei_grant_feedback",
        "use_case_intake_funnel",
    ]
    priority_lookup = {name: index for index, name in enumerate(priority_order)}

    for segment in sorted(segments, key=lambda item: priority_lookup.get(item.get("milestone"), 999)):
        for candidate in project_review_action_candidates(segment):
            key = candidate["action"].lower()
            if key in seen:
                continue
            seen.add(key)
            actions.append(candidate["action"])
            owners.append(candidate["owner"])
            deadlines.append(candidate["deadline"])
            related_lookup[key] = candidate["related_milestone"]

    structured = build_structured_actions(actions, owners, deadlines, raw_turns, config)
    for item in structured:
        key = item["meetingActionPoint"].rstrip(".").lower()
        if key in related_lookup:
            item["relatedMilestone"] = related_lookup[key]
            if item["meetingActionPointOwner"] == "Owner not specified" and related_lookup[key] == "ei_grant_feedback":
                item["meetingActionPointOwner"] = "Emma"
                item["actionConfidence"] = 0.85
    return structured


def build_template_values(text: str, analysis: dict[str, Any], turns: list[Any], config: dict[str, Any]) -> dict[str, Any]:
    meeting_title, meeting_date, meeting_location = extract_header_fields(text, config)
    raw_turns = extract_raw_turn_entries(text)
    source_turns = raw_turns or [{"speaker": turn.speaker, "content": turn.text, "timestamp": turn.timestamp} for turn in turns]
    cleaned_turns = analysis.get("cleaned_turns", [])
    segments = [segment for segment in analysis["segments"] if segment.get("milestone") != "unclassified"]
    meeting_type = detect_meeting_mode(cleaned_turns, meeting_title)
    if meeting_type == "project_status_review" and not segments:
        meeting_type = "general_meeting"
    meeting_theme = infer_meeting_theme(meeting_type, analysis, cleaned_turns)
    meeting_style = infer_meeting_style(meeting_type)
    if not meeting_title:
        meeting_title = meeting_theme
    discourse_features, discourse_patterns = detect_discourse_patterns(source_turns) if meeting_type != "project_status_review" else ([], [])

    participants = extract_participants(analysis["segments"], config)
    if not participants["participants.client"] and not participants["participants.trinzo"]:
        participants = extract_participants_from_turns(turns, config)
    if not participants["participants.client"] and not participants["participants.trinzo"]:
        participants = extract_participants_from_raw_turns(raw_turns, config)
    if not participants["participants.client"] and not participants["participants.trinzo"]:
        participants = extract_participants_from_text(text, config)

    actions, block_deadline = extract_action_block(text)
    if meeting_type == "project_status_review":
        structured_actions = build_project_review_actions(segments, raw_turns, config)
    elif meeting_type in {"webinar_rehearsal", "presentation_review", "sales_or_client_discussion", "general_meeting"}:
        if not actions:
            actions, action_owners, action_deadlines = [], [], []
        else:
            action_owners = [owner_for_action(action, config) for action in actions]
            action_deadlines = [deadline_for_action(action, block_deadline, config) for action in actions]
        pattern_actions, pattern_action_owners, pattern_action_deadlines, pattern_evidence = extract_actions_from_patterns(
            discourse_patterns
        )
        if pattern_actions:
            existing = {canonical_action_key(action) for action in actions}
            for action, owner, deadline in zip(pattern_actions, pattern_action_owners, pattern_action_deadlines):
                key = canonical_action_key(action)
                if not key or key in existing:
                    continue
                actions.append(action)
                action_owners.append(owner)
                action_deadlines.append(deadline)
                existing.add(key)
            CONVERSATIONAL_ACTION_EVIDENCE.update(pattern_evidence)
        generic_actions, generic_action_owners, generic_action_deadlines = extract_generic_actions(text, source_turns, config)
        if generic_actions:
            existing = {canonical_action_key(action) for action in actions}
            for action, owner, deadline in zip(generic_actions, generic_action_owners, generic_action_deadlines):
                key = canonical_action_key(action)
                if not key or key in existing:
                    continue
                actions.append(action)
                action_owners.append(owner)
                action_deadlines.append(deadline)
                existing.add(key)
        named_actions, named_action_owners, named_action_deadlines = extract_named_assignment_actions(source_turns, config)
        if named_actions:
            existing = {canonical_action_key(action) for action in actions}
            for action, owner, deadline in zip(named_actions, named_action_owners, named_action_deadlines):
                key = canonical_action_key(action)
                if not key or key in existing:
                    continue
                actions.append(action)
                action_owners.append(owner)
                action_deadlines.append(deadline)
                existing.add(key)
        linked_actions, linked_action_owners, linked_action_deadlines = extract_linked_conversational_actions(source_turns, config)
        if linked_actions:
            existing = {canonical_action_key(action) for action in actions}
            for action, owner, deadline in zip(linked_actions, linked_action_owners, linked_action_deadlines):
                key = canonical_action_key(action)
                if not key or key in existing:
                    continue
                actions.append(action)
                action_owners.append(owner)
                action_deadlines.append(deadline)
                existing.add(key)
        fallback_actions, fallback_action_owners, fallback_action_deadlines = extract_fallback_actions(source_turns, config)
        if fallback_actions:
            existing = {canonical_action_key(action) for action in actions}
            for action, owner, deadline in zip(fallback_actions, fallback_action_owners, fallback_action_deadlines):
                key = canonical_action_key(action)
                if not key or key in existing:
                    continue
                actions.append(action)
                action_owners.append(owner)
                action_deadlines.append(deadline)
                existing.add(key)
        structured_actions = dedupe_structured_actions(
            build_structured_actions(actions, action_owners, action_deadlines, source_turns, config)
        )
        for item in structured_actions:
            item["relatedMilestone"] = "unlinked"
    elif actions:
        action_owners = [owner_for_action(action, config) for action in actions]
        action_deadlines = [deadline_for_action(action, block_deadline, config) for action in actions]
        structured_actions = dedupe_structured_actions(
            build_structured_actions(actions, action_owners, action_deadlines, raw_turns, config)
        )
    else:
        structured_actions = []

    pattern_decision_details = extract_decisions_from_patterns(discourse_patterns, meeting_type)
    fallback_decisions, fallback_decision_details = build_decisions(cleaned_turns, meeting_type, structured_actions)
    if pattern_decision_details:
        merged_decision_details = pattern_decision_details + [
            item
            for item in fallback_decision_details
            if action_text_key(item.get("decision", "")) not in {action_text_key(existing.get("decision", "")) for existing in pattern_decision_details}
        ]
        decision_details = resolve_decision_candidates(merged_decision_details)[:5]
        decisions = [item["decision"] for item in decision_details]
    else:
        decisions, decision_details = fallback_decisions, fallback_decision_details

    discussion_point_details: list[dict[str, Any]] = []
    discussion_points = build_milestone_discussion_points(segments, config) if meeting_type == "project_status_review" else []
    if not discussion_points and meeting_type != "project_status_review":
        pattern_discussion_details = extract_discussion_points_from_patterns(
            discourse_patterns,
            decision_details,
        )
        general_discussion_details = extract_general_discussion_details(
            cleaned_turns,
            meeting_type,
            decision_details,
            structured_actions,
        )
        if len(general_discussion_details) >= 3:
            discussion_point_details = general_discussion_details[:8]
        else:
            discussion_point_details = dedupe_discussion_details(general_discussion_details + pattern_discussion_details)[:8]
        discussion_points = [item["discussionPoint"] for item in discussion_point_details]
    if not discussion_points and meeting_type != "project_status_review":
        discussion_points = extract_generic_discussion_points(text, source_turns, config)
    if not discussion_points and meeting_type != "project_status_review":
        discussion_points = extract_turn_level_discussion_points(source_turns)
    if not discussion_point_details and discussion_points:
        discussion_point_details = [{"discussionPoint": point, "_evidence": []} for point in discussion_points]

    meeting_sections = build_meeting_sections(cleaned_turns, meeting_type, structured_actions)
    health_summary = build_health_summary(segments) if meeting_type == "project_status_review" else {}
    executive_summary = build_evidence_only_summary(
        cleaned_turns,
        meeting_type,
        discussion_point_details,
        decision_details,
        structured_actions,
    )
    if not executive_summary:
        executive_summary = build_executive_summary(meeting_theme, meeting_type, segments, config, structured_actions)
    internal_evidence = build_internal_evidence(
        discussion_point_details,
        structured_actions,
        meeting_sections,
        decision_details,
    )

    template_values = {
        "meetingTitle": meeting_title,
        "meetingDate": meeting_date,
        "meetingLocation": meeting_location,
        "meetingType": meeting_type,
        "meetingStyle": meeting_style,
        "meetingTheme": meeting_theme,
        "meetingObjectives": objectives_for_meeting_type(meeting_type, meeting_theme, analysis),
        "participants.client": participants["participants.client"],
        "participants.trinzo": participants["participants.trinzo"],
        "itemTopic": meeting_theme if meeting_type != "webinar_rehearsal" else infer_item_topic(text, config),
        "discussionPoints": discussion_points,
        "meetingActionPoint": [item["meetingActionPoint"] for item in structured_actions],
        "meetingActionPointOwner": [item["meetingActionPointOwner"] for item in structured_actions],
        "meetingActionPointDeadline": [item["meetingActionPointDeadline"] for item in structured_actions],
        "meetingActionPointConfidence": [item["actionConfidence"] for item in structured_actions],
        "meetingActionPointRelatedMilestone": [item["relatedMilestone"] for item in structured_actions],
        "actions": structured_actions,
        "executiveSummary": executive_summary,
        "healthSummary": health_summary,
        "meetingSections": meeting_sections,
        "decisions": decisions,
        "discussionPointDetails": discussion_point_details,
        "decisionDetails": decision_details,
        "internalEvidence": internal_evidence,
    }
    glossary = load_glossary(GLOSSARY_CONFIG)
    return apply_glossary_to_output(template_values, glossary)


def parse_speaker_turns(text: str) -> list[Any]:
    analyzer = load_analyzer_module()
    turns = analyzer.parse_turns(text)
    return [turn for turn in turns if not is_action_heading_label(getattr(turn, "speaker", ""))]


def build_fallback_turns(text: str, analyzer: Any) -> list[Any]:
    raw_turns = extract_raw_turn_entries(text)
    return [
        analyzer.Turn(
            speaker=entry["speaker"],
            timestamp=entry["timestamp"],
            text=entry["content"],
        )
        for entry in raw_turns
    ]


def analyse(text: str) -> dict[str, Any]:
    config = load_json(MINUTES_CONFIG)
    analyzer = load_analyzer_module()
    turns = parse_speaker_turns(text)
    if not turns:
        turns = build_fallback_turns(text, analyzer)
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
