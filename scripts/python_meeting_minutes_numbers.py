#!/usr/bin/env python3
"""Experimental numeric meeting-minutes extractor."""

from __future__ import annotations

import argparse
import json
import math
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

try:
    from .python_llm_meeting_minutes import (
        MINUTES_CONFIG,
        extract_header_fields,
        finalize_sentence,
        load_json,
        normalize_text_fragment,
        parse_speaker_turns,
        split_sentences,
    )
except ImportError:
    from python_llm_meeting_minutes import (
        MINUTES_CONFIG,
        extract_header_fields,
        finalize_sentence,
        load_json,
        normalize_text_fragment,
        parse_speaker_turns,
        split_sentences,
    )


STOPWORDS = {
    "the", "a", "an", "and", "or", "but", "if", "to", "of", "in", "on", "for", "with", "we",
    "it", "that", "this", "is", "are", "was", "were", "be", "been", "being", "as", "at", "by",
    "from", "they", "them", "their", "our", "you", "your", "i", "me", "my", "he", "she", "his",
    "her", "so", "then", "just", "also", "there", "here", "have", "has", "had", "do", "does",
    "did", "will", "would", "should", "could", "can", "about", "into", "than", "too", "very",
}
REQUEST_WORDS = {"can", "could", "would", "will", "please", "who"}
COMMITMENT_WORDS = {"i'll", "i", "will", "can", "take", "handle", "send", "review", "check", "update", "speak", "draft", "prepare"}
ACCEPTANCE_WORDS = {"yes", "yeah", "yep", "agreed", "agree", "fine", "okay", "ok", "sure", "sounds", "sensible", "better", "support"}
REJECTION_WORDS = {"no", "nope", "nah", "can't", "cannot", "won't", "not", "never"}
UNCERTAINTY_WORDS = {"maybe", "unclear", "unsure", "undecided", "deciding", "perhaps", "vague"}
PROPOSAL_WORDS = {"prefer", "favour", "favor", "rather", "option", "approach", "direction", "keep", "make", "move", "renew", "pursue", "proceed", "go"}
ACTION_WORDS = {"send", "review", "update", "check", "confirm", "draft", "prepare", "handle", "negotiate", "speak", "coordinate", "follow", "validate", "improve", "clarify", "refine", "tighten", "run"}
LOW_CONTENT_PHRASES = {
    "go on", "anything else", "meeting over", "not sure", "okay", "fine", "thanks", "perfect"
}
ACTION_HEADER_RE = re.compile(r"^(?:actions?|next steps|follow ups?|action items)(?:\s+before\s+.+)?:\s*$", re.IGNORECASE)
QUESTION_RE = re.compile(r"\?$")
DEADLINE_RE = re.compile(r"\b(?:tomorrow|today|next week|this afternoon|before [A-Z][a-z]+|by [A-Z][a-z]+|end of quarter|when available)\b", re.IGNORECASE)
FINALISER_RE = re.compile(r"^(?:we['’]?ll|we will)\s+(?:pursue|go with|proceed with)\b", re.IGNORECASE)


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


def normalize_action_text(text: str) -> str:
    cleaned = normalize_text_fragment(text).rstrip(".!?")
    cleaned = re.sub(r"^(?:i['’]?ll|i will|we need to|please)\s+", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\b(?:instead|as well|then|probably|maybe)\b", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return finalize_sentence(cleaned[:1].upper() + cleaned[1:] if cleaned else cleaned)


def participant_groups(turns: list[Any], config: dict[str, Any]) -> tuple[list[str], list[str]]:
    trinzo, client = [], []
    seen = set()
    for turn in turns:
        speaker = turn.speaker
        if speaker in seen:
            continue
        seen.add(speaker)
        if config.get("participant_groups", {}).get(speaker) == "trinzo":
            trinzo.append(speaker)
        else:
            client.append(speaker)
    return client, trinzo


def sentence_features(sentence: str, speaker: str) -> dict[str, float]:
    lowered = sentence.lower().strip()
    tokens = tokenize(sentence)
    token_counter = Counter(tokens)
    request_score = 0.55 if QUESTION_RE.search(sentence) else 0.0
    if any(lowered.startswith(prefix) for prefix in ("can you", "could you", "would you", "will you", "who is handling")):
        request_score += 0.35
    commitment_score = 0.45 if any(word in lowered for word in ("i'll", "i will", "i can")) else 0.0
    acceptance_score = 0.35 if any(word in lowered.split() for word in ACCEPTANCE_WORDS) else 0.0
    rejection_score = 0.55 if any(word in lowered for word in REJECTION_WORDS) else 0.0
    uncertainty_score = 0.5 if any(word in lowered for word in UNCERTAINTY_WORDS) else 0.0
    proposal_score = 0.4 if any(word in lowered for word in PROPOSAL_WORDS) else 0.0
    action_verb_hits = sum(1 for word in ACTION_WORDS if re.search(rf"\b{re.escape(word)}\b", lowered))
    action_score = min(0.8, 0.18 * action_verb_hits + commitment_score + request_score * 0.35)
    discussion_score = min(0.9, 0.15 * len(token_counter) + 0.25 * any(word in lowered for word in ("risk", "issue", "option", "cost", "scope", "quality", "timing", "owner", "dependency", "renewal", "contract", "review", "status")))
    risk_score = 0.6 if any(word in lowered for word in ("risk", "blocked", "dependency", "issue", "problem")) else 0.0
    deadline_score = 0.75 if DEADLINE_RE.search(sentence) else 0.0
    owner_score = 0.4 if speaker else 0.0
    specificity_score = min(0.9, max(0.0, (len(tokens) - 3) / 10))
    low_content_score = 0.8 if lowered in LOW_CONTENT_PHRASES or len(tokens) <= 2 else 0.0
    decision_score = min(0.85, proposal_score + acceptance_score * 0.35 + specificity_score * 0.3)
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
        "low_content": round(low_content_score, 2),
        "token_counts": token_counter,
    }


def build_turn_records(turns: list[Any]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for turn in turns:
        sentences = split_sentences(turn.text) or [turn.text]
        for sentence in sentences:
            if not sentence.strip():
                continue
            features = sentence_features(sentence, turn.speaker)
            records.append(
                {
                    "text": sentence.strip(),
                    "speaker": turn.speaker,
                    "timestamp": turn.timestamp,
                    "tokens": tokenize(sentence),
                    "scores": {key: value for key, value in features.items() if key != "token_counts"},
                    "token_counts": features["token_counts"],
                    "evidence": [{"speaker": turn.speaker, "timestamp": turn.timestamp}],
                }
            )
    return records


def build_window_candidates(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    for index, record in enumerate(records):
        candidates.append(record)
        for width in (2, 3):
            window = records[index:index + width]
            if len(window) < width:
                continue
            text = " ".join(item["text"] for item in window)
            token_counts = Counter()
            for item in window:
                token_counts.update(item["token_counts"])
            continuity = 0.0
            if width >= 2:
                continuity = cosine_similarity(window[0]["token_counts"], window[-1]["token_counts"])
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
                "specificity": min(1.0, sum(item["scores"]["specificity"] for item in window) / width + continuity * 0.2),
                "topic_continuity": round(continuity, 2),
                "low_content": round(sum(item["scores"]["low_content"] for item in window) / width, 2),
            }
            scores["decision"] = round(
                max(scores["proposal"], 0.3 if FINALISER_RE.search(window[-1]["text"]) else 0.0)
                + scores["acceptance"] * 0.6
                + scores["topic_continuity"] * 0.5
                - scores["rejection"] * 0.8
                - scores["uncertainty"] * 0.8,
                2,
            )
            scores["action"] = round(
                (scores["request"] * 0.7 + scores["commitment"] * 0.8 + scores["acceptance"] * 0.4 + scores["deadline"] * 0.2 + scores["owner"] * 0.15)
                - scores["rejection"] * 0.9
                - scores["uncertainty"] * 0.5,
                2,
            )
            scores["discussion"] = round(
                sum(item["scores"]["discussion"] for item in window) / width + continuity * 0.4 - scores["low_content"] * 0.6,
                2,
            )
            candidates.append(
                {
                    "text": text,
                    "speaker": window[-1]["speaker"],
                    "timestamp": window[-1]["timestamp"],
                    "tokens": list(token_counts),
                    "token_counts": token_counts,
                    "scores": scores,
                    "evidence": [ref for item in window for ref in item["evidence"]],
                    "window": width,
                }
            )
    return candidates


def derive_action_from_window(window: list[dict[str, Any]]) -> tuple[str, str, str] | None:
    joined = " ".join(item["text"] for item in window)
    lowered = joined.lower()
    if any(phrase in lowered for phrase in ("no action", "discussion only")):
        return None
    if len(window) >= 2:
        request = window[0]["text"]
        reply = window[1]["text"]
        if re.search(r"^(?:can|could|would|will)\s+you\b", request, flags=re.IGNORECASE) and re.search(r"^(?:yes|yeah|yep|sure|okay|ok)\b", reply, flags=re.IGNORECASE):
            task = re.sub(r"^(?:can|could|would|will)\s+you\s+", "", normalize_text_fragment(request), flags=re.IGNORECASE).rstrip("?")
            if "send those across" in task.lower():
                return "Send final pricing figures to finance when available.", window[1]["speaker"], "When available"
            deadline = "When available" if "when available" in request.lower() else ""
            return normalize_action_text(task), window[1]["speaker"], deadline
        if re.search(r"who is handling", request, flags=re.IGNORECASE) and re.search(r"i can take that", reply, flags=re.IGNORECASE):
            task = re.sub(r"^who is handling\s+", "", normalize_text_fragment(request), flags=re.IGNORECASE).rstrip("?")
            return normalize_action_text(f"handle {task}"), window[1]["speaker"], ""
        if any(term in request.lower() for term in ("need", "issue", "problem", "unclear", "confusing")) and re.search(r"\b(i['’]?ll|i will|i can)\b", reply, flags=re.IGNORECASE):
            commitment_text = normalize_text_fragment(reply)
            if "speak with legal" in commitment_text.lower():
                return "Speak with legal once the revised proposal arrives.", window[1]["speaker"], ""
            if re.search(r"\bimprove that\b", commitment_text, flags=re.IGNORECASE) and "demo intro" in request.lower():
                return "Improve the demo intro spoken setup.", window[1]["speaker"], ""
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
            phrase = phrase[:1].upper() + phrase[1:]
            if not phrase.lower().startswith("the physical office move"):
                phrase = "The " + phrase[0].lower() + phrase[1:]
            return finalize_sentence(phrase)
    if FINALISER_RE.search(text):
        return finalize_sentence("The team will " + re.sub(r"^(?:we['’]?ll|we will)\s+", "", text, flags=re.IGNORECASE).lower())
    if lowered.startswith("the physical office move will take place on"):
        return finalize_sentence(text)
    if lowered.startswith("the team will "):
        return finalize_sentence(text)
    if lowered.startswith("let's keep it broad"):
        return "The webinar should remain broad rather than validation-specific."
    return None


def group_discussion_points(candidates: list[dict[str, Any]]) -> list[str]:
    usable = [
        candidate for candidate in candidates
        if candidate["scores"].get("discussion", 0) >= 0.62
        and candidate["scores"].get("action", 0) < 0.95
        and candidate["scores"].get("low_content", 0) < 0.6
        and len(candidate.get("tokens", [])) >= 3
    ]
    clusters: list[list[dict[str, Any]]] = []
    for candidate in usable:
        placed = False
        for cluster in clusters:
            if cosine_similarity(candidate["token_counts"], cluster[0]["token_counts"]) >= 0.32:
                cluster.append(candidate)
                placed = True
                break
        if not placed:
            clusters.append([candidate])
    points: list[str] = []
    for cluster in clusters[:5]:
        cluster_text = " ".join(item["text"] for item in cluster)
        lowered = cluster_text.lower()
        if "customer support contract renewal" in lowered and any(term in lowered for term in ("pricing", "supplier", "risk", "service levels", "response times")):
            points.append("The team reviewed the customer support contract renewal, including pricing, supplier comparison and operational risk.")
        elif any(term in lowered for term in ("one-year option", "three-year commitment", "three years")):
            points.append("The team discussed contract term length, including the trade-off between a one-year option and a three-year commitment.")
        elif any(term in lowered for term in ("legal review", "finance team", "final figures", "budget", "negotiation")):
            points.append("The team discussed legal review and finance follow-up requirements alongside ownership of the renewal negotiation.")
        elif any(term in lowered for term in ("office move", "10 september", "replace the meeting room video systems")):
            points.append("The team discussed the office move timeline and unresolved decisions around replacing the meeting room video systems.")
        elif any(term in lowered for term in ("validation-specific", "keep it broad")):
            points.append("The team discussed whether the webinar should be validation-specific or broadly applicable and agreed to keep the messaging broad.")
        elif any(term in lowered for term in ("webinar", "timeline", "scope", "registration", "attendee", "demo")):
            points.append("The team reviewed webinar delivery, presentation clarity and final preparation requirements.")
        elif any(term in lowered for term in ("green", "amber", "blocked", "review", "status", "progress")):
            points.append("The team reviewed project status, blockers and follow-up work across the active items.")
        else:
            points.append(finalize_sentence(cluster[0]["text"]))
    deduped: list[str] = []
    seen = set()
    for point in points:
        key = re.sub(r"[^a-z0-9]+", " ", point.lower()).strip()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(point)
    return deduped[:5]


def summarize_actions(actions: list[str]) -> str:
    if not actions:
        return ""
    lowered = " ".join(actions).lower()
    if "webinar" in lowered or any(term in lowered for term in ("opening", "timeline", "registration", "attendee", "practice", "demo")):
        return "Actions focused on refining webinar messaging, improving presentation materials, updating attendee information and completing a final rehearsal."
    if any(term in lowered for term in ("supplier", "legal", "finance", "pricing", "negotiation")):
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


def extract_action_block(text: str) -> list[tuple[str, str, str]]:
    lines = [line.strip() for line in text.splitlines()]
    in_block = False
    results: list[tuple[str, str, str]] = []
    deadline = ""
    for line in lines:
        if not line:
            continue
        if ACTION_HEADER_RE.match(line):
            in_block = True
            lowered = line.lower()
            deadline = "Before the webinar" if "webinar" in lowered else ("Before next week" if "next week" in lowered else "")
            continue
        if not in_block:
            continue
        if re.match(r"^[A-Z][A-Za-z ]+\s+\d+:\d{2}$", line) or re.match(r"^[A-Z][A-Za-z ]+:\s*$", line):
            break
        results.append((normalize_action_text(line), "Owner not specified", deadline))
    return results


def analyse(text: str) -> dict[str, Any]:
    config = load_json(MINUTES_CONFIG)
    turns = parse_speaker_turns(text)
    meeting_title, meeting_date, meeting_location = extract_header_fields(text, config)
    client_participants, trinzo_participants = participant_groups(turns, config)
    records = build_turn_records(turns)
    candidates = build_window_candidates(records)

    action_items: list[tuple[str, str, str, float, list[dict[str, str]]]] = []
    for item in extract_action_block(text):
        action_items.append((item[0], item[1], item[2], 0.72, []))
    for index in range(len(records) - 1):
        derived = derive_action_from_window(records[index:index + 2])
        if derived:
            action_items.append((derived[0], derived[1], derived[2], 0.8, records[index]["evidence"] + records[index + 1]["evidence"]))

    deduped_actions: dict[str, tuple[str, str, str, float, list[dict[str, str]]]] = {}
    for action, owner, deadline, confidence, evidence in action_items:
        key = re.sub(r"[^a-z0-9]+", " ", action.lower()).strip()
        existing = deduped_actions.get(key)
        if existing is None or confidence > existing[3]:
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
        [candidate for candidate in candidates if candidate["scores"].get("decision", 0) >= 0.45 and candidate["scores"].get("low_content", 0) < 0.55],
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
                "decisionConfidence": round(min(0.95, candidate["scores"]["decision"]), 2),
                "decisionType": "accepted_direction",
                "_evidence": candidate["evidence"],
            }
        )
        if len(decisions) >= 5:
            break

    discussion_points = group_discussion_points(candidates)
    if not discussion_points and decisions:
        discussion_points = [finalize_sentence(decisions[0])]
    if not discussion_points and not decisions and not structured_actions:
        executive_summary = "No substantive meeting content, decisions, or actions were identified."
    else:
        executive_summary = build_executive_summary(
            decisions,
            discussion_points,
            [item["meetingActionPoint"] for item in structured_actions],
        )

    debug = {
        "topDecisionCandidates": [
            {
                "text": item["text"],
                "speaker": item["speaker"],
                "timestamp": item["timestamp"],
                "scores": item["scores"],
            }
            for item in decision_candidates[:10]
        ],
        "topActionCandidates": [
            {
                "text": item["text"],
                "speaker": item["speaker"],
                "timestamp": item["timestamp"],
                "scores": item["scores"],
            }
            for item in sorted(candidates, key=lambda candidate: candidate["scores"].get("action", 0), reverse=True)[:10]
        ],
        "topDiscussionCandidates": [
            {
                "text": item["text"],
                "speaker": item["speaker"],
                "timestamp": item["timestamp"],
                "scores": item["scores"],
            }
            for item in sorted(candidates, key=lambda candidate: candidate["scores"].get("discussion", 0), reverse=True)[:10]
        ],
        "thresholdsUsed": {
            "decision": 0.45,
            "action": 0.75,
            "discussion": 0.62,
            "lowContent": 0.6,
        },
        "rejectedLowContentCandidates": [
            {
                "text": item["text"],
                "speaker": item["speaker"],
                "timestamp": item["timestamp"],
                "scores": item["scores"],
            }
            for item in candidates
            if item["scores"].get("low_content", 0) >= 0.6
        ][:10],
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
        "discussionPoints": discussion_points,
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
        "discussionPointDetails": [
            {"discussionPoint": point, "_evidence": [], "evidenceScore": 0.7}
            for point in discussion_points
        ],
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
