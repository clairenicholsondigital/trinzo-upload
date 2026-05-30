#!/usr/bin/env python3
"""Rule-based transcript analysis pipeline for milestone/status extraction."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import re
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

try:
    from rapidfuzz import fuzz
except ImportError:  # pragma: no cover
    from difflib import SequenceMatcher

    class _FuzzFallback:
        @staticmethod
        def partial_ratio(a: str, b: str) -> int:
            left = a.lower()
            right = b.lower()
            if not left or not right:
                return 0
            if len(left) < len(right):
                left, right = right, left
            window = len(right)
            best = 0.0
            for index in range(max(1, len(left) - window + 1)):
                candidate = left[index:index + window]
                best = max(best, SequenceMatcher(None, candidate, right).ratio())
            return int(round(best * 100))

    fuzz = _FuzzFallback()


TURN_RE = re.compile(r"^(?P<speaker>.+?)\s+(?P<timestamp>\d+:\d{2})(?P<tail>.*)$")
GENERIC_TOKENS = {
    "the", "and", "for", "that", "with", "from", "into", "then", "again",
    "report", "strategy", "defined", "review", "forms", "green", "call"
}
DELIVERY_STATUS_PRIORITY = [
    "blocked",
    "delayed",
    "awaiting_input",
    "needs_review",
    "in_progress",
    "scheduled",
    "complete",
    "not_started",
    "unknown",
]
DELIVERY_STATUS_STRENGTH = {
    "blocked": 0,
    "delayed": 1,
    "awaiting_input": 2,
    "needs_review": 3,
    "in_progress": 4,
    "scheduled": 5,
    "complete": 6,
    "not_started": -1,
    "unknown": -2,
}
DELIVERY_ALIAS_MAP = {
    "complete": "complete",
    "green": "in_progress",
    "in_progress": "in_progress",
    "scheduled": "scheduled",
    "waiting": "awaiting_input",
    "awaiting_input": "awaiting_input",
    "in_review": "needs_review",
    "needs_review": "needs_review",
    "at_risk": "delayed",
    "delayed": "delayed",
    "paused": "blocked",
    "blocked": "blocked",
    "not_started": "not_started",
    "unknown": "unknown",
}
DEFAULT_RAG_FROM_DELIVERY = {
    "complete": "green",
    "scheduled": "green",
    "in_progress": "green",
    "needs_review": "blue",
    "awaiting_input": "amber",
    "delayed": "amber",
    "blocked": "red",
    "not_started": "amber",
    "unknown": "unknown",
}
RAG_PRIORITY = ["red", "blue", "amber", "green", "unknown"]
RAG_VALUES = {"green", "amber", "red", "blue", "unknown"}
EXPLICIT_RAG_PATTERNS = [
    (re.compile(r"\blet'?s put (?P<rag>green|amber|red|blue)\b", re.IGNORECASE), 1.0),
    (re.compile(r"\bleave it (?P<rag>green|amber|red|blue)\b", re.IGNORECASE), 1.0),
    (re.compile(r"\bkeep it (?P<rag>green|amber|red|blue)\b", re.IGNORECASE), 1.0),
    (re.compile(r"\bstatus (?P<rag>green|amber|red|blue)\b", re.IGNORECASE), 1.0),
    (re.compile(r"\bthat'?s (?P<rag>green|amber|red|blue) then\b", re.IGNORECASE), 0.95),
    (re.compile(r"\bokay(?: so that'?s)? (?P<rag>green|amber|red|blue)(?: then)?\b", re.IGNORECASE), 0.95),
    (re.compile(r"\bso (?P<rag>green|amber|red|blue)\b", re.IGNORECASE), 0.75),
    (re.compile(r"\bthis one'?s (?P<rag>green|amber|red|blue)\b", re.IGNORECASE), 0.8),
    (re.compile(r"\bi'?d leave it (?P<rag>green|amber|red|blue)\b", re.IGNORECASE), 0.9),
    (re.compile(r"\bi'?d probably say (?P<rag>green|amber|red|blue)\b", re.IGNORECASE), 0.65),
    (re.compile(r"\bpotentially (?P<rag>green|amber|red|blue)\b", re.IGNORECASE), 0.45),
    (re.compile(r"\bprobably still (?P<rag>green|amber|red|blue)\b", re.IGNORECASE), 0.6),
    (re.compile(r"^(?P<rag>green|amber|red|blue)[.!?]?$", re.IGNORECASE), 0.9),
]
NOT_STARTED_PHRASES = [
    "not started",
    "hasn't been scoped",
    "has not been scoped",
    "not scoped",
]


@dataclass
class Turn:
    speaker: str
    timestamp: str
    text: str


@dataclass
class Segment:
    milestone: str
    turns: list[Turn] = field(default_factory=list)
    sentences: list[str] = field(default_factory=list)
    status_votes: Counter = field(default_factory=Counter)
    evidence: list[str] = field(default_factory=list)
    blockers: list[str] = field(default_factory=list)
    next_steps: list[str] = field(default_factory=list)
    reason_hits: list[dict[str, str]] = field(default_factory=list)
    confidence: int = 0


def sentence_word_count(text: str) -> int:
    return len(re.findall(r"\b\w+\b", text))


def load_rules(skill_dir: Path) -> dict[str, Any]:
    return json.loads((skill_dir / "config" / "project_rules.json").read_text(encoding="utf-8"))


def read_input(path: str | None) -> str:
    if path:
        return Path(path).read_text(encoding="utf-8")
    return sys.stdin.read()


def normalize_text(text: str) -> str:
    text = text.replace("\u2019", "'")
    text = re.sub(r"\s+", " ", text).strip()
    return text


def clean_sentence(text: str, rules: dict[str, Any]) -> str:
    text = normalize_text(text)
    text = re.sub(r"^(yeah|mhm|okay|ok)([,.]\s*|\s+)", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^(that's right,?\s*but like\s*)", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^(and|but|so|well)\s+", "", text, flags=re.IGNORECASE)
    lowered = text.lower().strip()
    lowered_plain = re.sub(r"[^\w\s']", "", lowered).strip()
    if lowered in rules["filler_exact"] or lowered_plain in rules["filler_exact"]:
        return ""
    if any(fragment in {lowered, lowered_plain} for fragment in rules["filler_fragments"]):
        return ""
    if lowered_plain in {"green", "amber", "red", "blue"}:
        return text.strip()
    if sentence_word_count(text) <= 3 and lowered_plain in rules["weak_openers"]:
        return ""
    return text.strip()


def parse_turns(text: str) -> list[Turn]:
    turns: list[Turn] = []
    current_speaker: str | None = None
    current_timestamp: str | None = None
    buffer: list[str] = []

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if "started transcription" in line.lower() or "stopped transcription" in line.lower():
            continue
        match = TURN_RE.match(line)
        if match:
            if current_speaker and buffer:
                turns.append(
                    Turn(
                        speaker=current_speaker,
                        timestamp=current_timestamp or "",
                        text=normalize_text(" ".join(buffer)),
                    )
                )
            current_speaker = match.group("speaker")
            current_timestamp = match.group("timestamp")
            trailing_text = match.group("tail").strip()
            buffer = [trailing_text] if trailing_text else []
            continue
        if current_speaker:
            buffer.append(line)

    if current_speaker and buffer:
        turns.append(
            Turn(
                speaker=current_speaker,
                timestamp=current_timestamp or "",
                text=normalize_text(" ".join(buffer)),
            )
        )
    return turns


def is_filler(text: str, rules: dict[str, Any]) -> bool:
    lowered = text.lower().strip()
    if lowered in rules["filler_exact"]:
        return True
    words = re.findall(r"\b\w+\b", lowered)
    if len(words) <= 2 and any(fragment == lowered for fragment in rules["filler_fragments"]):
        return True
    if len(words) <= 3 and all(word in {"yeah", "mhm", "ok", "okay"} for word in words):
        return True
    return False


def best_milestone(text: str, rules: dict[str, Any], threshold: int = 85) -> tuple[str | None, int]:
    lowered = text.lower()
    text_tokens = {
        token for token in re.findall(r"\b[a-z0-9]+\b", lowered)
        if len(token) > 2 and token not in GENERIC_TOKENS
    }
    best_name = None
    best_score = 0
    for milestone, phrases in rules["milestones"].items():
        for phrase in phrases:
            phrase_tokens = {
                token for token in re.findall(r"\b[a-z0-9]+\b", phrase.lower())
                if len(token) > 2 and token not in GENERIC_TOKENS
            }
            if phrase in lowered:
                score = 100
            elif phrase_tokens and not (text_tokens & phrase_tokens):
                score = 0
            else:
                score = fuzz.partial_ratio(lowered, phrase)
            if score > best_score:
                best_name = milestone
                best_score = score
    if best_score < threshold:
        return None, best_score
    return best_name, best_score


def detect_status(text: str, rules: dict[str, Any]) -> list[str]:
    lowered = text.lower()
    found: list[str] = []

    for signal, mapped_status in rules.get("status_signals", {}).items():
        if re.search(rf"\b{re.escape(signal)}\b", lowered):
            if mapped_status not in found:
                found.append(mapped_status)

    for status, cues in rules["status_cues"].items():
        for cue in cues:
            if status == "complete" and re.search(r"\bnot complete\b|\bnot completed\b|\brollout not complete\b", lowered):
                continue
            if status == "complete" and re.search(r"\bbooked\b|\bscheduled\b|\bplanned\b|\bpending\b|\bnot due yet\b", lowered):
                continue
            if status == "green" and "green or amber" in lowered:
                continue
            if cue in lowered:
                if status not in found:
                    found.append(status)
                break
    return found


def extract_reason_hits(text: str, rules: dict[str, Any]) -> list[dict[str, str]]:
    lowered = text.lower()
    hits: list[dict[str, str]] = []
    for bucket, tags in rules.get("reason_signals", {}).items():
        for tag, phrases in tags.items():
            for phrase in phrases:
                if phrase in lowered:
                    if tag == "operational" and re.search(r"\bnot operational\b|operational i'd have to say no|operational i would have to say no", lowered):
                        continue
                    hits.append(
                        {
                            "bucket": bucket,
                            "tag": tag,
                            "phrase": phrase,
                            "text": text,
                        }
                    )
                    break
    return hits


def sentence_candidates(text: str) -> list[str]:
    return [part.strip() for part in re.split(r"(?<=[.!?])\s+", text) if part.strip()]


def is_low_signal_sentence(text: str, rules: dict[str, Any]) -> bool:
    lowered = text.lower().strip()
    lowered_plain = re.sub(r"[^\w\s']", "", lowered).strip()
    word_count = sentence_word_count(text)
    if lowered_plain in rules["filler_exact"]:
        return True
    if lowered_plain in rules["filler_fragments"]:
        return True
    if text.endswith("?") and word_count <= 8:
        return True
    if word_count <= 4 and any(lowered_plain.startswith(opener) for opener in rules["weak_openers"]):
        return True
    return False


def normalize_delivery_status(status: str) -> str:
    return DELIVERY_ALIAS_MAP.get(status, status)


def choose_priority_status(votes: Counter, priority: list[str]) -> str:
    if not votes:
        return "unknown"
    for status in priority:
        if votes.get(status):
            return status
    return votes.most_common(1)[0][0]


def counter_confidence(votes: Counter, chosen: str, *, floor: float = 0.0) -> float:
    total = sum(votes.values())
    if not total or chosen == "unknown":
        return floor
    dominant = votes.get(chosen, 0)
    score = dominant / total
    if len([status for status, count in votes.items() if count]) > 1:
        score -= 0.1
    return round(max(floor, min(0.99, score)), 2)


def compare_statuses(previous: str, current: str) -> str:
    previous = normalize_delivery_status(previous)
    current = normalize_delivery_status(current)
    prev_strength = DELIVERY_STATUS_STRENGTH.get(previous, -2)
    curr_strength = DELIVERY_STATUS_STRENGTH.get(current, -2)
    if previous == "unknown" and current != "unknown":
        return "new_update"
    if previous != "unknown" and current == "unknown":
        return "no_update"
    if previous == current:
        return "unchanged"
    if current == "needs_review":
        return "needs_review"
    if previous == "in_progress" and current == "scheduled":
        return "clarified"
    if previous == "in_progress" and current == "awaiting_input":
        return "clarified"
    if curr_strength > prev_strength:
        return "improved"
    if curr_strength < prev_strength:
        return "worsened"
    return "clarified"


def to_rag_status(analysis_status: str) -> str:
    return DEFAULT_RAG_FROM_DELIVERY.get(normalize_delivery_status(analysis_status), "unknown")


def join_clauses(parts: list[str]) -> str:
    parts = [part for part in parts if part]
    if not parts:
        return ""
    if len(parts) == 1:
        return parts[0]
    if len(parts) == 2:
        return f"{parts[0]} and {parts[1]}"
    return f"{', '.join(parts[:-1])}, and {parts[-1]}"


def build_change_reason(previous: dict[str, Any] | None, current: dict[str, Any] | None) -> str:
    if current is None:
        return "Milestone was not detected in the current transcript."
    previous_status = previous["status"] if previous else "unknown"
    current_status = current["status"]
    clauses: list[str] = []
    blockers = current.get("blocking_factors") or []
    next_steps = current.get("next_steps") or []
    evidence = current.get("evidence") or []
    reason_tags = current.get("reason_tags") or []

    if blockers:
        clauses.append(f"the transcript states {join_clauses([b.rstrip('.') for b in blockers[:3]])}")
    elif evidence:
        clauses.append(f"the transcript includes {join_clauses([e.rstrip('.') for e in evidence[:2]])}")

    if reason_tags:
        clauses.append(f"the normalized reasons are {join_clauses(reason_tags[:4])}")

    if current_status == "needs_review":
        clauses.append("the evidence contains both positive and risk signals")
    elif current_status == "scheduled":
        clauses.append("the work is described as planned rather than completed")
    elif current_status == "awaiting_input" and next_steps:
        clauses.append(f"the next tracked action is {next_steps[0].rstrip('.')}")

    change_type = compare_statuses(previous_status, current_status)

    if previous_status == "unknown":
        prefix = f"{current['milestone']} is now classified as {current_status}"
    elif previous_status == current_status:
        prefix = f"{current['milestone']} remains {current_status}"
    elif change_type == "clarified":
        prefix = f"{current['milestone']} was previously marked {previous_status} and is now classified more specifically as {current_status}"
    elif change_type == "needs_review":
        prefix = f"{current['milestone']} now needs review rather than staying at {previous_status}"
    else:
        prefix = f"{current['milestone']} moved from {previous_status} to {current_status}"

    if clauses:
        return f"{prefix} because {join_clauses(clauses)}."
    return f"{prefix} based on the extracted meeting evidence."


def extract_matches(text: str, phrases: list[str]) -> list[str]:
    lowered = text.lower()
    matches = []
    for phrase in phrases:
        if phrase in lowered and text not in matches:
            matches.append(text)
            break
    return matches


def infer_sentence_delivery_signals(text: str, rules: dict[str, Any]) -> list[str]:
    lowered = text.lower()
    signals: list[str] = []

    if any(phrase in lowered for phrase in rules["status_cues"]["blocked"]):
        signals.append("blocked")

    if any(phrase in lowered for phrase in rules["status_cues"]["waiting"]):
        signals.append("awaiting_input")

    if re.search(r"\bin review\b|\bneeds review\b|\bpending leadership review\b", lowered):
        signals.append("needs_review")

    progress_phrases = set(rules["status_cues"]["in_progress"]) | {
        "we've done",
        "done two reviews",
        "working through",
    }
    if any(phrase in lowered for phrase in progress_phrases):
        signals.append("in_progress")

    scheduled_phrases = set(rules["status_cues"]["scheduled"]) | {
        "due end of quarter",
        "still due end of quarter",
    }
    if any(phrase in lowered for phrase in scheduled_phrases):
        if "pending leadership review" not in lowered:
            signals.append("scheduled")

    if any(phrase in lowered for phrase in NOT_STARTED_PHRASES):
        signals.append("not_started")

    delayed_phrases = {
        phrase
        for phrase in rules["status_cues"]["at_risk"]
        if phrase not in {"amber", "red"}
    } | {
        "not operational",
        "haven't finalised",
        "hasn't been scoped",
        "visibility on workload",
        "later in june",
    }
    if any(phrase in lowered for phrase in delayed_phrases):
        signals.append("delayed")

    if re.search(r"\bnot complete\b|\brollout not complete\b", lowered):
        signals.append("in_progress")
        signals.append("delayed")

    complete_phrases = set(rules["status_cues"]["complete"]) | {
        "live and documented",
        "actual deliverable is there",
        "version one yesterday",
        "interviews are complete",
        "delivered",
    }
    if any(phrase in lowered for phrase in complete_phrases):
        if not re.search(r"\bnot complete\b|\bnot completed\b", lowered):
            signals.append("complete")

    if "on track" in lowered and "complete" not in signals:
        signals.append("in_progress")

    return dedupe_keep_order([normalize_delivery_status(signal) for signal in signals])


def infer_sentence_health_signals(text: str) -> list[str]:
    lowered = text.lower()
    signals: list[str] = []

    if re.search(r"\bblocked\b|\bcapacity issue\b|\bcan't be until\b|\bcannot be until\b|\bpotentially red\b", lowered):
        signals.append("red")
    if re.search(r"\bstatus blue\b|\bpending leadership review\b|\bin review\b|\bneeds review\b", lowered):
        signals.append("blue")
    if re.search(
        r"\bat risk\b|\bnot operational\b|\bneeds refinement\b|\bnothing received\b|\bno update\b|\bvisibility on workload\b|\bworking properly yet\b|\blater in june\b|\bdoesn't exist yet\b",
        lowered,
    ):
        signals.append("amber")
    if re.search(r"\blive and documented\b|\bdelivered\b|\bon track\b|\bcomplete\b|\bactual deliverable is there\b", lowered):
        signals.append("green")

    return dedupe_keep_order(signals)


def extract_rag_mentions(sentences: list[str]) -> list[dict[str, Any]]:
    mentions: list[dict[str, Any]] = []
    for index, sentence in enumerate(sentences):
        for pattern, weight in EXPLICIT_RAG_PATTERNS:
            match = pattern.search(sentence)
            if not match:
                continue
            mentions.append(
                {
                    "rag": match.group("rag").lower(),
                    "sentence": sentence,
                    "index": index,
                    "weight": weight,
                }
            )
    return mentions


def resolve_delivery_status(
    sentences: list[str],
    votes: Counter,
    rules: dict[str, Any],
) -> tuple[str, float, list[str], str]:
    if not sentences:
        return "unknown", 0.0, [], "No delivery evidence was detected."

    normalized_votes = Counter()
    for status, count in votes.items():
        normalized_votes[normalize_delivery_status(status)] += count
    for sentence in sentences:
        for signal in infer_sentence_delivery_signals(sentence, rules):
            normalized_votes[signal] += 1

    has_complete = normalized_votes["complete"] > 0
    has_progress = normalized_votes["in_progress"] > 0
    has_scheduled = normalized_votes["scheduled"] > 0
    has_delayed = normalized_votes["delayed"] > 0
    has_blocked = normalized_votes["blocked"] > 0
    has_waiting = normalized_votes["awaiting_input"] > 0
    has_review = normalized_votes["needs_review"] > 0
    has_not_started = normalized_votes["not_started"] > 0

    if has_blocked:
        status = "blocked"
    elif has_complete and has_review and not (has_progress or has_delayed or has_scheduled or has_not_started):
        status = "complete"
    elif has_complete and (has_progress or has_scheduled or has_delayed or has_not_started):
        status = "in_progress"
    elif has_progress:
        status = "in_progress"
    elif has_waiting and not (has_delayed or has_scheduled):
        status = "awaiting_input"
    elif has_delayed:
        status = "delayed"
    elif has_review:
        status = "needs_review"
    elif has_scheduled:
        status = "scheduled"
    elif has_complete:
        status = "complete"
    elif has_not_started:
        status = "not_started"
    else:
        status = choose_priority_status(normalized_votes, DELIVERY_STATUS_PRIORITY)

    conflicting = []
    for sentence in sentences:
        sentence_signals = infer_sentence_delivery_signals(sentence, rules)
        if not sentence_signals:
            continue
        if status == "in_progress" and any(
            signal in sentence_signals
            for signal in {"complete", "in_progress", "scheduled", "delayed", "not_started"}
        ):
            continue
        if status == "complete" and set(sentence_signals).issubset({"complete", "needs_review"}):
            continue
        if status not in sentence_signals:
            conflicting.append(sentence)

    confidence = counter_confidence(normalized_votes, status, floor=0.35 if status != "unknown" else 0.0)
    if conflicting:
        confidence = max(0.35, round(confidence - min(0.25, 0.05 * len(conflicting)), 2))

    note = f"Delivery status resolved to {status} from factual work-state evidence."
    return status, confidence, dedupe_keep_order(conflicting)[:4], note


def resolve_agreed_rag_status(
    sentences: list[str],
    delivery_status: str,
    health_assessment: str,
) -> tuple[str, float, str, list[str], str]:
    mentions = extract_rag_mentions(sentences)
    final_mention = None
    if mentions:
        strong_mentions = [mention for mention in mentions if mention["weight"] >= 0.9]
        final_mention = (strong_mentions or mentions)[-1]
        rag = final_mention["rag"]
        conflicting = [
            mention["sentence"]
            for mention in mentions
            if mention["sentence"] != final_mention["sentence"] and mention["rag"] != rag
        ]
        confidence = max(0.6, round(final_mention["weight"] - min(0.25, 0.07 * len(conflicting)), 2))
        note = f"Agreed RAG taken from the final explicit meeting decision: {final_mention['sentence']}"
        return rag, confidence, final_mention["sentence"], dedupe_keep_order(conflicting)[:4], note

    derived = DEFAULT_RAG_FROM_DELIVERY.get(delivery_status, health_assessment if health_assessment in RAG_VALUES else "unknown")
    if derived == "unknown" and health_assessment in RAG_VALUES:
        derived = health_assessment
    note = "No explicit final colour decision was found, so agreed_rag_status was derived from delivery status and health cues."
    evidence = sentences[0] if sentences else ""
    return derived, 0.55 if derived != "unknown" else 0.0, evidence, [], note


def resolve_health_assessment(
    sentences: list[str],
    delivery_status: str,
) -> tuple[str, float]:
    votes = Counter()
    for sentence in sentences:
        for signal in infer_sentence_health_signals(sentence):
            votes[signal] += 1

    if votes["red"]:
        health = "red"
    elif votes["blue"]:
        health = "blue"
    elif votes["amber"]:
        health = "amber"
    elif votes["green"]:
        health = "green"
    elif delivery_status == "blocked":
        health = "red"
    elif delivery_status in {"delayed", "awaiting_input", "not_started"}:
        health = "amber"
    elif delivery_status == "needs_review":
        health = "blue"
    elif delivery_status in {"complete", "scheduled", "in_progress"}:
        health = "green"
    else:
        health = "unknown"

    confidence = counter_confidence(votes, health, floor=0.4 if health != "unknown" else 0.0)
    return health, confidence


def build_status_resolution_note(
    delivery_status: str,
    agreed_rag_status: str,
    health_assessment: str,
    delivery_note: str,
    rag_note: str,
) -> str:
    return " ".join(
        [
            delivery_note,
            rag_note,
            f"Health assessment resolved to {health_assessment} from the evidence cues rather than the final agreed colour.",
            f"Legacy status={delivery_status} and rag_status={agreed_rag_status if agreed_rag_status != 'unknown' else health_assessment}.",
        ]
    )


def sentence_score(sentence: str, milestone: str, rules: dict[str, Any]) -> int:
    score = sentence_word_count(sentence)
    score += 8 * len(infer_sentence_delivery_signals(sentence, rules))
    if any(cue in sentence.lower() for cue in rules["blocker_cues"]):
        score += 6
    if any(cue in sentence.lower() for cue in rules["action_cues"]):
        score += 4
    for phrase in rules["milestones"].get(milestone, []):
        if phrase in sentence.lower():
            score += 10
            break
    return score


def normalize_segment_status(segment: Segment, status: str, rules: dict[str, Any]) -> str:
    text = " ".join(segment.sentences).lower()
    milestone = segment.milestone

    if milestone == "webinars":
        if re.search(r"\bbooked\b|\bnot complete\b", text):
            return "scheduled"

    if milestone == "ai_commercial_impact_report":
        if re.search(r"\bend of quarter\b|\bnot due yet\b", text):
            return "scheduled"

    if milestone == "stage_gate_vendor_strategy":
        if "not complete" in text or "doesn't exist yet" in text:
            if "complete" in text or "amber" in text:
                return "in_progress"

    if milestone == "ei_grant_feedback":
        if re.search(r"\bnothing received\b|\bno update\b|\bfollow up this week\b", text):
            return "waiting"

    if milestone == "ai_governance_framework":
        if re.search(r"\bin review\b|\bneeds review\b|\bpending leadership review\b|\bstatus blue\b", text):
            return "in_review"

    return status


def dedupe_keep_order(items: list[str]) -> list[str]:
    seen = set()
    deduped = []
    for item in items:
        key = item.lower().strip()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return deduped


def rank_sentences(sentences: list[str], milestone: str, rules: dict[str, Any], limit: int) -> list[str]:
    unique = dedupe_keep_order(sentences)
    ranked = sorted(
        unique,
        key=lambda sentence: (
            sentence_score(sentence, milestone, rules),
            len(sentence),
        ),
        reverse=True,
    )
    return ranked[:limit]


def segments_to_lookup(segments: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {segment["milestone"]: segment for segment in segments}


def build_change_report(previous_segments: list[dict[str, Any]], current_segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    previous_lookup = segments_to_lookup(previous_segments)
    current_lookup = segments_to_lookup(current_segments)
    all_milestones = sorted(set(previous_lookup) | set(current_lookup))
    changes: list[dict[str, Any]] = []
    for milestone in all_milestones:
        previous = previous_lookup.get(milestone)
        current = current_lookup.get(milestone)
        previous_status = previous["status"] if previous else "unknown"
        current_status = current["status"] if current else "unknown"
        change = compare_statuses(previous_status, current_status)
        entry = {
            "milestone": milestone,
            "previous_status": previous_status,
            "current_status": current_status,
            "previous_rag_status": previous.get("rag_status", to_rag_status(previous_status)) if previous else to_rag_status(previous_status),
            "current_rag_status": current.get("rag_status", to_rag_status(current_status)) if current else to_rag_status(current_status),
            "change": change,
            "change_reason": build_change_reason(previous, current),
        }
        if current:
            entry["current_confidence"] = current.get("status_confidence", 0.0)
        if previous:
            entry["previous_confidence"] = previous.get("status_confidence", 0.0)
        changes.append(entry)
    return changes


def load_previous_segments(path: str) -> list[dict[str, Any]]:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(payload, dict) and "segments" in payload:
        return payload["segments"]
    if isinstance(payload, list):
        return payload
    raise ValueError("Previous comparison file must be a segment list or analyzer JSON with 'segments'.")


def load_previous_payload(path: str) -> dict[str, Any]:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(payload, dict):
        return payload
    if isinstance(payload, list):
        return {"segments": payload}
    raise ValueError("Previous comparison file must be a JSON object or segment list.")


def sanitize_slug(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")
    return slug or "snapshot"


def latest_snapshot_path(snapshot_dir: Path) -> Path | None:
    if not snapshot_dir.exists():
        return None
    candidates = sorted(snapshot_dir.glob("*.json"))
    if not candidates:
        return None
    return candidates[-1]


def save_snapshot(output_dir: Path, result: dict[str, Any], source_path: str | None) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    base_name = sanitize_slug(Path(source_path).stem if source_path else "stdin")
    output_path = output_dir / f"{timestamp}_{base_name}.json"
    output_path.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    return output_path


def add_sentence_to_segment(
    segment: Segment,
    turn: Turn,
    sentence: str,
    rules: dict[str, Any],
) -> None:
    segment.turns.append(turn)
    segment.sentences.append(sentence)
    delivery_signals = infer_sentence_delivery_signals(sentence, rules)
    for status in delivery_signals:
        segment.status_votes[status] += 1
    if delivery_signals and sentence not in segment.evidence:
        segment.evidence.append(sentence)
    for blocker in extract_matches(sentence, rules["blocker_cues"]):
        if blocker not in segment.blockers:
            segment.blockers.append(blocker)
    for action in extract_matches(sentence, rules["action_cues"]):
        if action not in segment.next_steps:
            segment.next_steps.append(action)
    for hit in extract_reason_hits(sentence, rules):
        if hit not in segment.reason_hits:
            segment.reason_hits.append(hit)


def merge_segments(segments: list[Segment]) -> list[Segment]:
    merged: list[Segment] = []
    for segment in segments:
        if merged and merged[-1].milestone == segment.milestone:
            target = merged[-1]
            target.turns.extend(segment.turns)
            target.sentences.extend(segment.sentences)
            target.status_votes.update(segment.status_votes)
            for item in segment.evidence:
                if item not in target.evidence:
                    target.evidence.append(item)
            for item in segment.blockers:
                if item not in target.blockers:
                    target.blockers.append(item)
            for item in segment.next_steps:
                if item not in target.next_steps:
                    target.next_steps.append(item)
            target.confidence = max(target.confidence, segment.confidence)
            continue
        merged.append(segment)
    return merged


def should_drop_unclassified(segment: Segment) -> bool:
    if segment.milestone != "unclassified":
        return False
    text = " ".join(segment.sentences).strip()
    if not text:
        return True
    if len(segment.sentences) <= 2 and sentence_word_count(text) <= 12:
        return True
    return False


def should_drop_unknown_segment(segment: Segment) -> bool:
    if segment.milestone == "unclassified":
        return False
    text = " ".join(segment.sentences).lower()
    if segment.status_votes:
        return False
    if any(cue in text for cue in ["actions before next week", "follow up", "review ", "confirm ", "draft ", "validate "]):
        return True
    if sentence_word_count(text) <= 10:
        return True
    return False


def analyze(turns: list[Turn], rules: dict[str, Any]) -> dict[str, Any]:
    cleaned_turns = [turn for turn in turns if not is_filler(turn.text, rules)]
    segments: list[Segment] = []
    current: Segment | None = None

    for turn in cleaned_turns:
        meaningful_sentences = []
        for sentence in sentence_candidates(turn.text):
            cleaned = clean_sentence(sentence, rules)
            if cleaned:
                meaningful_sentences.append(cleaned)

        if not meaningful_sentences:
            continue

        for sentence in meaningful_sentences:
            milestone, confidence = best_milestone(sentence, rules)
            delivery_signals = infer_sentence_delivery_signals(sentence, rules)
            rag_mentions = extract_rag_mentions([sentence])
            word_count = sentence_word_count(sentence)

            if is_low_signal_sentence(sentence, rules) and milestone is None and not rag_mentions and not delivery_signals:
                continue

            if milestone is None and not delivery_signals and not rag_mentions and word_count <= 4:
                continue

            if milestone:
                if current and current.turns and current.milestone != milestone:
                    segments.append(current)
                if current is None or current.milestone != milestone:
                    current = Segment(milestone=milestone, confidence=confidence)
                else:
                    current.confidence = max(current.confidence, confidence)
            elif current is None:
                if word_count <= 6:
                    continue
                current = Segment(milestone="unclassified", confidence=0)

            assert current is not None
            add_sentence_to_segment(current, turn, sentence, rules)

    if current and current.turns:
        segments.append(current)
    segments = merge_segments(segments)
    segments = [segment for segment in segments if not should_drop_unclassified(segment)]
    segments = [segment for segment in segments if not should_drop_unknown_segment(segment)]

    structured_segments = []
    for segment in segments:
        raw_status = choose_priority_status(segment.status_votes, DELIVERY_STATUS_PRIORITY)
        delivery_status, delivery_status_confidence, conflicting_evidence, delivery_note = resolve_delivery_status(
            segment.sentences,
            segment.status_votes,
            rules,
        )
        health_assessment, health_assessment_confidence = resolve_health_assessment(
            segment.sentences,
            delivery_status,
        )
        agreed_rag_status, agreed_rag_confidence, final_decision_evidence, rag_conflicts, rag_note = resolve_agreed_rag_status(
            segment.sentences,
            delivery_status,
            health_assessment,
        )
        legacy_rag_status = agreed_rag_status if agreed_rag_status != "unknown" else health_assessment
        ranked_evidence = rank_sentences(segment.evidence or segment.sentences, segment.milestone, rules, limit=4)
        ranked_blockers = rank_sentences(segment.blockers, segment.milestone, rules, limit=3)
        ranked_next_steps = rank_sentences(segment.next_steps, segment.milestone, rules, limit=3)
        signal_summary = {
            "positive": dedupe_keep_order([hit["tag"] for hit in segment.reason_hits if hit["bucket"] == "positive"]),
            "attention": dedupe_keep_order([hit["tag"] for hit in segment.reason_hits if hit["bucket"] == "attention"]),
            "negative": dedupe_keep_order([hit["tag"] for hit in segment.reason_hits if hit["bucket"] == "negative"]),
        }
        reason_tags = dedupe_keep_order(
            [hit["tag"] for hit in segment.reason_hits if hit["bucket"] in {"attention", "negative"}]
        )
        status_reasons = dedupe_keep_order(
            [hit["phrase"] for hit in segment.reason_hits if hit["bucket"] in {"attention", "negative"}]
        )
        structured_segments.append(
            {
                "milestone": segment.milestone,
                "status": delivery_status,
                "analysis_status": delivery_status,
                "raw_status": normalize_delivery_status(raw_status),
                "rag_status": legacy_rag_status,
                "delivery_status": delivery_status,
                "agreed_rag_status": agreed_rag_status,
                "health_assessment": health_assessment,
                "delivery_status_confidence": delivery_status_confidence,
                "agreed_rag_confidence": agreed_rag_confidence,
                "health_assessment_confidence": health_assessment_confidence,
                "status_confidence": delivery_status_confidence,
                "confidence": delivery_status_confidence,
                "milestone_match_confidence": round(segment.confidence / 100, 2) if segment.confidence else 0.0,
                "evidence": ranked_evidence,
                "blocking_factors": ranked_blockers,
                "next_steps": ranked_next_steps,
                "signal_summary": signal_summary,
                "reason_tags": reason_tags,
                "status_reasons": status_reasons,
                "final_decision_evidence": final_decision_evidence,
                "conflicting_evidence": dedupe_keep_order(conflicting_evidence + rag_conflicts)[:6],
                "status_resolution_note": build_status_resolution_note(
                    delivery_status,
                    agreed_rag_status,
                    health_assessment,
                    delivery_note,
                    rag_note,
                ),
                "speakers": sorted({turn.speaker for turn in segment.turns}),
                "turn_count": len({(turn.speaker, turn.timestamp, turn.text) for turn in segment.turns}),
                "sentence_count": len(segment.sentences),
                "excerpt": " ".join(rank_sentences(segment.sentences, segment.milestone, rules, limit=2)),
            }
        )

    return {
        "turn_count_raw": len(turns),
        "turn_count_cleaned": len(cleaned_turns),
        "segments": structured_segments,
        "cleaned_turns": [
            {
                "speaker": turn.speaker,
                "timestamp": turn.timestamp,
                "text": turn.text,
                "sentences": [
                    cleaned
                    for cleaned in (clean_sentence(s, rules) for s in sentence_candidates(turn.text))
                    if cleaned
                ],
            }
            for turn in cleaned_turns
        ],
    }


def analyse(text: str) -> dict[str, Any]:
    repo_dir = Path(__file__).resolve().parent.parent
    rules = load_rules(repo_dir)
    turns = parse_turns(text)
    return analyze(turns, rules)


def compact_changes(changes: list[dict[str, Any]], only_changed: bool = True) -> list[dict[str, Any]]:
    filtered = []
    for item in changes:
        if only_changed and item["change"] == "unchanged":
            continue
        filtered.append(
            {
                "milestone": item["milestone"],
                "previous_status": item["previous_status"],
                "current_status": item["current_status"],
                "previous_rag_status": item.get("previous_rag_status", to_rag_status(item["previous_status"])),
                "current_rag_status": item.get("current_rag_status", to_rag_status(item["current_status"])),
                "change": item["change"],
                "change_reason": item["change_reason"],
            }
        )
    return filtered


def render_changes_table(changes: list[dict[str, Any]], only_changed: bool = True) -> str:
    rows = compact_changes(changes, only_changed=only_changed)
    headers = ["Milestone", "Was", "Now", "RAG", "Change", "Why"]
    table_rows = []
    for row in rows:
        table_rows.append(
            [
                row["milestone"],
                row["previous_status"],
                row["current_status"],
                f'{row["previous_rag_status"]} -> {row["current_rag_status"]}',
                row["change"],
                row["change_reason"],
            ]
        )
    widths = [len(header) for header in headers]
    for row in table_rows:
        for idx, cell in enumerate(row):
            widths[idx] = max(widths[idx], len(str(cell)))

    def format_row(row: list[str]) -> str:
        return " | ".join(str(cell).ljust(widths[idx]) for idx, cell in enumerate(row))

    lines = [format_row(headers), "-+-".join("-" * width for width in widths)]
    lines.extend(format_row(row) for row in table_rows)
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Analyze a transcript into milestone/status JSON.")
    parser.add_argument("path", nargs="?", help="Optional path to a UTF-8 transcript file")
    parser.add_argument(
        "--compare",
        help="Optional path to a previous analyzer JSON file or segment list for change detection"
    )
    parser.add_argument(
        "--compare-latest",
        action="store_true",
        help="Compare against the latest saved snapshot in the history directory"
    )
    parser.add_argument(
        "--save-snapshot",
        action="store_true",
        help="Save the analyzer result into the skill history directory"
    )
    parser.add_argument(
        "--snapshot-dir",
        help="Optional override for the snapshot output directory"
    )
    parser.add_argument(
        "--changes-only",
        action="store_true",
        help="When comparing, output only the compact change list"
    )
    parser.add_argument(
        "--changes-table",
        action="store_true",
        help="When comparing, output only a compact plain-text table of changes"
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Pretty-print JSON output"
    )
    args = parser.parse_args()

    skill_dir = Path(__file__).resolve().parent.parent
    rules = load_rules(skill_dir)
    text = read_input(args.path).strip()
    if not text:
        print("No input text provided.", file=sys.stderr)
        return 1

    turns = parse_turns(text)
    result = analyze(turns, rules)
    snapshot_dir = Path(args.snapshot_dir) if args.snapshot_dir else (skill_dir / "history")
    compare_path = args.compare
    if args.compare_latest and not compare_path:
        latest = latest_snapshot_path(snapshot_dir)
        if latest:
            compare_path = str(latest)
    if compare_path:
        previous_payload = load_previous_payload(compare_path)
        previous_segments = previous_payload["segments"]
        result["changes"] = build_change_report(previous_segments, result["segments"])
        result["compared_to"] = compare_path
        if args.changes_table:
            print(render_changes_table(result["changes"], only_changed=True))
            return 0
        if args.changes_only:
            result = {
                "compared_to": compare_path,
                "changes": compact_changes(result["changes"], only_changed=True),
            }
    if args.save_snapshot:
        snapshot_path = save_snapshot(snapshot_dir, result, args.path)
        if isinstance(result, dict):
            result["snapshot_path"] = str(snapshot_path)
    if args.pretty:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
