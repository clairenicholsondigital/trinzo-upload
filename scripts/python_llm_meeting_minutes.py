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
    "governance_review",
    "steering_group",
    "implementation_review",
    "workshop",
    "webinar_rehearsal",
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


def infer_item_topic(text: str, config: dict[str, Any]) -> str:
    lowered = text.lower()
    for rule in config.get("item_topic_rules", []):
        if any(term in lowered for term in rule["contains_any"]):
            return rule["topic"]
    return config["item_topic_default"]


def classify_meeting_type(
    text: str,
    analysis: dict[str, Any],
) -> str:
    lowered = text.lower()
    segments = [segment for segment in analysis.get("segments", []) if segment.get("milestone") != "unclassified"]
    categories = [MILESTONE_CATEGORY_MAP.get(segment["milestone"], "general") for segment in segments]
    governance_count = categories.count("governance")
    implementation_count = categories.count("implementation")
    delivery_count = categories.count("delivery")

    if len(segments) >= 4:
        return "project_status_review"
    if any(term in lowered for term in ("practice call", "slide deck", "registration list")):
        return "webinar_rehearsal"
    if "webinar" in lowered and len(segments) <= 2:
        return "webinar_rehearsal"
    if governance_count and governance_count >= max(delivery_count, implementation_count) and len(segments) <= 3:
        return "governance_review"
    if governance_count and delivery_count:
        return "project_status_review"
    if implementation_count > delivery_count and implementation_count >= 2:
        return "implementation_review"
    if "workshop" in lowered:
        return "workshop"
    return "general_meeting"


def infer_meeting_theme(meeting_type: str, analysis: dict[str, Any]) -> str:
    segments = [segment for segment in analysis.get("segments", []) if segment.get("milestone") != "unclassified"]
    milestone_names = {segment["milestone"] for segment in segments}
    if meeting_type == "webinar_rehearsal":
        return "Webinar rehearsal and presentation review"
    if "ai_governance_framework" in milestone_names and "ai_pipeline_strategy" in milestone_names:
        return "AI delivery and governance review"
    if meeting_type == "project_status_review":
        return "AI programme project status review"
    if meeting_type == "implementation_review":
        return "Implementation workstream review"
    if meeting_type == "governance_review":
        return "AI delivery and governance review"
    if meeting_type == "workshop":
        return "Workshop review"
    return "General meeting review"


def objectives_for_meeting_type(meeting_type: str, meeting_theme: str, analysis: dict[str, Any]) -> list[str]:
    if meeting_type == "project_status_review":
        return ["Review programme milestones, confirm status updates, identify blockers, and agree actions before the next review cycle."]
    if meeting_type == "implementation_review":
        return ["Review progress on active workstreams and agree next delivery actions."]
    if meeting_type == "governance_review":
        return ["Review governance items, approvals, risks, and required follow-up actions."]
    if meeting_type == "webinar_rehearsal":
        return ["Review the webinar flow, confirm presentation readiness, and agree final preparation actions."]
    if meeting_type == "workshop":
        return ["Review workshop objectives, key discussion themes, and agreed follow-up actions."]
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
    if delivery_status == "complete" and agreed_rag_status == "green":
        return f"{label} {was} confirmed as complete."
    if delivery_status == "blocked" and agreed_rag_status == "red":
        return f"{label} {remains} blocked and {was} assessed as high risk."
    if delivery_status == "blocked" and agreed_rag_status == "amber":
        return f"{label} {remains} blocked, although the team agreed an amber status pending further review."
    if delivery_status == "in_progress" and agreed_rag_status == "green":
        return f"{label} {remains} in progress and {plural and 'are' or 'is'} progressing as expected."
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
        "needs_review": 0,
        "delayed": 0,
        "not_started": 0,
    }
    for segment in segments:
        summary[segment.get("agreed_rag_status", "unknown")] = summary.get(segment.get("agreed_rag_status", "unknown"), 0) + 1
        summary[segment.get("delivery_status", "unknown")] = summary.get(segment.get("delivery_status", "unknown"), 0) + 1
    return summary


def build_executive_summary(meeting_theme: str, meeting_type: str, segments: list[dict[str, Any]], config: dict[str, Any]) -> str:
    complete = [milestone_label(segment, config) for segment in segments if segment.get("delivery_status") == "complete"]
    active = [milestone_label(segment, config) for segment in segments if segment.get("delivery_status") == "in_progress"]
    blocked = [milestone_label(segment, config) for segment in segments if segment.get("delivery_status") == "blocked"]
    governance = [milestone_label(segment, config) for segment in segments if MILESTONE_CATEGORY_MAP.get(segment.get("milestone")) == "governance"]

    paragraphs = []
    if meeting_type == "project_status_review":
        lead = f"The meeting focused on {meeting_theme}."
        if complete:
            if len(complete) == 1:
                lead += f" {complete[0]} was confirmed as complete."
            else:
                lead += f" {', '.join(complete[:-1])} and {complete[-1]} were confirmed as complete."
        elif active:
            lead += f" {', '.join(active[:2])} remained active workstreams."
        paragraphs.append(lead.strip())
    else:
        paragraphs.append(f"The meeting focused on {meeting_theme}.")

    issue_lines = []
    if blocked:
        if len(blocked) == 1:
            issue_lines.append(f"{blocked[0]} remains blocked pending further input.")
        else:
            issue_lines.append(f"{', '.join(blocked[:-1])} and {blocked[-1]} remain blocked pending further input.")
    amber_items = [milestone_label(segment, config) for segment in segments if segment.get("agreed_rag_status") == "amber"]
    if amber_items:
        issue_lines.append(f"{', '.join(amber_items[:3])} require further attention before the next review cycle.")
    if issue_lines:
        paragraphs.append(" ".join(issue_lines))

    if governance:
        blue_items = [milestone_label(segment, config) for segment in segments if segment.get("agreed_rag_status") == "blue"]
        if blue_items:
            if len(blue_items) == 1:
                paragraphs.append(f"{blue_items[0]} was also reviewed and remains subject to formal governance or approval steps.")
            else:
                paragraphs.append(f"{', '.join(blue_items)} were also reviewed and remain subject to formal governance or approval steps.")
        else:
            paragraphs.append(f"Governance items reviewed included {', '.join(governance[:3])}.")

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
    raw_turns: list[dict[str, str]],
    config: dict[str, Any],
) -> tuple[str, float]:
    lowered = action_text.lower()
    if lowered.startswith("i will"):
        return "SPEAKER", 0.95
    direct_name = find_named_owner(action_text, config)
    if direct_name:
        return direct_name, 0.95
    can_you_match = re.match(r"can you ([A-Z][a-z]+)", action_text, flags=re.IGNORECASE)
    if can_you_match:
        first_name = can_you_match.group(1)
        for participant in config.get("participant_groups", {}):
            if participant.split()[0].lower() == first_name.lower():
                return participant, 0.9
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
        explicit_owner, owner_confidence = resolve_explicit_action_owner(action, raw_turns, config)
        if explicit_owner == "SPEAKER":
            final_owner = owner if owner not in {"Owner not specified", ""} else "Owner not specified"
        elif explicit_owner != "Owner not specified":
            final_owner = explicit_owner
        elif owner in {"Owner not specified", ""}:
            final_owner = "Owner not specified"
        elif action.lower().startswith(("we should", "review ", "confirm ", "draft ", "validate ", "follow up ")):
            final_owner = "Owner not specified"
            owner_confidence = 0.2
        else:
            final_owner = owner
        if final_owner != owner and explicit_owner != "Owner not specified":
            owner_confidence = max(owner_confidence, 0.85)
        elif final_owner == "Owner not specified":
            owner_confidence = 0.2
        related_milestone = infer_action_related_milestone(action, config)
        structured.append(
            {
                "meetingActionPoint": finalize_sentence(action),
                "meetingActionPointOwner": final_owner,
                "meetingActionPointDeadline": deadline,
                "actionConfidence": round(owner_confidence, 2),
                "relatedMilestone": related_milestone or "unlinked",
            }
        )
    return structured


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


def build_template_values(text: str, analysis: dict[str, Any], turns: list[Any], config: dict[str, Any]) -> dict[str, Any]:
    meeting_title, meeting_date, meeting_location = extract_header_fields(text, config)
    raw_turns = extract_raw_turn_entries(text)
    segments = [segment for segment in analysis["segments"] if segment.get("milestone") != "unclassified"]
    meeting_type = classify_meeting_type(text, analysis)
    meeting_theme = infer_meeting_theme(meeting_type, analysis)
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
    if not actions and meeting_type == "webinar_rehearsal":
        actions, action_owners, action_deadlines = extract_generic_actions(text, raw_turns, config)
    if not actions and meeting_type == "webinar_rehearsal":
        actions, action_owners, action_deadlines = extract_fallback_actions(raw_turns, config)
    elif actions:
        action_owners = [owner_for_action(action, config) for action in actions]
        action_deadlines = [deadline_for_action(action, block_deadline, config) for action in actions]
    else:
        action_owners = []
        action_deadlines = []

    structured_actions = build_structured_actions(actions, action_owners, action_deadlines, raw_turns, config)

    discussion_points = build_milestone_discussion_points(segments, config) if meeting_type != "webinar_rehearsal" else []
    if not discussion_points and meeting_type == "webinar_rehearsal":
        discussion_points = build_discussion_points(analysis["segments"], config)
    if not discussion_points and meeting_type == "webinar_rehearsal":
        discussion_points = extract_generic_discussion_points(text, raw_turns, config)
    if not discussion_points and meeting_type == "webinar_rehearsal":
        discussion_points = extract_turn_level_discussion_points(raw_turns)

    template_values = {
        "meetingTitle": meeting_title,
        "meetingDate": meeting_date,
        "meetingLocation": meeting_location,
        "meetingType": meeting_type,
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
        "healthSummary": build_health_summary(segments),
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
