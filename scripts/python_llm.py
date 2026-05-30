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
STATUS_PRIORITY = ["blocked", "paused", "at_risk", "waiting", "in_review", "in_progress", "scheduled", "complete", "green"]
STATUS_STRENGTH = {
    "needs_review": 2,
    "awaiting_input": 3,
    "delayed": 2,
    "blocked": 0,
    "paused": 1,
    "at_risk": 2,
    "waiting": 3,
    "in_review": 4,
    "in_progress": 4,
    "scheduled": 5,
    "green": 6,
    "complete": 7,
    "unknown": -1,
}
CANONICAL_STATUS_MAP = {
    "complete": "complete",
    "green": "in_progress",
    "in_progress": "in_progress",
    "scheduled": "scheduled",
    "waiting": "awaiting_input",
    "in_review": "needs_review",
    "needs_review": "needs_review",
    "at_risk": "delayed",
    "paused": "paused",
    "blocked": "blocked",
    "unknown": "unknown",
}
RAG_MAP = {
    "complete": "green",
    "green": "green",
    "in_progress": "green",
    "scheduled": "green",
    "in_review": "blue",
    "waiting": "amber",
    "at_risk": "amber",
    "needs_review": "amber",
    "awaiting_input": "amber",
    "delayed": "amber",
    "paused": "red",
    "blocked": "red",
    "unknown": "grey",
}


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
    if lowered_plain in {"green", "amber", "red"}:
        return ""
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


def choose_status(votes: Counter) -> str:
    if not votes:
        return "unknown"
    positive = any(votes.get(status) for status in {"green", "complete", "scheduled"})
    caution = any(votes.get(status) for status in {"at_risk"})
    hard_block = any(votes.get(status) for status in {"blocked", "paused"})
    if positive and caution and not hard_block:
        return "needs_review"
    for status in STATUS_PRIORITY:
        if votes.get(status):
            return status
    return votes.most_common(1)[0][0]


def status_confidence(votes: Counter) -> float:
    total = sum(votes.values())
    if not total:
        return 0.0
    chosen = choose_status(votes)
    if chosen == "needs_review":
        dominant_votes = votes.most_common(1)[0][1] if votes else 0
        return round(1 - (dominant_votes / total), 2)
    return round(votes[chosen] / total, 2)


def compare_statuses(previous: str, current: str) -> str:
    previous = to_canonical_status(previous)
    current = to_canonical_status(current)
    prev_strength = STATUS_STRENGTH.get(previous, -1)
    curr_strength = STATUS_STRENGTH.get(current, -1)
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
    return RAG_MAP.get(analysis_status, "grey")


def to_canonical_status(status: str) -> str:
    return CANONICAL_STATUS_MAP.get(status, status)


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


def sentence_score(sentence: str, milestone: str, rules: dict[str, Any]) -> int:
    score = sentence_word_count(sentence)
    score += 8 * len(detect_status(sentence, rules))
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
            "previous_rag_status": to_rag_status(previous_status),
            "current_rag_status": to_rag_status(current_status),
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
    statuses = detect_status(sentence, rules)
    for status in statuses:
        segment.status_votes[status] += 1
    if statuses and sentence not in segment.evidence:
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
            statuses = detect_status(sentence, rules)
            word_count = sentence_word_count(sentence)

            if is_low_signal_sentence(sentence, rules) and milestone is None:
                continue

            if milestone is None and not statuses and word_count <= 4:
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
        raw_status = choose_status(segment.status_votes)
        raw_status = normalize_segment_status(segment, raw_status, rules)
        status = to_canonical_status(raw_status)
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
                "status": status,
                "analysis_status": status,
                "raw_status": raw_status,
                "rag_status": to_rag_status(status),
                "status_confidence": status_confidence(segment.status_votes),
                "confidence": segment.confidence,
                "evidence": ranked_evidence,
                "blocking_factors": ranked_blockers,
                "next_steps": ranked_next_steps,
                "signal_summary": signal_summary,
                "reason_tags": reason_tags,
                "status_reasons": status_reasons,
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
