from __future__ import annotations

import re
from typing import Any, Callable

try:
    from .meeting_minutes_text import finalize_sentence, normalize_requested_task
except ImportError:
    from meeting_minutes_text import finalize_sentence, normalize_requested_task


def extract_contextual_commitment(sentence: str) -> dict[str, str] | None:
    stripped = sentence.strip()
    lowered = stripped.lower()
    patterns = [
        (r"\b(?:i'll|i will)\s+think\s+(?:that|it)\s+through\b", "Refine"),
        (r"\b(?:i'll|i will)\s+think\s+about\s+(?:that|it)\b", "Refine"),
        (r"\b(?:i'll|i will)\s+work\s+through\s+(?:that|it)\b", "Refine"),
        (r"\b(?:i'll|i will)\s+tighten\s+(?:that|it)\s+up\b", "Clarify"),
        (r"\b(?:i'll|i will)\s+refine\s+(?:that|it)\b", "Refine"),
        (r"\b(?:i'll|i will)\s+improve\s+(?:that|it)\b", "Improve"),
    ]
    for pattern, action_verb in patterns:
        if re.search(pattern, lowered):
            return {"action_verb": action_verb}
    return None


def extract_problem_context(sentence: str) -> dict[str, str] | None:
    stripped = sentence.strip().rstrip(".")
    lowered = stripped.lower()
    if not stripped or stripped.endswith("?"):
        return None

    patterns = [
        (r"^(?:the\s+)?(?P<subject>.+?)\s+isn['’]?t\s+clear\b", "Refine"),
        (r"^(?:the\s+)?(?P<subject>.+?)\s+is\s+not\s+clear\b", "Refine"),
        (r"^(?:the\s+)?(?P<subject>.+?)\s+is\s+confusing\b", "Clarify"),
        (r"^(?:the\s+)?(?P<subject>.+?)\s+feels\s+confusing\b", "Clarify"),
        (r"^(?:the\s+)?(?P<subject>.+?)\s+needs\s+to\s+be\s+clearer\b", "Clarify"),
        (r"^(?:the\s+)?(?P<subject>.+?)\s+could\s+be\s+clearer\b", "Clarify"),
        (r"^(?:the\s+)?(?P<subject>.+?)\s+needs\s+tightening\s+up\b", "Refine"),
        (r"^(?:the\s+)?(?P<subject>.+?)\s+needs\s+improvement\b", "Improve"),
    ]
    for pattern, default_action_verb in patterns:
        match = re.match(pattern, stripped, flags=re.IGNORECASE)
        if not match:
            continue
        subject = normalize_requested_task(match.group("subject"))
        if subject:
            return {"subject": subject, "default_action_verb": default_action_verb}
    return None


def build_contextual_action_text(action_verb: str, subject: str) -> str:
    cleaned_subject = normalize_requested_task(subject)
    if not cleaned_subject:
        return ""
    return finalize_sentence(f"{action_verb} the {cleaned_subject}")


def extract_request_task(sentence: str, speaker: str = "") -> str | None:
    stripped = sentence.strip()
    patterns = [
        r"^can\s+(?:somebody|someone|anybody|anyone)\s+(?P<task>.+?)\??$",
        r"^can\s+you\s+(?P<task>.+?)\??$",
        r"^could\s+(?:somebody|someone|anybody|anyone)\s+(?P<task>.+?)\??$",
        r"^we\s+need\s+(?P<task>.+?)\.?$",
        r"^someone\s+needs\s+to\s+(?P<task>.+?)\.?$",
    ]
    for pattern in patterns:
        match = re.match(pattern, stripped, flags=re.IGNORECASE)
        if not match:
            continue
        task = normalize_requested_task(match.group("task"), speaker)
        if task:
            return task
    return None


def extract_response_commitment(
    sentence: str,
    speaker: str,
    config: dict[str, Any],
    find_participant_by_first_name: Callable[[str, dict[str, Any]], str | None],
) -> dict[str, Any] | None:
    stripped = sentence.strip()
    lowered = stripped.lower()
    if re.search(r"\b(no|nope|nah)\b", lowered) or re.search(
        r"\b(i won['’]t have time|i will not have time|can['’]?t|cannot|not before friday)\b",
        lowered,
    ):
        return {"rejects_request": True}

    accepts_request = bool(
        re.search(r"\b(yes|yep|yeah|sure|okay|ok)\b", lowered)
        or re.search(r"\b(i'll|i will|i can)\b", lowered)
    )
    if not accepts_request:
        return None

    collaborator = None
    collaborator_match = re.search(r"\b(?:work|pair)\s+with\s+([A-Z][a-z]+)\b", stripped)
    if collaborator_match:
        collaborator = find_participant_by_first_name(collaborator_match.group(1), config)

    if re.search(r"\b(do both)\b", lowered):
        return {"inherits_task": True, "collaborator": collaborator, "request_count": 2}
    if re.fullmatch(r"(i'll|i will|i can)[.!]?", lowered):
        return {"inherits_task": True, "collaborator": collaborator, "request_count": 1}
    if re.search(r"\b(do that|do it|handle that|handle it|take that|take it|look into that|look into it)\b", lowered):
        return {"inherits_task": True, "collaborator": collaborator, "request_count": 1}
    if re.search(r"\bwork with [A-Z][a-z]+ on (?:that|it)\b", stripped, flags=re.IGNORECASE):
        return {"inherits_task": True, "collaborator": collaborator, "request_count": 1}
    if re.fullmatch(r"(yes|yep|yeah|sure|okay|ok)[.!]?", lowered):
        return {"acknowledges_request": True}

    explicit_match = re.search(r"\b(?:i'll|i will|i can)\s+(?P<task>.+)$", stripped, flags=re.IGNORECASE)
    if not explicit_match:
        return None
    explicit_task = normalize_requested_task(explicit_match.group("task"), speaker)
    if not explicit_task:
        return None
    return {"inherits_task": False, "task": explicit_task, "collaborator": collaborator}


def build_linked_action_text(task: str, collaborator: str | None, speaker: str = "") -> str:
    task = normalize_requested_task(task, speaker)
    if not task:
        return ""
    if collaborator:
        first_name = collaborator.split()[0]
        return finalize_sentence(f"Work with {first_name} to {task}")
    return finalize_sentence(task)
