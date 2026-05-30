from __future__ import annotations

import re
from typing import Any, Callable

try:
    from .meeting_minutes_text import finalize_sentence, normalize_requested_task
except ImportError:
    from meeting_minutes_text import finalize_sentence, normalize_requested_task


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
