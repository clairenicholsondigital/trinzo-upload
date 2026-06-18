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

FIXED_HEALTH_AREAS = ["scope", "schedule", "financial", "resources", "other_issue_risk"]

PROJECT_ACTION_PROTOTYPES = [
    "A concrete next action is assigned or proposed for the project.",
    "The team needs to do a specific follow-up task after this project update.",
    "A project owner should complete, confirm, review, draft, validate, or enforce a specific action.",
    "There is a clear action item with an object, deliverable, owner, dependency, or follow-up target.",
]

PROJECT_SIGNAL_PROTOTYPES = {
    "overall_status": [
        "overall project status or RAG position is stable, green, amber, red, on track, or changing",
        "the dashboard status is calm but there is nuance under the surface",
    ],
    "delivery_pressure": [
        "delivery pressure, compression, capacity strain, or execution bandwidth is affecting the project",
        "pipeline demand and delivery execution are mismatched",
    ],
    "capability_risk": [
        "key personnel attrition, single points of failure, skills gaps, documentation, or cross-training are risks",
        "AI delivery and technical architecture capability or redundancy is weak",
    ],
    "governance_risk": [
        "vendor governance, ownership, due diligence, partner framework, or decision authority is unclear",
        "no single owner or formal framework creates project governance risk",
    ],
    "milestone_progress": [
        "a milestone, deliverable, training, webinar, roadmap, framework, policy, or funding decision is complete or in progress",
        "forecast dates, baseline dates, delivered work, or completed project outputs are discussed",
    ],
    "leading_indicators": [
        "leading indicators, resource utilisation, active SOWs, dependency concentration, or early warning metrics should be tracked",
        "the team wants earlier signals before status turns amber or red",
    ],
}

PROJECT_SIGNAL_CATEGORY_PRIORITY = {
    "delivery_pressure": 100,
    "capability_risk": 95,
    "governance_risk": 90,
    "overall_status": 80,
    "leading_indicators": 75,
    "milestone_progress": 65,
}

ACTION_START_VERBS = {
    "accelerate",
    "add",
    "align",
    "assign",
    "book",
    "check",
    "clarify",
    "complete",
    "confirm",
    "create",
    "define",
    "document",
    "draft",
    "enforce",
    "escalate",
    "explore",
    "finalise",
    "follow",
    "identify",
    "prepare",
    "review",
    "send",
    "share",
    "start",
    "strengthen",
    "validate",
}

DISCOURSE_OPENERS = {"alright", "okay", "ok", "so", "right"}
VAGUE_ACTION_OBJECTS = {"that", "this", "it", "them", "something", "anything"}
ACTION_COMMENTARY_MARKERS = {
    "which is good",
    "which is fine",
    "if it impacts",
    "even if",
    "might want to",
    "we might want",
}


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


def sentence_case(value: Any) -> str:
    text = clean_text(value)
    if not text:
        return ""
    chars = list(text)
    for index, char in enumerate(chars):
        if char.isalpha():
            chars[index] = char.upper()
            break
    text = "".join(chars)
    if text[-1] not in ".!?:;":
        text += "."
    return text


def split_report_sentences(value: Any) -> list[str]:
    text = clean_text(value)
    if not text:
        return []
    parts = re.split(r"(?<=[.!?])\s+|[\n\r]+", text)
    return [clean_text(part) for part in parts if clean_text(part)]


def is_conversational_report_framing(value: Any) -> bool:
    text = clean_text(value).lower()
    if not text:
        return True
    words = re.findall(r"[a-z']+", text)
    if not words:
        return True
    first_person = bool(re.search(r"\b(i|i'll|i’m|i'm|we|we'll|we’re|we're)\b", text))
    facilitation = any(cue in text for cue in ["run through", "walk through", "talk through", "cover", "go through"])
    planning = any(cue in text for cue in ["agenda", "today", "this call", "this meeting", "twenty minutes", "minutes"])
    substance = any(cue in text for cue in ["delivered", "blocked", "complete", "risk", "escalate", "status"])
    # Drop meeting facilitation/introduction lines, but keep actual status statements.
    return first_person and facilitation and planning and not re.search(r"\b(is|are|was|were|remains|delivered|blocked|completed)\b", text)


def filter_report_text(value: Any) -> str:
    kept = [sentence_case(part) for part in split_report_sentences(value) if not is_conversational_report_framing(part)]
    return " ".join(item for item in kept if item)


def strip_action_preface(value: Any) -> str:
    text = clean_text(value)
    text = re.sub(rf"^({'|'.join(sorted(DISCOURSE_OPENERS))})[,.!?:;\s]+", "", text, flags=re.IGNORECASE)
    # Remove generic spoken lead-ins before an action list without depending on one exact phrase.
    text = re.sub(r"^(?:actions?|next steps?|follow[- ]?ups?)\s+(?:from|for|before|are|is|include|this|that|the)?\s*[^:]{0,80}:\s*", "", text, flags=re.IGNORECASE)
    return clean_text(text)


def normalise_action_candidate(value: Any) -> str:
    text = strip_action_preface(value).strip(" -–—:;")
    text = re.sub(r"^(?:add|capture|note)\s*,?\s+(?:we\s+)?might\s+want\s+to\s+", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^(?:we|i)\s+(?:might\s+want\s+to|should|need\s+to|will|can)\s+", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^might\s+want\s+to\s+", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^start\s+to\s+", "start ", text, flags=re.IGNORECASE)
    return clean_text(text.strip(" -–—:;"))


def is_actionable_candidate(value: Any) -> bool:
    text = clean_text(value)
    if not text:
        return False
    lowered = text.lower().strip(".")
    words = re.findall(r"[a-z0-9']+", lowered)
    if len(words) < 4:
        return False
    if any(marker in lowered for marker in ACTION_COMMENTARY_MARKERS):
        return False
    if re.search(r"\b(?:which|that|this)\s+(?:is|was|are|were)\b", lowered):
        return False
    if words[0] in {"complete", "completed"} and any(word in lowered for word in ["good", "fine", "done"]):
        return False
    if lowered.startswith("start with "):
        return False
    if words[0] in {"follow", "follow-up", "followup"} and len(words) < 5:
        return False
    if len(words) >= 2 and words[1] in VAGUE_ACTION_OBJECTS:
        return False
    if re.search(r"\b(?:as a|as an|as the|to the|for the)$", lowered):
        return False
    return True


def is_project_signal_candidate(value: Any) -> bool:
    text = clean_text(value)
    if not text:
        return False
    lowered = text.lower().strip(" .!?")
    words = re.findall(r"[a-z0-9']+", lowered)
    if len(words) < 5:
        return False
    if "?" in text:
        return False
    if any(cue in lowered for cue in ["can you hear me", "loud and clear", "thanks", "thank you", "sounds good", "all good"]):
        return False
    if is_conversational_report_framing(text):
        return False
    return True


def is_valid_risk_mitigation_candidate(value: Any) -> bool:
    text = clean_text(value)
    if not text:
        return False
    lowered = text.lower().strip(" .;:!?-–—")
    if re.match(r"^(yeah\s+)?(?:she|he|they|we|it|someone)\s+said\b", lowered):
        return False
    if re.match(r"^(?:she|he|they|someone)\s+(?:will|would|'d|is going to)\s+follow\s+up\b", lowered):
        return False
    if lowered in {"follow up", "follow-up", "follow up this week", "follow up next week", "no update", "nothing received"}:
        return False
    if re.search(r"\b(?:said|mentioned|noted)\s+(?:she|he|they|we)\b", lowered):
        return False
    if len(re.findall(r"[a-z0-9']+", lowered)) < 3:
        return False
    mitigation_terms = [
        "mitigation", "enforce", "assign", "owner", "validate", "confirm", "review", "draft",
        "document", "cross-training", "capacity", "sign-off", "track", "monitor", "escalate",
        "follow up", "clarify", "resolve", "dependency", "approval", "routing", "framework",
    ]
    return any(term in lowered for term in mitigation_terms)


def select_risk_mitigations(candidates: list[Any], fallback: str = "Review owner, dependency, and next action.") -> str:
    selected: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        text = sentence_case(candidate)
        if not text or not is_valid_risk_mitigation_candidate(text):
            continue
        key = text.lower()
        if key in seen:
            continue
        seen.add(key)
        selected.append(text)
        if len(selected) >= 2:
            break
    return "; ".join(selected) if selected else fallback


def project_signal_materiality(signal: dict[str, Any]) -> float:
    text = clean_text(signal.get("text", ""))
    lowered = text.lower()
    category = clean_text(signal.get("category", ""))
    score = float(signal.get("score") or 0)
    priority = PROJECT_SIGNAL_CATEGORY_PRIORITY.get(category, 50)
    material_terms = [
        "risk", "capacity", "sow", "delivery", "execution", "bandwidth", "pressure",
        "mismatch", "single point", "skills gap", "documentation", "cross-training",
        "governance", "owner", "framework", "decision", "amber", "red", "green status",
        "dashboard", "leading indicator", "resource utilisation", "dependency concentration",
    ]
    material_boost = 12 if any(term in lowered for term in material_terms) else 0
    weak_context_penalty = 0
    if "pipeline" in lowered and not any(term in lowered for term in ["delivery", "execution", "capacity", "sow", "bandwidth", "mismatch"]):
        weak_context_penalty += 45
    if category == "milestone_progress" and not any(term in lowered for term in ["complete", "delivered", "done", "live", "in progress", "stable"]):
        weak_context_penalty += 15
    return priority + material_boost + score - weak_context_penalty


def ranked_project_signals(signals: list[dict[str, Any]], limit: int = 8, per_category: int = 2) -> list[dict[str, Any]]:
    scored = [signal for signal in signals if isinstance(signal, dict) and clean_text(signal.get("text"))]
    scored.sort(key=project_signal_materiality, reverse=True)
    ranked: list[dict[str, Any]] = []
    category_counts: dict[str, int] = {}
    seen: set[str] = set()
    for signal in scored:
        text = clean_text(signal.get("text"))
        key = text.lower()
        category = clean_text(signal.get("category", "")) or "unknown"
        if key in seen:
            continue
        if category_counts.get(category, 0) >= per_category:
            continue
        seen.add(key)
        category_counts[category] = category_counts.get(category, 0) + 1
        ranked.append(signal)
        if len(ranked) >= limit:
            break
    return ranked


def split_action_candidates(value: Any) -> list[str]:
    text = strip_action_preface(value)
    if not text:
        return []
    verb_pattern = "|".join(sorted(ACTION_START_VERBS))
    text = re.sub(rf"\s+(?=({verb_pattern})\b)", "\n", text, flags=re.IGNORECASE)
    raw_parts = re.split(r"[\n\r;•]+|(?<=[.!?])\s+", text)
    candidates = []
    for part in raw_parts:
        item = normalise_action_candidate(part)
        item = re.split(r"\b(?:first|second|third|next)\s+risk\b", item, maxsplit=1, flags=re.IGNORECASE)[0].strip(" -–—:;")
        item = re.sub(r"\b(?:and|or)$", "", item, flags=re.IGNORECASE).strip(" -–—:;")
        if not item:
            continue
        lowered = item.lower()
        first_word = re.match(r"[a-z]+", lowered)
        if not first_word or first_word.group(0) not in ACTION_START_VERBS:
            continue
        if len(re.findall(r"\w+", item)) < 2:
            continue
        if lowered.startswith(("risk ", "first risk", "second risk")):
            continue
        if not is_actionable_candidate(item):
            continue
        candidates.append(sentence_case(item))
    return candidates


def infer_action_rows_from_report(report: dict[str, Any]) -> list[dict[str, Any]]:
    existing = report.get("actions", [])
    weak_actions = {"complete", "completed", "green", "amber", "red", "blue", "done"}
    if isinstance(existing, list) and existing:
        viable = []
        for action in existing:
            text = clean_text(action.get("action") or action.get("meetingActionPoint", "")) if isinstance(action, dict) else clean_text(action)
            if text.lower().strip(".") not in weak_actions and is_actionable_candidate(text):
                viable.append(action)
        if viable:
            return viable
    source_texts = [report.get("summary", ""), *report.get("keyUpdates", []), *report.get("_actionSourceTexts", [])]
    actions: list[dict[str, Any]] = []
    seen: set[str] = set()
    for text in source_texts:
        for candidate in split_action_candidates(text):
            key = candidate.lower()
            if key in seen:
                continue
            seen.add(key)
            actions.append(
                {
                    "action": candidate,
                    "related_milestone": "unlinked",
                    "meetingActionPointOwner": "Owner not specified",
                    "actionConfidence": 0.55,
                    "deadline": "",
                }
            )
    return actions


def normalise_report_payload(report: dict[str, Any]) -> dict[str, Any]:
    normalised = {**report}
    normalised["summary"] = filter_report_text(normalised.get("summary", "")) or "Project update analysed from transcript."
    normalised["keyUpdates"] = [
        item for item in (filter_report_text(update) for update in normalised.get("keyUpdates", [])) if item
    ]
    for milestone in normalised.get("milestones", []):
        if isinstance(milestone, dict):
            for field in ("normalised_evidence_summary", "excerpt", "status_resolution_note"):
                if milestone.get(field):
                    milestone[field] = filter_report_text(milestone[field])
            milestone["evidence"] = [filter_report_text(item) for item in milestone.get("evidence", []) if filter_report_text(item)]
            milestone["conflicting_evidence"] = [filter_report_text(item) for item in milestone.get("conflicting_evidence", []) if filter_report_text(item)]
            milestone["next_steps"] = [sentence_case(item) for item in milestone.get("next_steps", []) if clean_text(item)]
    for risk in normalised.get("risks", []):
        if isinstance(risk, dict):
            for field in ("description", "suggestedMitigation"):
                if risk.get(field):
                    risk[field] = filter_report_text(risk[field]) or sentence_case(risk[field])
    normalised["actions"] = infer_action_rows_from_report(normalised)
    normalised["actions"] = [
        {**action, "action": sentence_case(action.get("action") or action.get("meetingActionPoint", ""))}
        for action in normalised.get("actions", [])
        if clean_text(action.get("action") or action.get("meetingActionPoint", ""))
    ]
    normalised.pop("_actionSourceTexts", None)
    return normalised


def collect_action_source_texts(result: dict[str, Any], enriched_segments: list[dict[str, Any]]) -> list[str]:
    texts: list[str] = []
    for turn in result.get("cleaned_turns", []):
        if isinstance(turn, dict):
            texts.append(clean_text(turn.get("text", "")))
            texts.extend(clean_text(sentence) for sentence in turn.get("sentences", []) if clean_text(sentence))
    for segment in enriched_segments:
        texts.extend(clean_text(item) for item in segment.get("evidence", []) if clean_text(item))
        texts.extend(clean_text(item) for item in segment.get("next_steps", []) if clean_text(item))
    seen: set[str] = set()
    unique: list[str] = []
    for text in texts:
        key = text.lower()
        if text and key not in seen:
            seen.add(key)
            unique.append(text)
    return unique


def collect_raw_transcript_windows(transcript_text: str) -> list[EvidenceWindow]:
    windows: list[EvidenceWindow] = []
    turn_re = re.compile(r"^(?P<speaker>.+?)\s+(?P<timestamp>\d+:\d{2})(?P<tail>.*)$")
    colon_re = re.compile(r"^(?P<speaker>[A-Z][A-Za-z ]+):\s*(?P<tail>.*)$")
    turn_index = 0
    for raw_line in transcript_text.splitlines():
        line = clean_text(raw_line)
        if not line or "started transcription" in line.lower() or "stopped transcription" in line.lower():
            continue
        lowered_line = line.lower().strip()
        if lowered_line.startswith("📄 transcript:") or lowered_line in {"participants:", "participants"}:
            continue
        if re.match(r"^date\s*:", line, flags=re.IGNORECASE) or re.match(r"^\d{1,2}\s+[A-Za-z]+\s+\d{4}$", line):
            continue
        if re.match(r"^\[[0-9:.]+\]$", line) or re.match(r"^[A-Z][A-Za-z .'-]+\s+\([^)]+\)$", line):
            continue
        speaker = ""
        text = line
        match = turn_re.match(line)
        if match:
            speaker = clean_text(match.group("speaker"))
            text = clean_text(match.group("tail"))
        else:
            colon_match = colon_re.match(line)
            if colon_match:
                speaker = clean_text(colon_match.group("speaker"))
                text = clean_text(colon_match.group("tail"))
        for sentence in split_report_sentences(text):
            if sentence:
                windows.append(EvidenceWindow(text=sentence, speaker=speaker, turn_index=turn_index, source="minilm_first.raw_transcript"))
        turn_index += 1
    return windows


def build_minilm_first_context(transcript_text: str, backend: MiniLMBackend) -> dict[str, Any]:
    windows = collect_raw_transcript_windows(transcript_text)
    diagnostics: dict[str, Any] = {
        "runsBeforeRules": True,
        "windowCount": len(windows),
        "actionPrototypeCount": len(PROJECT_ACTION_PROTOTYPES),
        "projectSignalPrototypeGroupCount": len(PROJECT_SIGNAL_PROTOTYPES),
        "selectedActionWindowCount": 0,
        "selectedActionCount": 0,
        "selectedProjectSignalCount": 0,
    }
    actions: list[dict[str, Any]] = []
    action_source_texts: list[str] = []
    selected_windows: list[dict[str, Any]] = []
    project_signals: list[dict[str, Any]] = []
    seen_actions: set[str] = set()

    if backend.available and windows:
        signal_targets = [prototype for prototypes in PROJECT_SIGNAL_PROTOTYPES.values() for prototype in prototypes]
        lookup = semantic_lookup(backend, windows, PROJECT_ACTION_PROTOTYPES + signal_targets)
        scored = []
        for window in windows:
            score = max((cosine_from_lookup(lookup, window.text, prototype) for prototype in PROJECT_ACTION_PROTOTYPES), default=0.0)
            candidates = split_action_candidates(window.text)
            if score >= 0.28 or candidates:
                scored.append((score, window, candidates))
        scored.sort(key=lambda item: (bool(item[2]), item[0]), reverse=True)
        for score, window, candidates in scored[:18]:
            if not candidates:
                continue
            selected_windows.append(
                {
                    "text": window.text,
                    "speaker": window.speaker,
                    "turnIndex": window.turn_index,
                    "source": window.source,
                    "score": round(score, 4),
                }
            )
            action_source_texts.append(window.text)
            for candidate in candidates:
                key = candidate.lower()
                if key in seen_actions:
                    continue
                seen_actions.add(key)
                actions.append(
                    {
                        "action": candidate,
                        "related_milestone": "unlinked",
                        "meetingActionPointOwner": "Owner not specified",
                        "actionConfidence": max(0.55, round(score, 2)),
                        "deadline": "",
                        "_source": "minilm_first",
                    }
                )
        seen_signal_texts: set[str] = set()
        for category, prototypes in PROJECT_SIGNAL_PROTOTYPES.items():
            matches = top_matches(lookup, windows, prototypes, limit=3)
            for match in matches:
                if match["score"] < 0.28:
                    continue
                if not is_project_signal_candidate(match["text"]):
                    continue
                key = clean_text(match["text"]).lower()
                if not key or key in seen_signal_texts:
                    continue
                seen_signal_texts.add(key)
                project_signals.append({**match, "category": category})
    else:
        for window in windows:
            action_source_texts.append(window.text)

    diagnostics["selectedActionWindowCount"] = len(selected_windows)
    diagnostics["selectedActionCount"] = len(actions)
    diagnostics["selectedActionWindows"] = selected_windows[:10]
    diagnostics["selectedProjectSignalCount"] = len(project_signals)
    diagnostics["selectedProjectSignalWindows"] = project_signals[:12]
    diagnostics["rankedProjectSignalWindows"] = ranked_project_signals(project_signals, limit=12, per_category=2)
    return {
        "actions": actions,
        "actionSourceTexts": action_source_texts,
        "selectedActionWindows": selected_windows,
        "projectSignals": project_signals,
        "rankedProjectSignals": ranked_project_signals(project_signals, limit=12, per_category=2),
        "diagnostics": diagnostics,
    }


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


def load_project_context(path: str | None) -> dict[str, Any]:
    if not path:
        return {}
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"_contextLoadError": f"Could not load project context from {path}."}
    if isinstance(data, dict) and isinstance(data.get("context"), dict):
        return data["context"]
    return data if isinstance(data, dict) else {}


def normalise_key(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(value or "").strip().lower()).strip("_")


def milestone_match_tokens(value: Any) -> set[str]:
    key = normalise_key(value).replace("stagegate", "stage_gate")
    stop_words = {
        "a", "an", "and", "the", "of", "for", "to",
        "completed", "complete", "delivered", "defined", "implemented", "rolled", "out",
        "review", "reviewed", "internal", "forum", "plan", "set", "delivery",
    }
    return {token for token in key.split("_") if token and token not in stop_words}


def milestone_match_score(left: Any, right: Any) -> float:
    left_tokens = milestone_match_tokens(left)
    right_tokens = milestone_match_tokens(right)
    if not left_tokens or not right_tokens:
        return 0.0
    overlap = len(left_tokens & right_tokens)
    return overlap / max(1, min(len(left_tokens), len(right_tokens)))


def normalise_trend(value: Any) -> str:
    trend = str(value or "").strip().lower()
    return trend if trend in {"improving", "stable", "deteriorating", "replanned", "new_update", "new_risk", "resolved", "unknown"} else "unknown"


def assessment_status(value: Any) -> str:
    status = str(value or "").strip().lower()
    mapping = {
        "complete": "completed",
        "completed": "completed",
        "green": "on_track",
        "blue": "completed",
        "amber": "at_risk",
        "red": "off_track",
        "in_progress": "on_track",
        "scheduled": "on_track",
        "in_review": "on_track",
        "awaiting_input": "at_risk",
        "delayed": "delayed",
        "blocked": "blocked",
        "not_started": "not_started",
        "on_track": "on_track",
        "at_risk": "at_risk",
        "off_track": "off_track",
    }
    return mapping.get(status, "unknown")


def status_severity(value: Any) -> int:
    status = assessment_status(value)
    return {
        "completed": 0,
        "on_track": 1,
        "not_started": 2,
        "at_risk": 3,
        "delayed": 4,
        "blocked": 5,
        "off_track": 5,
        "unknown": 2,
    }.get(status, 2)


def infer_trend(previous_status: Any, current_status: Any, *, existing: Any = None) -> str:
    current = assessment_status(current_status)
    previous = assessment_status(previous_status)
    if current == "unknown":
        return normalise_trend(existing) if normalise_trend(existing) != "unknown" else "unknown"
    if previous == "unknown":
        return "new_update"
    if previous == "completed" and current in {"on_track", "not_started", "at_risk"}:
        return "replanned"
    if current in {"completed", "on_track"} and previous in {"blocked", "delayed", "off_track", "at_risk"}:
        return "resolved" if current == "completed" else "improving"
    previous_score = status_severity(previous)
    current_score = status_severity(current)
    if current_score > previous_score:
        return "deteriorating"
    if current_score < previous_score:
        return "improving"
    return "stable"


def latest_by_key(items: list[Any], key_candidates: list[str]) -> dict[str, Any]:
    output: dict[str, Any] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        for candidate in key_candidates:
            key = normalise_key(item.get(candidate))
            if key and key not in output:
                output[key] = item
    return output


def annotate_report_with_project_context(report: dict[str, Any], project_context: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    diagnostics = {
        "contextProvided": bool(project_context),
        "contextFound": bool(project_context.get("found")),
        "milestonesCompared": 0,
        "healthAreasCompared": 0,
        "riskTitlesCompared": 0,
        "contextLoadError": project_context.get("_contextLoadError", ""),
    }
    if not project_context or project_context.get("_contextLoadError"):
        return report, diagnostics

    annotated = {**report}
    milestones = [dict(item) for item in report.get("milestones", []) if isinstance(item, dict)]
    health_areas = dict(report.get("healthAreas", {}) if isinstance(report.get("healthAreas"), dict) else {})
    risks = [dict(item) for item in report.get("risks", []) if isinstance(item, dict)]

    previous_milestones: dict[str, dict[str, Any]] = {}
    for milestone in project_context.get("activeMilestones", []):
        if not isinstance(milestone, dict):
            continue
        latest = milestone.get("latestAssessment") if isinstance(milestone.get("latestAssessment"), dict) else {}
        previous = {
            **milestone,
            "status": latest.get("status") or milestone.get("status"),
            "trend": latest.get("trend") or milestone.get("trend"),
            "summary": latest.get("summary") or milestone.get("description"),
            "createdAt": latest.get("createdAt"),
        }
        for key in {normalise_key(milestone.get("comparisonKey")), normalise_key(milestone.get("milestoneName"))}:
            if key and key not in previous_milestones:
                previous_milestones[key] = previous
    for item in project_context.get("milestoneHistory", []):
        if isinstance(item, dict):
            for key in {normalise_key(item.get("comparisonKey")), normalise_key(item.get("milestoneName"))}:
                if key and key not in previous_milestones:
                    previous_milestones[key] = item

    milestone_snapshot: dict[str, Any] = {}
    for milestone in milestones:
        key = normalise_key(milestone.get("comparison_key") or milestone.get("milestone"))
        previous = previous_milestones.get(key, {})
        current_status = assessment_status(milestone.get("delivery_status") or milestone.get("status"))
        previous_status = assessment_status(previous.get("status"))
        trend = infer_trend(previous_status, current_status, existing=milestone.get("trend") or previous.get("trend"))
        milestone["previous_status"] = "" if previous_status == "unknown" else previous_status
        milestone["trend"] = trend
        if previous:
            diagnostics["milestonesCompared"] += 1
            milestone["previous_summary"] = clean_text(previous.get("summary", ""))
            milestone["previous_report_id"] = previous.get("reportId")
            milestone["previous_report_version_id"] = previous.get("reportVersionId")
        milestone_snapshot[key or normalise_key(milestone.get("milestone"))] = {
            "label": milestone.get("milestone", ""),
            "previousStatus": "" if previous_status == "unknown" else previous_status,
            "currentStatus": "" if current_status == "unknown" else current_status,
            "trend": trend,
            "previousReportId": previous.get("reportId"),
            "previousReportVersionId": previous.get("reportVersionId"),
        }

    previous_health = latest_by_key(project_context.get("healthHistory", []), ["area"])
    health_snapshot: dict[str, Any] = {}
    for area, detail in health_areas.items():
        if not isinstance(detail, dict):
            continue
        previous = previous_health.get(normalise_key(area), {})
        current_status = assessment_status(detail.get("status"))
        previous_status = assessment_status(previous.get("status"))
        trend = infer_trend(previous_status, current_status, existing=detail.get("trend") or previous.get("trend"))
        next_detail = {**detail, "trend": trend, "previousStatus": "" if previous_status == "unknown" else previous_status}
        if previous:
            diagnostics["healthAreasCompared"] += 1
            next_detail["previousReportId"] = previous.get("reportId")
            next_detail["previousReportVersionId"] = previous.get("reportVersionId")
        health_areas[area] = next_detail
        health_snapshot[area] = {
            "previousStatus": "" if previous_status == "unknown" else previous_status,
            "currentStatus": "" if current_status == "unknown" else current_status,
            "trend": trend,
            "previousReportId": previous.get("reportId"),
            "previousReportVersionId": previous.get("reportVersionId"),
        }

    previous_risks = latest_by_key(project_context.get("activeRisks", []), ["riskTitle"])
    previous_risks.update({key: value for key, value in latest_by_key(project_context.get("riskSuggestions", []), ["riskTitle"]).items() if key not in previous_risks})
    risk_snapshot: dict[str, Any] = {}
    for risk in risks:
        key = normalise_key(risk.get("riskTitle"))
        previous = previous_risks.get(key, {})
        if previous:
            diagnostics["riskTitlesCompared"] += 1
            trend = "stable" if previous.get("riskId") or str(previous.get("reviewStatus", "")).lower() in {"pending", "accepted", "reviewed"} else "new_risk"
            risk["previous_review_status"] = previous.get("reviewStatus", "")
            risk["previous_report_id"] = previous.get("reportId")
            risk["core_risk_id"] = previous.get("riskId")
        else:
            trend = "new_risk"
        risk["trend"] = trend
        risk_snapshot[key or normalise_key(risk.get("description"))] = {
            "label": risk.get("riskTitle", ""),
            "trend": trend,
            "previousReviewStatus": previous.get("reviewStatus", ""),
            "previousReportId": previous.get("reportId"),
            "coreRiskId": previous.get("riskId"),
        }

    existing_snapshot = report.get("comparisonSnapshot", {}) if isinstance(report.get("comparisonSnapshot"), dict) else {}
    annotated["milestones"] = milestones
    annotated["healthAreas"] = health_areas
    annotated["risks"] = risks
    annotated["comparisonSnapshot"] = {
        **existing_snapshot,
        "contextGeneratedAt": project_context.get("generatedAt", ""),
        "latestContextSnapshotId": (project_context.get("latestSnapshot") or {}).get("snapshotId") if isinstance(project_context.get("latestSnapshot"), dict) else None,
        "milestones": milestone_snapshot,
        "healthAreas": health_snapshot,
        "risks": risk_snapshot,
    }
    return annotated, diagnostics


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


def is_unmatched_milestone_segment(segment: dict[str, Any]) -> bool:
    key = normalise_key(segment.get("comparison_key") or segment.get("milestone"))
    if key not in {"", "unknown", "unclassified", "none", "general"}:
        return False
    try:
        match_confidence = float(segment.get("milestone_match_confidence") or 0)
    except (TypeError, ValueError):
        match_confidence = 0.0
    return match_confidence <= 0.05


def context_milestone_row(milestone: dict[str, Any]) -> dict[str, Any]:
    latest = milestone.get("latestAssessment") if isinstance(milestone.get("latestAssessment"), dict) else {}
    previous = milestone.get("previousAssessment") if isinstance(milestone.get("previousAssessment"), dict) else {}
    status = latest.get("status") or previous.get("status") or ""
    summary = latest.get("summary") or previous.get("summary") or milestone.get("description") or "No new transcript update captured for this milestone."
    return {
        "milestoneId": milestone.get("milestoneId"),
        "milestone": milestone.get("milestoneName") or milestone.get("milestone") or "Milestone",
        "comparison_key": normalise_key(milestone.get("comparisonKey") or milestone.get("milestoneName") or milestone.get("milestone")),
        "category": milestone.get("category", ""),
        "baseline_finish_date": milestone.get("baselineFinishDate") or milestone.get("baseline_finish_date") or "",
        "forecast_finish_date": latest.get("forecastFinishDate") or milestone.get("forecastFinishDate") or milestone.get("forecast_finish_date") or "",
        "delivery_status": blank_unknown_status(status),
        "health_assessment": blank_unknown_status(status),
        "normalised_evidence_summary": summary,
        "excerpt": summary,
        "evidence": [],
        "semantic_evidence": [],
        "next_steps": [],
        "blocking_factors": [],
        "context_source": "active_milestone",
        "transcript_update_status": "carried_forward",
        "is_official": milestone.get("isOfficial"),
        "official_label": milestone.get("officialLabel", ""),
    }


def merge_segment_into_milestone_row(row: dict[str, Any], segment: dict[str, Any]) -> dict[str, Any]:
    merged = {**row}
    for key, value in segment.items():
        if key in {"milestoneId", "baseline_finish_date", "baselineDeadline"}:
            continue
        if value not in (None, "", [], {}):
            merged[key] = value
    merged["milestoneId"] = row.get("milestoneId") or segment.get("milestoneId")
    merged["milestone"] = row.get("milestone") or segment.get("milestone")
    merged["comparison_key"] = row.get("comparison_key") or normalise_key(segment.get("comparison_key") or segment.get("milestone"))
    merged["baseline_finish_date"] = row.get("baseline_finish_date") or segment.get("baseline_finish_date") or segment.get("baselineDeadline") or segment.get("deadline") or ""
    merged["forecast_finish_date"] = segment.get("forecast_finish_date") or segment.get("forecastDeadline") or segment.get("deadline") or row.get("forecast_finish_date") or ""
    merged["delivery_status"] = blank_unknown_status(segment.get("delivery_status") or segment.get("status") or row.get("delivery_status"))
    merged["health_assessment"] = blank_unknown_status(segment.get("health_assessment") or row.get("health_assessment"))
    merged["next_steps"] = [step for step in combine_blockers_and_next_steps(segment) if is_valid_risk_mitigation_candidate(step)]
    merged["blocking_factors"] = []
    merged["context_source"] = row.get("context_source") or "transcript"
    merged["transcript_update_status"] = "updated_from_transcript"
    return merged


def build_context_first_milestones(enriched_segments: list[dict[str, Any]], project_context: dict[str, Any] | None) -> list[dict[str, Any]]:
    context = project_context or {}
    active_milestones = [item for item in context.get("activeMilestones", []) if isinstance(item, dict)]
    segment_rows: list[dict[str, Any]] = []
    for segment in enriched_segments:
        if is_unmatched_milestone_segment(segment):
            continue
        item = dict(segment)
        item["delivery_status"] = blank_unknown_status(item.get("delivery_status"))
        item["health_assessment"] = blank_unknown_status(item.get("health_assessment"))
        item["next_steps"] = [step for step in combine_blockers_and_next_steps(item) if is_valid_risk_mitigation_candidate(step)]
        item["blocking_factors"] = []
        item["comparison_key"] = normalise_key(item.get("comparison_key") or item.get("milestone"))
        item["context_source"] = "transcript"
        item["transcript_update_status"] = "updated_from_transcript"
        segment_rows.append(item)

    segments_by_key = {normalise_key(item.get("comparison_key") or item.get("milestone")): item for item in segment_rows}
    output: list[dict[str, Any]] = []
    used_segment_keys: set[str] = set()
    active_keys = {normalise_key(item.get("comparisonKey") or item.get("milestoneName")) for item in active_milestones}
    for milestone in active_milestones:
        row = context_milestone_row(milestone)
        key = normalise_key(row.get("comparison_key") or row.get("milestone"))
        segment = segments_by_key.get(key)
        if not segment:
            segment = max(
                (candidate for candidate in segment_rows if normalise_key(candidate.get("comparison_key") or candidate.get("milestone")) not in used_segment_keys),
                key=lambda candidate: milestone_match_score(row.get("comparison_key") or row.get("milestone"), candidate.get("comparison_key") or candidate.get("milestone")),
                default=None,
            )
            if segment and milestone_match_score(row.get("comparison_key") or row.get("milestone"), segment.get("comparison_key") or segment.get("milestone")) < 0.75:
                segment = None
        if segment:
            row = merge_segment_into_milestone_row(row, segment)
            used_segment_keys.add(normalise_key(segment.get("comparison_key") or segment.get("milestone")))
        output.append(row)

    for row in segment_rows:
        key = normalise_key(row.get("comparison_key") or row.get("milestone"))
        if active_milestones and key in used_segment_keys:
            continue
        if active_milestones and key in active_keys:
            continue
        if active_milestones and any(milestone_match_score(item.get("comparisonKey") or item.get("milestoneName"), row.get("comparison_key") or row.get("milestone")) >= 0.75 for item in active_milestones):
            continue
        output.append(row)
    return output


def build_fixed_health_areas(overall: str, diagnostics: dict[str, Any], project_context: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    matches_by_area = diagnostics.get("healthAreaMatches", {}) if isinstance(diagnostics.get("healthAreaMatches", {}), dict) else {}
    previous_health = latest_by_key((project_context or {}).get("healthHistory", []), ["area"])
    areas: dict[str, dict[str, Any]] = {}
    for area in FIXED_HEALTH_AREAS:
        previous = previous_health.get(area, {})
        previous_status = previous.get("status")
        fallback_status = health_to_report_status(overall if area == "schedule" else "unknown")
        status = blank_unknown_status(fallback_status) or blank_unknown_status(previous_status) or ""
        areas[area] = {
            "status": status,
            "trend": previous.get("trend") or "stable",
            "evidence": matches_by_area.get(area, []),
            "previousStatus": blank_unknown_status(previous_status),
            "previousReportId": previous.get("reportId"),
            "previousReportVersionId": previous.get("reportVersionId"),
        }
    return areas


def build_context_first_risks(risk_suggestions: list[dict[str, Any]], project_context: dict[str, Any] | None) -> list[dict[str, Any]]:
    context = project_context or {}
    active_risks = [item for item in context.get("activeRisks", []) if isinstance(item, dict)]
    suggestions_by_key = {normalise_key(item.get("riskTitle")): item for item in risk_suggestions if isinstance(item, dict)}
    output: list[dict[str, Any]] = []
    used: set[str] = set()
    for risk in active_risks:
        key = normalise_key(risk.get("riskTitle"))
        suggestion = suggestions_by_key.get(key)
        row = {
            "riskId": risk.get("riskId"),
            "riskTitle": risk.get("riskTitle") or "Project risk",
            "description": risk.get("description", ""),
            "suggestedMitigation": risk.get("mitigation", ""),
            "confidence": 0.7,
            "relatedMilestone": risk.get("relatedMilestone", ""),
            "context_source": "active_risk",
            "transcript_update_status": "carried_forward",
        }
        if suggestion:
            row = {**row, **{k: v for k, v in suggestion.items() if v not in (None, "", [], {})}}
            row["riskId"] = risk.get("riskId")
            row["context_source"] = "active_risk"
            row["transcript_update_status"] = "updated_from_transcript"
            used.add(key)
        output.append(row)
    for risk in risk_suggestions:
        key = normalise_key(risk.get("riskTitle"))
        if key and key not in used and key not in {normalise_key(item.get("riskTitle")) for item in active_risks}:
            output.append(risk)
    return output


def build_report_payload(
    result: dict[str, Any],
    enriched_segments: list[dict[str, Any]],
    diagnostics: dict[str, Any],
    minilm_first_context: dict[str, Any] | None = None,
    project_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    summary = result.get("project_health_summary", {})
    overall = summary.get("overall_health", "unknown")
    minilm_first_context = minilm_first_context or {}
    minilm_project_signals = minilm_first_context.get("rankedProjectSignals", []) if isinstance(minilm_first_context.get("rankedProjectSignals", []), list) else []
    if not minilm_project_signals:
        raw_signals = minilm_first_context.get("projectSignals", []) if isinstance(minilm_first_context.get("projectSignals", []), list) else []
        minilm_project_signals = ranked_project_signals(raw_signals, limit=8, per_category=2)
    minilm_signal_updates = [
        signal.get("text")
        for signal in minilm_project_signals
        if isinstance(signal, dict) and clean_text(signal.get("text")) and float(signal.get("score") or 0) >= 0.28
    ]
    key_updates = [
        *minilm_signal_updates,
        *[
            segment.get("normalised_evidence_summary") or segment.get("excerpt")
            for segment in enriched_segments
            if segment.get("normalised_evidence_summary") or segment.get("excerpt")
        ],
    ]
    deduped_key_updates: list[str] = []
    seen_key_updates: set[str] = set()
    for update in key_updates:
        cleaned = clean_text(update)
        if not cleaned:
            continue
        key = cleaned.lower()
        if key in seen_key_updates:
            continue
        seen_key_updates.add(key)
        deduped_key_updates.append(cleaned)
    key_updates = deduped_key_updates[:8]
    risk_suggestions = []
    for segment in enriched_segments:
        if segment.get("delivery_status") in {"blocked", "awaiting_input", "delayed"} or segment.get("agreed_rag_status") in {"amber", "red"}:
            risk_suggestions.append(
                {
                    "riskTitle": f"{friendly_milestone_label(segment.get('milestone', 'Workstream'))} needs attention",
                    "description": segment.get("normalised_evidence_summary") or segment.get("status_resolution_note") or segment.get("excerpt", ""),
                    "suggestedMitigation": select_risk_mitigations(segment.get("next_steps", [])),
                    "confidence": segment.get("semantic_confidence") or segment.get("health_assessment_confidence") or 0.5,
                    "relatedMilestone": segment.get("milestone", ""),
                }
            )

    report_milestones = build_context_first_milestones(enriched_segments, project_context)

    minilm_actions = minilm_first_context.get("actions", []) if isinstance(minilm_first_context.get("actions", []), list) else []
    minilm_action_sources = minilm_first_context.get("actionSourceTexts", []) if isinstance(minilm_first_context.get("actionSourceTexts", []), list) else []

    report = normalise_report_payload({
        "reportStatus": "draft",
        "overallHealth": health_to_report_status(overall),
        "overallHealthRag": overall,
        "summary": summary.get("overall_health_reason", "Project update analysed from transcript."),
        "keyUpdates": [clean_text(item) for item in key_updates if clean_text(item)],
        "healthAreas": build_fixed_health_areas(overall, diagnostics, project_context),
        "milestones": report_milestones,
        "risks": build_context_first_risks(risk_suggestions, project_context),
        "actions": minilm_actions or result.get("actions", []),
        "_actionSourceTexts": [*minilm_action_sources, *collect_action_source_texts(result, enriched_segments)],
        "comparisonSnapshot": result.get("comparison_snapshot", {}),
    })
    report, context_diagnostics = annotate_report_with_project_context(report, project_context or {})
    diagnostics["projectContext"] = context_diagnostics
    return normalise_report_payload(report)


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

    # Keep key updates as extracted evidence bullets. Rewriting them can alter meaning
    # or turn factual project signals into questions, which weakens the MiniLM-first layer.
    rewrite_plan = [{"field": "summary", "category": "discussion", "text": report.get("summary", "")}]
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
    return normalise_report_payload(rewritten), diagnostics


def build_project_update_output(
    transcript_text: str,
    use_minilm: bool = True,
    use_rewrite: bool = True,
    project_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    started = time.perf_counter()
    backend = MiniLMBackend.load(enabled=use_minilm)
    minilm_first_context = build_minilm_first_context(transcript_text, backend)
    baseline = analyse_project_update(transcript_text)
    enriched_segments, semantic_diagnostics = enrich_segments(baseline, backend)
    report = build_report_payload(
        baseline,
        enriched_segments,
        semantic_diagnostics,
        minilm_first_context=minilm_first_context,
        project_context=project_context or {},
    )

    rewriter = LocalMinutesRewriter.load(enabled=use_rewrite)
    report, rewrite_diagnostics = rewrite_report_summary(report, rewriter)
    timing_total = round((time.perf_counter() - started) * 1000, 2)

    return {
        **baseline,
        "segments": enriched_segments,
        "mode": "project_update_minilm",
        "projectReport": report,
        "modelDiagnostics": {
            "pipelineOrder": ["minilm_first_context", "rules_structuring", "minilm_segment_enrichment", "qwen_rewrite"],
            "minilmFirstContext": minilm_first_context.get("diagnostics", {}),
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
    parser.add_argument("--context-file", help="Optional JSON file containing saved project context/history for trend comparison.")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON output.")
    return parser.parse_args(argv)


def main() -> int:
    args = parse_args(sys.argv[1:])
    text = read_input(args.path).strip()
    if not text:
        print("No input text provided.", file=sys.stderr)
        return 1
    project_context = load_project_context(args.context_file)
    output = build_project_update_output(text, use_minilm=not args.skip_minilm, use_rewrite=not args.skip_rewrite, project_context=project_context)
    print(json.dumps(output, indent=2 if args.pretty else None, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
