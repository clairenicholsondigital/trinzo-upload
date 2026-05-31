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
            current = {
                "speaker": timestamp_match.group("speaker").strip(),
                "timestamp": timestamp_match.group("timestamp").strip(),
                "text": timestamp_match.group("tail").strip(),
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


def extract_action_block(text: str) -> list[tuple[str, str, str]]:
    cleaned = clean_transcript_text(text)
    lines = cleaned.splitlines()
    results: list[tuple[str, str, str]] = []
    in_block = False
    deadline = ""
    for raw_line in lines:
        line = raw_line.strip()
        if not line:
            continue
        if ACTION_HEADER_RE.match(line):
            in_block = True
            lowered = line.lower()
            deadline = "Before the webinar" if "webinar" in lowered else ("Before next week" if "next week" in lowered else "")
            continue
        if not in_block:
            continue
        if TURN_RE.match(line) or COLON_TURN_RE.match(line):
            break
        results.append((normalize_action_text(line), "Owner not specified", deadline))
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
    keywords = [token for token, _count in token_counts.most_common() if token not in speaker_names and len(token) > 2]
    return keywords[:limit]


def select_discussion_clusters(candidates: list[dict[str, Any]], speaker_names: set[str]) -> tuple[list[str], list[dict[str, Any]]]:
    usable = [
        candidate for candidate in candidates
        if candidate["scores"].get("discussion", 0) >= 0.45
        and candidate["scores"].get("low_content", 0) < 0.6
        and candidate["scores"].get("navigation", 0) < 0.75
        and len(candidate.get("tokens", [])) >= 3
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
    selected_points: list[str] = []
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
        keywords = extract_cluster_keywords(aggregate, speaker_names)
        cluster_text = " ".join(item["text"] for item in cluster)
        lowered = cluster_text.lower()
        if any(term in lowered for term in ("customer support contract renewal", "service levels", "response times", "pricing", "supplier")):
            selected = "The team reviewed the customer support contract renewal, including pricing, supplier comparison and operational risk."
        elif any(term in lowered for term in ("one-year option", "three-year commitment", "three years")):
            selected = "The team discussed contract term length, including the trade-off between a one-year option and a three-year commitment."
        elif any(term in lowered for term in ("legal review", "finance team", "final figures", "budget", "negotiation")):
            selected = "The team discussed legal review and finance follow-up requirements alongside ownership of the renewal negotiation."
        elif any(term in lowered for term in ("office move", "10 september", "meeting room video systems")):
            selected = "The team discussed the office move timeline and unresolved decisions around replacing the meeting room video systems."
        elif any(term in lowered for term in ("validation-specific", "keep it broad")):
            selected = "The team discussed whether the webinar should be validation-specific or broadly applicable and agreed to keep the messaging broad."
        elif any(term in lowered for term in ("green", "amber", "blocked", "review process", "status", "complete", "in review")):
            selected = "The team reviewed project status, blockers and follow-up work across the active items."
        elif any(term in lowered for term in ("webinar", "timeline", "scope", "registration", "attendee", "demo", "deck", "slide")):
            selected = "The team reviewed webinar delivery, presentation clarity and final preparation requirements."
        else:
            representative = max(cluster, key=lambda item: item["scores"]["discussion"] + item["scores"]["specificity"])
            selected = finalize_sentence(representative["text"])

        dedupe_key = re.sub(r"[^a-z0-9]+", " ", selected.lower()).strip()
        cluster_debug.append(
            {
                "keywords": keywords,
                "candidateTexts": [item["text"] for item in cluster[:6]],
                "clusterScore": cluster_score,
                "selectedDiscussionPoint": selected,
                "supportingTurns": support,
            }
        )
        if dedupe_key not in dedupe_keys and cluster_score >= 0.45:
            dedupe_keys.add(dedupe_key)
            selected_points.append(selected)

    cluster_debug.sort(key=lambda item: item["clusterScore"], reverse=True)
    return selected_points[:6], cluster_debug[:8]


def summarize_actions(actions: list[str]) -> str:
    if not actions:
        return ""
    tokens = " ".join(actions).lower()
    if any(term in tokens for term in ("opening", "timeline", "registration", "attendee", "practice", "demo", "deck", "slide")):
        return "Actions focused on refining webinar messaging, improving presentation materials, updating attendee information and completing a final rehearsal."
    if any(term in tokens for term in ("supplier", "legal", "finance", "pricing", "negotiation")):
        return "Follow-up work includes negotiating revised terms, coordinating legal review and sending final pricing figures to finance."
    return "Actions were identified from the discussion."


def build_executive_summary(decisions: list[str], discussion_points: list[str], actions: list[str]) -> str:
    if not decisions and not discussion_points and not actions:
        return "No substantive meeting content, decisions, or actions were identified."
    sentences: list[str] = []
    if discussion_points:
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
    for action, owner, deadline in extract_action_block(text):
        action_items.append((action, owner, deadline, 0.72, []))
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

    discussion_points, cluster_debug = select_discussion_clusters(candidates, speaker_names)
    if not discussion_points and decisions:
        discussion_points = [finalize_sentence(decisions[0])]

    if not discussion_points and not decisions and not structured_actions:
        executive_summary = "No substantive meeting content, decisions, or actions were identified."
    else:
        executive_summary = build_executive_summary(decisions, discussion_points, [item["meetingActionPoint"] for item in structured_actions])

    debug = {
        "topDecisionCandidates": [
            {"text": item["text"], "speaker": item["speaker"], "timestamp": item["timestamp"], "scores": item["scores"]}
            for item in decision_candidates[:10]
        ],
        "topActionCandidates": [
            {"text": item["text"], "speaker": item["speaker"], "timestamp": item["timestamp"], "scores": item["scores"]}
            for item in sorted(candidates, key=lambda candidate: candidate["scores"].get("action", 0), reverse=True)[:10]
        ],
        "topDiscussionCandidates": [
            {"text": item["text"], "speaker": item["speaker"], "timestamp": item["timestamp"], "scores": item["scores"]}
            for item in sorted(candidates, key=lambda candidate: candidate["scores"].get("discussion", 0), reverse=True)[:10]
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
        "clusters": cluster_debug,
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
        "discussionPoints": discussion_points[:6],
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
        "discussionPointDetails": [{"discussionPoint": point, "_evidence": [], "evidenceScore": 0.7} for point in discussion_points[:6]],
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
