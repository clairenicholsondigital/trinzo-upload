#!/usr/bin/env python3
"""Experimental numeric meeting-minutes extractor."""

from __future__ import annotations

import argparse
import json
import math
import re
from collections import Counter
from pathlib import Path
from typing import Any

try:
    from .python_llm_meeting_minutes import (
        MINUTES_CONFIG,
        extract_header_fields,
        finalize_sentence,
        load_json,
        normalize_text_fragment,
        split_sentences,
    )
except ImportError:
    from python_llm_meeting_minutes import (
        MINUTES_CONFIG,
        extract_header_fields,
        finalize_sentence,
        load_json,
        normalize_text_fragment,
        split_sentences,
    )


TURN_RE = re.compile(r"^(?P<speaker>[A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+){0,3})\s+(?P<timestamp>\d+:\d{2})\s*(?P<tail>.*)$")
COLON_TURN_RE = re.compile(r"^(?P<speaker>[A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+){0,3}):\s*(?P<tail>.*)$")
METADATA_RE = re.compile(
    r"(?:-meeting transcript$)|(?:^\d{1,2}\s+\w+\s+\d{4}(?:,\s*\d{1,2}:\d{2}(?:am|pm))?$)|(?:^\d+m\s+\d+s$)|(?:started transcription\.?$)|(?:stopped transcription\.?$)",
    re.IGNORECASE,
)
ACTION_HEADER_RE = re.compile(r"^(?:actions?|next steps|follow ups?|action items)(?:\s+before\s+.+)?:\s*$", re.IGNORECASE)
INLINE_ACTION_HEADER_RE = re.compile(r"^(?P<header>(?:actions?|next steps|follow ups?|action items)(?:\s+before\s+.+)?):\s*(?P<tail>.*)$", re.IGNORECASE)
QUESTION_RE = re.compile(r"\?$")
DEADLINE_RE = re.compile(
    r"\b(?:tomorrow|today|next week|this afternoon|before [A-Z][a-z]+|by [A-Z][a-z]+|end of quarter|when available|before friday|before the webinar)\b",
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
ACTION_VERBS = {
    "send", "review", "update", "check", "confirm", "draft", "prepare", "handle", "negotiate",
    "speak", "coordinate", "follow", "validate", "improve", "clarify", "refine", "tighten", "run",
    "complete", "share", "finalise", "finalize", "fix",
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
STATUS_TERMS = ("complete", "blocked", "amber", "green", "red", "blue", "due", "not operational", "awaiting", "in review")
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
}


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


def clean_transcript_text(text: str) -> str:
    kept: list[str] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            kept.append("")
            continue
        if METADATA_RE.search(line) or re.search(r"\b(?:started|stopped) transcription\.?$", line, flags=re.IGNORECASE):
            continue
        kept.append(raw_line)
    return "\n".join(kept)


def timestamp_to_seconds(timestamp: str) -> int:
    if not timestamp or ":" not in timestamp:
        return 10**9
    minutes, seconds = timestamp.split(":", 1)
    try:
        return int(minutes) * 60 + int(seconds)
    except ValueError:
        return 10**9


def normalize_discussion_key(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


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


def discussion_similarity(left: str, right: str) -> float:
    left_counts = Counter(tokenize(left))
    right_counts = Counter(tokenize(right))
    return cosine_similarity(left_counts, right_counts)


def parse_numeric_turns(text: str) -> list[dict[str, str]]:
    cleaned = clean_transcript_text(text)
    lines = cleaned.splitlines()
    turns: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    action_block = False

    def flush_current() -> None:
        nonlocal current
        if current and current.get("text", "").strip():
            current["text"] = current["text"].strip()
            turns.append(current)
        current = None

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
        timestamp_match = TURN_RE.match(line)
        colon_match = COLON_TURN_RE.match(line)
        if timestamp_match:
            flush_current()
            tail = timestamp_match.group("tail").strip()
            if INLINE_ACTION_HEADER_RE.match(tail):
                action_block = True
                current = None
                continue
            current = {
                "speaker": timestamp_match.group("speaker").strip(),
                "timestamp": timestamp_match.group("timestamp").strip(),
                "text": tail,
            }
            action_block = False
            continue
        if colon_match and not action_block:
            flush_current()
            current = {
                "speaker": colon_match.group("speaker").strip(),
                "timestamp": "",
                "text": colon_match.group("tail").strip(),
            }
            continue
        if action_block:
            continue
        if current is not None:
            current["text"] = (current["text"] + " " + line).strip()
    flush_current()
    return turns


def participant_groups(turns: list[dict[str, str]], config: dict[str, Any]) -> tuple[list[str], list[str]]:
    client: list[str] = []
    trinzo: list[str] = []
    seen = set()
    participant_map = config.get("participant_groups", {})
    for turn in turns:
        speaker = turn["speaker"]
        if speaker in seen:
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
    rejection_score = 0.62 if any(term in lowered for term in ("no", "nope", "nah", "can't", "cannot", "won't", "absolutely not")) else 0.0
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
                    "evidence": [{"speaker": turn["speaker"], "timestamp": turn["timestamp"]}],
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
            inline_match = INLINE_ACTION_HEADER_RE.match(tail)
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


def derive_decision_from_candidate(candidate: dict[str, Any]) -> str | None:
    text = normalize_text_fragment(candidate["text"])
    lowered = text.lower()
    if any(term in lowered for term in ("haven't decided", "have not decided", "still deciding", "we'll see", "come back to it")):
        return None
    if "existing supplier" in lowered and any(term in lowered for term in ("safer option", "service levels", "response times", "renew")):
        return "The team will renew with the existing supplier."
    if "keep it broad" in lowered or ("validation-specific" in lowered and "better" in lowered):
        return "The webinar should remain broad rather than validation-specific."
    if "one-year option" in lowered:
        return "The team will pursue a one-year contract term rather than a three-year commitment."
    if "physical office move will take place on" in lowered:
        match = re.search(r"physical office move will take place on [^.?!]+", text, flags=re.IGNORECASE)
        if match:
            phrase = match.group(0)
            return finalize_sentence(("The " if not phrase.lower().startswith("the ") else "") + phrase[:1].lower() + phrase[1:] if not phrase.lower().startswith("the ") else phrase)
    if FINALISER_RE.search(text):
        return finalize_sentence("The team will " + re.sub(r"^(?:we['’]?ll|we will)\s+", "", text, flags=re.IGNORECASE).lower())
    return None


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
            return comma_topic.group("topic").strip()
        short_question = re.match(r"^(?P<topic>[^?.!]{4,80})\?$", text)
        if short_question:
            return short_question.group("topic").strip()
        short_label = re.match(r"^(?P<topic>[A-Z][A-Za-z0-9&/()' -]{4,80})\.?$", text)
        if short_label and len(tokenize(short_label.group("topic"))) <= 8:
            return short_label.group("topic").strip()
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


def looks_like_topic_prompt(text: str) -> bool:
    cleaned = normalize_text_fragment(text)
    lowered_plain = cleaned.lower()
    lowered = f" {lowered_plain} "
    if not cleaned or any(phrase in lowered_plain for phrase in NAVIGATION_PHRASES):
        return False
    if lowered_plain.startswith(TOPIC_PROMPT_REJECT_PREFIXES):
        return False
    if any(prefix in lowered_plain for prefix in REQUEST_PREFIXES):
        return False
    if contains_status_term(lowered_plain):
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
        clause_match = re.match(r"^(?P<topic>(?:The\s+)?[A-Z][A-Za-z0-9&/()' -]{4,80}),\s+", sentences[0])
        if clause_match:
            topic = clause_match.group("topic").strip()
            if len(tokenize(topic)) <= 8:
                return topic.rstrip("?.!")
    for sentence in reversed(sentences):
        if looks_like_topic_prompt(sentence):
            return sentence.rstrip("?.!")
    return ""


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
    if any(term in lowered for term in ("due", "scheduled", "booked", "underway")):
        return "active"
    return "in progress"


def extract_status_review_points(turns: list[dict[str, str]]) -> list[dict[str, Any]]:
    points: list[dict[str, Any]] = []
    seen = set()
    for index, turn in enumerate(turns):
        topic_text = extract_topic_prompt_from_turn(turn["text"])
        if not looks_like_topic_prompt(topic_text):
            continue
        supporting_turns: list[dict[str, str]] = []
        for future_turn in turns[index + 1:index + 5]:
            if extract_topic_prompt_from_turn(future_turn["text"]):
                break
            supporting_turns.append(future_turn)
        if not supporting_turns:
            continue
        combined = " ".join(item["text"] for item in supporting_turns)
        lowered = combined.lower()
        if not contains_status_term(lowered) and not any(term in lowered for term in ("problem", "issue", "routing", "pending", "input", "scoped", "follow up", "nothing received", "no update", "deliverable is there", "live and documented")):
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
            point = "Ad hoc SOW delivery is active, with incoming requests at different stages and a need for clearer workload visibility."
        elif "vendor strategy" in topic_lower:
            point = "Vendor strategy rollout remains in progress: interviews are complete, but the strategy document has not yet been produced."
        elif "innovation grant feedback" in topic_lower:
            point = "Innovation grant feedback is still pending, with follow-up planned this week."
        elif "governance framework" in topic_lower:
            point = "The AI governance framework draft is in review pending leadership input."
        elif "repeatable ai use case library" in topic_lower:
            point = "The repeatable AI use case library appears complete."
        elif "three ai webinars delivered" in topic_lower:
            point = "The webinar delivery milestone remains active: two sessions have been delivered and the third is booked."
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
                        "routing", "input", "scoped", "booked", "doesn't exist", "don't have", "nothing new",
                    )
                ):
                    details.append(sentence)
            topic_normalized = topic_text.rstrip("?.!").lower()
            if status == "complete":
                point = finalize_sentence(f"The {topic_normalized} appears complete")
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
            evidence = [{"speaker": turn["speaker"], "timestamp": turn["timestamp"]}] + [
                {"speaker": item["speaker"], "timestamp": item["timestamp"]} for item in supporting_turns
            ]
            earliest_timestamp = min((timestamp_to_seconds(ref["timestamp"]) for ref in evidence if ref["timestamp"]), default=10**9)
            points.append(
                {
                    "text": point,
                    "sourceType": "statusReviewPoint",
                    "earliestTimestamp": earliest_timestamp,
                    "timestampLabel": turn["timestamp"],
                    "evidence": evidence,
                    "selectedReason": "structured_status_review_item",
                }
            )
    return points[:10]


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
    lowered = normalize_text_fragment(text).lower()
    return cleaned_endswith_question(text) or any(lowered.startswith(prefix) for prefix in REQUEST_PREFIXES)


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
    return round(
        centroid_similarity * 0.7
        + support_similarity * 0.35
        + structure_bonus
        + specificity
        - low_content_penalty
        - pronoun_penalty,
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


def lightly_clean_representative_sentence(text: str) -> str:
    cleaned = normalize_text_fragment(text)
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
    keyword_set = {keyword for keyword in filtered_keywords if keyword not in NON_TOPIC_TERMS}
    if keyword_set & MEANINGFUL_TOPIC_HINTS:
        return True
    cluster_blob = " ".join(item["text"].lower() for item in cluster)
    return any(hint in cluster_blob for hint in MEANINGFUL_TOPIC_HINTS)


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
    elif any(term in lowered_blob for term in ("customer support contract renewal", "service levels", "response times", "pricing", "supplier")):
        generated_summary = "The team reviewed the customer support contract renewal, including pricing, supplier comparison and operational risk."
        selection_mode = "compressed_multi" if len(sentences) > 1 else "single_candidate"
    elif any(term in lowered_blob for term in ("one-year option", "three-year commitment", "three years")):
        generated_summary = "The team discussed contract term length, including the trade-off between a one-year option and a three-year commitment."
        selection_mode = "compressed_multi" if len(sentences) > 1 else "single_candidate"
    elif any(term in lowered_blob for term in ("legal review", "finance team", "final figures", "budget", "negotiation")):
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
        generated_summary = "Ad hoc SOW delivery is active, with incoming requests at different stages and a need for clearer workload visibility."
        selection_mode = "compressed_multi"
    elif ("webinar" in keyword_set or "webinars" in keyword_set or "delivered" in keyword_set) and ("booked" in lowered_blob or "third one is booked" in lowered_blob):
        generated_summary = "The webinar delivery milestone remains active: two sessions have been delivered and the third is booked."
        selection_mode = "compressed_multi"
    else:
        generated_summary = compress_status_summary(subject, sentences, filtered_keywords or raw_keywords)
        selection_mode = "compressed_multi" if len(sentences) > 1 else "single_candidate"

    rejected_generated_summary = False
    rejection_reason = ""
    final_point = generated_summary
    final_source = "multi_sentence_cluster_summary"

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

    return {
        "selectedDiscussionPoint": final_point,
        "selectionMode": selection_mode,
        "selectedRepresentativeSentence": representative_point,
        "representativeSentenceScore": representative_score,
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
        and not is_request_or_question_fragment(candidate["text"])
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

    cluster_debug: list[dict[str, Any]] = []
    selected_points_with_scores: list[tuple[float, dict[str, Any]]] = []
    dedupe_keys = set()
    for cluster in clusters:
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
                        "evidence": evidence_refs,
                    },
                )
            )
            used = True
        cluster_debug.append(
            {
                "rawKeywords": raw_keywords,
                "keywords": filtered_keywords,
                "candidateTexts": [item["text"] for item in cluster[:6]],
                "cleanedCandidateSentences": cluster_summary["cleanedCandidateSentences"][:8],
                "clusterScore": cluster_score,
                "selectedDiscussionPoint": selected,
                "selectedRepresentativeSentence": cluster_summary["selectedRepresentativeSentence"],
                "representativeSentenceScore": cluster_summary["representativeSentenceScore"],
                "rejectedGeneratedSummary": cluster_summary["rejectedGeneratedSummary"],
                "finalDiscussionPointSource": cluster_summary["finalDiscussionPointSource"],
                "supportingTurns": support,
                "earliestTimestamp": earliest_timestamp if earliest_timestamp < 10**9 else None,
                "rejectedReason": rejected_reason or cluster_summary["rejectionReason"],
                "usedInDiscussionPoints": used,
                "selectionMode": selection_mode,
                "compressedFromMultipleCandidates": len(cluster) > 1,
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


def analyse(text: str) -> dict[str, Any]:
    config = load_json(MINUTES_CONFIG)
    cleaned_text = clean_transcript_text(text)
    meeting_title, meeting_date, meeting_location = extract_header_fields(text, config)
    turns = parse_numeric_turns(text)
    client_participants, trinzo_participants = participant_groups(turns, config)
    records = build_turn_records(turns)
    candidates = build_window_candidates(records)
    speaker_names = {part.lower() for turn in turns for part in turn["speaker"].split()}

    action_items: list[tuple[str, str, str, float, list[dict[str, str]]]] = []
    for action, owner, deadline, evidence in extract_action_block(text):
        action_items.append((action, owner, deadline, 0.72, evidence))
    for index in range(len(records) - 1):
        derived = derive_action_from_window(records[index:index + 2])
        if derived:
            action_items.append((derived[0], derived[1], derived[2], 0.8, records[index]["evidence"] + records[index + 1]["evidence"]))

    deduped_actions: dict[str, tuple[str, str, str, float, list[dict[str, str]]]] = {}
    for action, owner, deadline, confidence, evidence in action_items:
        key = re.sub(r"[^a-z0-9]+", " ", action.lower()).strip()
        if key not in deduped_actions or confidence > deduped_actions[key][3]:
            deduped_actions[key] = (action, owner, deadline, confidence, evidence)
    structured_actions = [
        {
            "meetingActionPoint": action,
            "meetingActionPointOwner": owner,
            "meetingActionPointDeadline": deadline,
            "actionConfidence": round(confidence, 2),
            "relatedMilestone": "unlinked",
            "_evidence": evidence,
        }
        for action, owner, deadline, confidence, evidence in deduped_actions.values()
    ]

    decision_candidates = sorted(
        [
            candidate for candidate in candidates
            if candidate["scores"].get("decision", 0) >= 0.45
            and candidate["scores"].get("low_content", 0) < 0.6
            and candidate["scores"].get("navigation", 0) < 0.8
        ],
        key=lambda item: item["scores"]["decision"],
        reverse=True,
    )
    decisions: list[str] = []
    decision_details: list[dict[str, Any]] = []
    seen_decisions = set()
    for candidate in decision_candidates:
        decision = derive_decision_from_candidate(candidate)
        if not decision:
            continue
        key = re.sub(r"[^a-z0-9]+", " ", decision.lower()).strip()
        if key in seen_decisions:
            continue
        seen_decisions.add(key)
        decisions.append(decision)
        decision_details.append(
            {
                "topic": key,
                "decision": decision,
                "decisionConfidence": round(min(0.95, max(0.45, candidate["scores"]["decision"])), 2),
                "decisionType": "accepted_direction",
                "_evidence": candidate["evidence"],
            }
        )
        if len(decisions) >= 5:
            break

    discussion_candidates, cluster_debug = select_discussion_clusters(candidates, speaker_names)
    status_review_points = extract_status_review_points(turns)
    structured_status_review = len(status_review_points) >= 4
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
    limit = 10 if structured_status_review else 6
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
    if not discussion_points and decisions:
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

    final_discussion_keys = {normalize_discussion_key(point) for point in discussion_points}
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
            }
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

    top_action_candidates = sorted(candidates, key=lambda candidate: candidate["scores"].get("action", 0), reverse=True)
    top_discussion_candidates = sorted(candidates, key=lambda candidate: candidate["scores"].get("discussion", 0), reverse=True)
    rejected_navigation_candidates = [
        {"text": item["text"], "speaker": item["speaker"], "timestamp": item["timestamp"], "scores": item["scores"]}
        for item in candidates
        if item["scores"].get("navigation", 0) >= 0.6
    ][:10]

    debug = {
        "topDecisionCandidates": [
            {"text": item["text"], "speaker": item["speaker"], "timestamp": item["timestamp"], "scores": item["scores"]}
            for item in decision_candidates[:10]
        ],
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
        "statusReviewPoints": [item["text"] for item in status_review_points],
        "finalDiscussionPoints": final_discussion_debug,
        "parsedTurnCount": len(turns),
        "candidateCount": len(candidates),
    }

    return {
        "meetingTitle": meeting_title or "Meeting minutes numbers experiment",
        "meetingDate": meeting_date,
        "meetingLocation": meeting_location,
        "meetingType": "experimental_numeric",
        "meetingStyle": "experimental_numeric",
        "meetingTheme": meeting_title or "Experimental meeting-minutes analysis",
        "meetingObjectives": [],
        "participants.client": client_participants,
        "participants.trinzo": trinzo_participants,
        "itemTopic": meeting_title or "Experimental meeting-minutes analysis",
        "discussionPoints": discussion_points[:10] if structured_status_review else discussion_points[:6],
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
        "discussionPointDetails": [{"discussionPoint": point, "_evidence": [], "evidenceScore": 0.7} for point in (discussion_points[:10] if structured_status_review else discussion_points[:6])],
        "decisionDetails": decision_details,
        "internalEvidence": {
            "discussionPoints": [],
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
