from __future__ import annotations

from dataclasses import asdict, dataclass
import re
from typing import Any

try:
    from .meeting_minutes_conversation import (
        build_contextual_action_text,
        build_linked_action_text,
        extract_contextual_commitment,
        extract_problem_context,
        extract_request_task,
    )
    from .meeting_minutes_text import normalize_requested_task, normalize_text_fragment, split_sentences
except ImportError:
    from meeting_minutes_conversation import (
        build_contextual_action_text,
        build_linked_action_text,
        extract_contextual_commitment,
        extract_problem_context,
        extract_request_task,
    )
    from meeting_minutes_text import normalize_requested_task, normalize_text_fragment, split_sentences


ACTION_HEADER_RE = re.compile(
    r"^(?:actions?|next steps|follow ups?|action items)(?:\s+before\s+(?:next\s+meeting|next\s+week|the\s+webinar))?:\s*$",
    re.IGNORECASE,
)
PROPOSAL_CUE_RE = re.compile(
    r"\b(?:let's|lets|i favour|i favor|i prefer|we should|we will|we'll|the team will|keep it|keep the|make it|renew with|pursue|move it to|include|put amber|put green|put red|put blue)\b",
    re.IGNORECASE,
)
ACCEPTANCE_CUE_RE = re.compile(
    r"\b(?:agreed|agree|sounds good|that'?s better|that is better|makes sense|i support that|support that|same here|fine|perfect|yes)\b",
    re.IGNORECASE,
)
REJECTION_CUE_RE = re.compile(
    r"\b(?:absolutely not|no\b|nah\b|nope\b|won't have time|will not have time|can't\b|cannot\b|not before)\b",
    re.IGNORECASE,
)
COMMITMENT_CUE_RE = re.compile(
    r"\b(?:i'll|i will|i can|i can take that|i can handle that|i can look into it|i can take it)\b",
    re.IGNORECASE,
)
UNCERTAINTY_CUE_RE = re.compile(
    r"\b(?:haven't decided|have not decided|still deciding|not sure|maybe|needs more discussion|need more discussion|come back to it|let's see what we can do|let's see if we can)\b",
    re.IGNORECASE,
)
DECISION_CUE_RE = re.compile(
    r"\b(?:agreed|decision|will take place|will renew|will pursue|rather than|instead of|keep it broad|remain broad|keep the validation example broad|existing supplier|one-year contract)\b",
    re.IGNORECASE,
)
DEADLINE_RE = re.compile(r"\b(?:by [A-Z][a-z]+|before [A-Z][a-z]+|tomorrow|this afternoon|next week|end of quarter)\b")
OWNER_REFERENCE_RE = re.compile(r"\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b")
NAVIGATION_RE = re.compile(
    r"^\s*(?:right,\s*)?let'?s\s+(?:run through|go through|move on|start with)\b|^\s*(?:go on|anything else)\b",
    re.IGNORECASE,
)
LOW_CONTENT_RE = re.compile(r"^\s*(?:yes|yeah|yep|fine|true|correct|okay|ok|perfect|go on|anything else|meeting over)\.?\s*$", re.IGNORECASE)
FACT_ONLY_RE = re.compile(
    r"\b(?:has proposed|proposed a|expires at|average .* dropped from|is booked|is there|we've done|we have done|nothing received|nothing new)\b",
    re.IGNORECASE,
)
OPTION_RE = re.compile(
    r"\b(?:rather than|instead of|whether to|renew with|pursue|replace|move will take place|move it to|one-year contract|three-year commitment)\b",
    re.IGNORECASE,
)
PROBLEM_RE = re.compile(
    r"\b(?:needs|blocked|isn't clear|is not clear|unclear|confusing|not working|failing|issue|risk|dependency|needed before signing)\b",
    re.IGNORECASE,
)
STATUS_RE = re.compile(r"\b(?:green|amber|red|blue|blocked|complete|in review|scheduled|underway|not complete)\b", re.IGNORECASE)
EXPLICIT_NON_ACTION_RE = re.compile(r"\b(?:no action|discussion only)\b", re.IGNORECASE)
VAGUE_RE = re.compile(r"\b(?:let'?s see what we can do|let'?s see if we can|do something there|do something)\b", re.IGNORECASE)
CHALLENGE_RE = re.compile(r"\b(?:that'?s vague|that is vague|bit vague|too vague)\b", re.IGNORECASE)
COUNTER_PROPOSAL_RE = re.compile(r"\b(?:actually|instead|rather|better)\b", re.IGNORECASE)
SUPPORTS_DISCUSSION_RE = re.compile(
    r"\b(?:risk|dependency|blocked|scope|quality|timing|cost|owner|ownership|supplier|contract|pricing|proposal|renewal|launch|move|replace|legal|finance|negotiation|issue|priority|status)\b",
    re.IGNORECASE,
)


@dataclass
class TurnFeature:
    speaker: str
    timestamp: str
    text: str
    sentence_count: int
    token_count: int
    has_question: bool
    has_request: bool
    has_proposal_cue: bool
    has_acceptance_cue: bool
    has_rejection_cue: bool
    has_commitment_cue: bool
    has_uncertainty_cue: bool
    has_decision_cue: bool
    has_action_header: bool
    has_deadline: bool
    has_owner_reference: bool
    is_navigation: bool
    is_low_content: bool
    is_fact_statement: bool
    is_option_statement: bool
    is_problem_statement: bool
    is_status_statement: bool
    is_explicit_non_action: bool
    is_vague_candidate: bool
    request_task: str
    explicit_commitment_task: str
    contextual_action_verb: str
    problem_subject: str
    problem_action_verb: str


def _extract_explicit_commitment_task(text: str) -> str:
    match = re.search(r"\b(?:i'll|i will|i can)\s+(?P<task>.+)$", text, flags=re.IGNORECASE)
    if not match:
        return ""
    task = normalize_requested_task(match.group("task"))
    if not task or task.lower() in {"do that", "do it", "take that", "take it", "handle that", "handle it"}:
        return ""
    return task


def _extract_deadline(text: str) -> str:
    lowered = text.lower()
    if "before the webinar" in lowered:
        return "Before the webinar"
    if "before friday" in lowered:
        return "Before Friday"
    if "tomorrow" in lowered:
        return "Tomorrow"
    if "this afternoon" in lowered:
        return "This afternoon"
    match = re.search(r"\bby\s+([A-Z][a-z]+)\b", text)
    if match:
        return f"by {match.group(1)}"
    return ""


def extract_turn_features(turn: dict[str, str]) -> dict[str, Any]:
    text = turn.get("content", "").strip()
    normalized = normalize_text_fragment(text, turn.get("speaker", ""))
    problem = extract_problem_context(text) or {}
    contextual = extract_contextual_commitment(text) or {}
    request_task = extract_request_task(text, turn.get("speaker", "")) or ""
    explicit_commitment_task = _extract_explicit_commitment_task(text)
    feature = TurnFeature(
        speaker=turn.get("speaker", ""),
        timestamp=turn.get("timestamp", ""),
        text=text,
        sentence_count=len(split_sentences(text)) or (1 if text else 0),
        token_count=len(re.findall(r"[A-Za-z0-9']+", text)),
        has_question=("?" in text or normalized.lower().startswith(("who ", "what ", "when ", "can ", "could "))),
        has_request=bool(request_task),
        has_proposal_cue=bool(PROPOSAL_CUE_RE.search(text)),
        has_acceptance_cue=bool(ACCEPTANCE_CUE_RE.search(text)),
        has_rejection_cue=bool(REJECTION_CUE_RE.search(text)),
        has_commitment_cue=bool(COMMITMENT_CUE_RE.search(text)),
        has_uncertainty_cue=bool(UNCERTAINTY_CUE_RE.search(text)),
        has_decision_cue=bool(DECISION_CUE_RE.search(text)),
        has_action_header=bool(ACTION_HEADER_RE.match(text)),
        has_deadline=bool(DEADLINE_RE.search(text)),
        has_owner_reference=bool(OWNER_REFERENCE_RE.search(text)),
        is_navigation=bool(NAVIGATION_RE.search(text)),
        is_low_content=bool(LOW_CONTENT_RE.match(text)),
        is_fact_statement=bool(FACT_ONLY_RE.search(text)),
        is_option_statement=bool(OPTION_RE.search(text)),
        is_problem_statement=bool(problem or PROBLEM_RE.search(text)),
        is_status_statement=bool(STATUS_RE.search(text)),
        is_explicit_non_action=bool(EXPLICIT_NON_ACTION_RE.search(text)),
        is_vague_candidate=bool(VAGUE_RE.search(text)),
        request_task=request_task,
        explicit_commitment_task=explicit_commitment_task,
        contextual_action_verb=contextual.get("action_verb", ""),
        problem_subject=problem.get("subject", ""),
        problem_action_verb=problem.get("default_action_verb", ""),
    )
    return asdict(feature)


def classify_turn_window(features: list[dict[str, Any]], index: int) -> list[dict[str, Any]]:
    current = features[index]
    next_feature = features[index + 1] if index + 1 < len(features) else None
    next_next = features[index + 2] if index + 2 < len(features) else None
    patterns: list[dict[str, Any]] = []

    if current["is_vague_candidate"] and next_feature and CHALLENGE_RE.search(next_feature["text"]):
        patterns.append(
            {
                "pattern_type": "vague_challenged",
                "source_index": index,
                "evidence": [current, next_feature],
            }
        )

    if current["has_request"] and next_feature:
        if next_feature["has_rejection_cue"]:
            patterns.append(
                {
                    "pattern_type": "request_rejection",
                    "source_index": index,
                    "task": current["request_task"],
                    "evidence": [current, next_feature],
                }
            )
        elif next_feature["has_commitment_cue"] or (next_feature["has_acceptance_cue"] and not next_feature["is_low_content"]):
            action_text = build_linked_action_text(current["request_task"], None, next_feature["speaker"])
            patterns.append(
                {
                    "pattern_type": "request_acceptance",
                    "source_index": index,
                    "task": current["request_task"],
                    "action_text": action_text,
                    "owner": next_feature["speaker"] or "Owner not specified",
                    "deadline": _extract_deadline(next_feature["text"]),
                    "evidence": [current, next_feature],
                }
            )

    if current["is_problem_statement"] and next_feature and next_feature["has_commitment_cue"]:
        if next_feature["contextual_action_verb"] and current["problem_subject"]:
            action_text = build_contextual_action_text(
                next_feature["contextual_action_verb"],
                current["problem_subject"],
            )
            patterns.append(
                {
                    "pattern_type": "problem_commitment",
                    "source_index": index,
                    "action_text": action_text,
                    "owner": next_feature["speaker"] or "Owner not specified",
                    "deadline": _extract_deadline(next_feature["text"]),
                    "evidence": [current, next_feature],
                }
            )

    if current["has_proposal_cue"] or current["has_decision_cue"] or current["is_option_statement"]:
        if current["has_uncertainty_cue"] or current["is_navigation"] or current["is_vague_candidate"]:
            return patterns
        if next_feature and COUNTER_PROPOSAL_RE.search(next_feature["text"]) and (
            next_feature["has_proposal_cue"] or next_feature["has_decision_cue"] or next_feature["is_option_statement"]
        ):
            accepted = next_next if next_next and next_next["has_acceptance_cue"] else None
            patterns.append(
                {
                    "pattern_type": "counter_proposal_acceptance" if accepted else "counter_proposal",
                    "source_index": index,
                    "source_text": current["text"],
                    "final_text": next_feature["text"],
                    "evidence": [item for item in (current, next_feature, accepted) if item],
                }
            )
        elif next_feature and next_feature["has_acceptance_cue"]:
            patterns.append(
                {
                    "pattern_type": "proposal_acceptance",
                    "source_index": index,
                    "source_text": current["text"],
                    "evidence": [current, next_feature],
                }
            )
        elif current["has_uncertainty_cue"]:
            patterns.append(
                {
                    "pattern_type": "unresolved_option",
                    "source_index": index,
                    "source_text": current["text"],
                    "evidence": [current],
                }
            )
        elif current["is_fact_statement"] or current["is_option_statement"]:
            patterns.append(
                {
                    "pattern_type": "fact_only",
                    "source_index": index,
                    "source_text": current["text"],
                    "evidence": [current],
                }
            )

    if current["has_uncertainty_cue"] and current["is_option_statement"]:
        patterns.append(
            {
                "pattern_type": "unresolved_option",
                "source_index": index,
                "source_text": current["text"],
                "evidence": [current],
            }
        )

    if current["is_status_statement"] and SUPPORTS_DISCUSSION_RE.search(current["text"]):
        patterns.append(
            {
                "pattern_type": "status_discussion",
                "source_index": index,
                "source_text": current["text"],
                "evidence": [current],
            }
        )

    return patterns


def detect_discourse_patterns(turns: list[dict[str, str]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    features = [extract_turn_features(turn) for turn in turns]
    patterns: list[dict[str, Any]] = []
    for index in range(len(features)):
        patterns.extend(classify_turn_window(features, index))

    deduped: list[dict[str, Any]] = []
    seen = set()
    for pattern in sorted(patterns, key=lambda item: (item.get("source_index", 0), item.get("pattern_type", ""))):
        key = (
            pattern.get("pattern_type", ""),
            normalize_text_fragment(pattern.get("action_text", "") or pattern.get("final_text", "") or pattern.get("source_text", "")),
        )
        if key in seen:
            continue
        seen.add(key)
        deduped.append(pattern)
    return features, deduped
