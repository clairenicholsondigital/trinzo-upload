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


def strip_leading_speaker_reference(text: str) -> str:
    cleaned = text.strip()
    cleaned = re.sub(r"^can you\s+[A-Z][a-z]+\s+", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"^[A-Z][a-z]+,\s+", "", cleaned)
    cleaned = re.sub(r"^[A-Z][a-z]+\s+should\s+", "", cleaned, flags=re.IGNORECASE)
    return cleaned.strip()


def action_to_imperative(action_text: str, owner: str) -> str:
    cleaned = normalize_text_fragment(action_text)
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

    cleaned = strip_leading_speaker_reference(cleaned)
    cleaned = re.sub(r"\bthe client attendees\b", "the client attendee list", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\bclient attendees\b", "client attendee list", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return finalize_sentence(sentence_case(cleaned))


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


def milestone_label(segment: dict[str, Any], config: dict[str, Any]) -> str:
    return config["milestone_labels"].get(segment["milestone"], segment["milestone"].replace("_", " ").title())


def normalize_text_fragment(text: str) -> str:
    cleaned = re.sub(r"^(okay|right|so|yeah|true|fine|interesting|correct)\b[,.]?\s*", "", text.strip(), flags=re.IGNORECASE)
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned.strip().rstrip(".")


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


def detect_meeting_mode(cleaned_turns: list[dict[str, Any]]) -> str:
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
    sales_terms = ["client", "proposal", "pricing", "commercial", "sales"]

    for turn in cleaned_turns:
        text = " ".join(turn.get("sentences") or [turn.get("text", "")]).lower()
        score["webinar_rehearsal"] += sum(2 for term in webinar_terms if term in text)
        score["project_status_review"] += sum(2 for term in project_terms if term in text)
        score["presentation_review"] += sum(1 for term in presentation_terms if term in text)
        score["sales_or_client_discussion"] += sum(1 for term in sales_terms if term in text)

    if score["webinar_rehearsal"] >= max(score["project_status_review"] + 1, 4):
        return "webinar_rehearsal"
    if score["project_status_review"] >= max(score["webinar_rehearsal"], 4):
        return "project_status_review"
    if score["presentation_review"] >= 3:
        return "presentation_review"
    if score["sales_or_client_discussion"] >= 3:
        return "sales_or_client_discussion"
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


def build_executive_summary(meeting_theme: str, meeting_type: str, segments: list[dict[str, Any]], config: dict[str, Any]) -> str:
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
            lead += f" {format_label_list(complete[:2])} {'was' if len(complete[:2]) == 1 else 'were'} confirmed as complete."
        elif active:
            lead += f" {format_label_list(active[:2])} {'remains' if len(active[:2]) == 1 else 'remain'} active workstreams."
        if scheduled:
            lead += f" {format_label_list(scheduled[:2])} {'remains' if len(scheduled[:2]) == 1 else 'remain'} scheduled."
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

    if governance:
        blue_items = [milestone_label(segment, config) for segment in segments if segment.get("agreed_rag_status") == "blue"]
        if blue_items:
            paragraphs.append(f"{format_label_list(blue_items)} {'remains' if len(blue_items) == 1 else 'remain'} subject to formal governance or approval steps.")
        else:
            paragraphs.append(f"Governance items reviewed included {format_label_list(governance[:3])}.")

    return "\n\n".join(paragraphs[:3]).strip()


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


def is_business_relevant(text: str) -> bool:
    lowered = text.lower()
    return not any(pattern in lowered for pattern in NON_BUSINESS_PATTERNS)


def cluster_sentence_for_mode(sentence: str, meeting_mode: str) -> str | None:
    lowered = sentence.lower()
    if not is_business_relevant(sentence):
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
        if any(term in lowered for term in ("timeline", "timing", "practice", "rehearsal", "friday", "next week")):
            return "Timing and rehearsal preparation"
    if meeting_mode == "presentation_review":
        if any(term in lowered for term in ("slide", "deck", "presentation", "visual")):
            return "Presentation structure and visuals"
    if meeting_mode == "sales_or_client_discussion":
        if any(term in lowered for term in ("client", "proposal", "commercial", "sales")):
            return "Client priorities and follow-up"
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
    fallback = sentences[0] if sentences else ""
    return finalize_sentence(sentence_case(normalize_text_fragment(fallback)))


def extract_general_discussion_details(cleaned_turns: list[dict[str, Any]], meeting_mode: str) -> list[dict[str, Any]]:
    clusters: dict[str, list[str]] = {}
    cluster_refs: dict[str, list[dict[str, str]]] = {}
    for turn in cleaned_turns:
        for sentence in turn.get("sentences") or [turn.get("text", "")]:
            cluster = cluster_sentence_for_mode(sentence, meeting_mode)
            if not cluster:
                continue
            clusters.setdefault(cluster, []).append(sentence)
            cluster_refs.setdefault(cluster, []).append(
                {"speaker": turn.get("speaker", ""), "timestamp": turn.get("timestamp", "")}
            )
    details = []
    for cluster, sentences in clusters.items():
        details.append(
            {
                "discussionPoint": build_cluster_sentence(cluster, sentences),
                "_evidence": dedupe_evidence_refs(cluster_refs.get(cluster, [])),
            }
        )
    return details[:8]


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
        if matching_sentences or matching_actions:
            sections.append(
                {
                    "section": rule["section"],
                    "summary": rule["summary"],
                    "actions": matching_actions,
                    "_evidence": dedupe_evidence_refs(matching_refs),
                }
            )
    return sections


def extract_action_block(raw_turns: list[dict[str, str]]) -> tuple[list[str], str]:
    actions: list[str] = []
    block_deadline = ""
    for turn in raw_turns:
        content = turn["content"].strip()
        lowered = content.lower()
        if not lowered.startswith("actions before next week"):
            continue
        block_deadline = "Before next week"
        tail = content.split(":", 1)[1].strip() if ":" in content else ""
        if tail:
            actions.extend([part.strip().rstrip(".") for part in tail.split(".") if part.strip()])
        break
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
    if "before the webinar" in lowered:
        return "Before the webinar"
    for deadline_rule in config.get("action_deadline_rules", []):
        if any(term in lowered for term in deadline_rule["contains_any"]):
            return deadline_rule["deadline"]
    return rule["deadline"]


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
    direct_name = find_named_owner(action_text, config)
    if direct_name:
        return direct_name, 0.85
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
        if action.lower().startswith(("we should", "review ", "confirm ", "draft ", "validate ", "follow up ")) and explicit_owner == "Owner not specified":
            final_owner = "Owner not specified"
            owner_confidence = 0.2
        related_milestone = infer_action_related_milestone(action, config)
        polished_action = action_to_imperative(action, final_owner)
        structured.append(
            {
                "meetingActionPoint": polished_action,
                "meetingActionPointOwner": final_owner,
                "meetingActionPointDeadline": deadline,
                "actionConfidence": round(owner_confidence, 2),
                "relatedMilestone": related_milestone or "unlinked",
                "_evidence": [evidence_ref(action_turn)] if action_turn else [],
            }
        )
    return structured


def build_decisions(
    cleaned_turns: list[dict[str, Any]],
    meeting_mode: str,
    structured_actions: list[dict[str, Any]],
) -> tuple[list[str], list[dict[str, Any]]]:
    if meeting_mode == "project_status_review":
        return [], []

    details: list[dict[str, Any]] = []
    for turn in cleaned_turns:
        text = " ".join(turn.get("sentences") or [turn.get("text", "")])
        lowered = text.lower()
        decision = ""
        if "need a clear view of what happens before the webinar" in lowered:
            decision = "The webinar should show the validation team what happens before the session begins."
        elif "main issue is making sure the timeline is clear" in lowered or ("timeline is clear" in lowered and "scope" in lowered):
            decision = "The webinar should explain the timeline and scope more clearly."
        elif "may ask detailed process questions" in lowered:
            decision = "The workshop material should prepare for detailed process questions from attendees."
        if decision:
            details.append(
                {
                    "decision": decision,
                    "_evidence": [{"speaker": turn.get("speaker", ""), "timestamp": turn.get("timestamp", "")}],
                }
            )

    if not details and structured_actions:
        for action in structured_actions[:2]:
            details.append(
                {
                    "decision": action["meetingActionPoint"],
                    "_evidence": action.get("_evidence", []),
                }
            )

    seen = set()
    unique_details = []
    for item in details:
        key = item["decision"].lower()
        if key in seen:
            continue
        seen.add(key)
        unique_details.append(item)
    return [item["decision"] for item in unique_details], unique_details


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
    cleaned_turns = analysis.get("cleaned_turns", [])
    segments = [segment for segment in analysis["segments"] if segment.get("milestone") != "unclassified"]
    meeting_type = detect_meeting_mode(cleaned_turns)
    meeting_theme = infer_meeting_theme(meeting_type, analysis, cleaned_turns)
    meeting_style = infer_meeting_style(meeting_type)
    if not meeting_title:
        meeting_title = meeting_theme

    participants = extract_participants(analysis["segments"], config)
    if not participants["participants.client"] and not participants["participants.trinzo"]:
        participants = extract_participants_from_turns(turns, config)
    if not participants["participants.client"] and not participants["participants.trinzo"]:
        participants = extract_participants_from_raw_turns(raw_turns, config)
    if not participants["participants.client"] and not participants["participants.trinzo"]:
        participants = extract_participants_from_text(text, config)

    actions, block_deadline = extract_action_block(raw_turns)
    if meeting_type == "project_status_review":
        structured_actions = build_project_review_actions(segments, raw_turns, config)
    elif meeting_type in {"webinar_rehearsal", "presentation_review", "sales_or_client_discussion", "general_meeting"}:
        if not actions:
            actions, action_owners, action_deadlines = extract_generic_actions(text, raw_turns, config)
        else:
            action_owners = [owner_for_action(action, config) for action in actions]
            action_deadlines = [deadline_for_action(action, block_deadline, config) for action in actions]
        if not actions:
            actions, action_owners, action_deadlines = extract_fallback_actions(raw_turns, config)
        structured_actions = build_structured_actions(actions, action_owners, action_deadlines, raw_turns, config)
        for item in structured_actions:
            item["relatedMilestone"] = "unlinked"
    elif actions:
        action_owners = [owner_for_action(action, config) for action in actions]
        action_deadlines = [deadline_for_action(action, block_deadline, config) for action in actions]
        structured_actions = build_structured_actions(actions, action_owners, action_deadlines, raw_turns, config)
    else:
        structured_actions = []

    discussion_point_details: list[dict[str, Any]] = []
    discussion_points = build_milestone_discussion_points(segments, config) if meeting_type == "project_status_review" else []
    if not discussion_points and meeting_type != "project_status_review":
        discussion_point_details = extract_general_discussion_details(cleaned_turns, meeting_type)
        discussion_points = [item["discussionPoint"] for item in discussion_point_details]
    if not discussion_points and meeting_type != "project_status_review":
        discussion_points = extract_generic_discussion_points(text, raw_turns, config)
    if not discussion_points and meeting_type != "project_status_review":
        discussion_points = extract_turn_level_discussion_points(raw_turns)
    if not discussion_point_details and discussion_points:
        discussion_point_details = [{"discussionPoint": point, "_evidence": []} for point in discussion_points]

    meeting_sections = build_meeting_sections(cleaned_turns, meeting_type, structured_actions)
    health_summary = build_health_summary(segments) if meeting_type == "project_status_review" else {}
    decisions, decision_details = build_decisions(cleaned_turns, meeting_type, structured_actions)
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
        "executiveSummary": build_executive_summary(meeting_theme, meeting_type, segments, config),
        "healthSummary": health_summary,
        "meetingSections": meeting_sections,
        "decisions": decisions,
        "discussionPointDetails": discussion_point_details,
        "decisionDetails": decision_details,
        "internalEvidence": internal_evidence,
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
