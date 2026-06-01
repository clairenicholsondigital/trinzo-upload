"""Reusable quality gates for meeting extraction.

The helpers in this module intentionally stay lightweight and deterministic so
that topic/evidence/status decisions can be unit-tested independently from the
larger meeting-minutes extractor.
"""

from __future__ import annotations

import re
from typing import Any

_DISCOURSE_PREFIXES = (
    "and", "but", "because", "so", "then", "yeah", "okay", "ok", "um", "uh",
)
_VAGUE_PREFIXES = ("that", "this", "it", "its", "it's")
_STATUS_EVIDENCE_PHRASES = (
    "deadline for that", "under pressure", "slips", "slip", "on track", "green",
    "amber", "red", "blocked", "nothing to deliver", "not within our control",
    "sales input is still required", "still required", "pending", "awaiting",
    "not yet", "not finalised", "not finalized", "in progress", "complete",
    "confirmed as", "milestone is", "that milestone", "last milestone",
    "still building", "nothing new", "nothing received", "no update",
    "doesn't exist yet", "does not exist yet", "not complete", "due end",
    "follow up", "follow-up", "chasing",
)
_NOISE_PHRASES = (
    "i'm not functioning", "im not functioning", "button.not really",
    "button. not really", "i'll turn off transcription", "ill turn off transcription",
    "started transcription", "stopped transcription", "soundtrack, we're working on it",
    "soundtrack, were working on it",
)
_TOPIC_HINTS = {
    "strategy", "pipeline", "report", "funnel", "process", "rollout", "review",
    "plan", "delivery", "sow", "sows", "intake", "grant", "feedback", "vendor",
    "commercial", "impact", "stage", "gate", "innovation", "use", "case",
    "framework", "governance", "webinar", "workflow", "library",
}
_TOPIC_VERBS = {
    "is", "are", "was", "were", "be", "been", "being", "remains", "remain",
    "has", "have", "had", "needs", "need", "requires", "required", "working",
    "chasing", "done", "completed",
}
_SINGLE_WORD_NOISE = {"the", "a", "an", "and", "but", "so", "that", "this", "it", "um", "uh", "yeah", "okay", "ok"}


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "").replace("\u2019", "'")).strip()


def _tokens(text: str) -> list[str]:
    return re.findall(r"[a-z0-9']+", _clean(text).lower())


def split_status_sentences(text: str) -> list[str]:
    """Split a speaker turn into status-review sentence/clause chunks."""
    cleaned = _clean(text)
    if not cleaned:
        return []
    chunks: list[str] = []
    # First split on hard sentence boundaries, then on semicolon/long dash
    # clause boundaries. Keep comma clauses intact because topic names often
    # include short descriptive commas in natural speech.
    for sentence in re.split(r"(?<=[.!?])\s+|[;]\s+|\s+[–—]\s+", cleaned):
        part = sentence.strip(" \t\n\r")
        if not part:
            continue
        # Split simple chained topic/evidence clauses without needing the full
        # extractor. This keeps "Topic. Evidence. Topic. Evidence." turns from
        # being treated as one subject.
        for clause in re.split(r"\s+(?=(?:Again,\s+)?(?:[A-Z][A-Za-z0-9&/' -]{3,60}\.?\s+)?(?:That milestone|The last milestone)\b)", part):
            clause = clause.strip(" ,").rstrip(".?!")
            if clause:
                chunks.append(clause)
    return chunks


def is_status_evidence(text: str) -> bool:
    lowered = _clean(text).lower().strip(".?!")
    if not lowered:
        return False
    return any(phrase in lowered for phrase in _STATUS_EVIDENCE_PHRASES)


def is_vague_reference_topic(text: str) -> bool:
    cleaned = _clean(text).strip(".?!")
    lowered = cleaned.lower()
    tokens = _tokens(cleaned)
    if not tokens:
        return True
    first = tokens[0]
    if first in _DISCOURSE_PREFIXES or first in _VAGUE_PREFIXES or first in {"still", "first", "second", "third", "one", "new", "right", "we", "we've", "weve", "i", "i'd", "id", "they"}:
        return True
    if len(tokens) >= 2 and tokens[0] == "the" and tokens[1] in set(_DISCOURSE_PREFIXES) | set(_VAGUE_PREFIXES):
        return True
    return any(
        phrase in lowered
        for phrase in (
            "that milestone", "the last milestone", "working on it", "deadline for that",
            "soundtrack, we're working on it", "soundtrack, were working on it",
        )
    )


def is_transcript_noise(text: str) -> bool:
    cleaned = _clean(text)
    lowered = cleaned.lower().strip(".?!")
    if not lowered:
        return True
    if lowered in _SINGLE_WORD_NOISE:
        return True
    if lowered.startswith(("right, let's", "right let's", "let's ", "lets ", "go ahead")):
        return True
    if len(_tokens(lowered)) == 1 and len(lowered) <= 4:
        return True
    return any(phrase in lowered for phrase in _NOISE_PHRASES)


def is_clean_topic_anchor(text: str) -> bool:
    cleaned = _clean(text).strip(".?!")
    lowered = cleaned.lower()
    tokens = _tokens(cleaned)
    if not tokens or len(tokens) > 8:
        return False
    if is_transcript_noise(cleaned) or is_vague_reference_topic(cleaned) or is_status_evidence(cleaned):
        return False
    if any(token in _TOPIC_VERBS for token in tokens):
        return False
    if tokens[0] in {"deliver", "review", "finalise", "finalize", "prepare"}:
        # Imperative/action phrasing is evidence/action, not the topic anchor.
        return False
    return any(token in _TOPIC_HINTS or len(token) >= 6 for token in tokens)


def is_client_safe_discussion_point(
    text: str,
    evidence: list[dict[str, Any]] | None = None,
    source_turn_indices: list[int] | None = None,
) -> bool:
    cleaned = _clean(text)
    lowered = cleaned.lower()
    if not cleaned or is_transcript_noise(cleaned):
        return False
    if cleaned.startswith(("The And", "The and")):
        return False
    unsafe_subjects = (
        "deadline for that", "that milestone", "soundtrack, we're working on it",
        "soundtrack, were working on it",
    )
    subject = lowered.split(" remains ", 1)[0].split(" is ", 1)[0].split(" appears ", 1)[0]
    if any(phrase in subject for phrase in unsafe_subjects):
        return False
    if "i'm not functioning" in lowered or "im not functioning" in lowered:
        return False
    has_evidence = bool(evidence) or bool(source_turn_indices)
    if not has_evidence:
        # Allow clean anchor summaries that are already explicit status-review
        # summaries. Everything else should have traceable support.
        return is_clean_topic_anchor(subject.removeprefix("the ")) and is_status_evidence(cleaned)
    return True
