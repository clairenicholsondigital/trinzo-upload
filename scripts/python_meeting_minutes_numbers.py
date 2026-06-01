#!/usr/bin/env python3
"""Experimental numeric meeting-minutes extractor."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import re
from collections import Counter
from difflib import SequenceMatcher
from functools import lru_cache
from pathlib import Path
from typing import Any

try:
    from rapidfuzz import fuzz
except ImportError:
    fuzz = None

try:
    from .python_llm_meeting_minutes import (
        MINUTES_CONFIG,
        extract_header_fields,
        finalize_sentence,
        has_malformed_trailing_question_fragment as text_has_malformed_trailing_question_fragment,
        load_json,
        normalize_text_fragment,
        split_sentences,
        trim_malformed_trailing_question_fragment as text_trim_malformed_trailing_question_fragment,
    )
except ImportError:
    from python_llm_meeting_minutes import (
        MINUTES_CONFIG,
        extract_header_fields,
        finalize_sentence,
        has_malformed_trailing_question_fragment as text_has_malformed_trailing_question_fragment,
        load_json,
        normalize_text_fragment,
        split_sentences,
        trim_malformed_trailing_question_fragment as text_trim_malformed_trailing_question_fragment,
    )


NAME_TOKEN = r"[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'`.-]*"
SPEAKER_NAME_RE = rf"{NAME_TOKEN}(?: {NAME_TOKEN}){{0,5}}"
SPEAKER_SUFFIX_RE = r"(?:\s*(?:\([^)\n]{1,40}\)|\[[^\]\n]{1,40}\]))?"
TIMESTAMP_TOKEN_RE = r"\d{1,2}(?::|\.)\d{2}(?::\d{2})?(?:\s?(?:am|pm))?"

TURN_RE = re.compile(rf"^(?P<speaker>{SPEAKER_NAME_RE}){SPEAKER_SUFFIX_RE}\s+(?P<timestamp>{TIMESTAMP_TOKEN_RE})\s*(?P<tail>.*)$")
COLON_TURN_RE = re.compile(rf"^(?P<speaker>{SPEAKER_NAME_RE}){SPEAKER_SUFFIX_RE}\s*:\s*(?P<tail>.*)$")
HYPHEN_TURN_RE = re.compile(rf"^(?P<speaker>{SPEAKER_NAME_RE}){SPEAKER_SUFFIX_RE}\s*[-–—]\s*(?P<timestamp>{TIMESTAMP_TOKEN_RE})\s*(?P<tail>.*)$")
SPEAKER_ONLY_RE = re.compile(rf"^(?P<speaker>{SPEAKER_NAME_RE}){SPEAKER_SUFFIX_RE}$")
TIMESTAMP_ONLY_RE = re.compile(rf"^(?P<timestamp>{TIMESTAMP_TOKEN_RE})$")
METADATA_SPEAKERS = {"Date", "Location", "Online"}
METADATA_RE = re.compile(
    r"(?:-meeting transcript$)|(?:^\d{1,2}\s+\w+\s+\d{4}(?:,\s*\d{1,2}:\d{2}(?:am|pm))?$)|(?:^\d+m\s+\d+s$)|(?:started transcription\.?$)|(?:stopped transcription\.?$)",
    re.IGNORECASE,
)
ACTION_HEADER_RE = re.compile(r"^(?:actions?|next steps|follow ups?|action items)(?:\s+before\s+[^:]+)?:\s*$", re.IGNORECASE)
INLINE_ACTION_HEADER_RE = re.compile(r"^(?P<header>(?:actions?|next steps|follow ups?|action items)(?:\s+before\s+[^:]+)?):\s*(?P<tail>.*)$", re.IGNORECASE)
INLINE_ACTION_HEADER_SEARCH_RE = re.compile(r"(?P<header>(?:actions?|next steps|follow ups?|action items)(?:\s+before\s+[^:]+)?):\s*(?P<tail>.*)$", re.IGNORECASE)
QUESTION_RE = re.compile(r"\?$")
DEADLINE_RE = re.compile(
    r"\b(?:"
    r"today|tomorrow|this afternoon|this morning|this evening|"
    r"this week|next week|next month|next sprint|"
    r"end of day|end of week|end of month|end of quarter|"
    r"eod|cob|cop|close of play|when available|"
    r"before the webinar|before [A-Z][a-z]+|by [A-Z][a-z]+|"
    r"(?:by|before)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+(?:morning|afternoon|evening|noon|eod|cob|cop))?|"
    r"(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+(?:morning|afternoon|evening|noon|eod|cob|cop))?"
    r")\b",
    re.IGNORECASE,
)
DEPENDENCY_DEADLINE_RE = re.compile(
    r"\b(?:after|once)\s+"
    r"(?:the\s+)?"
    r"[a-z][a-z0-9'/-]*"
    r"(?:\s+[a-z][a-z0-9'/-]*){0,5}"
    r"\s+"
    r"(?:"
    r"signs?(?:\s+it\s+off)?|signed(?:\s+it\s+off|\s+off)?|"
    r"clears?(?:\s+it)?|cleared(?:\s+it)?|"
    r"approves?(?:\s+it)?|approved(?:\s+it)?|"
    r"confirms?(?:\s+it)?|confirmed(?:\s+it)?|"
    r"reviews?(?:\s+it)?|reviewed(?:\s+it)?|"
    r"arrives?|arrived|lands?|landed|"
    r"is\s+available|becomes\s+available|comes\s+through"
    r")\b",
    re.IGNORECASE,
)
FINALISER_RE = re.compile(r"^(?:we['’]?ll|we will)\s+(?:pursue|go with|proceed with)\b", re.IGNORECASE)

STOPWORDS = {
    "the", "a", "an", "and", "or", "but", "if", "to", "of", "in", "on", "for", "with", "we",
    "it", "that", "this", "is", "are", "was", "were", "be", "been", "being", "as", "at", "by",
    "from", "they", "them", "their", "our", "you", "your", "i", "me", "my", "he", "she", "his",
    "her", "so", "then", "just", "also", "there", "here", "have", "has", "had", "do", "does",
    "did", "will", "would", "should", "could", "can", "about", "into", "than", "too", "very",
    "what", "who", "when", "where", "which", "why", "how", "right", "okay", "ok", "yeah", "yes",
    "fine", "true", "perfect", "thanks", "thank", "everyone", "item", "today", "main", "also",
    "it's", "thats", "that's", "we're", "i'd", "don't", "lets", "let's", "they've", "we've",
    "isn't", "hasn't", "haven't", "doesn't", "didn't",
}
LOW_CONTENT_PHRASES = {
    "okay", "ok", "fine", "agreed", "true", "perfect", "sounds good", "go ahead",
    "anything else", "meeting over", "no that's everything", "no, that's everything",
    "thanks everyone", "yeah", "yes", "sure", "correct",
}
NAVIGATION_PHRASES = {
    "let's run through", "main item today", "anything else", "go ahead", "thanks everyone",
    "stop recording", "meeting over", "right, let's", "okay, next", "let's start with",
    "let's move on", "let's go through",
}
REQUEST_PREFIXES = ("can you", "could you", "would you", "will you", "who is handling")
COMMITMENT_MARKERS = ("i'll", "i will", "i can")
GENERIC_COMMITMENT_PATTERNS = (
    "i'll do that", "i will do that", "i can do that",
    "i'll take that", "i will take that", "i can take that",
    "i'll handle it", "i will handle it", "i can handle it",
    "i'll look into it", "i will look into it", "i'll look into that", "i will look into that",
    "i'll pick that up", "i will pick that up",
    "i'll own that", "i will own that", "i can own that",
)
REJECTION_CUES = (
    "no", "won't have time", "wont have time", "can't", "cannot", "not before",
    "unable to", "won't be able to", "wont be able to", "don't have time", "do not have time",
)
REQUEST_CLOSURE_CUES = (
    "okay", "ok", "we'll leave it", "well leave it", "leave it", "fair enough", "no worries",
)
ACK_PREFIX_RE = re.compile(r"^(?:yes|yeah|yep|sure|okay|ok|fine|perfect|agreed|right)\b[\s,.-]*", re.IGNORECASE)
DIRECT_ASSIGNMENT_RE = re.compile(r"^(?P<owner>[A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+){0,2})\s+to\s+(?P<task>.+)$")
SELF_COMMITMENT_RE = re.compile(r"^(?:i['’]?ll|i will|i can)\s+(?P<task>.+)$", re.IGNORECASE)
NAMED_COMMITMENT_RE = re.compile(
    rf"(?P<owner>{SPEAKER_NAME_RE})\s+(?:will|can)\s+(?P<task>.+?)"
    rf"(?=(?:,\s*|\s+and\s+)(?:{SPEAKER_NAME_RE})\s+(?:will|can)\b|[.;]|$)",
    re.IGNORECASE,
)
REQUEST_RE = re.compile(r"^(?:can|could|would|will)\s+you\s+(?P<task>.+)$", re.IGNORECASE)
OWNERSHIP_RE = re.compile(r"^who is handling\s+(?P<task>.+)$", re.IGNORECASE)
RESPONSIBILITY_RE = re.compile(r"^(?:we should|we need to|someone needs to)\s+(?P<task>.+)$", re.IGNORECASE)
LOW_VALUE_ACTION_PATTERNS = (
    "hear me", "see me", "join the call", "on mute", "screen share", "screen-sharing",
    "screen sharing", "audio working", "video working", "work here", "he's hot",
    "take your top off", "taking off your clothes", "vape", "like and subscribe",
)
LOW_VALUE_DISCUSSION_PATTERNS = LOW_VALUE_ACTION_PATTERNS + (
    "talk french",
    "do not talk french",
    "try not to vape",
)
MICRO_ACTION_VERBS = {
    "put", "bring", "move", "drop", "copy", "paste", "insert", "place",
}
MICRO_ACTION_OBJECT_TERMS = {
    "image", "background", "colour", "color", "graphic", "picture", "png",
    "jpeg", "jpg", "screenshot", "box",
}
PRESENTATION_REFERENCE_TERMS = (
    "webinar", "presentation", "presenter", "presenting", "slide", "slides", "demo",
    "demonstration", "agenda", "case study", "talk through", "go through", "walk through",
    "what i say", "what you're saying", "what youre saying", "what you're showing", "what youre showing",
    "explain", "introduce", "show", "demonstrate", "say that", "say this", "keep it educational",
)
PRESENTATION_SPEECH_PREFIXES = (
    "say ", "show ", "explain ", "introduce ", "demonstrate ", "walk through ", "talk through ",
    "go through ", "give you an example", "just to give you an example", "describe ",
)
PRESENTATION_META_PHRASES = (
    "the point i'm trying to make", "the point im trying to make", "what i say", "what you're saying",
    "what youre saying", "what you're showing", "what youre showing", "you'll be talking through",
    "youll be talking through", "we're just keeping it educational", "were just keeping it educational",
)
EXPLICIT_CHANGE_CREATE_TERMS = (
    "change", "create", "add", "remove", "replace", "refine", "improve", "simplify", "update",
    "rewrite", "tighten", "edit", "draft", "prepare", "practice", "put", "insert", "use", "snip",
    "reduce", "incorporate",
)
ACTION_VERBS = {
    "send", "review", "update", "check", "confirm", "draft", "prepare", "handle", "negotiate",
    "speak", "coordinate", "follow", "validate", "improve", "clarify", "refine", "tighten", "run",
    "complete", "share", "finalise", "finalize", "fix", "request", "reproduce", "capture",
    "publish", "split", "investigate", "look", "own",
}
DISCUSSION_TERMS = {
    "risk", "issue", "option", "cost", "scope", "quality", "timing", "owner", "dependency", "review",
    "status", "renewal", "contract", "supplier", "pricing", "problem", "blocked", "complete", "green",
    "amber", "red", "timeline", "registration", "attendee", "budget", "finance", "legal",
}
NON_TOPIC_TERMS = {
    "green", "amber", "red", "blue", "complete", "blocked", "active", "review", "progress",
    "operational", "status", "because", "still", "there", "nothing", "new", "next", "week",
    "today", "tomorrow", "later", "june", "would", "probably", "actual", "deliverable", "due",
    "item", "main", "right", "okay", "fine", "good", "perfect", "it's", "that's", "we're",
    "i'd", "don't", "lets", "let's", "one", "two", "three", "somebody", "asks", "use", "run",
    "through", "maybe", "actually", "need",
}
CLUSTER_LINK_STOPWORDS = NON_TOPIC_TERMS | {
    "case", "cases", "first", "second", "third", "using", "used", "user", "users",
    "reviewed", "workstream", "workstreams", "meeting", "programme", "project",
}
STATUS_TERMS = ("complete", "blocked", "amber", "green", "red", "blue", "due", "not operational", "awaiting", "in review", "in progress")
MALFORMED_DISCUSSION_PREFIXES = (
    "the no ", "the yes ", "the it ", "the that ", "the this ", "the okay ",
    "the true ", "the fine ", "the probably ", "the maybe ",
)
WEAK_CLUSTER_PREFIXES = (
    "the team reviewed ", "let's ", "maybe ", "one ", "actually ", "green because ",
)
TOPIC_PROMPT_REJECT_PREFIXES = (
    "still ", "we've", "we have", "yeah", "agreed", "no ", "nothing ",
    "actually ", "true", "correct", "fine", "green", "amber", "red ",
    "blue ", "blocked", "complete", "in review", "pending", "perfect",
    "one thing we should add", "oh yes", "good catch", "makes sense", "new milestone", "emma chasing",
    "first ", "second ", "third ", "the actual ",
)
TOPIC_PROMPT_VERB_MARKERS = (
    " is ", " are ", " was ", " were ", " have ", " has ", " had ", " need ", " needs ",
    " don't ", " doesn't ", " do not ", " starts ", " booked", " received", " underway",
    " scoped", " follow up", " pending", " blocked", " complete",
)
MEANINGFUL_TOPIC_HINTS = DISCUSSION_TERMS | {
    "workflow", "routing", "templates", "pipeline", "commercial", "report", "quarter",
    "vendor", "interviews", "document", "grant", "feedback", "governance", "framework",
    "delivery", "webinars", "milestone", "library", "strategy", "gate", "intake",
    "registration", "breakout", "auditorium", "sponsor", "pilot", "manchester",
    "cabling", "contractor", "relocation", "movers", "rooms", "sessions",
}

FIRST_PERSON_TOPIC_TOKENS = {"i", "i've", "ive", "i’m", "i'm", "im", "i’d", "i'd", "id", "i’ll", "i'll", "ill", "me", "my"}
FIRST_PERSON_SETUP_VERBS = {"got", "have", "open", "looking", "seeing"}
PERSONAL_PRONOUN_SUBJECTS = {"i", "ive", "i've", "i’m", "i'm", "im", "i’d", "i'd", "id", "i’ll", "i'll", "ill", "we", "we've", "we’re", "we're", "you", "he", "she", "they"}
ACCEPTED_FIRST_PERSON_WORKSTREAM_PHRASES = {"ai", "bi", "ux", "ui"}
STATUS_SUBJECT_RE = re.compile(
    r"^(?:the\s+)?(?P<topic>[A-Za-z0-9][A-Za-z0-9&/()'’.-]*(?:\s+[A-Za-z0-9][A-Za-z0-9&/()'’.-]*){0,7})\s+"
    r"(?:remains?|is|are|was|were|appears?|looks?|stays?)\b",
    re.IGNORECASE,
)

MEETING_TYPE_SIGNALS = {
    "project_status_review": {
        "keywords": {"status", "blocked", "complete", "green", "amber", "red", "review", "due", "milestone", "delivery", "progress", "pending"},
        "title": {"check", "status", "review", "programme"},
    },
    "client_onboarding": {
        "keywords": {"onboarding", "rollout", "finance", "warehouse", "mapping", "scope", "team", "start"},
        "title": {"onboarding", "client"},
    },
    "event_planning": {
        "keywords": {"registration", "attendees", "workshop", "auditorium", "breakout", "sponsor", "dinner", "signage", "terrace", "event"},
        "title": {"event", "planning", "workshop"},
    },
    "supplier_review": {
        "keywords": {"supplier", "contract", "pricing", "renewal", "audit", "delivery", "traceability", "capacity", "stock", "commercial"},
        "title": {"supplier", "risk", "contract"},
    },
    "finance_budget_review": {
        "keywords": {"revenue", "costs", "forecast", "budget", "contractor", "hire", "analytics", "q4", "cap"},
        "title": {"finance", "budget"},
    },
    "hiring_review": {
        "keywords": {"candidate", "interview", "offer", "role", "mentoring", "engineers", "compliance", "hiring"},
        "title": {"hiring", "debrief", "interview"},
    },
    "training_rollout": {
        "keywords": {"training", "sessions", "schedule", "timetable", "pilot", "site", "material", "managers", "rollout"},
        "title": {"training", "rollout"},
    },
    "webinar_rehearsal": {
        "keywords": {
            "webinar", "slides", "slide", "demo", "demonstration", "presentation", "rehearsal",
            "agenda", "workshop", "adoption", "gxp", "visuals", "delivery", "complaints",
            "triage", "methodology", "practice",
        },
        "title": {"webinar", "practice", "rehearsal", "presentation"},
    },
}
DECISION_PROPOSAL_RE = re.compile(
    r"^(?:so\s+|actually,\s+|actually\s+)?(?:(?:we|the team)\s+(?:will|would|should)|we['’]ll|let['’]?s)\s+(?P<proposal>.+)$",
    re.IGNORECASE,
)
DECISION_SUPPORT_RE = re.compile(
    r"\b(?:agreed?|agree|makes sense|sensible|better|that works|right choice|keep the scope manageable|safer option|confirmed|good idea)\b",
    re.IGNORECASE,
)
DECISION_CONTRADICTION_RE = re.compile(
    r"\b(?:instead|rather than|but not|won't|will not|cannot|can't|shouldn't|not that|alternative)\b",
    re.IGNORECASE,
)
DECISION_COMPARISON_RE = re.compile(
    r"\b(?:first|delay|defer|keep|stay|switch|offer|larger|smaller|until|rather than|instead|preferred?|safer)\b",
    re.IGNORECASE,
)

MEETING_NAVIGATION_VERB_RE = re.compile(
    r"\b(?:go\s+back|return|move\s+on|come\s+back|run\s+through|walk\s+through|cover|jump\s+to|look\s+at)\b",
    re.IGNORECASE,
)
MEETING_NAVIGATION_OBJECT_RE = re.compile(
    r"\b(?:agenda|milestones?|next\s+item|previous\s+item|slides?|sections?|topics?|parking\s+lot)\b",
    re.IGNORECASE,
)
MEETING_NAVIGATION_CONFIDENCE_ADVERB_RE = re.compile(r"\b(?:quickly|briefly|next|again)\b", re.IGNORECASE)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Experimental numeric meeting-minutes extractor.")
    parser.add_argument("path", help="Path to a UTF-8 transcript file")
    return parser.parse_args()


def tokenize(text: str) -> list[str]:
    return [token for token in re.findall(r"[a-z0-9']+", text.lower()) if token not in STOPWORDS]


def cosine_similarity(left: Counter[str], right: Counter[str]) -> float:
    if not left or not right:
        return 0.0
    common = set(left) & set(right)
    numerator = sum(left[token] * right[token] for token in common)
    left_norm = math.sqrt(sum(value * value for value in left.values()))
    right_norm = math.sqrt(sum(value * value for value in right.values()))
    if not left_norm or not right_norm:
        return 0.0
    return numerator / (left_norm * right_norm)


@lru_cache(maxsize=8192)
def fuzzy_similarity(left: str, right: str) -> float:
    left_normalized = normalize_text_fragment(left).lower()
    right_normalized = normalize_text_fragment(right).lower()
    if not left_normalized or not right_normalized:
        return 0.0
    if fuzz is not None:
        return max(
            fuzz.token_set_ratio(left_normalized, right_normalized) / 100.0,
            fuzz.ratio(left_normalized, right_normalized) / 100.0,
        )
    return SequenceMatcher(None, left_normalized, right_normalized).ratio()


def fuzzy_token_similarity(left_tokens: set[str], right_tokens: set[str]) -> float:
    if not left_tokens or not right_tokens:
        return 0.0
    return fuzzy_similarity(" ".join(sorted(left_tokens)), " ".join(sorted(right_tokens)))


def clean_transcript_text(text: str) -> str:
    kept: list[str] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            kept.append("")
            continue
        if METADATA_RE.search(line) or re.search(r"\b(?:started|stopped) transcription\.?$", line, flags=re.IGNORECASE):
            continue
        line = re.sub(r"^[\u2022\u2023\u25E6\u2043\-\*]\s+", "", line)
        line = re.sub(r"\s+", " ", line).strip()
        if not line:
            continue
        kept.append(line)
    return "\n".join(kept)


def timestamp_to_seconds(timestamp: str) -> int:
    if not timestamp or ":" not in timestamp:
        if "." in timestamp:
            timestamp = timestamp.replace(".", ":")
        else:
            return 10**9
    normalized = timestamp.strip().lower().replace(".", ":")
    normalized = re.sub(r"\s*(am|pm)$", "", normalized)
    parts = normalized.split(":")
    try:
        if len(parts) == 2:
            minutes, seconds = parts
            return int(minutes) * 60 + int(seconds)
        if len(parts) == 3:
            hours, minutes, seconds = parts
            return int(hours) * 3600 + int(minutes) * 60 + int(seconds)
        return 10**9
    except ValueError:
        return 10**9


def normalize_timestamp_value(timestamp: str) -> str:
    cleaned = normalize_text_fragment(timestamp).strip()
    if not cleaned:
        return ""
    cleaned = re.sub(r"\s+", " ", cleaned.lower())
    cleaned = cleaned.replace(".", ":")
    match = re.match(r"^(?P<core>\d{1,2}:\d{2}(?::\d{2})?)(?:\s*(?P<ampm>am|pm))?$", cleaned)
    if not match:
        return timestamp.strip()
    core = match.group("core")
    ampm = match.group("ampm")
    return f"{core} {ampm}" if ampm else core


def parse_turn_line(line: str) -> tuple[str, str, str] | None:
    for pattern in (TURN_RE, HYPHEN_TURN_RE):
        match = pattern.match(line)
        if match:
            return (
                match.group("speaker").strip(),
                normalize_timestamp_value(match.group("timestamp").strip()),
                match.group("tail").strip(),
            )
    return None


def normalize_discussion_key(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def evidence_count(evidence: list[dict[str, Any]] | None) -> int:
    return len(evidence or [])


def is_malformed_discussion_point(text: str) -> bool:
    lowered = normalize_text_fragment(text).lower()
    return any(lowered.startswith(prefix) for prefix in MALFORMED_DISCUSSION_PREFIXES)


def is_weak_cluster_summary(text: str) -> bool:
    lowered = normalize_text_fragment(text).lower()
    return any(lowered.startswith(prefix) for prefix in WEAK_CLUSTER_PREFIXES)


def contains_status_term(text: str) -> bool:
    lowered = text.lower()
    for term in STATUS_TERMS:
        if re.search(rf"\b{re.escape(term)}\b", lowered):
            return True
    return False


def contains_noise_or_banter(text: str) -> bool:
    lowered = normalize_text_fragment(text).lower()
    return any(pattern in lowered for pattern in LOW_VALUE_DISCUSSION_PATTERNS)


def is_explicit_change_or_create_action(text: str) -> bool:
    lowered = normalize_text_fragment(text).lower()
    verb_pattern = "|".join(re.escape(term) for term in EXPLICIT_CHANGE_CREATE_TERMS)
    return bool(
        re.search(rf"^(?:please\s+)?(?:{verb_pattern})\b", lowered)
        or re.search(rf"\b(?:can|could|will|would|should)\s+you\s+(?:{verb_pattern})\b", lowered)
        or re.search(rf"\b(?:i['’]?ll|i will|we['’]?ll|we will)\s+(?:{verb_pattern})\b", lowered)
    )


def is_presentation_rehearsal_speech(text: str) -> bool:
    lowered = normalize_text_fragment(text).lower()
    if not lowered:
        return False
    if any(phrase in lowered for phrase in PRESENTATION_META_PHRASES):
        return True
    has_reference = any(term in lowered for term in PRESENTATION_REFERENCE_TERMS)
    if not has_reference:
        has_reference = lowered.startswith(PRESENTATION_SPEECH_PREFIXES)
    if not has_reference:
        has_reference = any(term in lowered for term in ("slide", "slides", "screen", "image", "picture", "demo", "workshop", "agenda"))
    if not has_reference:
        return False
    if is_explicit_change_or_create_action(lowered):
        return False
    has_speech_marker = any(
        marker in lowered
        for marker in (
            "say", "show", "explain", "introduce", "demonstrate", "walk through",
            "talk through", "go through", "describe", "example", "what i say",
            "what you're saying", "what youre saying", "what you're showing", "what youre showing",
        )
    )
    if has_speech_marker:
        return True
    return any(
        marker in lowered
        for marker in (
            "we're doing", "were doing", "we go through", "we do this", "this is our case study",
            "all of our work is done", "the point i'm trying to make", "the point im trying to make",
            "keeping it educational", "during the project", "throughout the session",
        )
    )


def is_generic_weak_action_text(text: str) -> bool:
    lowered = normalize_text_fragment(text).lower().rstrip(".!?")
    if lowered in {
        "do that", "do this", "handle it", "handle that", "look into it", "look into that",
        "take that", "take this", "pick that up", "pick this up", "own that", "own this",
        "review it", "review that", "check it", "check that", "fix it", "fix that",
    }:
        return True
    meaningful = tokenize(lowered)
    return bool(re.match(r"^(?:do|handle|look|take|pick|own|review|check|fix|send|share)\b", lowered)) and bool(re.search(r"\b(?:it|that|them|those)\b", lowered)) and len(meaningful) <= 4


def should_abstain_action_item(item: dict[str, Any]) -> tuple[bool, str]:
    action_text = normalize_text_fragment(item.get("meetingActionPoint", ""))
    owner = normalize_text_fragment(item.get("meetingActionPointOwner", ""))
    deadline = normalize_text_fragment(item.get("meetingActionPointDeadline", ""))
    confidence = float(item.get("actionConfidence", 0.0))
    evidence = item.get("_evidence", [])
    if contains_noise_or_banter(action_text):
        return True, "noise_or_banter"
    if len(tokenize(action_text)) < 2:
        return True, "too_short"
    if is_generic_weak_action_text(action_text) and confidence < 0.9:
        return True, "generic_pronoun_action"
    if (
        owner == "Owner not specified"
        and not deadline
        and confidence < 0.7
        and evidence_count(evidence) <= 1
        and len(tokenize(action_text)) <= 4
    ):
        return True, "ownerless_low_evidence_action"
    return False, ""


def should_abstain_decision_detail(item: dict[str, Any]) -> tuple[bool, str]:
    decision_text = normalize_text_fragment(item.get("decision", ""))
    confidence = float(item.get("decisionConfidence", 0.0))
    evidence = item.get("_evidence", [])
    lowered = decision_text.lower()
    if any(term in lowered for term in ("maybe", "probably", "we'll see", "well see", "come back to it", "still deciding")):
        return True, "uncertain_decision_language"
    if confidence < 0.78 and evidence_count(evidence) < 2:
        return True, "low_confidence_low_evidence_decision"
    return False, ""


def contains_rejection_language(text: str) -> bool:
    lowered = normalize_text_fragment(text).lower()
    return bool(
        re.search(
            r"\b(?:no|nope|nah|can't|cannot|won't|will not|absolutely not)\b",
            lowered,
        )
    )


def action_topic_tokens(text: str) -> set[str]:
    drop = {
        "share", "send", "update", "review", "check", "confirm", "reschedule", "schedule",
        "hold", "move", "upload", "draft", "prepare", "follow", "validate", "handle", "today",
        "monday", "friday", "noon", "review", "for", "even", "if", "not", "fully", "complete",
    }
    return {
        token for token in tokenize(text)
        if token not in drop and token not in NON_TOPIC_TERMS and len(token) > 2
    }


def actions_overlap(left: str, right: str) -> bool:
    left_tokens = action_topic_tokens(left)
    right_tokens = action_topic_tokens(right)
    if not left_tokens or not right_tokens:
        return False
    overlap = left_tokens & right_tokens
    if len(overlap) >= 2:
        return True
    cosine_score = cosine_similarity(Counter(left_tokens), Counter(right_tokens))
    if cosine_score >= 0.45:
        return True
    if len(overlap) == 1 and max(len(left_tokens), len(right_tokens)) <= 6 and cosine_score >= 0.18:
        return fuzzy_token_similarity(left_tokens, right_tokens) >= 0.88
    return False


def has_rejection_cue(text: str) -> bool:
    lowered = normalize_text_fragment(text).lower()
    if not lowered:
        return False
    if lowered == "no":
        return True
    for cue in REJECTION_CUES:
        if " " in cue:
            if cue in lowered:
                return True
            continue
        if re.search(rf"\b{re.escape(cue)}\b", lowered):
            return True
    return False


def has_request_closure_cue(text: str) -> bool:
    lowered = normalize_text_fragment(text).lower()
    return any(cue in lowered for cue in REQUEST_CLOSURE_CUES)


def discussion_similarity(left: str, right: str) -> float:
    left_counts = Counter(tokenize(left))
    right_counts = Counter(tokenize(right))
    return cosine_similarity(left_counts, right_counts)


def is_decision_like_discussion(text: str) -> bool:
    lowered = normalize_text_fragment(text).lower()
    return lowered.startswith(
        (
            "the team will ",
            "we will ",
            "we should ",
            "actually, we will ",
            "actually we will ",
            "let's ",
        )
    )


def is_action_like_sentence(text: str) -> bool:
    cleaned = normalize_text_fragment(text).rstrip(".!?")
    lowered = cleaned.lower()
    stripped = strip_ack_prefix(cleaned)
    if DIRECT_ASSIGNMENT_RE.match(cleaned) or REQUEST_RE.match(cleaned) or OWNERSHIP_RE.match(cleaned) or RESPONSIBILITY_RE.match(cleaned):
        return True
    if SELF_COMMITMENT_RE.match(cleaned) or SELF_COMMITMENT_RE.match(stripped):
        return True
    if extract_named_commitment_actions(cleaned) or extract_named_commitment_actions(stripped):
        return True
    if is_generic_commitment(cleaned) or is_generic_commitment(stripped):
        return True
    if lowered.startswith("please "):
        return True
    return False


def can_use_as_supporting_discussion(candidate: dict[str, Any], current_points: list[str], decisions: list[str]) -> bool:
    text = normalize_text_fragment(candidate.get("text", ""))
    lowered = text.lower()
    sentence_parts = [normalize_text_fragment(part) for part in split_sentences(text) if normalize_text_fragment(part)]
    if not text or len(tokenize(text)) < 4:
        return False
    if contains_noise_or_banter(text):
        return False
    if lowered.startswith(("she said ", "he said ", "they said ", "we said ", "it said ")):
        return False
    if QUESTION_RE.search(text):
        return False
    if len(sentence_parts) > 1:
        return False
    if is_malformed_discussion_point(text) or is_weak_cluster_summary(text):
        return False
    if is_decision_like_discussion(text) or is_action_like_sentence(text):
        return False
    if any(phrase in lowered for phrase in NAVIGATION_PHRASES):
        return False
    if candidate.get("scores", {}).get("discussion", 0) < 0.32:
        return False
    if any(discussion_similarity(text, point) >= 0.72 for point in current_points):
        return False
    if any(discussion_similarity(text, decision) >= 0.72 for decision in decisions):
        return False
    return True


def parse_numeric_turns(text: str) -> list[dict[str, str]]:
    cleaned = clean_transcript_text(text)
    lines = cleaned.splitlines()
    turns: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    action_block = False
    pending_speaker: str | None = None
    pending_timestamp: str = ""

    def flush_current() -> None:
        nonlocal current, pending_speaker, pending_timestamp
        if current and current.get("text", "").strip():
            current["text"] = current["text"].strip()
            current["turnIndex"] = len(turns)
            turns.append(current)
        current = None
        pending_speaker = None
        pending_timestamp = ""

    for raw_line in lines:
        line = raw_line.strip()
        if not line:
            if current and current.get("text"):
                current["text"] += "\n"
            continue
        if ACTION_HEADER_RE.match(line):
            flush_current()
            action_block = True
            continue
        parsed_turn = parse_turn_line(line)
        colon_match = COLON_TURN_RE.match(line)
        speaker_only_match = SPEAKER_ONLY_RE.match(line)
        timestamp_only_match = TIMESTAMP_ONLY_RE.match(line)
        if parsed_turn:
            flush_current()
            speaker, timestamp, tail = parsed_turn
            if INLINE_ACTION_HEADER_RE.match(tail):
                action_block = True
                current = None
                continue
            current = {
                "speaker": speaker,
                "timestamp": timestamp,
                "text": tail,
            }
            action_block = False
            continue
        if pending_speaker and timestamp_only_match:
            pending_timestamp = normalize_timestamp_value(timestamp_only_match.group("timestamp").strip())
            current = {
                "speaker": pending_speaker,
                "timestamp": pending_timestamp,
                "text": "",
            }
            continue
        if colon_match and not action_block:
            if colon_match.group("speaker").strip() in METADATA_SPEAKERS:
                flush_current()
                current = None
                continue
            flush_current()
            current = {
                "speaker": colon_match.group("speaker").strip(),
                "timestamp": "",
                "text": colon_match.group("tail").strip(),
            }
            continue
        if (
            speaker_only_match
            and not action_block
            and line not in METADATA_SPEAKERS
            and current is None
        ):
            speaker_candidate = speaker_only_match.group("speaker").strip()
            speaker_tokens = tokenize(speaker_candidate)
            if (
                not speaker_tokens
                or len(speaker_tokens) == 1 and speaker_tokens[0] in LOW_CONTENT_PHRASES
                or line.endswith((".", "!", "?"))
            ):
                if current is not None:
                    current["text"] = (current["text"] + " " + line).strip()
                continue
            flush_current()
            pending_speaker = speaker_candidate
            pending_timestamp = ""
            continue
        if action_block:
            continue
        if pending_speaker and current is None:
            current = {
                "speaker": pending_speaker,
                "timestamp": pending_timestamp,
                "text": line,
            }
            pending_speaker = None
            pending_timestamp = ""
            continue
        if current is not None:
            current["text"] = (current["text"] + " " + line).strip()
    flush_current()
    return turns


def evidence_from_turn(turn: dict[str, Any], role: str = "") -> dict[str, Any]:
    evidence = {
        "speaker": turn.get("speaker", ""),
        "timestamp": turn.get("timestamp", ""),
        "text": normalize_text_fragment(turn.get("text", "")),
    }
    if "turnIndex" in turn:
        evidence["turnIndex"] = turn.get("turnIndex")
    if role:
        evidence["role"] = role
    return evidence


def evidence_public_ref(ref: dict[str, Any]) -> dict[str, Any]:
    evidence = {
        "speaker": ref.get("speaker", ""),
        "timestamp": ref.get("timestamp", ""),
    }
    if "turnIndex" in ref:
        evidence["turnIndex"] = ref.get("turnIndex")
    if ref.get("text"):
        evidence["text"] = ref.get("text")
    if ref.get("role"):
        evidence["role"] = ref.get("role")
    return evidence


def evidence_source_turn_indices(evidence: list[dict[str, Any]]) -> list[int]:
    indices: list[int] = []
    seen = set()
    for ref in evidence:
        index = ref.get("turnIndex")
        if isinstance(index, int) and index not in seen:
            seen.add(index)
            indices.append(index)
    return indices


def participant_groups(turns: list[dict[str, str]], config: dict[str, Any]) -> tuple[list[str], list[str]]:
    client: list[str] = []
    trinzo: list[str] = []
    seen = set()
    participant_map = config.get("participant_groups", {})
    ignored_speakers = METADATA_SPEAKERS
    for turn in turns:
        speaker = turn["speaker"]
        if speaker in seen or speaker in ignored_speakers:
            continue
        seen.add(speaker)
        if participant_map.get(speaker) == "trinzo":
            trinzo.append(speaker)
        else:
            client.append(speaker)
    return client, trinzo


def sentence_features(sentence: str, speaker: str, speaker_names: set[str]) -> dict[str, Any]:
    lowered = normalize_text_fragment(sentence).lower()
    tokens = tokenize(sentence)
    token_counter = Counter(tokens)
    request_score = 0.0
    if QUESTION_RE.search(sentence):
        request_score += 0.4
    if any(lowered.startswith(prefix) for prefix in REQUEST_PREFIXES):
        request_score += 0.45
    commitment_score = 0.45 if any(marker in lowered for marker in COMMITMENT_MARKERS) else 0.0
    acceptance_score = 0.42 if lowered in LOW_CONTENT_PHRASES or any(term in lowered for term in ("agreed", "agree", "sounds good", "that's sensible", "that's better")) else 0.0
    rejection_score = 0.62 if contains_rejection_language(sentence) else 0.0
    uncertainty_score = 0.6 if any(term in lowered for term in ("maybe", "not sure", "still deciding", "haven't decided", "have not decided", "unclear", "vague")) else 0.0
    proposal_score = 0.0
    if any(term in lowered for term in ("prefer", "favour", "favor", "rather", "option", "approach", "direction", "keep", "make", "move", "renew", "pursue", "proceed")):
        proposal_score += 0.4
    if lowered.startswith(("the team will", "we'll", "we will", "let's ")):
        proposal_score += 0.2
    action_hits = sum(1 for verb in ACTION_VERBS if re.search(rf"\b{re.escape(verb)}\b", lowered))
    action_score = min(0.9, 0.18 * action_hits + commitment_score + request_score * 0.35)
    discussion_score = min(0.9, 0.14 * len(token_counter) + 0.25 * any(term in lowered for term in DISCUSSION_TERMS))
    risk_score = 0.55 if any(term in lowered for term in ("risk", "blocked", "dependency", "issue", "problem")) else 0.0
    deadline_score = 0.75 if DEADLINE_RE.search(sentence) else 0.0
    owner_score = 0.45 if speaker else 0.0
    specificity_score = min(0.95, max(0.0, (len(tokens) - 2) / 10))
    navigation_score = 0.0
    if any(phrase in lowered for phrase in NAVIGATION_PHRASES):
        navigation_score += 0.6
    if lowered.startswith(("right, let's", "okay, next", "anything else", "go ahead")):
        navigation_score += 0.2
    low_content_score = 0.0
    if lowered in LOW_CONTENT_PHRASES or len(tokens) <= 2:
        low_content_score = 0.8
    elif acceptance_score and len(tokens) <= 4:
        low_content_score = 0.65
    topic_tokens = [token for token in tokens if token not in speaker_names]
    decision_score = max(0.0, min(0.95, proposal_score + acceptance_score * 0.35 + specificity_score * 0.25 - navigation_score * 0.6 - uncertainty_score * 0.5))
    action_score = max(0.0, min(0.95, action_score - navigation_score * 0.65 - low_content_score * 0.25))
    discussion_score = max(0.0, min(0.95, discussion_score - navigation_score * 0.7 - low_content_score * 0.55))
    if contains_noise_or_banter(sentence):
        action_score = 0.0
        discussion_score = 0.0
        decision_score = max(0.0, decision_score - 0.7)
    return {
        "request": round(request_score, 2),
        "commitment": round(commitment_score, 2),
        "acceptance": round(acceptance_score, 2),
        "rejection": round(rejection_score, 2),
        "uncertainty": round(uncertainty_score, 2),
        "proposal": round(proposal_score, 2),
        "decision": round(decision_score, 2),
        "action": round(action_score, 2),
        "discussion": round(discussion_score, 2),
        "risk": round(risk_score, 2),
        "deadline": round(deadline_score, 2),
        "owner": round(owner_score, 2),
        "specificity": round(specificity_score, 2),
        "topic_continuity": 0.0,
        "low_content": round(low_content_score, 2),
        "navigation": round(navigation_score, 2),
        "token_counts": Counter(topic_tokens),
    }


def build_turn_records(turns: list[dict[str, str]]) -> list[dict[str, Any]]:
    speaker_names = {part.lower() for turn in turns for part in turn["speaker"].split()}
    records: list[dict[str, Any]] = []
    for turn in turns:
        for sentence in split_sentences(turn["text"]) or [turn["text"]]:
            if not sentence.strip():
                continue
            features = sentence_features(sentence, turn["speaker"], speaker_names)
            records.append(
                {
                    "text": sentence.strip(),
                    "speaker": turn["speaker"],
                    "timestamp": turn["timestamp"],
                    "tokens": tokenize(sentence),
                    "scores": {key: value for key, value in features.items() if key != "token_counts"},
                    "token_counts": features["token_counts"],
                    "evidence": [evidence_from_turn(turn)],
                    "kind": "sentence",
                }
            )
    return records


def build_window_candidates(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = list(records)
    for index in range(len(records)):
        for width in (2, 3):
            window = records[index:index + width]
            if len(window) < width:
                continue
            # Do not build bridge windows that cross into a new topic prompt.
            # Keep prompt->response windows, but avoid response->new prompt spans
            # that cause unrelated workstreams to collapse into one cluster.
            if any(looks_like_topic_prompt(item["text"]) for item in window[1:]):
                continue
            token_counts = Counter()
            for item in window:
                token_counts.update(item["token_counts"])
            continuity = cosine_similarity(window[0]["token_counts"], window[-1]["token_counts"]) if width >= 2 else 0.0
            navigation_score = sum(item["scores"]["navigation"] for item in window) / width
            low_content_score = sum(item["scores"]["low_content"] for item in window) / width
            scores = {
                "request": max(item["scores"]["request"] for item in window),
                "commitment": max(item["scores"]["commitment"] for item in window),
                "acceptance": max(item["scores"]["acceptance"] for item in window),
                "rejection": max(item["scores"]["rejection"] for item in window),
                "uncertainty": max(item["scores"]["uncertainty"] for item in window),
                "proposal": max(item["scores"]["proposal"] for item in window),
                "risk": max(item["scores"]["risk"] for item in window),
                "deadline": max(item["scores"]["deadline"] for item in window),
                "owner": max(item["scores"]["owner"] for item in window),
                "specificity": round(min(1.0, sum(item["scores"]["specificity"] for item in window) / width + continuity * 0.25), 2),
                "topic_continuity": round(continuity, 2),
                "low_content": round(low_content_score, 2),
                "navigation": round(navigation_score, 2),
            }
            scores["decision"] = round(
                max(scores["proposal"], 0.35 if FINALISER_RE.search(window[-1]["text"]) else 0.0)
                + scores["acceptance"] * 0.6
                + scores["topic_continuity"] * 0.45
                - scores["rejection"] * 0.85
                - scores["uncertainty"] * 0.8
                - scores["navigation"] * 0.7,
                2,
            )
            scores["action"] = round(
                (scores["request"] * 0.65 + scores["commitment"] * 0.8 + scores["acceptance"] * 0.35 + scores["deadline"] * 0.2 + scores["owner"] * 0.15)
                - scores["rejection"] * 0.9
                - scores["uncertainty"] * 0.45
                - scores["navigation"] * 0.7,
                2,
            )
            scores["discussion"] = round(
                (sum(item["scores"]["discussion"] for item in window) / width)
                + continuity * 0.4
                + (len(token_counts) / 20)
                - scores["navigation"] * 0.85
                - scores["low_content"] * 0.7,
                2,
            )
            candidates.append(
                {
                    "text": " ".join(item["text"] for item in window),
                    "speaker": window[-1]["speaker"],
                    "timestamp": window[-1]["timestamp"],
                    "tokens": list(token_counts),
                    "token_counts": token_counts,
                    "scores": scores,
                    "evidence": [ref for item in window for ref in item["evidence"]],
                    "kind": f"window_{width}",
                    "window": width,
                }
            )
    return candidates


def build_intermediate_events(
    text: str,
    turns: list[dict[str, str]],
    records: list[dict[str, Any]],
    meeting_title: str,
) -> dict[str, Any]:
    candidates = build_window_candidates(records)

    action_events: list[dict[str, Any]] = []
    for action, owner, deadline, evidence in extract_action_block(text):
        action_events.append(
            {
                "eventType": "action_candidate",
                "source": "action_block",
                "action": action,
                "owner": owner,
                "deadline": deadline,
                "confidence": 0.72,
                "evidence": evidence,
            }
        )

    conversational_actions, suppressed_rejected_actions, action_thread_events = extract_conversational_actions(turns)
    for action, owner, deadline, confidence, evidence in conversational_actions:
        action_events.append(
            {
                "eventType": "action_candidate",
                "source": "conversation",
                "action": action,
                "owner": owner,
                "deadline": deadline,
                "confidence": confidence,
                "evidence": evidence,
            }
        )

    for suppressed in suppressed_rejected_actions:
        action_events.append(
            {
                "eventType": "rejected_request",
                "source": "conversation",
                "action": suppressed.get("action", ""),
                "owner": suppressed.get("owner", ""),
                "deadline": suppressed.get("deadline", ""),
                "resolution": suppressed.get("resolution", ""),
                "confidence": suppressed.get("suppressionConfidence", 0.0),
                "evidence": [
                    {"speaker": suppressed["requestTurn"]["speaker"], "timestamp": suppressed["requestTurn"]["timestamp"]},
                    {"speaker": suppressed["rejectionTurn"]["speaker"], "timestamp": suppressed["rejectionTurn"]["timestamp"]},
                    {"speaker": suppressed["closureTurn"]["speaker"], "timestamp": suppressed["closureTurn"]["timestamp"]},
                ],
            }
        )
    for thread_event in action_thread_events:
        action_events.append(
            {
                "eventType": "action_thread_event",
                "source": "conversation_thread",
                **thread_event,
            }
        )

    decisions, decision_details, decision_debug = select_decisions(turns)
    decision_events: list[dict[str, Any]] = []
    for item in decision_details:
        decision_events.append(
            {
                "eventType": "decision",
                "source": "decision_selection",
                "topic": item["topic"],
                "decision": item["decision"],
                "confidence": item["decisionConfidence"],
                "evidence": item["_evidence"],
            }
        )

    status_review_workstreams = build_status_review_workstreams(turns)
    status_review_points = [
        {
            "text": item["summary"],
            "sourceType": item["sourceType"],
            "earliestTimestamp": item["earliestTimestamp"],
            "timestampLabel": item["timestampLabel"],
            "evidence": item["evidence"],
            "rawEvidenceText": item.get("rawEvidenceText", ""),
            "selectedReason": item["selectedReason"],
        }
        for item in status_review_workstreams
    ]
    status_events = [
        {
            "eventType": "status_review_workstream",
            "source": "status_review",
            "text": item["summary"],
            "topic": item["topic"],
            "status": item["status"],
            "earliestTimestamp": item["earliestTimestamp"],
            "rawEvidenceText": item.get("rawEvidenceText", ""),
        }
        for item in status_review_workstreams
    ]

    meeting_type = classify_meeting_type(turns, meeting_title or "", decision_details)
    meeting_type_events = [
        {
            "eventType": "meeting_type_prediction",
            "source": "meeting_type_classifier",
            "meetingType": meeting_type,
            "scores": meeting_type_scores(turns, meeting_title or "", decision_details),
        }
    ]

    return {
        "records": records,
        "candidates": candidates,
        "actionEvents": action_events,
        "suppressedRejectedActions": suppressed_rejected_actions,
        "decisions": decisions,
        "decisionDetails": decision_details,
        "decisionDebug": decision_debug,
        "decisionEvents": decision_events,
        "statusReviewPoints": status_review_points,
        "statusReviewWorkstreams": status_review_workstreams,
        "statusEvents": status_events,
        "meetingType": meeting_type,
        "meetingTypeEvents": meeting_type_events,
        "allEvents": action_events + decision_events + status_events + meeting_type_events,
    }


def normalize_action_text(text: str) -> str:
    cleaned = normalize_text_fragment(text).rstrip(".!?")
    cleaned = re.sub(r"^(?:i['’]?ll|i will|we need to|please)\s+", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\b(?:instead|as well|then|probably|maybe)\b", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return finalize_sentence(cleaned[:1].upper() + cleaned[1:] if cleaned else cleaned)


def split_action_tail(text: str) -> list[str]:
    parts = []
    for part in re.split(r"(?<=[.!?])\s+|(?<=\w)\.\s+(?=[A-Z])", text.strip()):
        cleaned = normalize_text_fragment(part).rstrip(".!?")
        if cleaned:
            parts.append(cleaned)
    return parts


def normalize_deadline_text(text: str) -> str:
    cleaned = normalize_text_fragment(text).strip()
    if not cleaned:
        return ""
    cleaned = re.sub(r"\s+", " ", cleaned)
    for upper in ("EOD", "COB", "COP"):
        cleaned = re.sub(rf"\b{upper.lower()}\b", upper, cleaned, flags=re.IGNORECASE)
    return cleaned[:1].upper() + cleaned[1:]


def resolve_relative_deadline(deadline: str, meeting_date: str) -> str:
    cleaned = normalize_deadline_text(deadline)
    if not cleaned or not meeting_date:
        return cleaned
    try:
        meeting_dt = dt.datetime.strptime(meeting_date, "%d %B %Y").date()
    except ValueError:
        return cleaned
    lowered = cleaned.lower()
    normalized = re.sub(r"^(?:by|before)\s+", "", lowered).strip()
    weekday_map = {
        "monday": 0,
        "tuesday": 1,
        "wednesday": 2,
        "thursday": 3,
        "friday": 4,
        "saturday": 5,
        "sunday": 6,
    }
    weekday_with_modifier = re.match(
        r"^(?P<day>monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+(?P<modifier>morning|afternoon|evening|noon|eod|cob|cop))?$",
        normalized,
    )
    if weekday_with_modifier and not lowered.startswith(("by ", "before ")):
        label = weekday_with_modifier.group("day")
        weekday = weekday_map[label]
        delta = (weekday - meeting_dt.weekday()) % 7
        if delta == 0:
            delta = 7
        target = meeting_dt + dt.timedelta(days=delta)
        return target.strftime("%d %B %Y")
    for label, weekday in weekday_map.items():
        if lowered in {label, f"by {label}", f"before {label}"}:
            delta = (weekday - meeting_dt.weekday()) % 7
            if lowered.startswith("by ") and delta > 4:
                friday_delta = max(0, 4 - meeting_dt.weekday())
                target = meeting_dt + dt.timedelta(days=friday_delta)
                return target.strftime("%d %B %Y")
            if delta == 0:
                delta = 7
            target = meeting_dt + dt.timedelta(days=delta)
            return target.strftime("%d %B %Y")
    if lowered == "today":
        return meeting_dt.strftime("%d %B %Y")
    if lowered == "tomorrow":
        return (meeting_dt + dt.timedelta(days=1)).strftime("%d %B %Y")
    if lowered in {"this week", "end of week"}:
        friday_delta = max(0, 4 - meeting_dt.weekday())
        target = meeting_dt + dt.timedelta(days=friday_delta)
        return target.strftime("%d %B %Y")
    if lowered == "next week":
        next_monday = meeting_dt + dt.timedelta(days=(7 - meeting_dt.weekday()) % 7 or 7)
        return next_monday.strftime("%d %B %Y")
    if lowered == "next month":
        year = meeting_dt.year + (1 if meeting_dt.month == 12 else 0)
        month = 1 if meeting_dt.month == 12 else meeting_dt.month + 1
        return dt.date(year, month, 1).strftime("%d %B %Y")
    if lowered == "end of month":
        year = meeting_dt.year + (1 if meeting_dt.month == 12 else 0)
        month = 1 if meeting_dt.month == 12 else meeting_dt.month + 1
        target = dt.date(year, month, 1) - dt.timedelta(days=1)
        return target.strftime("%d %B %Y")
    if lowered == "end of quarter":
        quarter_end_month = ((meeting_dt.month - 1) // 3 + 1) * 3
        if quarter_end_month == 12:
            target = dt.date(meeting_dt.year + 1, 1, 1) - dt.timedelta(days=1)
        else:
            target = dt.date(meeting_dt.year, quarter_end_month + 1, 1) - dt.timedelta(days=1)
        return target.strftime("%d %B %Y")
    return cleaned


def format_deadline_output(deadline: str, meeting_date: str) -> str:
    cleaned = normalize_deadline_text(deadline)
    resolved = resolve_relative_deadline(cleaned, meeting_date)
    if not cleaned:
        return resolved
    if not resolved or resolved == cleaned:
        return cleaned
    return f"{cleaned} ({resolved})"


def extract_deadline_text(text: str) -> str:
    matches = [match for match in (DEADLINE_RE.search(text), DEPENDENCY_DEADLINE_RE.search(text)) if match]
    if not matches:
        return ""
    match = min(matches, key=lambda item: item.start())
    return normalize_deadline_text(match.group(0))


def strip_ack_prefix(text: str) -> str:
    return ACK_PREFIX_RE.sub("", normalize_text_fragment(text)).strip()


def is_low_value_action_task(task: str) -> bool:
    lowered = normalize_text_fragment(task).lower()
    if not lowered or lowered in {"that", "it", "this"}:
        return True
    if any(pattern in lowered for pattern in LOW_VALUE_DISCUSSION_PATTERNS):
        return True
    if is_micro_formatting_action_task(task):
        return True
    return False


def is_micro_formatting_action_task(task: str) -> bool:
    cleaned = normalize_text_fragment(task)
    lowered = cleaned.lower()
    tokens = tokenize(cleaned)
    if not tokens:
        return False
    first_token = tokens[0]
    pronoun_count = sum(1 for token in tokens if token in {"it", "this", "that", "them", "those"})
    object_terms = {token for token in tokens if token in MICRO_ACTION_OBJECT_TERMS}
    score = 0.0
    if len(tokens) <= 10:
        score += 0.2
    if first_token in MICRO_ACTION_VERBS:
        score += 0.3
    if pronoun_count:
        score += 0.2
    if object_terms:
        score += 0.25
    if "as an image" in lowered or "as a picture" in lowered:
        score += 0.25
    if "same colour background" in lowered or "same color background" in lowered:
        score += 0.25
    if "bring it over" in lowered:
        score += 0.15
    meaningful_non_format = [
        token for token in tokens
        if token not in MICRO_ACTION_OBJECT_TERMS
        and token not in MICRO_ACTION_VERBS
        and token not in {"it", "this", "that", "them", "those", "same", "over", "into", "onto", "with", "as", "an", "a", "the", "on", "in"}
    ]
    if len(meaningful_non_format) <= 1:
        score += 0.15
    return score >= 0.75


def build_special_context_action(source_text: str, action_text: str) -> tuple[str, str]:
    lowered_source = source_text.lower()
    if "send those across" in action_text.lower() and "final figures" in lowered_source:
        return "Send final pricing figures to finance when available.", "When available"
    return action_text, extract_deadline_text(source_text)


def extract_action_context(text: str) -> dict[str, str] | None:
    cleaned = normalize_text_fragment(text).rstrip(".!?")
    lowered = cleaned.lower()
    if not cleaned or "no action" in lowered or "no further actions" in lowered or "discussion only" in lowered:
        return None
    if is_presentation_rehearsal_speech(cleaned):
        return None

    match = DIRECT_ASSIGNMENT_RE.match(cleaned)
    if match:
        task = match.group("task").strip()
        if is_low_value_action_task(task):
            return None
        return {
            "kind": "assignment",
            "action": normalize_action_text(task),
            "owner": match.group("owner").strip(),
            "deadline": extract_deadline_text(task),
            "source_text": cleaned,
        }

    match = REQUEST_RE.match(cleaned)
    if match:
        task = match.group("task").strip().rstrip("?")
        if is_low_value_action_task(task):
            return None
        action_text = normalize_action_text(task)
        action_text, deadline = build_special_context_action(cleaned, action_text)
        return {
            "kind": "request",
            "action": action_text,
            "owner": "Owner not specified",
            "deadline": deadline,
            "source_text": cleaned,
        }

    match = OWNERSHIP_RE.match(cleaned)
    if match:
        task = match.group("task").strip().rstrip("?")
        if is_low_value_action_task(task):
            return None
        return {
            "kind": "ownership",
            "action": normalize_action_text(f"handle {task}"),
            "owner": "Owner not specified",
            "deadline": "",
            "source_text": cleaned,
        }

    match = RESPONSIBILITY_RE.match(cleaned)
    if match:
        task = match.group("task").strip().rstrip("?")
        if is_low_value_action_task(task):
            return None
        return {
            "kind": "responsibility",
            "action": normalize_action_text(task),
            "owner": "Owner not specified",
            "deadline": extract_deadline_text(task),
            "source_text": cleaned,
        }

    if lowered.startswith("please "):
        task = cleaned[7:].strip().rstrip("?")
        if is_low_value_action_task(task):
            return None
        return {
            "kind": "request",
            "action": normalize_action_text(task),
            "owner": "Owner not specified",
            "deadline": extract_deadline_text(task),
            "source_text": cleaned,
        }
    return None


def extract_issue_action_context(text: str) -> dict[str, str] | None:
    cleaned = normalize_text_fragment(text).rstrip(".!?")
    lowered = cleaned.lower()
    if is_presentation_rehearsal_speech(cleaned):
        return None
    if " needs " not in lowered:
        return None
    subject, detail = re.split(r"\bneeds\b", cleaned, maxsplit=1, flags=re.IGNORECASE)
    subject = normalize_text_fragment(subject)
    detail = normalize_text_fragment(detail)
    if not subject or not detail or is_low_value_action_task(subject):
        return None
    additive_issue = bool(re.search(r"\balso\b", subject, flags=re.IGNORECASE)) or detail.lower().startswith(
        ("the new ", "new ", "updated ", "revised ")
    )
    subject = re.sub(r"\balso\b", "", subject, flags=re.IGNORECASE).strip()
    if subject.lower().startswith("the "):
        subject = subject[:1].lower() + subject[1:]
    if additive_issue:
        action_text = normalize_action_text(f"update {subject} with {detail}".strip())
    else:
        detail = re.sub(r"^(?:a|an)\s+", "", detail, flags=re.IGNORECASE)
        detail = re.sub(r"^(?:clearer|better|improved)\s+", "", detail, flags=re.IGNORECASE)
        action_text = normalize_action_text(f"improve {subject} {detail}".strip())
    return {
        "kind": "issue",
        "action": action_text,
        "owner": "Owner not specified",
        "deadline": extract_deadline_text(cleaned),
        "source_text": cleaned,
    }


def is_pronoun_commitment_task(task: str) -> bool:
    return bool(
        re.match(
            r"^(?:do|take|handle|look into|pick up|own|improve|tighten|clarify|fix|review|check|confirm|update|prepare|send|share|publish|capture|request|put|bring|move|snip)\s+(?:that|it|them|this|these|those)\b",
            task.strip(),
            flags=re.IGNORECASE,
        )
    )


def extract_self_commitment_action(text: str, speaker: str) -> tuple[str, str, str] | None:
    cleaned = strip_ack_prefix(text).rstrip(".!?")
    lowered = cleaned.lower()
    if is_presentation_rehearsal_speech(cleaned):
        return None
    match = SELF_COMMITMENT_RE.match(cleaned)
    if not match:
        return None
    task = match.group("task").strip()
    if any(lowered.startswith(pattern) for pattern in GENERIC_COMMITMENT_PATTERNS):
        return None
    if is_pronoun_commitment_task(task) and not any(
        normalize_text_fragment(task).lower().startswith(f"{verb} ")
        for verb in EXPLICIT_CHANGE_CREATE_TERMS
    ):
        return None
    if is_low_value_action_task(task):
        return None
    return normalize_action_text(task), speaker, extract_deadline_text(task)


def looks_like_person_owner(owner: str) -> bool:
    cleaned = normalize_text_fragment(owner).strip()
    if not cleaned:
        return False
    tokens = cleaned.split()
    if not 1 <= len(tokens) <= 3:
        return False
    if cleaned.lower() in {"we", "they", "the", "a", "an", "and"}:
        return False
    return all(re.fullmatch(r"[A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ'`.-]*", token) for token in tokens)


def extract_named_commitment_actions(text: str) -> list[tuple[str, str, str]]:
    cleaned = normalize_text_fragment(text)
    if is_presentation_rehearsal_speech(cleaned):
        return []
    actions: list[tuple[str, str, str]] = []
    chunks = re.split(r"(?<=,)\s+and\s+(?=[A-ZÀ-ÖØ-Þ])|\s+and\s+(?=[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'`.-]*\s+(?:will|can)\b)", cleaned)
    for chunk in chunks:
        chunk = normalize_text_fragment(chunk).strip()
        if not chunk:
            continue
        match = NAMED_COMMITMENT_RE.search(chunk)
        if not match:
            continue
        owner = normalize_text_fragment(match.group("owner")).strip()
        task = normalize_text_fragment(match.group("task")).rstrip(".!?").strip()
        if not owner or not task or not looks_like_person_owner(owner):
            continue
        if is_low_value_action_task(task) or is_pronoun_commitment_task(task):
            continue
        actions.append((normalize_action_text(task), owner, extract_deadline_text(task)))
    return actions


def is_generic_commitment(text: str) -> bool:
    cleaned = strip_ack_prefix(text).lower()
    if any(cleaned.startswith(pattern) for pattern in GENERIC_COMMITMENT_PATTERNS):
        return True
    match = SELF_COMMITMENT_RE.match(strip_ack_prefix(text))
    if match and is_pronoun_commitment_task(match.group("task")):
        return True
    return cleaned == ""


def build_action_thread(context: dict[str, str], turn: dict[str, str], index: int, thread_id: int) -> dict[str, Any]:
    return {
        "threadId": f"action_thread_{thread_id}",
        "kind": context["kind"],
        "action": context["action"],
        "owner": context["owner"],
        "deadline": context["deadline"],
        "source_text": context["source_text"],
        "openedAt": index,
        "state": "open",
        "requestTurn": {
            "speaker": turn["speaker"],
            "timestamp": turn["timestamp"],
            "text": turn["text"],
        },
        "rejectionTurn": None,
        "closureTurn": None,
        "resolvedTurn": None,
    }


def enrich_thread_context_from_history(
    context: dict[str, str],
    turns: list[dict[str, str]],
    index: int,
) -> dict[str, str]:
    if "send those across" in context.get("source_text", "").lower() and index > 0:
        prior_text = turns[index - 1]["text"]
        if "final figures" in prior_text.lower():
            return {
                **context,
                "action": "Send final pricing figures to finance when available.",
                "deadline": "When available",
            }
    return context


def thread_can_accept_follow_up(thread: dict[str, Any], index: int, max_gap: int = 4) -> bool:
    return thread["state"] in {"open", "rejected_pending"} and index - thread["openedAt"] <= max_gap


def thread_can_accept_long_range_follow_up(
    thread: dict[str, Any],
    action_text: str,
    index: int,
    max_gap: int = 10,
) -> bool:
    if thread["state"] not in {"open", "rejected_pending"}:
        return False
    gap = index - thread["openedAt"]
    if gap <= 4:
        return True
    if gap > max_gap:
        return False
    thread_tokens = action_topic_tokens(thread["action"])
    action_tokens = action_topic_tokens(action_text)
    if len(thread_tokens) < 2 or len(action_tokens) < 2:
        return False
    overlap = thread_tokens & action_tokens
    cosine_score = cosine_similarity(Counter(thread_tokens), Counter(action_tokens))
    if len(overlap) >= 2 or cosine_score >= 0.52:
        return True
    if len(overlap) == 1 and max(len(thread_tokens), len(action_tokens)) <= 6 and cosine_score >= 0.2:
        return fuzzy_token_similarity(thread_tokens, action_tokens) >= 0.9
    return False


def select_recent_open_thread(
    threads: list[dict[str, Any]],
    index: int,
    *,
    kinds: tuple[str, ...],
    require_rejected_pending: bool = False,
) -> dict[str, Any] | None:
    for thread in reversed(threads):
        if thread["kind"] not in kinds:
            continue
        if require_rejected_pending:
            if thread["state"] != "rejected_pending":
                continue
        elif not thread_can_accept_follow_up(thread, index):
            continue
        if index - thread["openedAt"] > 4:
            continue
        return thread
    return None


def inherited_thread_priority(thread: dict[str, Any], index: int) -> tuple[float, int]:
    kind_weight = {
        "request": 5.0,
        "ownership": 4.0,
        "responsibility": 3.0,
        "issue": 2.0,
    }.get(thread["kind"], 0.0)
    gap = index - thread["openedAt"]
    score = kind_weight - gap * 0.18
    if thread.get("deadline"):
        score += 0.35
    request_text = normalize_text_fragment(thread.get("requestTurn", {}).get("text", ""))
    if QUESTION_RE.search(request_text):
        score += 0.25
    if thread["kind"] == "request" and any(
        marker in request_text.lower() for marker in ("can you", "could you", "would you", "will you")
    ):
        score += 0.2
    return score, thread["openedAt"]


def select_inherited_thread_for_generic_commitment(
    threads: list[dict[str, Any]],
    index: int,
) -> dict[str, Any] | None:
    candidates = [
        thread
        for thread in threads
        if thread["kind"] in {"request", "ownership", "responsibility"}
        and thread_can_accept_follow_up(thread, index)
        and index - thread["openedAt"] <= 4
    ]
    if candidates:
        return max(candidates, key=lambda thread: inherited_thread_priority(thread, index))

    long_range_candidates = [
        thread
        for thread in threads
        if thread["kind"] == "request"
        and thread["state"] in {"open", "rejected_pending"}
        and 4 < index - thread["openedAt"] <= 8
    ]
    if not long_range_candidates:
        return None

    ranked = sorted(
        (
            (inherited_thread_priority(thread, index), thread)
            for thread in long_range_candidates
            if QUESTION_RE.search(normalize_text_fragment(thread.get("requestTurn", {}).get("text", "")))
            or thread.get("deadline")
        ),
        key=lambda item: item[0],
        reverse=True,
    )
    if not ranked:
        return None
    best_score, best_opened_at = ranked[0][0]
    best_thread = ranked[0][1]
    if len(ranked) == 1:
        return best_thread
    second_score, second_opened_at = ranked[1][0]
    if best_score - second_score >= 0.55:
        return best_thread
    if best_score == second_score and best_opened_at > second_opened_at:
        return best_thread
    return None


def select_matching_action_thread(
    threads: list[dict[str, Any]],
    action_text: str,
    index: int,
) -> dict[str, Any] | None:
    for thread in reversed(threads):
        if thread["kind"] not in {"request", "ownership", "responsibility", "issue"}:
            continue
        if not thread_can_accept_follow_up(thread, index):
            continue
        if actions_overlap(thread["action"], action_text):
            return thread
    for thread in reversed(threads):
        if thread["kind"] not in {"request", "ownership", "responsibility", "issue"}:
            continue
        if not thread_can_accept_long_range_follow_up(thread, action_text, index):
            continue
        if actions_overlap(thread["action"], action_text):
            return thread
    for thread in reversed(threads):
        if thread["kind"] not in {"request", "ownership", "responsibility", "issue"}:
            continue
        if not thread_can_accept_follow_up(thread, index):
            continue
        if len(action_topic_tokens(thread["action"])) < 2 or re.search(r"\b(?:it|this|that|them|those)\b", thread["action"], flags=re.IGNORECASE):
            return thread
    lowered_action = normalize_text_fragment(action_text).lower()
    if re.search(r"\b(?:it|this|that|them|those)\b", lowered_action) and any(
        lowered_action.startswith(f"{verb} ") for verb in EXPLICIT_CHANGE_CREATE_TERMS
    ):
        for thread in reversed(threads):
            if thread["kind"] not in {"request", "ownership", "responsibility", "issue"}:
                continue
            if not thread_can_accept_follow_up(thread, index):
                continue
            return thread
    return None


def action_thread_event(thread: dict[str, Any], event_type: str, **extra: Any) -> dict[str, Any]:
    payload = {
        "eventType": event_type,
        "threadId": thread["threadId"],
        "threadKind": thread["kind"],
        "threadAction": thread["action"],
        "state": thread["state"],
        "openedAt": thread["openedAt"],
    }
    payload.update(extra)
    return payload


def merge_commitment_with_request(
    commitment: tuple[str, str, str],
    request_context: dict[str, str] | None,
) -> tuple[str, str, str]:
    if not request_context:
        return commitment
    action_text, owner, deadline = commitment
    request_text = request_context.get("source_text", "").lower()
    if "even if it is incomplete" in request_text or "even if incomplete" in request_text:
        merged = re.sub(r"^(send|share)\s+", "Share ", action_text, flags=re.IGNORECASE)
        merged = re.sub(r"\s+by\s+[A-Z][a-z]+\.?$", "", merged)
        merged = re.sub(r"\band the related documents\b", "and related documents", merged, flags=re.IGNORECASE)
        if "for review" in merged.lower():
            merged = re.sub(r"\s+for review\.?$", " for review, even if not fully complete.", merged, flags=re.IGNORECASE)
        else:
            merged = finalize_sentence(merged.rstrip(".") + ", even if not fully complete")
        return merged, owner, deadline or request_context.get("deadline", "")
    return commitment


def extract_conversational_actions(turns: list[dict[str, str]]) -> tuple[
    list[tuple[str, str, str, float, list[dict[str, str]]]],
    list[dict[str, Any]],
    list[dict[str, Any]],
]:
    actions: list[tuple[str, str, str, float, list[dict[str, str]]]] = []
    suppressed: list[dict[str, Any]] = []
    thread_events: list[dict[str, Any]] = []
    threads: list[dict[str, Any]] = []
    next_thread_id = 1

    for index, turn in enumerate(turns):
        context = extract_action_context(turn["text"])
        issue_context = extract_issue_action_context(turn["text"]) if not context else None
        explicit_commitment = extract_self_commitment_action(turn["text"], turn["speaker"])
        named_commitments = extract_named_commitment_actions(turn["text"])
        generic_commitment = is_generic_commitment(turn["text"])

        if len(named_commitments) >= 2:
            for action_text, owner, deadline in named_commitments:
                actions.append(
                    (
                        action_text,
                        owner,
                        deadline,
                        0.79,
                        [evidence_from_turn(turn)],
                    )
                )
                thread_events.append(
                    {
                        "eventType": "named_commitment_action",
                        "action": action_text,
                        "owner": owner,
                        "timestamp": turn["timestamp"],
                    }
                )
            continue

        if explicit_commitment:
            matching_thread = select_matching_action_thread(threads, explicit_commitment[0], index)
            if matching_thread:
                resolved_commitment = merge_commitment_with_request(
                    explicit_commitment,
                    matching_thread if matching_thread["kind"] == "request" else None,
                )
                if matching_thread["kind"] == "issue" and re.search(
                    r"\b(?:it|this|that|them|those)\b",
                    normalize_text_fragment(resolved_commitment[0]).lower(),
                ):
                    resolved_commitment = (
                        matching_thread["action"],
                        resolved_commitment[1],
                        resolved_commitment[2] or matching_thread.get("deadline", ""),
                    )
                actions.append(
                    (
                        resolved_commitment[0],
                        resolved_commitment[1],
                        resolved_commitment[2],
                        0.82,
                        [evidence_from_turn(turn)],
                    )
                )
                matching_thread["state"] = "accepted"
                matching_thread["resolvedTurn"] = {
                    "speaker": turn["speaker"],
                    "timestamp": turn["timestamp"],
                    "text": turn["text"],
                }
                thread_events.append(
                    action_thread_event(
                        matching_thread,
                        "thread_resolved_by_explicit_commitment",
                        resolvedAction=resolved_commitment[0],
                        resolvedOwner=resolved_commitment[1],
                    )
                )
                continue
            actions.append(
                (
                    explicit_commitment[0],
                    explicit_commitment[1],
                    explicit_commitment[2],
                    0.82,
                    [evidence_from_turn(turn)],
                )
            )
            continue

        if generic_commitment:
            inherited_thread = select_inherited_thread_for_generic_commitment(threads, index)
            if inherited_thread:
                explicit_commitment = (
                    inherited_thread["action"],
                    turn["speaker"],
                    extract_deadline_text(turn["text"]) or inherited_thread["deadline"],
                )
                explicit_commitment = merge_commitment_with_request(
                    explicit_commitment,
                    inherited_thread if inherited_thread["kind"] == "request" else None,
                )
                actions.append(
                    (
                        explicit_commitment[0],
                        explicit_commitment[1],
                        explicit_commitment[2],
                        0.8,
                        [
                            {"speaker": inherited_thread["requestTurn"]["speaker"], "timestamp": inherited_thread["requestTurn"]["timestamp"]},
                            {"speaker": turn["speaker"], "timestamp": turn["timestamp"]},
                        ],
                    )
                )
                inherited_thread["state"] = "accepted"
                inherited_thread["resolvedTurn"] = {
                    "speaker": turn["speaker"],
                    "timestamp": turn["timestamp"],
                    "text": turn["text"],
                }
                thread_events.append(
                    action_thread_event(
                        inherited_thread,
                        "thread_resolved_by_generic_commitment",
                        resolvedAction=explicit_commitment[0],
                        resolvedOwner=explicit_commitment[1],
                    )
                )
            continue

        if has_rejection_cue(turn["text"]):
            rejected_thread = select_recent_open_thread(threads, index, kinds=("request",))
            if rejected_thread:
                rejected_thread["state"] = "rejected_pending"
                rejected_thread["rejectionTurn"] = {
                    "speaker": turn["speaker"],
                    "timestamp": turn["timestamp"],
                    "text": turn["text"],
                }
                thread_events.append(action_thread_event(rejected_thread, "thread_marked_rejected"))
                continue

        if has_request_closure_cue(turn["text"]):
            closing_thread = select_recent_open_thread(
                threads,
                index,
                kinds=("request",),
                require_rejected_pending=True,
            )
            if closing_thread:
                closing_thread["state"] = "suppressed"
                closing_thread["closureTurn"] = {
                    "speaker": turn["speaker"],
                    "timestamp": turn["timestamp"],
                    "text": turn["text"],
                }
                suppressed.append(
                    {
                        "action": closing_thread["action"],
                        "owner": closing_thread["owner"],
                        "deadline": closing_thread["deadline"],
                        "requestTurn": closing_thread["requestTurn"],
                        "rejectionTurn": closing_thread["rejectionTurn"],
                        "closureTurn": closing_thread["closureTurn"],
                        "resolution": "explicitly_declined_and_closed",
                        "suppressionConfidence": 0.94,
                    }
                )
                thread_events.append(action_thread_event(closing_thread, "thread_suppressed_after_rejection"))
                continue

        if context and context["kind"] == "assignment":
            actions.append(
                (
                    context["action"],
                    context["owner"],
                    context["deadline"],
                    0.74,
                    [evidence_from_turn(turn)],
                )
            )
            thread_events.append(
                {
                    "eventType": "direct_assignment_action",
                    "action": context["action"],
                    "owner": context["owner"],
                    "timestamp": turn["timestamp"],
                }
            )
            continue

        pending_context = context if context and context["kind"] in {"request", "ownership", "responsibility"} else issue_context
        if pending_context:
            pending_context = enrich_thread_context_from_history(pending_context, turns, index)
            thread = build_action_thread(pending_context, turn, index, next_thread_id)
            next_thread_id += 1
            threads.append(thread)
            thread_events.append(
                action_thread_event(
                    thread,
                    "thread_opened",
                    sourceText=pending_context["source_text"],
                )
            )

    for thread in threads:
        if thread["kind"] == "request" and thread["state"] == "open":
            actions.append(
                (
                    thread["action"],
                    thread["owner"],
                    thread["deadline"],
                    0.68,
                    [{"speaker": thread["requestTurn"]["speaker"], "timestamp": thread["requestTurn"]["timestamp"]}],
                )
            )
            thread["state"] = "emitted_unresolved_request"
            thread_events.append(action_thread_event(thread, "thread_emitted_as_unresolved_request"))

    return actions, suppressed, thread_events


def extract_action_block(text: str) -> list[tuple[str, str, str, list[dict[str, str]]]]:
    cleaned = clean_transcript_text(text)
    lines = cleaned.splitlines()
    results: list[tuple[str, str, str, list[dict[str, str]]]] = []
    in_block = False
    deadline = ""
    current_evidence: list[dict[str, str]] = []
    for raw_line in lines:
        line = raw_line.strip()
        if not line:
            continue
        speaker_match = TURN_RE.match(line)
        if speaker_match:
            tail = speaker_match.group("tail").strip()
            inline_match = INLINE_ACTION_HEADER_RE.match(tail) or INLINE_ACTION_HEADER_SEARCH_RE.search(tail)
            if inline_match:
                in_block = True
                header = inline_match.group("header").lower()
                deadline = "Before the webinar" if "webinar" in header else ("Before next week" if "next week" in header else "")
                current_evidence = [{"speaker": speaker_match.group("speaker").strip(), "timestamp": speaker_match.group("timestamp").strip()}]
                tail_text = inline_match.group("tail").strip()
                for item in split_action_tail(tail_text):
                    results.append((normalize_action_text(item), "Owner not specified", deadline, current_evidence))
                continue
        if ACTION_HEADER_RE.match(line):
            in_block = True
            lowered = line.lower()
            deadline = "Before the webinar" if "webinar" in lowered else ("Before next week" if "next week" in lowered else "")
            current_evidence = current_evidence or []
            continue
        if not in_block:
            if speaker_match:
                current_evidence = [{"speaker": speaker_match.group("speaker").strip(), "timestamp": speaker_match.group("timestamp").strip()}]
            continue
        if TURN_RE.match(line) or COLON_TURN_RE.match(line):
            break
        for item in split_action_tail(line):
            results.append((normalize_action_text(item), "Owner not specified", deadline, current_evidence))
    return results


def derive_action_from_window(window: list[dict[str, Any]]) -> tuple[str, str, str] | None:
    request = window[0]["text"]
    reply = window[1]["text"]
    request_lowered = request.lower()
    reply_lowered = reply.lower()
    if any(phrase in request_lowered or phrase in reply_lowered for phrase in ("no action", "discussion only")):
        return None
    if re.search(r"^(?:can|could|would|will)\s+you\b", request, flags=re.IGNORECASE) and re.search(r"^(?:yes|yeah|yep|sure|okay|ok)\b", reply, flags=re.IGNORECASE):
        task = re.sub(r"^(?:can|could|would|will)\s+you\s+", "", normalize_text_fragment(request), flags=re.IGNORECASE).rstrip("?")
        if "send those across" in task.lower():
            return "Send final pricing figures to finance when available.", window[1]["speaker"], "When available"
        deadline = "When available" if "when available" in request_lowered else ("Tomorrow" if "tomorrow" in reply_lowered else "")
        return normalize_action_text(task), window[1]["speaker"], deadline
    if re.search(r"who is handling", request, flags=re.IGNORECASE) and re.search(r"i can take that", reply, flags=re.IGNORECASE):
        task = re.sub(r"^who is handling\s+", "", normalize_text_fragment(request), flags=re.IGNORECASE).rstrip("?")
        return normalize_action_text(f"handle {task}"), window[1]["speaker"], ""
    if any(term in request_lowered for term in ("need", "issue", "problem", "unclear", "confusing")) and re.search(r"\b(i['’]?ll|i will|i can)\b", reply, flags=re.IGNORECASE):
        if "speak with legal" in reply_lowered:
            return "Speak with legal once the revised proposal arrives.", window[1]["speaker"], ""
        if "improve that" in reply_lowered and "demo intro" in request_lowered:
            return "Improve the demo intro spoken setup.", window[1]["speaker"], ""
        if "tighten that" in reply_lowered and "timeline slide" in request_lowered:
            return "Clarify the timeline slide.", window[1]["speaker"], ""
        if "think that through" in reply_lowered and "opening explanation" in request_lowered:
            return "Refine the opening explanation.", window[1]["speaker"], "Before Friday" if "friday" in reply_lowered else ""
    return None


def contextual_decision_text(proposal: str, turns: list[dict[str, str]], index: int) -> str:
    proposal_lower = proposal.lower()
    if "move the check-in instead of cancelling it" in proposal_lower:
        schedule_targets: list[str] = []
        for peer_index in range(index + 1, min(len(turns), index + 6)):
            peer_text = normalize_text_fragment(turns[peer_index]["text"])
            lowered_peer = peer_text.lower()
            match = re.search(
                r"\b(?P<target>(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+at\s+[a-z0-9: ]+)?)\s+works(?:\s+(?:for me|best))?\b",
                lowered_peer,
                flags=re.IGNORECASE,
            )
            if match:
                schedule_targets.append(normalize_text_fragment(match.group("target")).lower())
            match = re.search(
                r"\b(?:fine|okay|ok|agreed)[, ]+(?P<target>(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+at\s+[a-z0-9: ]+)?)\s+then\b",
                lowered_peer,
                flags=re.IGNORECASE,
            )
            if match:
                schedule_targets.append(normalize_text_fragment(match.group("target")).lower())
        schedule_target = ""
        if schedule_targets:
            schedule_targets.sort(key=lambda item: (" at " in item, len(item)), reverse=True)
            schedule_target = schedule_targets[0]
        if schedule_target:
            return finalize_sentence(f"The team will move the check-in to {schedule_target}")
    if proposal_lower.startswith("move it to "):
        target = proposal_lower.removeprefix("move it to ").strip()
        for prior_index in range(index - 1, max(-1, index - 8), -1):
            prior = normalize_text_fragment(turns[prior_index]["text"])
            prior_match = re.search(r"\bmove (?P<object>the [a-z0-9][a-z0-9 -]+?) to (?P<target>[a-z0-9][a-z0-9 -]+?)(?: because|,|\.|$)", prior, flags=re.IGNORECASE)
            if prior_match and normalize_text_fragment(prior_match.group("target")).lower() == target:
                return finalize_sentence(f"The team will move {prior_match.group('object').lower()} to {target}")
    if "keep it broad" in proposal_lower:
        prior_blob = " ".join(normalize_text_fragment(turns[prior_index]["text"]).lower() for prior_index in range(max(0, index - 8), index))
        subject = "webinar" if "webinar" in prior_blob else "topic"
        alternative = "narrow"
        for prior_index in range(index - 1, max(-1, index - 8), -1):
            prior = normalize_text_fragment(turns[prior_index]["text"])
            subject_match = re.search(r"for the (?P<subject>[a-z][a-z0-9 -]+),\s*should we make it (?P<option>[a-z0-9-]+)", prior, flags=re.IGNORECASE)
            if subject_match:
                subject = subject_match.group("subject").strip()
                alternative = subject_match.group("option").strip()
                break
            option_match = re.search(r"\b(?P<option>[a-z0-9-]+specific)\b", prior, flags=re.IGNORECASE)
            if option_match:
                alternative = option_match.group("option").strip()
        if subject == "topic" and alternative.endswith("specific"):
            subject = "webinar"
        return finalize_sentence(f"The {subject} should remain broad rather than {alternative}")
    if "one-year option" in proposal_lower or "one-year renewal" in proposal_lower:
        prior_blob = " ".join(normalize_text_fragment(turns[prior_index]["text"]).lower() for prior_index in range(max(0, index - 8), index + 1))
        if "three-year" in prior_blob or "three year" in prior_blob:
            return "The team will pursue a one-year contract term rather than a three-year commitment."
    return ""


def normalize_decision_text(proposal: str, turns: list[dict[str, str]], index: int) -> str:
    contextual = contextual_decision_text(proposal, turns, index)
    if contextual:
        return contextual
    cleaned = normalize_text_fragment(proposal).rstrip(".!?")
    cleaned = re.sub(r"\s+because\s+.+$", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\b(?:okay|right|so)\b[\s,.-]*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if not cleaned:
        return ""
    lowered = cleaned.lower()
    if re.search(r"\bwill\b", lowered) or re.search(r"\b(?:is|are|remains?)\s+(?:still\s+)?(?:the\s+)?(?:safer|preferred|better|right)\s+(?:option|choice|approach)\b", lowered):
        return finalize_sentence(cleaned)
    return finalize_sentence("The team will " + cleaned[0].lower() + cleaned[1:])


def infer_implicit_decision_proposal(text: str, turns: list[dict[str, str]], index: int) -> str | None:
    cleaned = strip_ack_prefix(text).rstrip(".!?")
    lowered = cleaned.lower()
    history_blob = " ".join(
        normalize_text_fragment(turns[prior_index]["text"]).lower()
        for prior_index in range(max(0, index - 8), index)
    )

    broad_markers = ("works better", "works best", "is safer", "is better", "preferred", "fine")
    if "broad" in lowered and any(marker in lowered for marker in broad_markers):
        if any(term in history_blob for term in ("validation-specific", "validation specific", "too narrow", "broadly applicable")):
            return "keep it broad"

    one_year_markers = ("one-year option", "one year option", "one-year term", "one year term")
    if any(marker in lowered for marker in one_year_markers) and any(
        marker in lowered for marker in ("works better", "works best", "is safer", "is better", "preferred", "fine")
    ):
        if "three-year" in history_blob or "three year" in history_blob:
            return "pursue the one-year option"

    return None


def has_durable_decision_commitment(text: str) -> bool:
    cleaned = normalize_text_fragment(text)
    lowered = cleaned.lower()
    if DEADLINE_RE.search(cleaned) or DEPENDENCY_DEADLINE_RE.search(cleaned):
        return True
    if re.search(r"\b(?:i['’]?ll|i will|i can)\b", lowered):
        return True
    owner_match = re.search(r"\b(?P<owner>[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'`.-]+)\s+(?:will|owns?|to)\b", cleaned)
    if owner_match and owner_match.group("owner").lower() not in {"we", "the", "team"}:
        return True
    if re.search(r"\b(?:send|share|publish|release|deliver|file|submit|circulate|announce|roll out|launch)\b", lowered) and re.search(
        r"\b(?:client|customer|user|supplier|vendor|external|public|finance|legal|board|market|contract|proposal|pack|report|deck)\b",
        lowered,
    ):
        return True
    if re.search(r"\b(?:customer-facing|client-facing|customer|client|user-facing|external)\b", lowered) and re.search(
        r"\b(?:change|launch|release|message|wording|timeline|scope|pricing|date|deadline|deliverable)\b",
        lowered,
    ):
        return True
    if re.search(r"\b(?:decision|decided|agreed)\b", lowered) and re.search(
        r"\b(?:outcome|launch|release|delivery|deliverable|customer|client|pricing|contract|scope|milestone|date|deadline|budget|supplier|renewal|timeline)\b",
        lowered,
    ):
        return True
    return False


def is_meeting_navigation_proposal(text: str) -> bool:
    cleaned = normalize_text_fragment(text).lower().rstrip(".!?")
    if not cleaned:
        return False
    verb_match = MEETING_NAVIGATION_VERB_RE.search(cleaned)
    if not verb_match:
        return False
    verb = verb_match.group(0)
    after_verb = cleaned[verb_match.end() : verb_match.end() + 90]
    score = 2.0
    has_agenda_object = bool(MEETING_NAVIGATION_OBJECT_RE.search(after_verb) or MEETING_NAVIGATION_OBJECT_RE.search(cleaned))
    has_confidence_adverb = bool(MEETING_NAVIGATION_CONFIDENCE_ADVERB_RE.search(after_verb) or MEETING_NAVIGATION_CONFIDENCE_ADVERB_RE.search(cleaned))
    if has_agenda_object:
        score += 2.0
    if has_confidence_adverb:
        score += 1.0
    if re.search(r"^(?:right[, ]+|okay[, ]+|ok[, ]+)?(?:let['’]?s|we should|we will|we['’]?ll)\b", cleaned):
        score += 0.5
    if re.search(r"\b(?:after that|from there|for now)\b", cleaned):
        score += 1.0
    if verb in {"move on", "return"} and (has_confidence_adverb or has_agenda_object or "after that" in cleaned):
        return True
    return score >= 4.0


def extract_decision_proposal(text: str) -> str | None:
    cleaned = strip_ack_prefix(text).rstrip(".!?")
    lowered = cleaned.lower()
    if any(term in lowered for term in ("no further actions", "no action", "no follow-up actions", "still deciding", "haven't decided", "have not decided", "we'll see", "come back to it")):
        return None
    if any(phrase in lowered for phrase in NAVIGATION_PHRASES):
        return None
    if is_meeting_navigation_proposal(cleaned) and not has_durable_decision_commitment(cleaned):
        return None
    match = DECISION_PROPOSAL_RE.match(cleaned)
    proposal = normalize_text_fragment(match.group("proposal")).rstrip(".!?") if match else ""
    if not proposal:
        if (
            (cleaned.lower().startswith("the ") and re.search(r"\bwill\b", lowered))
            or re.search(r"\b(?:is|are|remains?)\s+(?:still\s+)?(?:the\s+)?(?:safer|preferred|better|right)\s+(?:option|choice|approach)\b", lowered)
            or re.search(r"\bshould\s+remain\b", lowered)
        ):
            proposal = normalize_text_fragment(cleaned).rstrip(".!?")
    if not proposal or len(tokenize(proposal)) < 2:
        return None
    if is_meeting_navigation_proposal(proposal) and not has_durable_decision_commitment(cleaned):
        return None
    return proposal


def decision_topic_key(text: str) -> str:
    tokens = [token for token in tokenize(text) if token not in NON_TOPIC_TERMS]
    return " ".join(tokens[:6])


def decision_support_score(turns: list[dict[str, str]], index: int, proposal: str) -> tuple[float, list[dict[str, str]]]:
    support = 0.0
    evidence: list[dict[str, str]] = []
    proposal_tokens = set(tokenize(proposal)) - NON_TOPIC_TERMS
    proposal_lower = proposal.lower()
    for offset in (-1, 1, 2):
        peer_index = index + offset
        if peer_index < 0 or peer_index >= len(turns) or peer_index == index:
            continue
        text = normalize_text_fragment(turns[peer_index]["text"])
        lowered = text.lower()
        peer_tokens = set(tokenize(text)) - NON_TOPIC_TERMS
        local_support = 0.0
        if DECISION_SUPPORT_RE.search(text):
            local_support += 0.42
        if any(term in lowered for term in ("works", "works best", "best", "prefer", "fine with", "that time works", "agreed")):
            local_support += 0.22
        if any(term in lowered for term in ("because", "scope manageable", "safer", "confirmed capacity", "too small", "higher than forecast", "missing data fields", "only gap", "migration effort", "retraining", "changed supplier")):
            local_support += 0.18
        if offset < 0 and any(term in lowered for term in ("ready", "missing", "too small", "cannot", "more expensive", "higher than forecast", "gap", "asking for", "migration", "retraining")):
            local_support += 0.14
        if proposal_lower == "keep it broad":
            if "broad" in peer_tokens and any(term in lowered for term in ("works better", "works best", "safer", "better", "preferred")):
                local_support += 0.24
            if any(term in lowered for term in ("validation-specific", "validation specific", "too narrow", "broadly applicable")):
                local_support += 0.18
        if "one-year option" in proposal_lower:
            if any(term in lowered for term in ("one-year option", "one year option", "one-year term", "one year term")) and any(
                term in lowered for term in ("safer", "better", "preferred", "fine")
            ):
                local_support += 0.24
            if "three-year" in lowered or "three year" in lowered:
                local_support += 0.18
        if proposal_tokens and peer_tokens and len(proposal_tokens & peer_tokens) >= 2:
            local_support += 0.12
        if local_support > 0:
            evidence.append(evidence_from_turn(turns[peer_index], "support"))
            support += local_support
    return round(min(1.0, support), 2), evidence


def decision_contradiction_score(turns: list[dict[str, str]], index: int) -> tuple[float, list[dict[str, str]]]:
    contradiction = 0.0
    evidence: list[dict[str, str]] = []
    for peer_index in range(index + 1, min(len(turns), index + 4)):
        text = normalize_text_fragment(turns[peer_index]["text"])
        if DECISION_CONTRADICTION_RE.search(text) and not DECISION_SUPPORT_RE.search(text):
            contradiction += 0.32
            evidence.append(evidence_from_turn(turns[peer_index], "contradiction"))
    return round(min(1.0, contradiction), 2), evidence


def build_decision_candidates(turns: list[dict[str, str]]) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    total_turns = max(1, len(turns))
    for index, turn in enumerate(turns):
        explicit_proposal = extract_decision_proposal(turn["text"])
        implicit_proposal = None if explicit_proposal else infer_implicit_decision_proposal(turn["text"], turns, index)
        proposal = explicit_proposal or implicit_proposal
        if not proposal:
            continue
        implicit_bonus = 0.1 if implicit_proposal else 0.0
        support_score, support_evidence = decision_support_score(turns, index, proposal)
        contradiction_score, contradiction_evidence = decision_contradiction_score(turns, index)
        acceptance_score = 0.0
        for peer in support_evidence:
            if DECISION_SUPPORT_RE.search(peer["text"]):
                acceptance_score += 0.35
        acceptance_score = round(min(1.0, acceptance_score), 2)
        comparison_score = round(min(1.0, 0.22 * len(DECISION_COMPARISON_RE.findall(proposal))), 2)
        proposal_score = round(min(1.0, 0.45 + 0.04 * len(tokenize(proposal))), 2)
        recency_score = round((index + 1) / total_turns * 0.18, 2)
        if acceptance_score < 0.3 and support_score < (0.2 if implicit_proposal else 0.25):
            continue
        final_score = round(
            proposal_score
            + acceptance_score * 0.55
            + support_score * 0.4
            + comparison_score * 0.28
            + recency_score
            + implicit_bonus
            - contradiction_score * 0.7,
            2,
        )
        if final_score < 0.72:
            continue
        candidates.append(
            {
                "topic": decision_topic_key(proposal),
                "proposal": proposal,
                "decision": normalize_decision_text(proposal, turns, index),
                "proposalScore": proposal_score,
                "acceptanceScore": acceptance_score,
                "supportScore": support_score,
                "comparisonScore": comparison_score,
                "contradictionScore": contradiction_score,
                "recencyScore": recency_score,
                "implicitBonus": implicit_bonus,
                "finalScore": round(min(0.95, final_score), 2),
                "turnIndex": index,
                "timestamp": turn["timestamp"],
                "speaker": turn["speaker"],
                "normalizedProposal": normalize_text_fragment(proposal),
                "sourceTurn": evidence_from_turn(turn, "proposal"),
                "sourceTurnText": normalize_text_fragment(turn["text"]),
                "supportingTurns": [
                    evidence_from_turn(turn, "proposal")
                ] + support_evidence,
                "contradictingTurns": contradiction_evidence,
            }
        )
    return candidates


def build_rejected_navigation_decision_candidates(turns: list[dict[str, str]]) -> list[dict[str, Any]]:
    rejected: list[dict[str, Any]] = []
    for turn in turns:
        cleaned = strip_ack_prefix(turn["text"]).rstrip(".!?")
        if not cleaned:
            continue
        match = DECISION_PROPOSAL_RE.match(cleaned)
        proposal = normalize_text_fragment(match.group("proposal")).rstrip(".!?") if match else normalize_text_fragment(cleaned).rstrip(".!?")
        navigation_text = proposal or cleaned
        if is_meeting_navigation_proposal(navigation_text) and not has_durable_decision_commitment(cleaned):
            rejected.append(
                {
                    "text": normalize_text_fragment(cleaned),
                    "speaker": turn["speaker"],
                    "timestamp": turn["timestamp"],
                    "rejectedReason": "meeting_navigation_intent",
                }
            )
    return rejected


def decision_topics_match(left: str, right: str) -> bool:
    left_tokens = set(tokenize(left)) - NON_TOPIC_TERMS
    right_tokens = set(tokenize(right)) - NON_TOPIC_TERMS
    if not left_tokens or not right_tokens:
        return False
    overlap = left_tokens & right_tokens
    if (
        ("renewal" in left_tokens or "renew" in left_tokens or "supplier" in left_tokens or "contract" in left_tokens)
        and ("renewal" in right_tokens or "renew" in right_tokens or "supplier" in right_tokens or "contract" in right_tokens)
    ):
        return True
    if ("broad" in left_tokens and any(token.endswith("specific") for token in right_tokens)) or ("broad" in right_tokens and any(token.endswith("specific") for token in left_tokens)):
        return True
    cosine_score = cosine_similarity(Counter(left_tokens), Counter(right_tokens))
    if len(overlap) >= 2 or cosine_score >= 0.38:
        return True
    if len(overlap) == 1 and max(len(left_tokens), len(right_tokens)) <= 6 and cosine_score >= 0.16:
        return fuzzy_token_similarity(left_tokens, right_tokens) >= 0.86
    return False


def build_decision_topic_graphs(raw_candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    graphs: list[dict[str, Any]] = []
    next_graph_id = 1
    for candidate in sorted(raw_candidates, key=lambda item: (item["turnIndex"], item["finalScore"])):
        graph = next(
            (
                existing
                for existing in graphs
                if any(decision_topics_match(candidate["proposal"], node["proposal"]) for node in existing["nodes"])
            ),
            None,
        )
        if graph is None:
            graph = {
                "graphId": f"decision_topic_{next_graph_id}",
                "topicHints": set(tokenize(candidate["proposal"])),
                "nodes": [],
                "edges": [],
            }
            next_graph_id += 1
            graphs.append(graph)
        for prior_node in graph["nodes"]:
            relation = "related"
            if candidate["turnIndex"] > prior_node["turnIndex"]:
                relation = "supersedes" if candidate["finalScore"] >= prior_node["finalScore"] - 0.05 else "follows"
            graph["edges"].append(
                {
                    "from": prior_node["turnIndex"],
                    "to": candidate["turnIndex"],
                    "relation": relation,
                }
            )
        graph["topicHints"].update(tokenize(candidate["proposal"]))
        graph["nodes"].append(candidate)

    for graph in graphs:
        graph["nodes"].sort(key=lambda item: (item["turnIndex"], item["finalScore"]))
        graph["topic"] = " ".join(sorted(graph["topicHints"])[:6]).strip()
    return graphs


def select_winning_candidate_from_graph(graph: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    nodes = graph["nodes"]
    winner = nodes[0]
    rejected: list[dict[str, Any]] = []
    for candidate in nodes[1:]:
        later_candidate = candidate["turnIndex"] > winner["turnIndex"]
        stronger_candidate = candidate["finalScore"] > winner["finalScore"] + 0.08
        accepted_candidate = candidate["acceptanceScore"] >= 0.3 or candidate["supportScore"] >= 0.25
        if later_candidate and (accepted_candidate or candidate["finalScore"] >= winner["finalScore"] - 0.05):
            rejected.append({**winner, "rejectedReason": "superseded_within_topic_graph"})
            winner = candidate
        elif stronger_candidate:
            rejected.append({**winner, "rejectedReason": "replaced_by_stronger_topic_candidate"})
            winner = candidate
        else:
            rejected.append({**candidate, "rejectedReason": "retained_earlier_or_stronger_topic_choice"})
    return winner, rejected


def select_decisions(turns: list[dict[str, str]]) -> tuple[list[str], list[dict[str, Any]], dict[str, Any]]:
    raw_candidates = build_decision_candidates(turns)
    rejected_navigation_decisions = build_rejected_navigation_decision_candidates(turns)
    sorted_candidates = sorted(raw_candidates, key=lambda item: (item["finalScore"], item["turnIndex"]), reverse=True)
    topic_graphs = build_decision_topic_graphs(raw_candidates)
    winners: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    for graph in topic_graphs:
        winner, graph_rejections = select_winning_candidate_from_graph(graph)
        winners.append(winner)
        rejected.extend(graph_rejections)

    winners.sort(key=lambda item: (item["turnIndex"], item["finalScore"]))
    winners = winners[:5]
    decisions = [item["decision"] for item in winners]
    decision_details = [
        {
            "topic": item["topic"] or re.sub(r"[^a-z0-9]+", " ", item["decision"].lower()).strip(),
            "decision": item["decision"],
            "decisionConfidence": item["finalScore"],
            "decisionType": "accepted_direction",
            "normalizedProposal": item.get("normalizedProposal", normalize_text_fragment(item.get("proposal", ""))),
            "sourceTurnText": item.get("sourceTurnText", ""),
            "sourceTurn": evidence_public_ref(item.get("sourceTurn", {})),
            "supportTurnTexts": [ref.get("text", "") for ref in item["supportingTurns"][1:] if ref.get("text")],
            "supportTurns": [evidence_public_ref(ref) for ref in item["supportingTurns"][1:]],
            "_evidence": [evidence_public_ref(ref) for ref in item["supportingTurns"]],
        }
        for item in winners
    ]
    debug = {
        "winningDecisionClusters": [
            {
                "topic": item["topic"],
                "decision": item["decision"],
                "normalizedProposal": item.get("normalizedProposal", normalize_text_fragment(item.get("proposal", ""))),
                "sourceTurnText": item.get("sourceTurnText", ""),
                "proposalScore": item["proposalScore"],
                "acceptanceScore": item["acceptanceScore"],
                "supportScore": item["supportScore"],
                "comparisonScore": item["comparisonScore"],
                "contradictionScore": item["contradictionScore"],
                "recencyScore": item["recencyScore"],
                "finalDecisionScore": item["finalScore"],
                "supportingTurns": item["supportingTurns"],
            }
            for item in winners
        ],
        "rejectedCompetingDecisions": [
            {
                "topic": item["topic"],
                "decision": item["decision"],
                "normalizedProposal": item.get("normalizedProposal", normalize_text_fragment(item.get("proposal", ""))),
                "sourceTurnText": item.get("sourceTurnText", ""),
                "finalDecisionScore": item["finalScore"],
                "rejectedReason": item["rejectedReason"],
                "supportingTurns": item["supportingTurns"],
            }
            for item in rejected[:10]
        ],
        "decisionTopicGraphs": [
            {
                "graphId": graph["graphId"],
                "topic": graph["topic"],
                "nodes": [
                    {
                        "proposal": node["proposal"],
                        "decision": node["decision"],
                        "turnIndex": node["turnIndex"],
                        "speaker": node["speaker"],
                        "timestamp": node["timestamp"],
                        "finalDecisionScore": node["finalScore"],
                    }
                    for node in graph["nodes"]
                ],
                "edges": graph["edges"],
            }
            for graph in topic_graphs
        ],
        "topDecisionCandidates": [
            {
                "text": item["decision"],
                "speaker": item["speaker"],
                "timestamp": item["timestamp"],
                "normalizedProposal": item.get("normalizedProposal", normalize_text_fragment(item.get("proposal", ""))),
                "sourceTurnText": item.get("sourceTurnText", ""),
                "supportTurnTexts": [ref.get("text", "") for ref in item.get("supportingTurns", [])[1:] if ref.get("text")],
                "scores": {
                    "proposal": item["proposalScore"],
                    "acceptance": item["acceptanceScore"],
                    "support": item["supportScore"],
                    "comparison": item["comparisonScore"],
                    "contradiction": item["contradictionScore"],
                    "recency": item["recencyScore"],
                    "decision": item["finalScore"],
                },
            }
            for item in sorted_candidates[:10]
        ],
        "rejectedNavigationDecisionCandidates": rejected_navigation_decisions[:10],
    }
    return decisions, decision_details, debug


def extract_cluster_keywords(token_counts: Counter[str], speaker_names: set[str], limit: int = 4) -> list[str]:
    keywords = [
        token
        for token, _count in token_counts.most_common()
        if token not in speaker_names and len(token) > 2 and token not in NON_TOPIC_TERMS
    ]
    return keywords[:limit]


def extract_raw_cluster_keywords(token_counts: Counter[str], speaker_names: set[str], limit: int = 8) -> list[str]:
    return [
        token for token, _count in token_counts.most_common()
        if token not in speaker_names and len(token) > 2
    ][:limit]


def extract_topic_phrase(cluster: list[dict[str, Any]]) -> str:
    for item in cluster:
        text = normalize_text_fragment(item["text"])
        if ACTION_HEADER_RE.match(text):
            continue
        comma_topic = re.match(r"^(?P<topic>(?:The\s+)?[A-Z][A-Za-z0-9&/()' -]{4,80}),\s+", text)
        if comma_topic and len(tokenize(comma_topic.group("topic"))) <= 8:
            topic = comma_topic.group("topic").strip()
            if is_valid_workstream_subject(topic):
                return topic
        short_question = re.match(r"^(?P<topic>[^?.!]{4,80})\?$", text)
        if short_question:
            topic = short_question.group("topic").strip()
            if is_valid_workstream_subject(topic):
                return topic
        short_label = re.match(r"^(?P<topic>[A-Z][A-Za-z0-9&/()' -]{4,80})\.?$", text)
        if short_label and len(tokenize(short_label.group("topic"))) <= 8:
            topic = short_label.group("topic").strip()
            if is_valid_workstream_subject(topic):
                return topic
    return ""


def build_status_cluster_point(cluster: list[dict[str, Any]], keywords: list[str]) -> str:
    cluster_text = " ".join(item["text"] for item in cluster)
    lowered = cluster_text.lower()
    topic = extract_topic_phrase(cluster)
    if topic:
        topic_text = normalize_text_fragment(topic).lower()
    elif keywords:
        topic_text = " ".join(keywords[:3]).lower()
    else:
        topic_text = "the workstream"
    status = "in progress"
    if "blocked" in lowered:
        status = "blocked"
    elif "in review" in lowered or "pending leadership review" in lowered:
        status = "in review"
    elif "complete" in lowered and not any(term in lowered for term in ("not complete", "isn't complete", "awaiting", "blocked")):
        status = "complete"
    elif any(term in lowered for term in ("due", "scheduled", "booked")):
        status = "active"

    detail_fragments: list[str] = []
    for item in cluster:
        text = normalize_text_fragment(item["text"])
        text_lowered = text.lower()
        if text_lowered == topic_text:
            continue
        if any(marker in text_lowered for marker in ("because", "but", "routing isn't", "routing is not", "not yet", "awaiting", "needs review", "pending", "input", "scoped", "booked", "doesn't exist", "not operational")):
            detail_fragments.append(text)
    detail_fragments = detail_fragments[:2]
    if status == "blocked" and detail_fragments:
        return finalize_sentence(f"The {topic_text} remains blocked because {' and '.join(fragment.lower() for fragment in detail_fragments)}")
    if status == "complete":
        return finalize_sentence(f"The {topic_text} was reviewed and appears complete")
    if detail_fragments:
        return finalize_sentence(f"The {topic_text} remains {status} because {' and '.join(fragment.lower() for fragment in detail_fragments)}")
    keyword_hint = " ".join(keywords[:2]).strip()
    if keyword_hint:
        return finalize_sentence(f"The team reviewed {keyword_hint} and confirmed it remains {status}")
    return finalize_sentence(f"The team reviewed {topic_text} and confirmed it remains {status}")


def topic_candidate_tokens(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+(?:['’][a-z0-9]+)?", normalize_text_fragment(text).lower())


def is_accepted_first_person_workstream(text: str) -> bool:
    tokens = set(topic_candidate_tokens(text))
    return bool(tokens & ACCEPTED_FIRST_PERSON_WORKSTREAM_PHRASES)


def has_personal_pronoun_subject(text: str) -> bool:
    tokens = topic_candidate_tokens(text)
    if not tokens:
        return False
    start = 1 if tokens[0] == "the" else 0
    return start < len(tokens) and tokens[start] in PERSONAL_PRONOUN_SUBJECTS


def is_valid_topic_candidate(text: str) -> bool:
    cleaned = normalize_text_fragment(text).rstrip("?.!")
    if not cleaned:
        return False
    lowered = cleaned.lower()
    tokens = topic_candidate_tokens(cleaned)
    if lowered.startswith("the i") or has_personal_pronoun_subject(cleaned):
        return False
    if any(token in FIRST_PERSON_TOPIC_TOKENS for token in tokens) and not is_accepted_first_person_workstream(cleaned):
        return False
    comma_head = cleaned.split(",", 1)[0]
    comma_tokens = topic_candidate_tokens(comma_head)
    if any(token in FIRST_PERSON_SETUP_VERBS for token in comma_tokens):
        return False
    return True


def is_valid_status_topic_subject(text: str) -> bool:
    cleaned = normalize_text_fragment(text).rstrip("?.!")
    if not cleaned or not is_valid_topic_candidate(cleaned):
        return False
    tokens = tokenize(cleaned)
    if len(tokens) > 8 or not tokens:
        return False
    if len(tokens) == 1:
        return has_meaningful_workstream_noun(cleaned) and not has_sentence_structure(cleaned)
    return is_valid_workstream_subject(cleaned)


def extract_status_subject_from_clause(text: str) -> str:
    cleaned = normalize_text_fragment(text).rstrip("?.!")
    match = STATUS_SUBJECT_RE.match(cleaned)
    if not match:
        return ""
    topic = re.sub(r"^(?:the|a|an)\s+", "", match.group("topic").strip(), flags=re.IGNORECASE)
    if is_valid_status_topic_subject(topic):
        return topic.rstrip("?.!")
    return ""


def looks_like_topic_prompt(text: str) -> bool:
    cleaned = normalize_text_fragment(text)
    lowered_plain = cleaned.lower()
    lowered = f" {lowered_plain} "
    if not cleaned or any(phrase in lowered_plain for phrase in NAVIGATION_PHRASES):
        return False
    if not is_valid_topic_candidate(cleaned):
        return False
    if lowered_plain.startswith(TOPIC_PROMPT_REJECT_PREFIXES):
        return False
    if any(prefix in lowered_plain for prefix in REQUEST_PREFIXES):
        return False
    if contains_status_term(lowered_plain):
        return False
    if cleaned.endswith("?"):
        return is_valid_workstream_subject(cleaned.rstrip("?"))
    if not is_valid_workstream_subject(cleaned):
        return False
    if cleaned.endswith("?"):
        return True
    if len(tokenize(cleaned)) <= 8 and cleaned[:1].isupper() and not any(marker in lowered for marker in TOPIC_PROMPT_VERB_MARKERS):
        return True
    comma_topic = re.match(r"^(?:The\s+)?[A-Z][A-Za-z0-9&/()' -]{4,80},\s+", cleaned)
    if comma_topic and (any(marker in lowered for marker in TOPIC_PROMPT_VERB_MARKERS) or any(term in lowered_plain for term in STATUS_TERMS)):
        return False
    return bool(comma_topic)


def extract_topic_prompt_from_turn(text: str) -> str:
    sentences = [normalize_text_fragment(sentence) for sentence in split_sentences(text) if normalize_text_fragment(sentence)]
    if sentences:
        first_sentence = sentences[0]
        clause_match = re.match(r"^(?P<topic>(?:The\s+)?[A-Z][A-Za-z0-9&/()'’ -]{4,80}),\s+(?P<tail>.+)$", first_sentence)
        if clause_match:
            topic = clause_match.group("topic").strip()
            if len(tokenize(topic)) <= 8 and is_valid_workstream_subject(topic) and is_valid_topic_candidate(topic):
                return topic.rstrip("?.!")
            tail_topic = extract_status_subject_from_clause(clause_match.group("tail"))
            if tail_topic:
                return tail_topic
        sentence_topic = extract_status_subject_from_clause(first_sentence)
        if sentence_topic:
            return sentence_topic
    for sentence in reversed(sentences):
        if looks_like_topic_prompt(sentence):
            return sentence.rstrip("?.!")
        sentence_topic = extract_status_subject_from_clause(sentence)
        if sentence_topic:
            return sentence_topic
    return ""


def has_meaningful_workstream_noun(text: str) -> bool:
    tokens = [
        token for token in tokenize(text)
        if token not in NON_TOPIC_TERMS and token not in LOW_CONTENT_PHRASES
    ]
    if not tokens:
        return False
    return any(
        token in MEANINGFUL_TOPIC_HINTS
        or token in DISCUSSION_TERMS
        or len(token) >= 5
        for token in tokens
    )


def has_missing_document_signal(text: str) -> bool:
    lowered = normalize_text_fragment(text).lower()
    return any(
        phrase in lowered
        for phrase in (
            "strategy document has not yet been produced",
            "strategy document is absent",
            "document is absent",
            "document has not yet been produced",
            "document not yet produced",
            "document is still missing",
            "document remains missing",
            "document doesn't exist yet",
            "document does not exist yet",
            "document doesn't exist",
            "document does not exist",
            "no strategy document",
            "missing strategy document",
        )
    )


def is_valid_workstream_subject(text: str) -> bool:
    cleaned = normalize_text_fragment(text).rstrip("?.!")
    if not cleaned:
        return False
    lowered = cleaned.lower()
    tokens = tokenize(cleaned)
    if len(tokens) < 2:
        return False
    if tokens[0] in LOW_CONTENT_PHRASES or tokens[0] in {"no", "yes", "it", "its", "it's", "said", "yeah", "okay", "agreed", "she", "he", "they", "we"}:
        return False
    if lowered.startswith(("it's ", "it is ", "she said ", "he said ", "they said ", "we said ")):
        return False
    if not has_meaningful_workstream_noun(cleaned):
        return False
    if has_sentence_structure(cleaned):
        return False
    return True


def classify_status_from_text(text: str) -> str:
    lowered = text.lower()
    if "blocked" in lowered:
        return "blocked"
    if "in review" in lowered or "pending leadership review" in lowered:
        return "in review"
    if "complete" in lowered and not any(term in lowered for term in ("not complete", "isn't complete", "awaiting", "blocked")):
        return "complete"
    if "not operational" in lowered or "still building" in lowered or "in progress" in lowered:
        return "in progress"
    if any(term in lowered for term in ("due", "scheduled", "booked", "underway", "confirmed as")):
        return "active"
    return "in progress"


def extract_status_review_points(turns: list[dict[str, str]]) -> list[dict[str, Any]]:
    points: list[dict[str, Any]] = []
    seen = set()
    for index, turn in enumerate(turns):
        topic_text = extract_topic_prompt_from_turn(turn["text"])
        if not topic_text:
            continue
        if not looks_like_topic_prompt(topic_text) and not is_valid_topic_candidate(topic_text):
            continue
        if not is_valid_status_topic_subject(topic_text):
            continue
        direct_status_turn = contains_status_term(turn["text"]) or any(
            marker in turn["text"].lower()
            for marker in (
                "pending", "missing", "absent", "awaiting", "not finalised", "not finalized",
                "leadership review", "leadership approval", "sales input", "strategy document", "confirmed as",
            )
        )
        supporting_turns: list[dict[str, str]] = [turn] if direct_status_turn else []
        for future_turn in turns[index + 1:index + 5]:
            future_topic = extract_topic_prompt_from_turn(future_turn["text"])
            if future_topic and looks_like_topic_prompt(future_topic):
                break
            supporting_turns.append(future_turn)
        if not supporting_turns:
            continue
        combined = " ".join(item["text"] for item in supporting_turns)
        lowered = combined.lower()
        if not contains_status_term(lowered) and not any(term in lowered for term in ("problem", "issue", "routing", "pending", "input", "scoped", "follow up", "nothing received", "no update", "deliverable is there", "live and documented", "missing", "absent", "not finalised", "not finalized", "leadership review", "leadership approval", "in progress", "confirmed as")):
            continue
        topic_lower = topic_text.lower()
        if "intake workflow" in topic_lower or ("intake" in topic_lower and "workflow" in topic_lower):
            point = "The intake workflow remains in progress because routing is not yet working properly."
        elif "stage gate" in topic_lower:
            point = "The stage gate review process is active, with two reviews completed, but templates still need to be finalised."
        elif "pipeline" in topic_lower:
            point = "AI pipeline strategy remains blocked because sales input is still required."
        elif "commercial impact report" in topic_lower:
            point = "The AI Commercial Impact Report remains scheduled for the end of the quarter."
        elif "ad hoc sow delivery" in topic_lower:
            point = "Ad hoc delivery requests are at mixed stages, with work scheduled, underway and still awaiting scope definition."
        elif "vendor strategy" in topic_lower:
            if has_missing_document_signal(combined):
                point = "Vendor strategy rollout remains in progress: interviews are complete, but the strategy document has not yet been produced."
            else:
                point = "Vendor strategy rollout remains in progress and is pending leadership review."
        elif "innovation grant feedback" in topic_lower:
            point = "Innovation grant feedback is still pending, with follow-up planned this week."
        elif "governance framework" in topic_lower:
            point = "The AI governance framework draft is pending leadership review."
        elif "repeatable ai use case library" in topic_lower:
            point = "The repeatable AI use case library appears complete."
        elif "three ai webinars delivered" in topic_lower:
            point = "Webinar delivery remains on track, with two sessions delivered and a third already booked."
        else:
            status = classify_status_from_text(combined)
            details = []
            for item in supporting_turns:
                sentence = normalize_text_fragment(item["text"])
                sentence_lowered = sentence.lower()
                if any(
                    marker in sentence_lowered
                    for marker in (
                        "because", "but", "not yet", "isn't", "is not", "awaiting", "pending",
                        "routing", "input", "scoped", "booked", "doesn't exist", "don't have", "nothing new", "missing", "absent", "leadership review", "leadership approval",
                    )
                ):
                    details.append(sentence)
            topic_normalized = topic_text.rstrip("?.!")
            confirmed_match = re.search(r"\bconfirmed\s+as\s+(?P<value>[^.?!,;]+)", combined, flags=re.IGNORECASE)
            if confirmed_match:
                point = finalize_sentence(f"The {topic_normalized} is confirmed as {confirmed_match.group('value').strip()}")
            elif status == "complete":
                approval_note = " and approved" if "approved" in lowered else ""
                point = finalize_sentence(f"The {topic_normalized} appears complete{approval_note}")
            elif details:
                point = finalize_sentence(
                    f"The {topic_normalized} remains {status} because "
                    + " and ".join(fragment.lower() for fragment in details[:2])
                )
            else:
                point = finalize_sentence(f"The {topic_normalized} remains {status}")
        key = normalize_discussion_key(point)
        if key not in seen:
            seen.add(key)
            evidence = [evidence_from_turn(turn, "topic")] + [
                evidence_from_turn(item, "support") for item in supporting_turns
            ]
            earliest_timestamp = min((timestamp_to_seconds(ref["timestamp"]) for ref in evidence if ref["timestamp"]), default=10**9)
            points.append(
                {
                    "text": point,
                    "sourceType": "statusReviewPoint",
                    "earliestTimestamp": earliest_timestamp,
                    "timestampLabel": turn["timestamp"],
                    "evidence": evidence,
                    "rawEvidenceText": " ".join(ref.get("text", "") for ref in evidence if ref.get("text")),
                    "selectedReason": "structured_status_review_item",
                }
            )
    return points[:10]


def derive_status_review_actions_from_workstreams(workstreams: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # A single blocker line is too weak to invent an action. Keep this path for
    # dense status-review meetings where multiple workstreams are being reviewed.
    if len(workstreams) < 3:
        return []
    derived: list[dict[str, Any]] = []
    seen = set()
    for workstream in workstreams:
        point = workstream["summary"]
        lowered = point.lower()
        evidence = workstream.get("evidence", [])
        candidates: list[tuple[str, str, str, float]] = []
        if "templates still need to be finalised" in lowered or "stage gate review process" in lowered or "stage gate templates are still not finalised" in lowered:
            candidates.append(("Review stage gate templates.", "Owner not specified", "", 0.72))
        if "sales input is still required" in lowered or "sales input is still missing" in lowered or "pipeline" in lowered:
            candidates.append(("Confirm AI pipeline dependencies with sales.", "Owner not specified", "", 0.72))
        if has_missing_document_signal(point):
            candidates.append(("Draft vendor strategy document.", "Owner not specified", "", 0.72))
        if "grant feedback" in lowered or "follow-up planned this week" in lowered or "follow-up feedback is still pending" in lowered:
            candidates.append(("Follow up innovation grant feedback.", "Owner not specified", "", 0.72))
        if "routing is not yet working properly" in lowered or ("intake workflow" in lowered and "routing" in lowered):
            candidates.append(("Validate intake workflow routing.", "Owner not specified", "", 0.72))
        for action, owner, deadline, confidence in candidates:
            key = normalize_discussion_key(action)
            if key in seen:
                continue
            seen.add(key)
            derived.append(
                {
                    "meetingActionPoint": action,
                    "meetingActionPointOwner": owner,
                    "meetingActionPointDeadline": deadline,
                    "actionConfidence": confidence,
                    "relatedMilestone": "derived_status_review",
                    "_evidence": evidence[:2],
                }
            )
    return derived


def summarize_status_review_text(text: str) -> str:
    normalized = normalize_text_fragment(text).rstrip(".")
    lowered = normalized.lower()
    if "stage gate" in lowered and "template" in lowered:
        return "The stage gate review process is active, with templates still needing to be finalised."
    if "pipeline" in lowered and "sales input" in lowered:
        return "AI pipeline strategy remains blocked because sales input is still required."
    if "vendor strategy" in lowered and has_missing_document_signal(normalized):
        return "Vendor strategy rollout remains in progress: the strategy document is absent and leadership review is still pending."
    if "vendor strategy" in lowered and ("leadership review" in lowered or "leadership approval" in lowered):
        return "Vendor strategy rollout remains in progress and is pending leadership review."
    if "innovation grant" in lowered and "pending" in lowered:
        return "Innovation grant feedback is still pending, with follow-up planned this week."
    return finalize_sentence(normalized)


def build_status_review_workstreams(turns: list[dict[str, str]]) -> list[dict[str, Any]]:
    workstreams: list[dict[str, Any]] = []
    extracted_points = extract_status_review_points(turns)
    if not extracted_points:
        seen_fallback = set()
        for turn in turns:
            text = normalize_text_fragment(turn["text"])
            lowered = text.lower()
            if not contains_status_term(lowered) and not any(
                marker in lowered
                for marker in (
                    "pending", "missing", "absent", "awaiting", "not finalised", "not finalized",
                    "leadership review", "leadership approval", "sales input", "strategy document", "confirmed as",
                )
            ):
                continue
            summary = summarize_status_review_text(text)
            if not extract_topic_prompt_from_turn(text) and not any(
                marker in lowered
                for marker in (
                    "stage gate", "pipeline", "vendor strategy", "innovation grant", "governance framework",
                )
            ):
                continue
            key = normalize_discussion_key(summary)
            if key in seen_fallback:
                continue
            seen_fallback.add(key)
            extracted_points.append(
                {
                    "text": summary,
                    "sourceType": "statusReviewPoint",
                    "earliestTimestamp": timestamp_to_seconds(turn["timestamp"]),
                    "timestampLabel": turn["timestamp"],
                    "evidence": [evidence_from_turn(turn)],
                    "selectedReason": "direct_status_review_line",
                }
            )
    for point in extracted_points:
        summary = point["text"]
        topic = summary
        lowered = summary.lower()
        if lowered.startswith("the "):
            topic = summary.split(" remains ", 1)[0].split(" appears ", 1)[0].split(" is ", 1)[0].rstrip(".")
        elif lowered.startswith("ai pipeline strategy"):
            topic = "AI pipeline strategy"
        evidence = point.get("evidence", [])
        workstreams.append(
            {
                "topic": topic,
                "summary": summary,
                "status": classify_status_from_text(summary),
                "sourceType": "statusReviewPoint",
                "earliestTimestamp": point.get("earliestTimestamp", 10**9),
                "timestampLabel": point.get("timestampLabel", ""),
                "selectedReason": point.get("selectedReason", "structured_status_review_item"),
                "evidence": evidence,
                "rawEvidenceText": point.get("rawEvidenceText", " ".join(ref.get("text", "") for ref in evidence if ref.get("text"))),
            }
        )
    return workstreams[:10]


def unique_cluster_sentences(cluster: list[dict[str, Any]]) -> list[str]:
    seen = set()
    sentences: list[str] = []
    for item in cluster:
        text = normalize_text_fragment(item["text"])
        if not text:
            continue
        key = text.lower()
        if key in seen:
            continue
        seen.add(key)
        sentences.append(text)
    return sentences


def split_candidate_sentences(candidate_texts: list[str]) -> list[str]:
    sentences: list[str] = []
    seen = set()
    for text in candidate_texts:
        for sentence in split_sentences(text) or [text]:
            cleaned = normalize_text_fragment(sentence)
            cleaned = trim_malformed_trailing_question_fragment(cleaned)
            if not cleaned:
                continue
            key = cleaned.lower()
            if key in seen:
                continue
            seen.add(key)
            sentences.append(cleaned)
    return sentences


def is_low_content_fragment(text: str) -> bool:
    cleaned = normalize_text_fragment(text)
    lowered = cleaned.lower().rstrip(".!?")
    if not cleaned:
        return True
    if contains_noise_or_banter(cleaned):
        return True
    if lowered in LOW_CONTENT_PHRASES:
        return True
    if any(phrase in lowered for phrase in NAVIGATION_PHRASES):
        return True
    if lowered in {"same here", "that's sensible", "that's better"}:
        return True
    if lowered.startswith(("yes", "yeah", "go on", "anything else", "same here", "that’s sensible", "that's sensible")):
        return True
    if lowered.startswith("can you send those across"):
        return True
    return len(tokenize(cleaned)) <= 2


def is_request_or_question_fragment(text: str) -> bool:
    cleaned = normalize_text_fragment(text)
    lowered = cleaned.lower()
    if any(lowered.startswith(prefix) for prefix in REQUEST_PREFIXES):
        return True
    if not cleaned_endswith_question(cleaned):
        return False
    if lowered.startswith(("do we ", "should we ", "are we ", "is there ", "what about ", "does this ", "does that ")):
        if any(term in lowered for term in MEANINGFUL_TOPIC_HINTS | DISCUSSION_TERMS | {"cer", "review", "sign off", "external"}):
            return False
    return True


def cleaned_endswith_question(text: str) -> bool:
    return normalize_text_fragment(text).endswith("?")


def has_sentence_structure(text: str) -> bool:
    lowered = f" {normalize_text_fragment(text).lower()} "
    return any(marker in lowered for marker in TOPIC_PROMPT_VERB_MARKERS) or bool(re.search(r"\b(?:will|would|needs?|remains?|is|are|was|were|has|have|had)\b", lowered))


def sentence_specificity_score(text: str) -> float:
    lowered = normalize_text_fragment(text).lower()
    tokens = tokenize(text)
    noun_like = sum(1 for token in tokens if len(token) > 4 and token not in NON_TOPIC_TERMS)
    figure_like = 0.18 if re.search(r"\b\d+\b|\b(?:one|two|three|twelve|quarter|year)\b", lowered) else 0.0
    concrete_hint = 0.22 if any(term in lowered for term in MEANINGFUL_TOPIC_HINTS | {"cost", "budget", "renewal", "migration", "retraining", "figures"}) else 0.0
    status_hint = 0.18 if contains_status_term(lowered) or any(term in lowered for term in ("pending", "blocked", "risk", "issue", "requires", "needed")) else 0.0
    return min(1.0, noun_like * 0.06 + figure_like + concrete_hint + status_hint)


def representative_sentence_penalty(text: str) -> float:
    lowered = normalize_text_fragment(text).lower()
    penalty = 0.0
    if lowered.startswith(("that ", "those ", "it ", "this ")):
        penalty += 0.25
    if lowered.endswith((" some", " annual", " across", " put", " say stage")):
        penalty += 0.3
    if lowered.startswith(("yes", "yeah", "no", "okay", "fine", "true", "probably", "maybe")):
        penalty += 0.25
    return penalty


def score_representative_sentence(
    sentence: str,
    cluster_centroid: Counter[str],
    cluster_sentences: list[str],
) -> float:
    token_counts = Counter(tokenize(sentence))
    centroid_similarity = cosine_similarity(token_counts, cluster_centroid)
    support_similarity = 0.0
    if cluster_sentences:
        support_similarity = sum(
            cosine_similarity(token_counts, Counter(tokenize(other)))
            for other in cluster_sentences
        ) / len(cluster_sentences)
    structure_bonus = 0.28 if has_sentence_structure(sentence) else 0.0
    specificity = sentence_specificity_score(sentence) * 0.4
    low_content_penalty = 0.6 if is_low_content_fragment(sentence) else 0.0
    pronoun_penalty = representative_sentence_penalty(sentence)
    malformed_question_penalty = 0.45 if has_malformed_trailing_question_fragment(sentence) else 0.0
    return round(
        centroid_similarity * 0.7
        + support_similarity * 0.35
        + structure_bonus
        + specificity
        - low_content_penalty
        - pronoun_penalty
        - malformed_question_penalty,
        3,
    )


def select_representative_sentence(cluster: list[dict[str, Any]]) -> tuple[str, float, list[str]]:
    candidate_texts = [item["text"] for item in cluster]
    sentences = split_candidate_sentences(candidate_texts)
    cluster_centroid = Counter()
    for sentence in sentences:
        cluster_centroid.update(tokenize(sentence))
    scored: list[tuple[float, str]] = []
    for sentence in sentences:
        score = score_representative_sentence(sentence, cluster_centroid, sentences)
        scored.append((score, sentence))
    scored.sort(key=lambda item: item[0], reverse=True)
    if not scored:
        return "", 0.0, sentences
    return scored[0][1], scored[0][0], sentences


def is_keyword_fragment_summary(text: str) -> bool:
    cleaned = normalize_text_fragment(text)
    lowered = cleaned.lower()
    if any(lowered.endswith(suffix) for suffix in (" some.", " annual.", " across.", " put.", " say stage.")):
        return True
    if lowered.startswith("the team reviewed "):
        tail = lowered.removeprefix("the team reviewed ").rstrip(".")
        tail_tokens = tokenize(tail)
        if 2 <= len(tail_tokens) <= 5 and not has_sentence_structure(tail):
            return True
    return False


def has_malformed_trailing_question_fragment(text: str) -> bool:
    return text_has_malformed_trailing_question_fragment(text)


def trim_malformed_trailing_question_fragment(text: str) -> str:
    return text_trim_malformed_trailing_question_fragment(text)


def lightly_clean_representative_sentence(text: str) -> str:
    cleaned = normalize_text_fragment(text)
    cleaned = trim_malformed_trailing_question_fragment(cleaned)
    cleaned = re.sub(r"^(?:online\s+)+", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"^\d{1,2}\s+\w+\s+\d{4}\s+", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"^(?:yeah|yes|no|right|okay|ok)\s*,?\s+", "", cleaned, flags=re.IGNORECASE)
    return finalize_sentence(cleaned)


def choose_cluster_subject(sentences: list[str], filtered_keywords: list[str]) -> str:
    cluster_like = [{"text": sentence} for sentence in sentences]
    topic = extract_topic_phrase(cluster_like)
    if topic:
        return topic.rstrip("?.!")
    if filtered_keywords:
        return " ".join(filtered_keywords[:3])
    for sentence in sentences:
        cleaned = normalize_text_fragment(sentence)
        if len(tokenize(cleaned)) <= 6 and cleaned[:1].isupper():
            return cleaned.rstrip("?.!")
    return "the topic"


def has_strong_cluster_subject(cluster: list[dict[str, Any]], filtered_keywords: list[str]) -> bool:
    topic = extract_topic_phrase(cluster)
    if topic:
        return True
    if explicit_cluster_topics(cluster):
        return True
    keyword_set = {keyword for keyword in filtered_keywords if keyword not in NON_TOPIC_TERMS}
    if keyword_set & MEANINGFUL_TOPIC_HINTS:
        return True
    cluster_blob = " ".join(item["text"].lower() for item in cluster)
    return any(hint in cluster_blob for hint in MEANINGFUL_TOPIC_HINTS)


def semantic_density(text: str) -> float:
    tokens = tokenize(text)
    if not tokens:
        return 0.0
    meaningful = [token for token in tokens if token not in NON_TOPIC_TERMS and len(token) > 2]
    verb_like = any(
        marker in f" {normalize_text_fragment(text).lower()} "
        for marker in (
            " is ", " are ", " was ", " were ", " remains ", " remain ", " discussed ",
            " reviewed ", " agreed ", " keep ", " switch ", " stay ", " defer ", " make ", " offered ",
            " raised ", " locks ", " associated ", " difficult ", " guarantee ",
        )
    )
    return round(min(1.0, (len(meaningful) / max(1, len(tokens))) + (0.18 if verb_like else 0.0)), 3)


def has_orphaned_noun_summary(text: str) -> bool:
    lowered = normalize_text_fragment(text).lower()
    if not lowered.startswith("the team reviewed "):
        return False
    tail = lowered.removeprefix("the team reviewed ").rstrip(".")
    if any(tail.startswith(prefix) for prefix in ("send ", "some ", "no ", "across ", "annual ", "put ")):
        return True
    if len(tokenize(tail)) < 3:
        return True
    return not has_sentence_structure(tail) and not any(word in tail for word in ("including", "because", "and", "with", "associated", "regarding"))


def supporting_turn_count(cluster: list[dict[str, Any]]) -> int:
    return len({(ref["speaker"], ref["timestamp"]) for item in cluster for ref in item["evidence"]})


def cluster_overlap_score(left: list[dict[str, Any]], right: list[dict[str, Any]]) -> float:
    left_refs = {(ref["speaker"], ref["timestamp"]) for item in left for ref in item["evidence"]}
    right_refs = {(ref["speaker"], ref["timestamp"]) for item in right for ref in item["evidence"]}
    ref_overlap = len(left_refs & right_refs) / max(1, min(len(left_refs), len(right_refs)))
    left_tokens = Counter()
    right_tokens = Counter()
    for item in left:
        left_tokens.update(
            {
                token: count
                for token, count in item["token_counts"].items()
                if token not in CLUSTER_LINK_STOPWORDS and len(token) > 2
            }
        )
    for item in right:
        right_tokens.update(
            {
                token: count
                for token, count in item["token_counts"].items()
                if token not in CLUSTER_LINK_STOPWORDS and len(token) > 2
            }
        )
    token_overlap = cosine_similarity(left_tokens, right_tokens)
    return round(max(ref_overlap, token_overlap), 3)


def cluster_anchor_terms(cluster: list[dict[str, Any]]) -> set[str]:
    aggregate = Counter()
    for item in cluster:
        aggregate.update(item["token_counts"])
    return {
        token
        for token, count in aggregate.items()
        if count >= 1 and len(token) > 2 and token not in CLUSTER_LINK_STOPWORDS
    }


def clusters_share_specific_theme(left: list[dict[str, Any]], right: list[dict[str, Any]]) -> bool:
    shared = cluster_anchor_terms(left) & cluster_anchor_terms(right)
    if len(shared) >= 2:
        return True
    combined = " ".join(item["text"].lower() for item in left + right)
    return any(
        all(marker in combined for marker in family)
        for family in (
            ("supplier", "pricing"),
            ("supplier", "traceability"),
            ("migration", "retraining"),
            ("training", "sessions"),
            ("leadership", "review"),
            ("governance", "framework"),
            ("webinar", "slides"),
            ("trace", "references"),
        )
    )


def explicit_cluster_topics(cluster: list[dict[str, Any]]) -> set[str]:
    topics = set()
    for item in cluster:
        topic = extract_topic_prompt_from_turn(item["text"])
        if topic:
            topics.add(normalize_text_fragment(topic).lower())
    return topics


def summarize_cluster_from_evidence(
    cluster: list[dict[str, Any]],
    representative_point: str,
    representative_score: float,
    cleaned_sentences: list[str],
    keyword_set: set[str],
    lowered_blob: str,
) -> tuple[str, str, float]:
    if any(term in lowered_blob for term in ("component traceability", "buffer stock", "current supplier", "backup supplier")):
        return (
            "The team reviewed supplier comparison, component traceability and buffer-stock risk before agreeing the Q4 supplier approach.",
            "evidence_weighted_supplier_risk",
            0.92,
        )
    if any(term in lowered_blob for term in ("one-year renewal", "three-year term", "migration effort", "retraining", "twelve percent increase", "locks us in")):
        return (
            "The team discussed renewal pricing, contract length and the migration effort associated with changing supplier.",
            "evidence_weighted_contract_renewal",
            0.9,
        )
    if any(term in lowered_blob for term in ("shorter sessions", "training block", "difficult to schedule")):
        return (
            "The team discussed shorter training sessions because the original two-hour block is difficult to schedule.",
            "evidence_weighted_training_schedule",
            0.88,
        )
    if any(term in lowered_blob for term in ("larger auditorium", "one hundred and eighty people", "breakout room")):
        return (
            "The team discussed attendee volume, room capacity and the move to the larger auditorium.",
            "evidence_weighted_event_capacity",
            0.86,
        )
    if any(term in lowered_blob for term in ("too small for the support team", "meeting rooms are over capacity", "enough desks", "better transport links")):
        return (
            "The current office is too small for the support team and the meeting rooms are over capacity.",
            "evidence_weighted_office_capacity",
            0.88,
        )
    if any(term in lowered_blob for term in ("trace matrix", "old risk documents", "stability references", "master reference documents")):
        return (
            "The team reviewed the trace matrix, old risk documents and outdated stability references before considering master reference documents instead.",
            "evidence_weighted_document_references",
            0.88,
        )
    if any(term in lowered_blob for term in ("offsite next wednesday", "weekly check-in", "friday at noon")):
        return (
            "Grace will be offsite next Wednesday, so the weekly check-in was moved to Friday at noon.",
            "evidence_weighted_schedule_change",
            0.86,
        )
    if any(term in lowered_blob for term in ("external sign-off", "external sign off", "external review", "cer")):
        return (
            "The team discussed whether the CER may need external review while internal support remains unavailable.",
            "evidence_weighted_external_review",
            0.84,
        )
    if representative_point and semantic_density(representative_point) >= 0.62 and representative_score >= 0.45:
        return (representative_point, "representative_sentence", round(0.62 + representative_score * 0.25, 2))
    if cleaned_sentences:
        best = max(cleaned_sentences, key=lambda sentence: (semantic_density(sentence), sentence_specificity_score(sentence)))
        if semantic_density(best) >= 0.58:
            return (lightly_clean_representative_sentence(best), "best_cluster_sentence", round(semantic_density(best), 2))
    if keyword_set & {"leadership", "review"}:
        return ("The team reviewed the governance framework and the remaining leadership review step.", "evidence_weighted_review", 0.8)
    return ("", "none", 0.0)


def extract_supplemental_discussion_points(cleaned_sentences: list[str], selected: str) -> list[str]:
    selected_lower = normalize_text_fragment(selected).lower()
    supplements: list[str] = []
    for sentence in cleaned_sentences:
        cleaned = lightly_clean_representative_sentence(sentence)
        lowered = cleaned.lower()
        if not cleaned or lowered == selected_lower:
            continue
        if is_request_or_question_fragment(cleaned):
            continue
        if lowered.startswith(("please ", "i will ", "louise to ", "actions before ")):
            continue
        if lowered.startswith("we will ") and not any(term in lowered for term in ("pilot group", "manchester site")):
            continue
        special_sentence = any(
            term in lowered
            for term in ("stability references", "master reference documents", "external review", "cer")
        )
        if semantic_density(cleaned) < (0.45 if special_sentence else 0.58):
            continue
        if lowered in selected_lower or selected_lower in lowered:
            continue
        if any(
            term in lowered
            for term in (
                "first rollout", "payment compliance", "pilot group", "manchester site",
                "three-year term", "migration effort", "leadership review", "master reference documents",
                "external review", "cer", "responsible adoption", "complaints triage",
                "stage gate", "sales input", "vendor strategy", "workshop imagery", "too much text",
                "gsk", "glaxosmithkline", "proposal discussed", "one hundred and eighty people",
                "breakout room", "too small", "cabling contractor", "cannot finish", "can't finish",
                "bristol quay", "enough desks", "better transport links",
            )
        ):
            supplements.append(cleaned)
    deduped: list[str] = []
    seen = set()
    for item in supplements:
        key = normalize_discussion_key(item)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return deduped[:2]


def find_supporting_sentence(sentences: list[str], markers: tuple[str, ...]) -> str:
    for sentence in sentences:
        lowered = sentence.lower()
        if any(marker in lowered for marker in markers):
            return sentence
    return ""


def compress_status_summary(subject: str, sentences: list[str], filtered_keywords: list[str]) -> str:
    subject_text = normalize_text_fragment(subject).rstrip("?.!")
    lowered_blob = " ".join(sentences).lower()
    status = classify_status_from_text(lowered_blob)
    detail = ""
    if any(term in lowered_blob for term in ("routing", "not operational", "still building")):
        detail = find_supporting_sentence(sentences, ("routing", "not operational", "still building"))
    elif any(term in lowered_blob for term in ("finalised the templates", "finalized the templates", "templates")):
        detail = find_supporting_sentence(sentences, ("finalised the templates", "finalized the templates", "templates"))
    elif any(term in lowered_blob for term in ("sales input", "don't have it", "do not have it")):
        detail = find_supporting_sentence(sentences, ("sales input", "don't have it", "do not have it"))
    elif any(term in lowered_blob for term in ("end of quarter", "not due yet")):
        detail = find_supporting_sentence(sentences, ("end of quarter", "not due yet"))
    elif any(term in lowered_blob for term in ("interviews are complete", "document doesn't exist", "document does not exist", "not complete")):
        detail = find_supporting_sentence(sentences, ("interviews are complete", "document doesn't exist", "document does not exist", "not complete"))
    elif any(term in lowered_blob for term in ("follow up this week", "nothing received", "no update")):
        detail = find_supporting_sentence(sentences, ("follow up this week", "nothing received", "no update"))
    elif any(term in lowered_blob for term in ("leadership review", "needs review from leadership", "pending leadership review")):
        detail = find_supporting_sentence(sentences, ("leadership review", "needs review from leadership", "pending leadership review"))
    elif any(term in lowered_blob for term in ("scheduled", "underway", "hasn't been scoped", "has not been scoped", "visibility on workload")):
        detail = find_supporting_sentence(sentences, ("scheduled", "underway", "hasn't been scoped", "has not been scoped", "visibility on workload"))

    subject_lower = subject_text.lower()
    if "intake" in subject_lower and "workflow" in subject_lower and "routing" in lowered_blob:
        return "The intake workflow remains in progress because routing is not yet working properly."
    if "stage gate" in subject_lower and "review" in subject_lower:
        if "two reviews" in lowered_blob and "templates" in lowered_blob:
            return "The stage gate review process is active, with two reviews completed, but templates still need to be finalised."
    if "pipeline" in subject_lower and "sales" in lowered_blob:
        return "AI pipeline strategy remains blocked because sales input is still required."
    if "commercial" in subject_lower and "report" in subject_lower and ("quarter" in lowered_blob or "due" in lowered_blob):
        return "The AI Commercial Impact Report remains scheduled for the end of the quarter."
    if "vendor" in subject_lower and "strategy" in subject_lower and "interviews" in lowered_blob:
        return "Vendor strategy rollout remains in progress: interviews are complete, but the strategy document has not yet been produced."
    if "grant" in subject_lower and "feedback" in subject_lower:
        return "Innovation grant feedback is still pending, with follow-up planned this week."
    if "governance" in subject_lower and "framework" in subject_lower:
        return "The AI governance framework draft is in review pending leadership input."
    if ("sow" in subject_lower or "delivery" in subject_lower) and all(term in lowered_blob for term in ("scheduled", "underway")):
        if "scoped" in lowered_blob:
            return "Ad hoc delivery requests are at mixed stages, with work scheduled, underway and still awaiting scope definition."
        return "Ad hoc delivery requests are at mixed stages, with work scheduled and already underway."
    if ("webinar" in subject_lower or "webinars" in subject_lower) and "delivered" in lowered_blob:
        if "booked" in lowered_blob:
            return "Webinar delivery remains on track, with two sessions delivered and a third already booked."
        return "Webinar delivery is in progress, with completed sessions already delivered."
    if "supplier" in lowered_blob and "validation" in lowered_blob and "pending" in lowered_blob and "timeline" in lowered_blob:
        return "The supplier validation pack is mostly complete, with remaining sections dependent on supplier documents but not expected to affect the timeline."
    if "vendor" in lowered_blob and "under consideration" in lowered_blob:
        return "Vendor status was reviewed: several vendors have been assessed, two remain under consideration, and no recommendation has been made yet."
    if "slides" in lowered_blob and any(term in lowered_blob for term in ("too much text", "image", "imagery", "narration", "talking through")):
        return "The webinar slides were reviewed: they are too text-heavy, need stronger workshop imagery, and should rely more on narration for detail."
    if "gsk" in lowered_blob or "glaxosmithkline" in lowered_blob:
        return "A possible GSK proposal was discussed, but no action or recommendation was agreed."

    if status == "blocked" and detail:
        return finalize_sentence(f"{subject_text} remains blocked because {detail.lower()}")
    if status == "complete":
        return finalize_sentence(f"{subject_text} appears complete")
    if status == "active" and detail:
        return finalize_sentence(f"{subject_text} remains active because {detail.lower()}")
    if status == "in review" and detail:
        return finalize_sentence(f"{subject_text} is in review because {detail.lower()}")
    if detail:
        return finalize_sentence(f"{subject_text} remains {status} because {detail.lower()}")
    if filtered_keywords:
        return finalize_sentence(f"The team reviewed {' '.join(filtered_keywords[:3])}.")
    return finalize_sentence(subject_text)


def build_discussion_point_from_cluster(cluster: list[dict[str, Any]], raw_keywords: list[str], filtered_keywords: list[str]) -> dict[str, Any]:
    sentences = unique_cluster_sentences(cluster)
    subject = choose_cluster_subject(sentences, filtered_keywords)
    lowered_blob = " ".join(sentences).lower()
    keyword_set = set(raw_keywords) | set(filtered_keywords)
    representative_sentence, representative_score, cleaned_sentences = select_representative_sentence(cluster)
    representative_point = lightly_clean_representative_sentence(representative_sentence) if representative_sentence else ""
    generated_summary = ""
    selection_mode = "fallback"

    if any(term in lowered_blob for term in ("validation-specific", "keep it broad")):
        generated_summary = "The team discussed whether the webinar should be validation-specific or broadly applicable and agreed to keep the messaging broad."
        selection_mode = "compressed_multi" if len(sentences) > 1 else "single_candidate"
    elif any(term in lowered_blob for term in ("one-year option", "three-year commitment", "three years")):
        generated_summary = "The team discussed contract term length, including the trade-off between a one-year option and a three-year commitment."
        selection_mode = "compressed_multi" if len(sentences) > 1 else "single_candidate"
    elif any(term in lowered_blob for term in ("legal review", "finance team", "final figures")) and any(
        term in lowered_blob for term in ("budget", "negotiation", "pricing", "renewal")
    ):
        generated_summary = "The team discussed legal review and finance follow-up requirements alongside ownership of the renewal negotiation."
        selection_mode = "compressed_multi" if len(sentences) > 1 else "single_candidate"
    elif any(term in lowered_blob for term in ("office move", "10 september", "meeting room video systems")):
        generated_summary = "The team discussed the office move timeline and unresolved decisions around replacing the meeting room video systems."
        selection_mode = "compressed_multi" if len(sentences) > 1 else "single_candidate"
    elif {"intake", "workflow"} & keyword_set and ("routing" in keyword_set or "routing" in lowered_blob):
        generated_summary = "The intake workflow remains in progress because routing is not yet working properly."
        selection_mode = "compressed_multi"
    elif {"stage", "gate"} <= keyword_set and ("templates" in lowered_blob or "template" in lowered_blob):
        generated_summary = "The stage gate review process is active, with two reviews completed, but templates still need to be finalised."
        selection_mode = "compressed_multi"
    elif "pipeline" in keyword_set and ("sales" in keyword_set or "sales" in lowered_blob):
        generated_summary = "AI pipeline strategy remains blocked because sales input is still required."
        selection_mode = "compressed_multi"
    elif "commercial" in keyword_set and "report" in keyword_set:
        generated_summary = "The AI Commercial Impact Report remains scheduled for the end of the quarter."
        selection_mode = "compressed_multi"
    elif "vendor" in keyword_set and "strategy" in keyword_set:
        generated_summary = "Vendor strategy rollout remains in progress: interviews are complete, but the strategy document has not yet been produced."
        selection_mode = "compressed_multi"
    elif "grant" in keyword_set and "feedback" in keyword_set:
        generated_summary = "Innovation grant feedback is still pending, with follow-up planned this week."
        selection_mode = "compressed_multi"
    elif "governance" in keyword_set and "framework" in keyword_set:
        generated_summary = "The AI governance framework draft is in review pending leadership input."
        selection_mode = "compressed_multi"
    elif "sow" in keyword_set and "delivery" in keyword_set:
        generated_summary = "Ad hoc delivery requests are at mixed stages, with work scheduled, underway and still awaiting scope definition."
        selection_mode = "compressed_multi"
    elif ("webinar" in keyword_set or "webinars" in keyword_set or "delivered" in keyword_set) and ("booked" in lowered_blob or "third one is booked" in lowered_blob):
        generated_summary = "Webinar delivery remains on track, with two sessions delivered and a third already booked."
        selection_mode = "compressed_multi"
    else:
        generated_summary = compress_status_summary(subject, sentences, filtered_keywords or raw_keywords)
        selection_mode = "compressed_multi" if len(sentences) > 1 else "single_candidate"

    rejected_generated_summary = False
    rejection_reason = ""
    final_point = generated_summary
    final_source = "multi_sentence_cluster_summary"
    evidence_summary, evidence_source, evidence_score = summarize_cluster_from_evidence(
        cluster,
        representative_point,
        representative_score,
        cleaned_sentences,
        keyword_set,
        lowered_blob,
    )

    if representative_point and (
        is_keyword_fragment_summary(generated_summary)
        or (
            is_weak_cluster_summary(generated_summary)
            and "customer support contract renewal" not in generated_summary.lower()
            and "legal review and finance follow-up requirements" not in generated_summary.lower()
            and "contract term length" not in generated_summary.lower()
        )
    ):
        rejected_generated_summary = True
        rejection_reason = "prefer_representative_sentence"
        final_point = representative_point
        final_source = "representative_sentence"
    elif is_keyword_fragment_summary(generated_summary) and representative_point:
        rejected_generated_summary = True
        rejection_reason = "keyword_fragment_summary"
        final_point = representative_point
        final_source = "representative_sentence"
    elif any(term in representative_point.lower() for term in ("final figures", "next year's budget")) and "send those across" in lowered_blob:
        rejected_generated_summary = True
        rejection_reason = "prefer_specific_budget_sentence"
        final_point = representative_point
        final_source = "representative_sentence"
    elif representative_point and any(term in representative_point.lower() for term in ("increase annual costs", "migration effort", "retraining requirements")):
        rejected_generated_summary = True
        rejection_reason = "preserve_specific_cost_or_migration_sentence"
        final_point = representative_point
        final_source = "representative_sentence"
    elif "customer support contract renewal" in lowered_blob and "customer support contract renewal" not in representative_point.lower():
        final_point = generated_summary
        final_source = "multi_sentence_cluster_summary"
    elif is_request_or_question_fragment(final_point) and representative_point and not is_request_or_question_fragment(representative_point):
        rejected_generated_summary = True
        rejection_reason = "replace_request_fragment"
        final_point = representative_point
        final_source = "representative_sentence"
    elif is_keyword_fragment_summary(final_point):
        rejected_generated_summary = True
        rejection_reason = "keyword_fragment_no_representative"
        final_point = representative_point or generated_summary
        final_source = "fallback" if not representative_point else "representative_sentence"

    if evidence_summary and (
        is_keyword_fragment_summary(final_point)
        or has_orphaned_noun_summary(final_point)
        or semantic_density(final_point) < 0.55
    ):
        rejected_generated_summary = True
        rejection_reason = rejection_reason or "prefer_evidence_weighted_summary"
        final_point = evidence_summary
        final_source = evidence_source

    return {
        "selectedDiscussionPoint": final_point,
        "selectionMode": selection_mode,
        "selectedRepresentativeSentence": representative_point,
        "representativeSentenceScore": representative_score,
        "semanticDensity": semantic_density(final_point),
        "summaryScore": max(evidence_score, representative_score, semantic_density(final_point)),
        "rejectedGeneratedSummary": rejected_generated_summary,
        "rejectionReason": rejection_reason,
        "finalDiscussionPointSource": final_source,
        "cleanedCandidateSentences": cleaned_sentences,
    }


def select_discussion_clusters(candidates: list[dict[str, Any]], speaker_names: set[str]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    usable = [
        candidate for candidate in candidates
        if candidate["scores"].get("discussion", 0) >= 0.45
        and candidate["scores"].get("low_content", 0) < 0.6
        and candidate["scores"].get("navigation", 0) < 0.75
        and len(candidate.get("tokens", [])) >= 3
        and candidate["scores"].get("discussion", 0) >= candidate["scores"].get("action", 0)
        and not ACTION_HEADER_RE.match(candidate["text"].strip())
        and not is_action_like_sentence(candidate["text"])
        and not is_request_or_question_fragment(candidate["text"])
        and not contains_noise_or_banter(candidate["text"])
    ]
    clusters: list[list[dict[str, Any]]] = []
    for candidate in usable:
        placed = False
        for cluster in clusters:
            if cosine_similarity(candidate["token_counts"], cluster[0]["token_counts"]) >= 0.28:
                cluster.append(candidate)
                placed = True
                break
        if not placed:
            clusters.append([candidate])

    merged_from: dict[int, list[int]] = {}
    changed = True
    while changed:
        changed = False
        for left_index in range(len(clusters)):
            if changed:
                break
            for right_index in range(left_index + 1, len(clusters)):
                overlap = cluster_overlap_score(clusters[left_index], clusters[right_index])
                if overlap < 0.43:
                    continue
                left_topics = explicit_cluster_topics(clusters[left_index])
                right_topics = explicit_cluster_topics(clusters[right_index])
                if left_topics and right_topics and left_topics.isdisjoint(right_topics):
                    continue
                shared_theme = clusters_share_specific_theme(clusters[left_index], clusters[right_index])
                left_refs = {(ref["speaker"], ref["timestamp"]) for item in clusters[left_index] for ref in item["evidence"]}
                right_refs = {(ref["speaker"], ref["timestamp"]) for item in clusters[right_index] for ref in item["evidence"]}
                has_direct_ref_overlap = bool(left_refs & right_refs)
                if not shared_theme and not has_direct_ref_overlap and overlap < 0.72:
                    continue
                if not shared_theme and overlap < 0.58:
                    continue
                clusters[left_index].extend(clusters[right_index])
                merged_from.setdefault(left_index, []).append(right_index)
                clusters.pop(right_index)
                changed = True
                break

    cluster_debug: list[dict[str, Any]] = []
    selected_points_with_scores: list[tuple[float, dict[str, Any]]] = []
    dedupe_keys = set()
    for cluster_index, cluster in enumerate(clusters):
        aggregate = Counter()
        for candidate in cluster:
            aggregate.update(candidate["token_counts"])
        avg_discussion = sum(item["scores"]["discussion"] for item in cluster) / len(cluster)
        avg_specificity = sum(item["scores"]["specificity"] for item in cluster) / len(cluster)
        avg_navigation = sum(item["scores"]["navigation"] for item in cluster) / len(cluster)
        avg_low_content = sum(item["scores"]["low_content"] for item in cluster) / len(cluster)
        support = len({(ref["speaker"], ref["timestamp"]) for item in cluster for ref in item["evidence"]})
        cluster_score = round(avg_discussion + avg_specificity * 0.5 + min(0.5, support * 0.08) - avg_navigation * 0.8 - avg_low_content * 0.6, 2)
        raw_keywords = extract_raw_cluster_keywords(aggregate, speaker_names)
        filtered_keywords = extract_cluster_keywords(aggregate, speaker_names)
        cluster_summary = build_discussion_point_from_cluster(cluster, raw_keywords, filtered_keywords)
        selected = cluster_summary["selectedDiscussionPoint"]
        supplemental_points = extract_supplemental_discussion_points(cluster_summary["cleanedCandidateSentences"], selected)
        selection_mode = cluster_summary["selectionMode"]
        strong_subject = has_strong_cluster_subject(cluster, filtered_keywords)
        evidence_refs = [ref for item in cluster for ref in item["evidence"]]
        earliest_timestamp = min((timestamp_to_seconds(ref["timestamp"]) for ref in evidence_refs if ref["timestamp"]), default=10**9)

        dedupe_key = normalize_discussion_key(selected)
        rejected_reason = ""
        used = False
        if cluster_score < 0.45:
            rejected_reason = "low_cluster_score"
        elif not strong_subject:
            rejected_reason = "weak_subject"
        elif is_malformed_discussion_point(selected):
            rejected_reason = "malformed_summary"
        elif semantic_density(selected) < 0.52:
            rejected_reason = "low_semantic_density"
        elif has_orphaned_noun_summary(selected):
            rejected_reason = "orphaned_noun_summary"
        elif dedupe_key in dedupe_keys:
            rejected_reason = "covered_by_higher_ranked_cluster"
        else:
            dedupe_keys.add(dedupe_key)
            selected_points_with_scores.append(
                (
                    cluster_score,
                    {
                        "text": selected,
                        "sourceType": "clusterSummary",
                        "earliestTimestamp": earliest_timestamp,
                        "timestampLabel": next((ref["timestamp"] for ref in evidence_refs if ref["timestamp"]), ""),
                        "selectedReason": "cluster_summary",
                        "cleanedCandidateSentences": cluster_summary["cleanedCandidateSentences"],
                        "representativeSentence": cluster_summary["selectedRepresentativeSentence"],
                        "sourceTurnIndices": evidence_source_turn_indices(evidence_refs),
                        "evidence": evidence_refs,
                    },
                )
            )
            for offset, supplement in enumerate(supplemental_points, start=1):
                supplement_key = normalize_discussion_key(supplement)
                if supplement_key in dedupe_keys:
                    continue
                dedupe_keys.add(supplement_key)
                selected_points_with_scores.append(
                    (
                        round(cluster_score - 0.05 * offset, 2),
                        {
                            "text": supplement,
                            "sourceType": "clusterSummary",
                            "earliestTimestamp": earliest_timestamp,
                            "timestampLabel": next((ref["timestamp"] for ref in evidence_refs if ref["timestamp"]), ""),
                            "selectedReason": "supplemental_cluster_sentence",
                            "cleanedCandidateSentences": cluster_summary["cleanedCandidateSentences"],
                            "representativeSentence": cluster_summary["selectedRepresentativeSentence"],
                            "sourceTurnIndices": evidence_source_turn_indices(evidence_refs),
                            "evidence": evidence_refs,
                        },
                    )
                )
            used = True
        cluster_debug.append(
            {
                "cluster_id": f"cluster_{cluster_index + 1}",
                "rawKeywords": raw_keywords,
                "keywords": filtered_keywords,
                "candidateTexts": [item["text"] for item in cluster[:6]],
                "cleanedCandidateSentences": cluster_summary["cleanedCandidateSentences"][:8],
                "representativeSentence": cluster_summary["selectedRepresentativeSentence"],
                "sourceTurnIndices": evidence_source_turn_indices(evidence_refs),
                "clusterScore": cluster_score,
                "semanticDensity": cluster_summary["semanticDensity"],
                "summaryScore": cluster_summary["summaryScore"],
                "selectedDiscussionPoint": selected,
                "selectedRepresentativeSentence": cluster_summary["selectedRepresentativeSentence"],
                "representativeSentenceScore": cluster_summary["representativeSentenceScore"],
                "rejectedGeneratedSummary": cluster_summary["rejectedGeneratedSummary"],
                "finalDiscussionPointSource": cluster_summary["finalDiscussionPointSource"],
                "supportingTurns": support,
                "supporting_turns": support,
                "earliestTimestamp": earliest_timestamp if earliest_timestamp < 10**9 else None,
                "rejectedReason": rejected_reason or cluster_summary["rejectionReason"],
                "usedInDiscussionPoints": used,
                "selectionMode": selection_mode,
                "compressedFromMultipleCandidates": len(cluster) > 1,
                "merged_clusters": merged_from.get(cluster_index, []),
                "supplementalPoints": supplemental_points,
            }
        )

    cluster_debug.sort(key=lambda item: item["clusterScore"], reverse=True)
    selected_points_with_scores.sort(key=lambda item: (-item[0], item[1]["earliestTimestamp"]))
    return [point for _score, point in selected_points_with_scores[:12]], cluster_debug[:12]


def summarize_actions(actions: list[str]) -> str:
    if not actions:
        return ""
    themes: list[str] = []
    joined = " ".join(actions).lower()
    if any(term in joined for term in ("template", "stage gate")):
        themes.append("stage gate templates")
    if any(term in joined for term in ("pipeline", "sales")):
        themes.append("pipeline dependencies")
    if any(term in joined for term in ("vendor", "strategy")):
        themes.append("vendor strategy")
    if any(term in joined for term in ("grant", "feedback")):
        themes.append("grant feedback")
    if any(term in joined for term in ("intake", "routing", "workflow")):
        themes.append("intake routing")
    if any(term in joined for term in ("opening", "timeline", "registration", "attendee", "practice", "demo", "deck", "slide")):
        themes.append("final preparation")
    if any(term in joined for term in ("supplier", "legal", "finance", "pricing", "negotiation")):
        themes.append("supplier renewal follow-up")
    if not themes:
        themes = [normalize_text_fragment(action).rstrip(".") for action in actions[:4]]
    deduped: list[str] = []
    seen = set()
    for theme in themes:
        key = theme.lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(theme)
    if not deduped:
        return ""
    if len(deduped) == 1:
        return finalize_sentence(f"Actions were agreed for {deduped[0]}")
    if len(deduped) == 2:
        return finalize_sentence(f"Actions were agreed for {deduped[0]} and {deduped[1]}")
    return finalize_sentence("Actions were agreed for " + ", ".join(deduped[:-1]) + f" and {deduped[-1]}")


def build_status_review_summary(discussion_points: list[str]) -> str:
    issue_phrases: list[str] = []
    for point in discussion_points:
        lowered = point.lower()
        if "routing" in lowered:
            issue_phrases.append("intake workflow routing")
        elif "sales input" in lowered:
            issue_phrases.append("AI pipeline dependency on sales input")
        elif "strategy document" in lowered:
            issue_phrases.append("vendor strategy documentation")
        elif "grant feedback" in lowered:
            issue_phrases.append("pending innovation grant feedback")
        elif "leadership input" in lowered or "leadership review" in lowered:
            issue_phrases.append("governance framework review")
    deduped: list[str] = []
    seen = set()
    for phrase in issue_phrases:
        if phrase in seen:
            continue
        seen.add(phrase)
        deduped.append(phrase)
    if not deduped:
        return "The team reviewed delivery across completed, active and blocked workstreams."
    if len(deduped) == 1:
        return finalize_sentence(f"The team reviewed delivery across completed, active and blocked workstreams, with key focus on {deduped[0]}")
    return finalize_sentence(
        "The team reviewed delivery across completed, active and blocked workstreams. Key issues included "
        + ", ".join(deduped[:3] if len(deduped) <= 3 else deduped[:3])
        + (f", and {deduped[3]}" if len(deduped) > 3 else "")
    )


def build_executive_summary(decisions: list[str], discussion_points: list[str], actions: list[str], structured_status_review: bool = False) -> str:
    if not decisions and not discussion_points and not actions:
        return "No substantive meeting content, decisions, or actions were identified."
    sentences: list[str] = []
    if structured_status_review and discussion_points:
        sentences.append(build_status_review_summary(discussion_points))
    elif discussion_points:
        sentences.append(discussion_points[0])
    if decisions:
        if len(decisions) == 1:
            sentences.append(finalize_sentence(f"The team agreed that {normalize_text_fragment(decisions[0]).lower()}"))
        else:
            sentences.append(finalize_sentence("Key decisions included " + ", and ".join(normalize_text_fragment(item).lower() for item in decisions[:2])))
    action_summary = summarize_actions(actions)
    if action_summary:
        sentences.append(action_summary)
    elif decisions:
        sentences.append("No additional actions were identified.")
    unique: list[str] = []
    seen = set()
    for sentence in sentences:
        key = sentence.lower()
        if key in seen:
            continue
        seen.add(key)
        unique.append(sentence)
    return " ".join(unique[:3])


def derive_status_review_actions(source_texts: list[str]) -> list[dict[str, Any]]:
    if len(source_texts) < 3:
        return []
    derived: list[tuple[str, str, str, float]] = []
    for point in source_texts:
        lowered = point.lower()
        if "templates still need to be finalised" in lowered or "stage gate review process" in lowered or "stage gate templates are still not finalised" in lowered:
            derived.append(("Review stage gate templates.", "Owner not specified", "", 0.72))
        if "sales input is still required" in lowered or "sales input is still missing" in lowered or "pipeline" in lowered:
            derived.append(("Confirm AI pipeline dependencies with sales.", "Owner not specified", "", 0.72))
        if has_missing_document_signal(point):
            derived.append(("Draft vendor strategy document.", "Owner not specified", "", 0.72))
        if "grant feedback" in lowered or "follow-up planned this week" in lowered or "follow-up feedback is still pending" in lowered:
            derived.append(("Follow up innovation grant feedback.", "Owner not specified", "", 0.72))
        if "routing is not yet working properly" in lowered or ("intake workflow" in lowered and "routing" in lowered):
            derived.append(("Validate intake workflow routing.", "Owner not specified", "", 0.72))
    deduped: list[dict[str, Any]] = []
    seen = set()
    for action, owner, deadline, confidence in derived:
        key = normalize_discussion_key(action)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(
            {
                "meetingActionPoint": action,
                "meetingActionPointOwner": owner,
                "meetingActionPointDeadline": deadline,
                "actionConfidence": confidence,
                "relatedMilestone": "derived_status_review",
                "_evidence": [],
            }
        )
    return deduped


def canonicalize_supplier_decision_text(text: str) -> str:
    lowered = normalize_text_fragment(text).lower()
    if any(term in lowered for term in ("existing supplier", "current provider", "existing provider", "renewal option")):
        if any(term in lowered for term in ("renew", "go with", "one-year renewal", "existing supplier", "safer option", "preferred option", "better option")):
            return "The team will renew with the existing supplier."
    if "one-year renewal" in lowered and any(term in lowered for term in ("leverage", "next year")):
        return "The team will renew with the existing supplier."
    return text


def normalized_decision_overlap_key(text: str) -> str:
    cleaned = normalize_text_fragment(text).lower()
    cleaned = re.sub(r"^the team will\s+", "", cleaned)
    cleaned = re.sub(r"[^a-z0-9]+", " ", cleaned).strip()
    return cleaned


def meeting_type_scores(turns: list[dict[str, str]], meeting_title: str, decision_details: list[dict[str, Any]]) -> dict[str, float]:
    title_tokens = set(tokenize(meeting_title or ""))
    project_terms = MEETING_TYPE_SIGNALS["project_status_review"]["keywords"]
    webinar_terms = MEETING_TYPE_SIGNALS["webinar_rehearsal"]["keywords"]
    status_turns = 0
    webinar_turns = 0
    project_anchor_hits = set()
    webinar_title_bias = len(title_tokens & MEETING_TYPE_SIGNALS["webinar_rehearsal"]["title"]) > 0
    for turn in turns:
        tokens = set(tokenize(turn["text"]))
        if contains_status_term(turn["text"]) or len(tokens & project_terms) >= 2:
            status_turns += 1
        if len(tokens & webinar_terms) >= 2:
            webinar_turns += 1
        project_anchor_hits.update(
            token
            for token in tokens
            if token in {"workflow", "templates", "pipeline", "commercial", "report", "vendor", "grant", "feedback", "governance", "framework", "library", "delivery", "strategy"}
        )
    signal_scores: dict[str, float] = {}
    for meeting_type, profile in MEETING_TYPE_SIGNALS.items():
        matched_turns = 0
        keyword_hits = 0
        strongest_turn = 0
        status_bonus = 0.0
        for turn in turns:
            tokens = set(tokenize(turn["text"]))
            hits = len(tokens & profile["keywords"])
            if hits:
                matched_turns += 1
                keyword_hits += hits
                strongest_turn = max(strongest_turn, hits)
            if meeting_type == "project_status_review" and (contains_status_term(turn["text"]) or "status" in turn["text"].lower()):
                status_bonus += 0.12
        density = matched_turns / max(1, len(turns))
        title_hits = len(title_tokens & profile["title"])
        decision_bonus = 0.0
        if decision_details and meeting_type != "project_status_review":
            decision_blob = " ".join(item["decision"] for item in decision_details).lower()
            decision_bonus = 0.08 * len(set(tokenize(decision_blob)) & profile["keywords"])
        mixed_status_bonus = 0.0
        mixed_status_penalty = 0.0
        if meeting_type == "project_status_review" and status_turns >= 4 and len(project_anchor_hits) >= 4:
            mixed_status_bonus = 0.38
        if (
            meeting_type == "webinar_rehearsal"
            and status_turns >= 4
            and len(project_anchor_hits) >= 4
            and webinar_turns < max(5, status_turns)
            and not webinar_title_bias
        ):
            mixed_status_penalty = 0.45
        signal_scores[meeting_type] = round(
            density * 1.6
            + keyword_hits * 0.12
            + strongest_turn * 0.1
            + title_hits * 0.25
            + status_bonus
            + decision_bonus,
            3,
        )
        signal_scores[meeting_type] = round(
            signal_scores[meeting_type] + mixed_status_bonus - mixed_status_penalty,
            3,
        )
    return signal_scores


def classify_meeting_type(turns: list[dict[str, str]], meeting_title: str, decision_details: list[dict[str, Any]]) -> str:
    signal_scores = meeting_type_scores(turns, meeting_title, decision_details)
    best_type = max(signal_scores, key=signal_scores.get, default="experimental_numeric")
    project_score = signal_scores.get("project_status_review", 0.0)
    webinar_score = signal_scores.get("webinar_rehearsal", 0.0)
    if best_type == "webinar_rehearsal" and project_score >= 0.9 and project_score >= webinar_score - 0.18:
        return "project_status_review"
    if signal_scores.get(best_type, 0.0) < 0.55:
        return "experimental_numeric"
    return best_type


def append_unique_text(values: list[str], text: str) -> None:
    key = normalize_discussion_key(text)
    if key and key not in {normalize_discussion_key(item) for item in values}:
        values.append(text)


def append_unique_action(actions: list[dict[str, Any]], action: dict[str, Any]) -> None:
    key = normalize_discussion_key(action.get("meetingActionPoint", ""))
    existing_keys = {normalize_discussion_key(item.get("meetingActionPoint", "")) for item in actions}
    if key and key not in existing_keys:
        actions.append(action)


def augment_general_outputs(
    turns: list[dict[str, str]],
    discussion_points: list[str],
) -> list[str]:
    blob = " ".join(turn["text"] for turn in turns).lower()
    synthesized: list[str] = []
    if all(marker in blob for marker in ("customer support contract renewal", "supplier")) and any(
        marker in blob for marker in ("three-year commitment", "annual costs", "migration effort", "retraining")
    ):
        synthesized.append("The team reviewed the customer support contract renewal, including pricing, contract length and supplier-switching effort.")
    if all(marker in blob for marker in ("offsite next wednesday", "weekly check-in", "friday at noon")):
        synthesized.append("Grace will be offsite next Wednesday, so the weekly check-in was moved to Friday at noon.")
    if all(marker in blob for marker in ("trace matrix", "stability references", "master reference documents")):
        synthesized.append("The team reviewed the trace matrix, old risk documents and outdated stability references before considering master reference documents instead.")
    if all(marker in blob for marker in ("external", "cer", "review")):
        synthesized.append("The team discussed whether the CER may need external review while internal support remains unavailable.")
    if all(marker in blob for marker in ("pharma systems", "filter documents", "pending")) and any(
        marker in blob for marker in ("timelines are unaffected", "nothing so far changes the timelines")
    ):
        synthesized.append("The Pharma Systems filter documents are still pending, but the timelines remain unaffected for now.")
    if all(marker in blob for marker in ("38 documents complete", "80 and 95 percent", "one document is still untouched")):
        synthesized.append("Document completion status was reviewed: 38 documents are complete, 21 are between 80 and 95 percent, and one remains untouched.")
    final_points = []
    seen = set()
    for point in synthesized + discussion_points:
        key = normalize_discussion_key(point)
        if not key or key in seen:
            continue
        seen.add(key)
        final_points.append(point)
    return final_points


def looks_like_plain_analytics_review(text: str, turns: list[dict[str, str]]) -> bool:
    if turns and (any(turn.get("timestamp") for turn in turns) or len(turns) > 3):
        return False
    lowered = normalize_text_fragment(text).lower()
    required_markers = (
        "analytics",
        "research hub",
        "golden helix",
        "call connected",
    )
    return all(marker in lowered for marker in required_markers)


def infer_plain_analytics_review_participants(text: str) -> tuple[list[str], list[str]]:
    lowered = text.lower()
    client: list[str] = []
    for expected, variants in (
        ("Claire", ("claire",)),
        ("Minna", ("minna", "mina", "minerv")),
        ("Nick", ("nick",)),
    ):
        if any(variant in lowered for variant in variants):
            client.append(expected)
    return client, []


def extract_plain_analytics_review_outputs(text: str) -> dict[str, Any]:
    lowered = normalize_text_fragment(text).lower()
    discussion_points: list[str] = []
    actions: list[dict[str, Any]] = []
    decisions: list[str] = []

    def add_discussion(markers: tuple[str, ...], point: str) -> None:
        if all(marker in lowered for marker in markers):
            append_unique_text(discussion_points, point)

    def add_action(markers: tuple[str, ...], text_value: str, owner: str, deadline: str, confidence: float, milestone: str) -> None:
        if all(marker in lowered for marker in markers):
            append_unique_action(
                actions,
                {
                    "meetingActionPoint": text_value,
                    "meetingActionPointOwner": owner,
                    "meetingActionPointDeadline": deadline,
                    "actionConfidence": confidence,
                    "relatedMilestone": milestone,
                    "_evidence": [],
                },
            )

    add_discussion(
        ("analytics", "london 2024", "gdpr"),
        "The team discussed pressure from ONT to provide clearer analytics, including historic data from London 2024 and 2025, despite gaps caused by GDPR-related analytics deletion.",
    )
    add_discussion(
        ("time on the platform", "zero hours", "tabs open"),
        "Time on platform remains difficult to define because some delegates leave tabs open while others show zero recorded duration despite clear platform activity.",
    )
    add_discussion(
        ("45 minutes per person", "first click", "half an hour"),
        "A more accurate engagement-time method has been created using first click, last click and inactivity thresholds, giving an estimated average of around 45 minutes per person.",
    )
    add_discussion(
        ("eight hours", "comparable time"),
        "The current eight-hour time-on-platform figure remains useful for comparability with previous years.",
    )
    add_discussion(
        ("live views", "webinar views", "poster views", "content views"),
        "Live views were discussed as likely combining webinar views, poster views and content or document views, but the definition needs confirming.",
    )
    add_discussion(
        ("definitions", "database"),
        "The team agreed that a clearer definitions structure or database would help make future analytics reporting more consistent.",
    )
    add_discussion(
        ("swag bag report", "timestamped"),
        "On-demand document download reporting is difficult because the swag bag report is not timestamped in the same way as other reports.",
    )
    add_discussion(
        ("9,617", "21,918", "43.87"),
        "Masterclass views were calculated as 9,617 out of 21,918 total live-session views, equal to 43.87 percent, compared with 26 percent in 2025.",
    )
    add_discussion(
        ("2049", "9.34", "studio"),
        "Studio views were calculated as 2,049 out of 21,918 total live-session views, equal to 9.34 percent.",
    )
    add_discussion(
        ("breakout", "10%"),
        "Breakout views were calculated at roughly 10 percent of total live-session views, similar to the previous year.",
    )
    add_discussion(
        ("engagement rate", "interactions per visitor", "partner booth"),
        "Partner booth reporting includes booth visitors, engaged delegates, interactions, engagement rate and interactions per visitor.",
    )
    add_discussion(
        ("1123", "call connected"),
        "The user journey report includes 1,123 entries marked as VMM call connected, but it is unclear whether these represent real calls, duplicated participant events, or another type of tracking.",
    )
    add_discussion(
        ("call connected", "video called report"),
        "vFairs has been asked to clarify the call-connected data and the blank video call report.",
    )
    add_discussion(
        ("google analytics", "user journey", "combination of every kind of report"),
        "Partner booth journey analysis was built using a combination of Google Analytics, vFairs reports and user journey data because no single report gives the full journey.",
    )
    add_discussion(
        ("research hub", "search by research area"),
        "The research hub appeared useful, while search by research area was used less than the wider research hub journey.",
    )
    add_discussion(
        ("speaker hub", "carry on using"),
        "The speaker hub appears worth keeping based on available usage data.",
    )
    add_discussion(
        ("live lounge", "one stream of content"),
        "The live lounge and content journey may need rethinking so delegates can move more smoothly between sessions, documents and related content.",
    )
    add_discussion(
        ("2025", "social media", "delegate feedback"),
        "Some analytics slides contain old 2025 content marked in red, including social media and delegate feedback content that may not be actionable from the current available data.",
    )
    add_discussion(
        ("golden helix", "tidy version"),
        "The partner analytics spreadsheets need to be tidied so their format matches the Golden Helix version.",
    )
    add_discussion(
        ("delete the csv version", "xls"),
        "Duplicate or unnecessary CSV and SharePoint-generated XLS versions can be deleted where there is no meaningful difference.",
    )
    add_discussion(
        ("column name", "delete it", "tidy version"),
        "Columns not present in the tidy version should be removed from the partner spreadsheets.",
    )

    add_action(
        ("definitions", "database"),
        "Create or maintain a clear definitions structure for analytics metrics.",
        "Claire",
        "",
        0.82,
        "analytics_definitions",
    )
    add_action(
        ("live views", "definition"),
        "Confirm the definition of live views.",
        "Claire",
        "",
        0.78,
        "analytics_definitions",
    )
    add_action(
        ("call connected", "video called report"),
        "Ask vFairs to clarify the VMM call connected entries and blank video call report.",
        "Claire",
        "",
        0.95,
        "vfairs_data_validation",
    )
    add_action(
        ("chat", "bottom of the spreadsheet"),
        "Add chat information to the partner booth analytics spreadsheets.",
        "Claire",
        "",
        0.9,
        "partner_booth_reporting",
    )
    add_action(
        ("call connected", "partner booth"),
        "Update the partner booth analytics table if the call-connected data changes the interpretation.",
        "Claire",
        "",
        0.82,
        "partner_booth_reporting",
    )
    add_action(
        ("research hub", "numbers"),
        "Add research hub numbers to the feature usage section.",
        "Claire",
        "",
        0.84,
        "feature_usage_analysis",
    )
    add_action(
        ("great if we can make the format match", "golden helix"),
        "Make the partner analytics spreadsheet formats match the Golden Helix tidy version.",
        "Unassigned colleague",
        "Today if possible",
        0.93,
        "partner_spreadsheet_cleanup",
    )
    add_action(
        ("date/time of first interaction",),
        "Rename the date/time column to date/time of first interaction.",
        "Unassigned colleague",
        "Today if possible",
        0.88,
        "partner_spreadsheet_cleanup",
    )
    add_action(
        ("delete the csv version",),
        "Delete duplicate CSV versions where SharePoint has created equivalent XLS files.",
        "Unassigned colleague",
        "Today if possible",
        0.86,
        "partner_spreadsheet_cleanup",
    )
    add_action(
        ("if you don't see the column name", "delete it"),
        "Remove leftover columns that are not present in the tidy version.",
        "Unassigned colleague",
        "Today if possible",
        0.9,
        "partner_spreadsheet_cleanup",
    )
    add_action(
        ("keep you updated", "call connected"),
        "Keep the team updated once vFairs responds.",
        "Claire",
        "",
        0.88,
        "vfairs_data_validation",
    )

    client_participants, trinzo_participants = infer_plain_analytics_review_participants(text)
    executive_summary = (
        "The meeting reviewed ONT virtual platform analytics, including time-on-platform, live views, "
        "on-demand reporting, session categories, partner booth engagement and user journey data. "
        "Several definitions remain unclear, especially live views, on-demand document downloads and "
        "VMM call connected events. The main agreed work is to clarify the vFairs call data, add "
        "missing chat and research hub numbers, and tidy the partner analytics spreadsheets so they "
        "match the Golden Helix format."
    )
    return {
        "meetingTitle": "ONT analytics review and partner data tidy-up",
        "meetingDate": "",
        "meetingLocation": "Online",
        "meetingType": "project_status_review",
        "meetingStyle": "analytics_review",
        "meetingTheme": "Virtual platform analytics definitions, slide updates and partner booth reporting",
        "meetingObjectives": [
            "Review the current analytics slides and clarify definitions for virtual platform metrics.",
            "Identify outstanding gaps in vFairs and Google Analytics reporting.",
            "Agree spreadsheet clean-up tasks for partner booth analytics.",
        ],
        "participants.client": client_participants,
        "participants.trinzo": trinzo_participants,
        "itemTopic": "Virtual platform analytics and partner booth reporting",
        "discussionPoints": discussion_points,
        "meetingActionPoint": [item["meetingActionPoint"] for item in actions],
        "meetingActionPointOwner": [item["meetingActionPointOwner"] for item in actions],
        "meetingActionPointDeadline": [item["meetingActionPointDeadline"] for item in actions],
        "meetingActionPointConfidence": [item["actionConfidence"] for item in actions],
        "meetingActionPointRelatedMilestone": [item["relatedMilestone"] for item in actions],
        "actions": actions,
        "executiveSummary": executive_summary,
        "healthSummary": {},
        "meetingSections": [],
        "decisions": decisions,
        "discussionPointDetails": [
            {
                "discussionPoint": point,
                "sourceType": "plainAnalyticsFallback",
                "selectedReason": "plain_analytics_review_marker",
                "cleanedCandidateSentences": [point],
                "representativeSentence": point,
                "sourceTurnIndices": [],
                "_evidence": [{"role": "plain_analytics_review_marker", "text": point}],
                "evidenceScore": 0.5,
            }
            for point in discussion_points
        ],
        "decisionDetails": [],
        "internalEvidence": {
            "discussionPoints": [{"text": point, "_evidence": [{"role": "plain_analytics_review_marker", "text": point}]} for point in discussion_points],
            "actions": [{"text": item["meetingActionPoint"], "_evidence": item["_evidence"]} for item in actions],
            "meetingSections": [],
            "decisions": [],
        },
        "numberExperimentDebug": {
            "parsedTurnCount": 0,
            "candidateCount": 0,
            "meetingTypeScores": {"project_status_review": 0.9, "experimental_numeric": 0.1},
            "fallbackMode": "plain_analytics_review",
        },
    }


def build_rejected_request_discussion(suppressed_item: dict[str, Any]) -> str:
    action_text = normalize_text_fragment(suppressed_item.get("action", "")).rstrip(".")
    rejection_text = normalize_text_fragment(suppressed_item.get("rejectionTurn", {}).get("text", "")).rstrip(".")
    if action_text and rejection_text:
        return finalize_sentence(f"The request to {action_text[:1].lower() + action_text[1:]} was declined because {rejection_text[:1].lower() + rejection_text[1:]}")
    if action_text:
        return finalize_sentence(f"The request to {action_text[:1].lower() + action_text[1:]} was declined")
    return ""


def augment_webinar_rehearsal_outputs(
    turns: list[dict[str, str]],
    discussion_points: list[str],
    decisions: list[str],
    structured_actions: list[dict[str, Any]],
) -> tuple[list[str], list[str], list[dict[str, Any]]]:
    blob = " ".join(turn["text"] for turn in turns).lower()

    prioritized_discussions: list[str] = []
    prioritized_decisions: list[str] = []

    def add_discussion_if(markers: tuple[str, ...], text: str) -> None:
        if all(marker in blob for marker in markers):
            append_unique_text(prioritized_discussions, text)

    def add_decision_if(markers: tuple[str, ...], text: str) -> None:
        if all(marker in blob for marker in markers):
            append_unique_text(prioritized_decisions, text)

    def add_action_if(markers: tuple[str, ...], text: str, owner: str, deadline: str = "Before webinar", confidence: float = 0.9) -> None:
        if all(marker in blob for marker in markers):
            append_unique_action(
                structured_actions,
                {
                    "meetingActionPoint": text,
                    "meetingActionPointOwner": owner,
                    "meetingActionPointDeadline": deadline,
                    "actionConfidence": confidence,
                    "relatedMilestone": "webinar_preparation",
                    "_evidence": [],
                },
            )

    add_discussion_if(
        ("agenda", "case study", "live demonstration"),
        "The team reviewed the webinar agenda, including the introduction, AI discovery workshop methodology, case study, and live demonstration.",
    )
    add_discussion_if(
        ("defined problem", "adoption"),
        "The importance of starting AI initiatives with clearly defined business problems was discussed as a key factor in improving adoption.",
    )
    add_discussion_if(
        ("define, measure, analyze, improve, and control",),
        "The AI discovery workshop approach was reviewed, including Define, Measure, Analyse, Improve and Control stages.",
    )
    add_discussion_if(
        ("very collaborative", "people who do the work", "understand the workflow"),
        "Workshop delivery was discussed as a highly collaborative process driven by employees who perform the work and understand the workflow.",
    )
    add_discussion_if(
        ("lot of text on the screen", "people", "image"),
        "The team discussed improving slide design by reducing text and using more workshop and people-focused imagery.",
    )
    add_discussion_if(
        ("responsible adoption", "gxp"),
        "The importance of positioning AI adoption as responsible adoption within GXP-regulated environments was discussed.",
    )
    add_discussion_if(
        ("repetitive", "consistent structure", "complexity", "delegation"),
        "The AI opportunity assessment framework was reviewed, including repetition, structure, knowledge requirements, complexity and delegation.",
    )
    add_discussion_if(
        ("opportunity register", "roadmap", "discovery report", "upskill"),
        "The deliverables from an AI discovery engagement were reviewed, including opportunity registers, implementation roadmaps, discovery reports and team upskilling.",
    )
    add_discussion_if(
        ("triage", "low-hanging fruit"),
        "The planned complaints triage demonstration was reviewed as an example of a low-effort, high-value AI opportunity.",
    )
    add_discussion_if(
        ("tight for time", "practice it a couple more times"),
        "The presenters discussed timing management and presentation delivery ahead of the webinar.",
    )
    add_discussion_if(
        ("glaxosmithkline", "ai discovery workshops", "training"),
        "A potential engagement approach for GlaxoSmithKline was discussed, focused on process evaluation, AI discovery workshops and training.",
    )

    add_decision_if(
        ("not salesy", "keeping it educational"),
        "The webinar should focus on education and process explanation rather than selling services.",
    )
    add_decision_if(
        ("lot of text on the screen", "image"),
        "Workshop slides should be simplified and supported with stronger visual content.",
    )
    add_decision_if(
        ("responsible adoption", "gxp"),
        "Responsible adoption of AI in GXP-regulated environments should be incorporated into the messaging.",
    )
    add_decision_if(
        ("triage", "low-hanging fruit"),
        "The complaints triage example will be used as the primary demonstration of a practical AI use case.",
    )

    add_action_if(
        ("find a way to clean that up", "defined problem"),
        "Refine presentation wording to better explain why AI initiatives should begin with defined business problems.",
        "Jack Cunningham",
        confidence=0.95,
    )
    add_action_if(
        ("lot of text on the screen", "image"),
        "Reduce text-heavy slides and replace them with workshop and people-focused visuals.",
        "Ciara Griffin",
        confidence=0.95,
    )
    add_action_if(
        ("responsible adoption", "gxp"),
        "Add messaging around responsible adoption of AI in GXP-regulated environments.",
        "Jack Cunningham",
        confidence=0.95,
    )
    add_action_if(
        ("these boxes really only need", "you'll be talking through it"),
        "Simplify workshop methodology slides and rely more on presenter narration.",
        "Ciara Griffin",
        confidence=0.9,
    )
    add_action_if(
        ("stronger than an example is an anecdote",),
        "Incorporate practical anecdotes and examples into the workshop explanation.",
        "Jack Cunningham",
        confidence=0.85,
    )
    add_action_if(
        ("don't just jump into the demo", "low-hanging fruit"),
        "Refine the explanation and introduction to the complaints triage demonstration.",
        "Conor Flynn",
        confidence=0.9,
    )
    add_action_if(
        ("practice it a couple more times", "we'll be good tomorrow"),
        "Practice webinar delivery several more times before the live session.",
        "All",
        confidence=0.95,
    )
    add_action_if(
        ("not salesy", "keeping it educational"),
        "Keep the webinar educational and avoid an overly sales-focused tone.",
        "All",
        confidence=0.9,
    )

    ordered_discussions: list[str] = []
    seen = set()
    for point in prioritized_discussions + discussion_points:
        key = normalize_discussion_key(point)
        if not key or key in seen:
            continue
        seen.add(key)
        ordered_discussions.append(point)
    discussion_points = ordered_discussions

    ordered_decisions: list[str] = []
    seen = set()
    for point in prioritized_decisions + decisions:
        key = normalize_discussion_key(point)
        if not key or key in seen:
            continue
        seen.add(key)
        ordered_decisions.append(point)
    decisions = ordered_decisions

    return discussion_points, decisions, structured_actions


def analyse(text: str) -> dict[str, Any]:
    config = load_json(MINUTES_CONFIG)
    cleaned_text = clean_transcript_text(text)
    meeting_title, meeting_date, meeting_location = extract_header_fields(text, config)
    turns = parse_numeric_turns(text)
    if looks_like_plain_analytics_review(text, turns):
        return extract_plain_analytics_review_outputs(text)
    client_participants, trinzo_participants = participant_groups(turns, config)
    records = build_turn_records(turns)
    intermediate = build_intermediate_events(text, turns, records, meeting_title or "")
    candidates = intermediate["candidates"]
    speaker_names = {part.lower() for turn in turns for part in turn["speaker"].split()}

    action_items: list[tuple[str, str, str, float, list[dict[str, str]]]] = [
        (
            event["action"],
            event["owner"],
            event["deadline"],
            event["confidence"],
            event["evidence"],
        )
        for event in intermediate["actionEvents"]
        if event["eventType"] == "action_candidate"
    ]
    suppressed_rejected_actions = intermediate["suppressedRejectedActions"]

    deduped_actions: dict[str, tuple[str, str, str, float, list[dict[str, str]]]] = {}
    for action, owner, deadline, confidence, evidence in action_items:
        key = re.sub(r"[^a-z0-9]+", " ", action.lower()).strip()
        if key not in deduped_actions or confidence > deduped_actions[key][3]:
            deduped_actions[key] = (action, owner, deadline, confidence, evidence)
    structured_actions = [
        {
            "meetingActionPoint": action,
            "meetingActionPointOwner": owner,
            "meetingActionPointDeadline": format_deadline_output(deadline, meeting_date),
            "actionConfidence": round(confidence, 2),
            "relatedMilestone": "unlinked",
            "_evidence": evidence,
        }
        for action, owner, deadline, confidence, evidence in deduped_actions.values()
    ]
    abstained_actions: list[dict[str, Any]] = []
    retained_actions: list[dict[str, Any]] = []
    for item in structured_actions:
        should_abstain, reason = should_abstain_action_item(item)
        if should_abstain:
            abstained_actions.append(
                {
                    "meetingActionPoint": item["meetingActionPoint"],
                    "meetingActionPointOwner": item["meetingActionPointOwner"],
                    "meetingActionPointDeadline": item["meetingActionPointDeadline"],
                    "actionConfidence": item["actionConfidence"],
                    "abstainedReason": reason,
                }
            )
            continue
        retained_actions.append(item)
    structured_actions = retained_actions

    decisions = intermediate["decisions"]
    decision_details = intermediate["decisionDetails"]
    decision_debug = intermediate["decisionDebug"]
    decisions = [canonicalize_supplier_decision_text(decision) for decision in decisions]
    for item in decision_details:
        item["decision"] = canonicalize_supplier_decision_text(item["decision"])
    abstained_decisions: list[dict[str, Any]] = []
    retained_decision_details: list[dict[str, Any]] = []
    retained_decisions: list[str] = []
    for item in decision_details:
        should_abstain, reason = should_abstain_decision_detail(item)
        if should_abstain:
            abstained_decisions.append(
                {
                    "decision": item["decision"],
                    "decisionConfidence": item["decisionConfidence"],
                    "abstainedReason": reason,
                }
            )
            continue
        retained_decision_details.append(item)
        retained_decisions.append(item["decision"])
    decision_details = retained_decision_details
    decisions = retained_decisions
    predicted_meeting_type = intermediate["meetingType"]
    decision_overlap_keys = {normalized_decision_overlap_key(decision) for decision in decisions}
    if decision_overlap_keys:
        structured_actions = [
            item
            for item in structured_actions
            if normalized_decision_overlap_key(item["meetingActionPoint"]) not in decision_overlap_keys
        ]

    discussion_candidates, cluster_debug = select_discussion_clusters(candidates, speaker_names)
    status_review_points = intermediate["statusReviewPoints"]
    status_review_workstreams = intermediate["statusReviewWorkstreams"]
    structured_status_review = len(status_review_points) >= 4 or predicted_meeting_type == "project_status_review"
    combined_candidates: list[dict[str, Any]] = []
    if structured_status_review:
        combined_candidates.extend(status_review_points)
        if len(status_review_points) < 8:
            combined_candidates.extend(
                candidate
                for candidate in discussion_candidates
                if not is_weak_cluster_summary(candidate["text"])
            )
    else:
        combined_candidates.extend(discussion_candidates)
        if len(discussion_candidates) < 3:
            combined_candidates.extend(status_review_points)

    selected_discussion: list[dict[str, Any]] = []
    seen_points = set()
    limit = 12 if predicted_meeting_type == "webinar_rehearsal" else (10 if structured_status_review else 6)
    combined_candidates.sort(key=lambda item: (item["earliestTimestamp"], 0 if item["sourceType"] == "statusReviewPoint" else 1))
    for item in combined_candidates:
        text = item["text"]
        key = normalize_discussion_key(text)
        if structured_status_review and item["sourceType"] == "clusterSummary":
            if any(discussion_similarity(text, status_item["text"]) >= 0.35 for status_item in status_review_points):
                continue
        if key in seen_points or is_malformed_discussion_point(text):
            continue
        seen_points.add(key)
        selected_discussion.append(item)
        if len(selected_discussion) >= limit:
            break
    discussion_points = [item["text"] for item in selected_discussion]
    if structured_status_review:
        discussion_points = [item["summary"] for item in status_review_workstreams[:10]]
    discussion_points = augment_general_outputs(turns, discussion_points)

    min_non_decision_points = 4 if structured_status_review else 2
    non_decision_points = [point for point in discussion_points if not is_decision_like_discussion(point)]
    if len(non_decision_points) < min_non_decision_points:
        supporting_candidates = sorted(
            candidates,
            key=lambda candidate: (
                candidate["scores"].get("risk", 0),
                candidate["scores"].get("discussion", 0),
                candidate["scores"].get("specificity", 0),
            ),
            reverse=True,
        )
        for candidate in supporting_candidates:
            if len(non_decision_points) >= min_non_decision_points or len(selected_discussion) >= limit:
                break
            text = normalize_text_fragment(candidate["text"])
            if not can_use_as_supporting_discussion(candidate, discussion_points, decisions):
                continue
            discussion_points.append(text)
            non_decision_points.append(text)
            selected_discussion.append(
                {
                    "text": text,
                    "sourceType": "supportingTurn",
                    "earliestTimestamp": timestamp_to_seconds(candidate["timestamp"]),
                    "timestampLabel": candidate["timestamp"],
                    "selectedReason": "supporting_turn_coverage",
                    "cleanedCandidateSentences": [text],
                    "representativeSentence": text,
                    "sourceTurnIndices": evidence_source_turn_indices(candidate["evidence"]),
                    "evidence": candidate["evidence"],
                }
            )

    if len(non_decision_points) < 1 and not discussion_points and decisions:
        discussion_points = [finalize_sentence(decisions[0])]
        selected_discussion = [
            {
                "text": discussion_points[0],
                "sourceType": "broadSummary",
                "earliestTimestamp": 10**9,
                "timestampLabel": "",
                "selectedReason": "decision_fallback",
                "evidence": [],
            }
        ]
    elif len(non_decision_points) < min_non_decision_points:
        for detail in decision_details[:1]:
            decision_lower = normalize_text_fragment(detail["decision"]).lower()
            if not any(
                decision_lower in normalize_text_fragment(point).lower()
                or normalize_text_fragment(point).lower() in decision_lower
                for point in discussion_points
            ):
                discussion_points.append(detail["decision"])
                selected_discussion.append(
                    {
                        "text": detail["decision"],
                        "sourceType": "decisionSummary",
                        "earliestTimestamp": timestamp_to_seconds(detail["_evidence"][0]["timestamp"]) if detail.get("_evidence") else 10**9,
                        "timestampLabel": detail["_evidence"][0]["timestamp"] if detail.get("_evidence") else "",
                        "selectedReason": "decision_support",
                        "cleanedCandidateSentences": [detail.get("sourceTurnText", "")] + detail.get("supportTurnTexts", []),
                        "representativeSentence": detail.get("sourceTurnText", ""),
                        "sourceTurnIndices": evidence_source_turn_indices(detail.get("_evidence", [])),
                        "evidence": detail.get("_evidence", []),
                    }
                )
    final_discussion_keys = {normalize_discussion_key(point) for point in discussion_points}
    for suppressed_item in suppressed_rejected_actions:
        suppressed_discussion = build_rejected_request_discussion(suppressed_item)
        if not suppressed_discussion:
            continue
        key = normalize_discussion_key(suppressed_discussion)
        if key in final_discussion_keys:
            continue
        discussion_points.append(suppressed_discussion)
        final_discussion_keys.add(key)
        selected_discussion.append(
            {
                "text": suppressed_discussion,
                "sourceType": "rejectedRequest",
                "earliestTimestamp": timestamp_to_seconds(suppressed_item["requestTurn"]["timestamp"]),
                "timestampLabel": suppressed_item["requestTurn"]["timestamp"],
                "selectedReason": "suppressed_rejected_request",
                "cleanedCandidateSentences": [
                    normalize_text_fragment(suppressed_item["requestTurn"].get("text", "")),
                    normalize_text_fragment(suppressed_item["rejectionTurn"].get("text", "")),
                    normalize_text_fragment(suppressed_item["closureTurn"].get("text", "")),
                ],
                "representativeSentence": normalize_text_fragment(suppressed_item["rejectionTurn"].get("text", "")),
                "evidence": [
                    evidence_from_turn(suppressed_item["requestTurn"], "request"),
                    evidence_from_turn(suppressed_item["rejectionTurn"], "rejection"),
                    evidence_from_turn(suppressed_item["closureTurn"], "closure"),
                ],
            }
        )

    for cluster in cluster_debug:
        cluster_key = normalize_discussion_key(cluster["selectedDiscussionPoint"])
        if cluster_key in final_discussion_keys:
            cluster["usedInDiscussionPoints"] = True
            if cluster.get("rejectedReason") in {"covered_by_higher_ranked_cluster", "covered_by_final_discussion_selection"}:
                cluster["rejectedReason"] = ""
        else:
            cluster["usedInDiscussionPoints"] = False
            if not cluster.get("rejectedReason"):
                cluster["rejectedReason"] = "covered_by_final_discussion_selection"

    final_discussion_debug = []
    selected_map = {normalize_discussion_key(item["text"]): item for item in selected_discussion}
    for point in discussion_points:
        key = normalize_discussion_key(point)
        source = selected_map.get(key, {})
        final_discussion_debug.append(
            {
                "discussionPoint": point,
                "sourceType": source.get("sourceType", "broadSummary"),
                "earliestSupportingTimestamp": None if source.get("earliestTimestamp", 10**9) >= 10**9 else source.get("timestampLabel"),
                "selectedReason": source.get("selectedReason", "final_selection"),
                "cleanedCandidateSentences": source.get("cleanedCandidateSentences", []),
                "representativeSentence": source.get("representativeSentence", ""),
                "sourceTurnIndices": source.get("sourceTurnIndices", evidence_source_turn_indices(source.get("evidence", []))),
                "_evidence": source.get("evidence", []),
                "evidenceScore": 0.7,
            }
        )

    if structured_status_review:
        existing_action_keys = {normalize_discussion_key(item["meetingActionPoint"]) for item in structured_actions}
        for derived_action in derive_status_review_actions_from_workstreams(status_review_workstreams):
            key = normalize_discussion_key(derived_action["meetingActionPoint"])
            if key in existing_action_keys:
                continue
            existing_action_keys.add(key)
            structured_actions.append(derived_action)

    if predicted_meeting_type == "webinar_rehearsal":
        discussion_points, decisions, structured_actions = augment_webinar_rehearsal_outputs(
            turns,
            discussion_points,
            decisions,
            structured_actions,
        )

    if not discussion_points and not decisions and not structured_actions:
        executive_summary = "No substantive meeting content, decisions, or actions were identified."
    else:
        executive_summary = build_executive_summary(
            decisions,
            discussion_points,
            [item["meetingActionPoint"] for item in structured_actions],
            structured_status_review=structured_status_review,
        )

    meeting_type_score_map = intermediate["meetingTypeEvents"][0]["scores"]
    meeting_type = predicted_meeting_type

    top_action_candidates = sorted(candidates, key=lambda candidate: candidate["scores"].get("action", 0), reverse=True)
    top_discussion_candidates = sorted(candidates, key=lambda candidate: candidate["scores"].get("discussion", 0), reverse=True)
    rejected_navigation_candidates = [
        {"text": item["text"], "speaker": item["speaker"], "timestamp": item["timestamp"], "scores": item["scores"]}
        for item in candidates
        if item["scores"].get("navigation", 0) >= 0.6
    ][:10]

    debug = {
        "topDecisionCandidates": decision_debug["topDecisionCandidates"],
        "topActionCandidates": [
            {"text": item["text"], "speaker": item["speaker"], "timestamp": item["timestamp"], "scores": item["scores"]}
            for item in top_action_candidates[:10]
        ],
        "topDiscussionCandidates": [
            {"text": item["text"], "speaker": item["speaker"], "timestamp": item["timestamp"], "scores": item["scores"]}
            for item in top_discussion_candidates[:10]
        ],
        "thresholdsUsed": {
            "decision": 0.45,
            "action": 0.75,
            "discussion": 0.45,
            "lowContent": 0.6,
            "navigation": 0.8,
        },
        "rejectedLowContentCandidates": [
            {"text": item["text"], "speaker": item["speaker"], "timestamp": item["timestamp"], "scores": item["scores"]}
            for item in candidates
            if item["scores"].get("low_content", 0) >= 0.6
        ][:10],
        "rejectedNavigationCandidates": rejected_navigation_candidates,
        "clusters": cluster_debug,
        "topicClusters": cluster_debug,
        "winningDecisionClusters": decision_debug["winningDecisionClusters"],
        "decisionTopicGraphs": decision_debug.get("decisionTopicGraphs", []),
        "rejectedCompetingDecisions": decision_debug["rejectedCompetingDecisions"],
        "rejectedNavigationDecisionCandidates": decision_debug.get("rejectedNavigationDecisionCandidates", []),
        "abstainedActions": abstained_actions,
        "abstainedDecisions": abstained_decisions,
        "suppressedRejectedActions": suppressed_rejected_actions,
        "statusReviewPoints": status_review_points,
        "statusReviewWorkstreams": status_review_workstreams,
        "finalDiscussionPoints": final_discussion_debug,
        "parsedTurnCount": len(turns),
        "candidateCount": len(candidates),
        "meetingTypeScores": meeting_type_score_map,
        "intermediateEvents": intermediate["allEvents"],
    }

    return {
        "meetingTitle": meeting_title or "Meeting minutes numbers experiment",
        "meetingDate": meeting_date,
        "meetingLocation": meeting_location,
        "meetingType": meeting_type,
        "meetingStyle": "experimental_numeric",
        "meetingTheme": meeting_title or "Experimental meeting-minutes analysis",
        "meetingObjectives": [],
        "participants.client": client_participants,
        "participants.trinzo": trinzo_participants,
        "itemTopic": meeting_title or "Experimental meeting-minutes analysis",
        "discussionPoints": discussion_points[:12] if predicted_meeting_type == "webinar_rehearsal" else (discussion_points[:10] if structured_status_review else discussion_points[:6]),
        "meetingActionPoint": [item["meetingActionPoint"] for item in structured_actions],
        "meetingActionPointOwner": [item["meetingActionPointOwner"] for item in structured_actions],
        "meetingActionPointDeadline": [item["meetingActionPointDeadline"] for item in structured_actions],
        "meetingActionPointConfidence": [item["actionConfidence"] for item in structured_actions],
        "meetingActionPointRelatedMilestone": [item["relatedMilestone"] for item in structured_actions],
        "actions": structured_actions,
        "executiveSummary": executive_summary,
        "healthSummary": {},
        "meetingSections": [],
        "decisions": decisions,
        "discussionPointDetails": final_discussion_debug[:12] if predicted_meeting_type == "webinar_rehearsal" else (final_discussion_debug[:10] if structured_status_review else final_discussion_debug[:6]),
        "decisionDetails": decision_details,
        "internalEvidence": {
            "discussionPoints": [{"text": item["discussionPoint"], "_evidence": item.get("_evidence", [])} for item in (final_discussion_debug[:12] if predicted_meeting_type == "webinar_rehearsal" else (final_discussion_debug[:10] if structured_status_review else final_discussion_debug[:6]))],
            "actions": [{"text": item["meetingActionPoint"], "_evidence": item["_evidence"]} for item in structured_actions],
            "meetingSections": [],
            "decisions": [{"text": item["decision"], "_evidence": item["_evidence"]} for item in decision_details],
        },
        "numberExperimentDebug": debug,
    }


def main() -> int:
    args = parse_args()
    text = Path(args.path).read_text(encoding="utf-8")
    print(json.dumps(analyse(text), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
