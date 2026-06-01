from __future__ import annotations

import importlib
import json
import math
import os
import re
import sys
import time
from copy import deepcopy
from dataclasses import dataclass
from difflib import get_close_matches
from pathlib import Path
from typing import Any

from python_meeting_minutes_numbers import (
    analyse,
    build_intermediate_events,
    build_turn_records,
    clean_transcript_text,
    parse_numeric_turns,
)

MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
EXPERIMENT_USERBASE = Path("/var/tmp/pyuser")
EXPERIMENT_CACHE_ROOT = Path("/var/tmp/minilm-cache")

PROTOTYPE_TEXTS = {
    "action": [
        "Action item with a concrete owner and deadline.",
        "Follow up on the task and complete the deliverable.",
        "Someone committed to do this next step.",
    ],
    "decision": [
        "The team decided on a specific option.",
        "A final direction or choice was agreed.",
        "The meeting concluded with a clear decision.",
    ],
    "discussion": [
        "A substantive project discussion point.",
        "A meaningful meeting topic that matters to the minutes.",
        "A real workstream update or issue discussion.",
    ],
    "status": [
        "This workstream is on track or in progress.",
        "This milestone has a status update.",
        "A project item is complete, blocked, or pending review.",
    ],
    "blocker": [
        "This item is blocked or at risk.",
        "There is a dependency or issue preventing progress.",
        "A risk or blocker needs attention.",
    ],
    "milestone": [
        "A milestone or workstream heading in a status review.",
        "A short agenda item naming a project workstream.",
        "A project heading followed by status discussion.",
    ],
}


@dataclass
class MiniLMBackend:
    available: bool
    reason: str
    model_name: str = MODEL_NAME
    model: Any | None = None
    _cache: dict[str, list[float]] | None = None

    @classmethod
    def load(cls, enabled: bool = True) -> "MiniLMBackend":
        if not enabled:
            return cls(False, "MiniLM disabled for this run.")
        inject_experiment_user_site()
        try:
            sentence_transformers = importlib.import_module("sentence_transformers")
        except ModuleNotFoundError:
            return cls(False, "sentence-transformers is not installed.")
        cache_root = prepare_cache_root()
        try:
            model = sentence_transformers.SentenceTransformer(
                MODEL_NAME,
                cache_folder=str(cache_root) if cache_root else None,
            )
        except Exception as exc:  # pragma: no cover - exercised in real envs
            return cls(False, f"Could not load {MODEL_NAME}: {exc}")
        return cls(True, "", model=model, _cache={})

    def encode_many(self, texts: list[str]) -> dict[str, list[float]]:
        if not self.available or not self.model:
            return {}
        cleaned = []
        for text in texts:
            value = normalize_text_fragment(text)
            if value and value not in self._cache:
                cleaned.append(value)
        if cleaned:
            embeddings = self.model.encode(
                cleaned,
                normalize_embeddings=True,
                show_progress_bar=False,
            )
            for text, embedding in zip(cleaned, embeddings):
                self._cache[text] = embedding.tolist()
        return {normalize_text_fragment(text): self._cache[normalize_text_fragment(text)] for text in texts if normalize_text_fragment(text)}

    def similarity(self, left: str, right: str) -> float:
        if not self.available:
            return 0.0
        lookup = self.encode_many([left, right])
        left_vec = lookup.get(normalize_text_fragment(left))
        right_vec = lookup.get(normalize_text_fragment(right))
        if not left_vec or not right_vec:
            return 0.0
        return round(sum(a * b for a, b in zip(left_vec, right_vec)), 4)

    def score_against_prototypes(self, text: str, prototype_group: str) -> float:
        if not self.available:
            return 0.0
        return round(
            max((self.similarity(text, prototype) for prototype in PROTOTYPE_TEXTS[prototype_group]), default=0.0),
            4,
        )


def inject_experiment_user_site() -> None:
    major = sys.version_info.major
    minor = sys.version_info.minor
    candidate = EXPERIMENT_USERBASE / "lib" / f"python{major}.{minor}" / "site-packages"
    if candidate.exists():
        candidate_str = str(candidate)
        if candidate_str not in sys.path:
            sys.path.insert(0, candidate_str)


def prepare_cache_root() -> Path | None:
    cache_root = EXPERIMENT_CACHE_ROOT
    try:
        cache_root.mkdir(parents=True, exist_ok=True)
    except OSError:
        return None
    os.environ.setdefault("HF_HOME", str(cache_root))
    os.environ.setdefault("SENTENCE_TRANSFORMERS_HOME", str(cache_root / "sentence-transformers"))
    return cache_root


def normalize_text(value: Any) -> str:
    text = str(value or "")
    text = re.sub(r"\s+", " ", text.strip())
    return text.lower()


def normalize_text_fragment(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())


def normalized_list(values: list[Any]) -> list[str]:
    return [normalize_text(value) for value in values if normalize_text(value)]


def unique_normalized_list(values: list[Any]) -> list[str]:
    seen = set()
    result = []
    for value in normalized_list(values):
        if value not in seen:
            seen.add(value)
            result.append(value)
    return result


def exact_match(actual_value: Any, expected_value: Any) -> bool:
    return normalize_text(actual_value) == normalize_text(expected_value)


def contains_match(actual_values: list[Any], expected_value: Any) -> bool:
    expected_norm = normalize_text(expected_value)
    normalized_values = unique_normalized_list(actual_values)
    for actual_norm in normalized_values:
        if expected_norm in actual_norm or actual_norm in expected_norm:
            return True
    return False


def contains_all_concepts(actual_values: list[Any], concepts: list[str] | str) -> bool:
    normalized_values = unique_normalized_list(actual_values)
    if not normalized_values:
        return False
    if isinstance(concepts, str):
        concepts = [concepts]
    for concept in concepts:
        concept_norm = normalize_text(concept)
        if not any(concept_norm in actual_norm for actual_norm in normalized_values):
            return False
    return True


def action_texts(actual: dict[str, Any]) -> list[str]:
    outputs = []
    for action in actual.get("actions", []):
        if isinstance(action, dict):
            text = action.get("meetingActionPoint", "")
            if text:
                outputs.append(text)
    outputs.extend(actual.get("meetingActionPoint", []))
    return outputs


def action_matches(actual_action: dict[str, Any] | str, expected_action: dict[str, Any] | str) -> bool:
    text = actual_action.get("meetingActionPoint", "") if isinstance(actual_action, dict) else str(actual_action)
    if isinstance(expected_action, str):
        return contains_match([text], expected_action)
    expected_text = expected_action.get("text", "")
    if expected_text and not contains_match([text], expected_text):
        return False
    if expected_action.get("owner") and normalize_text(actual_action.get("meetingActionPointOwner", "")) != normalize_text(expected_action["owner"]):
        return False
    if expected_action.get("deadline") and normalize_text(expected_action["deadline"]) not in normalize_text(actual_action.get("meetingActionPointDeadline", "")):
        return False
    return True


def decision_matches(actual_decision: str, expected_decision: dict[str, Any] | str) -> bool:
    if isinstance(expected_decision, str):
        return contains_match([actual_decision], expected_decision)
    expected_text = expected_decision.get("text", "")
    if expected_text and not contains_match([actual_decision], expected_text):
        return False
    return True


def closest_values(actual_values: list[Any], expected_value: Any, limit: int = 3) -> list[str]:
    normalized_to_raw = {}
    for raw_value in actual_values:
        normalized = normalize_text(raw_value)
        if normalized and normalized not in normalized_to_raw:
            normalized_to_raw[normalized] = str(raw_value).strip()
    expected_norm = normalize_text(expected_value)
    matches = get_close_matches(expected_norm, list(normalized_to_raw.keys()), n=limit, cutoff=0.25)
    return [normalized_to_raw[match] for match in matches]


def format_closest(values: list[str]) -> str:
    if not values:
        return "no close actual values"
    return "closest actual values: " + "; ".join(repr(value) for value in values)


def participant_set(values: list[str]) -> set[str]:
    return set(unique_normalized_list(values))


def normalize_expected_payload(payload: Any) -> Any:
    if isinstance(payload, dict) and "assertions" in payload and isinstance(payload["assertions"], dict):
        return payload["assertions"]
    if isinstance(payload, dict):
        normalized = dict(payload)
        if "discussionPoints" in payload and "mustContainDiscussionPoints" not in payload:
            normalized["mustContainDiscussionPoints"] = payload["discussionPoints"]
        if "decisions" in payload and "mustContainDecisions" not in payload:
            normalized["mustContainDecisions"] = payload["decisions"]
        if "meetingActionPoint" in payload and "mustContainActions" not in payload:
            normalized["mustContainActions"] = payload["meetingActionPoint"]
        if "expectedMeetingType" in payload and "meetingType" not in payload:
            normalized["meetingType"] = payload["expectedMeetingType"]
        if "expectedParticipants" in payload and "participants" not in payload:
            normalized["expectedParticipants"] = payload["expectedParticipants"]
        return normalized
    return payload


def evaluate_output(folder_name: str, actual: dict[str, Any], exp: dict[str, Any], richer_duplicate_decision_fixture: bool = False) -> dict[str, Any]:
    failures: list[str] = []

    if "meetingTitle" in exp and not exact_match(actual.get("meetingTitle", ""), exp["meetingTitle"]):
        failures.append(f"expected meetingTitle {exp['meetingTitle']!r}, got {actual.get('meetingTitle', '')!r}")
    if "meetingDate" in exp and not exact_match(actual.get("meetingDate", ""), exp["meetingDate"]):
        failures.append(f"expected meetingDate {exp['meetingDate']!r}, got {actual.get('meetingDate', '')!r}")
    if "participants" in exp:
        expected_participants = exp["participants"]
        if "client" in expected_participants:
            actual_client = actual.get("participants.client", [])
            if participant_set(actual_client) != participant_set(expected_participants["client"]):
                failures.append(f"expected participants.client {expected_participants['client']!r}, got {actual_client!r}")
        if "trinzo" in expected_participants:
            actual_trinzo = actual.get("participants.trinzo", [])
            if participant_set(actual_trinzo) != participant_set(expected_participants["trinzo"]):
                failures.append(f"expected participants.trinzo {expected_participants['trinzo']!r}, got {actual_trinzo!r}")
    if "expectedParticipants" in exp:
        actual_total = actual.get("participants.client", []) + actual.get("participants.trinzo", [])
        if participant_set(actual_total) != participant_set(exp["expectedParticipants"]):
            failures.append(f"expected participants {exp['expectedParticipants']!r}, got {actual_total!r}")
    if "participantCount" in exp:
        participant_total = len(actual.get("participants.client", [])) + len(actual.get("participants.trinzo", []))
        if participant_total != exp["participantCount"]:
            failures.append(f"expected participantCount {exp['participantCount']}, got {participant_total}")
    if "meetingType" in exp and not exact_match(actual.get("meetingType", ""), exp["meetingType"]):
        failures.append(f"expected meetingType {exp['meetingType']!r}, got {actual.get('meetingType', '')!r}")

    action_count = len(actual.get("actions", []))
    decision_count = len(actual.get("decisions", []))
    discussion_count = len(actual.get("discussionPoints", []))

    if "expectedActionCount" in exp and action_count != exp["expectedActionCount"]:
        failures.append(f"expected {exp['expectedActionCount']} actions, got {action_count}")
    if "expectedActionCountMin" in exp and action_count < exp["expectedActionCountMin"]:
        failures.append(f"expected at least {exp['expectedActionCountMin']} actions, got {action_count}")
    if "expectedDecisionCount" in exp:
        skip_duplicate_count_check = exp["expectedDecisionCount"] == 0 and richer_duplicate_decision_fixture
        if not skip_duplicate_count_check and decision_count != exp["expectedDecisionCount"]:
            failures.append(f"expected {exp['expectedDecisionCount']} decisions, got {decision_count}")
    if "expectedDecisionCountMin" in exp and decision_count < exp["expectedDecisionCountMin"]:
        failures.append(f"expected at least {exp['expectedDecisionCountMin']} decisions, got {decision_count}")
    if "expectedDiscussionCountMin" in exp and discussion_count < exp["expectedDiscussionCountMin"]:
        failures.append(f"expected at least {exp['expectedDiscussionCountMin']} discussion points, got {discussion_count}")
    if "expectedDiscussionCount" in exp and discussion_count != exp["expectedDiscussionCount"]:
        failures.append(f"expected {exp['expectedDiscussionCount']} discussion points, got {discussion_count}")

    decisions = actual.get("decisions", [])
    discussion_points = actual.get("discussionPoints", [])
    actions = action_texts(actual)
    action_objects = [action for action in actual.get("actions", []) if isinstance(action, dict)]
    executive_summary = actual.get("executiveSummary", "")
    discussion_and_summary = discussion_points + ([executive_summary] if executive_summary else [])

    for text in exp.get("mustContainDecisions", []):
        expected_text = text.get("text", "") if isinstance(text, dict) else text
        if not any(decision_matches(actual_decision, text) for actual_decision in decisions):
            failures.append(f"missing decision {expected_text!r}; {format_closest(closest_values(decisions, expected_text))}")
    for text in exp.get("mustNotContainDecisions", []):
        if contains_match(decisions, text):
            failures.append(f"forbidden decision present: {text!r}")
    for concepts in exp.get("mustContainDiscussionTopics", []):
        if not contains_all_concepts(discussion_and_summary, concepts):
            expected_hint = concepts[0] if isinstance(concepts, list) else concepts
            failures.append(
                f"missing discussion topic concepts {concepts!r}; {format_closest(closest_values(discussion_and_summary, expected_hint))}"
            )
    for text in exp.get("mustContainDiscussionPoints", []):
        if not contains_match(discussion_points, text):
            failures.append(f"missing discussion point {text!r}; {format_closest(closest_values(discussion_points, text))}")
    for text in exp.get("mustContainExactDiscussionPoints", []):
        if str(text).strip() not in [str(point).strip() for point in discussion_points]:
            failures.append(f"missing exact discussion point {text!r}; actual values: {discussion_points!r}")
    for text in exp.get("mustNotContainDiscussionPoints", []):
        if contains_match(discussion_points, text):
            failures.append(f"forbidden discussion point present: {text!r}")
    for text in exp.get("mustContainActions", []):
        expected_text = text.get("text", "") if isinstance(text, dict) else text
        matched = any(action_matches(action, text) for action in action_objects) if isinstance(text, dict) else contains_match(actions, text)
        if not matched:
            failures.append(f"missing action {expected_text!r}; {format_closest(closest_values(actions, expected_text))}")
    for text in exp.get("mustNotContainActions", []):
        if contains_match(actions, text):
            failures.append(f"forbidden action present: {text!r}")
    for text in exp.get("mustContainExecutiveSummary", []):
        if normalize_text(text) not in normalize_text(executive_summary):
            failures.append(f"executive summary missing {text!r}; actual summary: {executive_summary!r}")
    for text in exp.get("mustNotContain", []):
        combined_values = decisions + discussion_points + actions + [executive_summary]
        if contains_match(combined_values, text):
            failures.append(f"forbidden content present: {text!r}")

    return {
        "folder": folder_name,
        "passed": not failures,
        "failureCount": len(failures),
        "failures": failures,
        "counts": {
            "actions": action_count,
            "decisions": decision_count,
            "discussionPoints": discussion_count,
        },
    }


def normalized_key(text: str) -> str:
    return normalize_text(text)


def dedupe_values(values: list[Any]) -> list[str]:
    seen = set()
    deduped = []
    for value in values:
        cleaned = normalize_text_fragment(value)
        key = normalized_key(cleaned)
        if not key or key in seen:
            continue
        seen.add(key)
        deduped.append(cleaned)
    return deduped


def dedupe_action_objects(actions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen = set()
    result = []
    for action in actions:
        key = normalized_key(action.get("meetingActionPoint", ""))
        if not key or key in seen:
            continue
        seen.add(key)
        result.append(action)
    return result


def collect_experiment_context(transcript_text: str) -> tuple[dict[str, Any], dict[str, Any]]:
    baseline = analyse(transcript_text)
    turns = parse_numeric_turns(transcript_text)
    records = build_turn_records(turns)
    intermediate = build_intermediate_events(
        clean_transcript_text(transcript_text),
        turns,
        records,
        baseline.get("meetingTitle", ""),
    )
    return baseline, intermediate


def collect_action_candidates(intermediate: dict[str, Any]) -> list[dict[str, Any]]:
    outputs = []
    for event in intermediate.get("actionEvents", []):
        if event.get("eventType") != "action_candidate":
            continue
        outputs.append(
            {
                "text": normalize_text_fragment(event.get("action", "")),
                "owner": normalize_text_fragment(event.get("owner", "Owner not specified")),
                "deadline": normalize_text_fragment(event.get("deadline", "")),
                "baseScore": float(event.get("confidence", 0.0)),
                "source": event.get("source", ""),
            }
        )
    return outputs


def collect_decision_candidates(intermediate: dict[str, Any]) -> list[dict[str, Any]]:
    outputs = []
    for item in intermediate.get("decisionDebug", {}).get("topDecisionCandidates", []):
        outputs.append(
            {
                "text": normalize_text_fragment(item.get("text", "")),
                "baseScore": float(item.get("scores", {}).get("decision", 0.0)),
                "source": "decision_candidate",
            }
        )
    return outputs


def collect_discussion_candidates(intermediate: dict[str, Any]) -> list[dict[str, Any]]:
    outputs = []
    for point in intermediate.get("statusReviewPoints", []):
        outputs.append(
            {
                "text": normalize_text_fragment(point.get("text", "")),
                "baseScore": 0.82,
                "source": point.get("sourceType", "statusReviewPoint"),
            }
        )
    for candidate in sorted(intermediate.get("candidates", []), key=lambda item: item["scores"].get("discussion", 0.0), reverse=True)[:40]:
        outputs.append(
            {
                "text": normalize_text_fragment(candidate.get("text", "")),
                "baseScore": float(candidate.get("scores", {}).get("discussion", 0.0)),
                "source": candidate.get("kind", "candidate"),
            }
        )
    deduped = []
    seen = set()
    for item in outputs:
        key = normalized_key(item["text"])
        if not key or key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return deduped


def build_minilm_variant(
    baseline: dict[str, Any],
    intermediate: dict[str, Any],
    backend: MiniLMBackend,
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    diagnostics = {
        "modelAvailable": backend.available,
        "modelReason": backend.reason,
        "actionCandidates": [],
        "decisionCandidates": [],
        "discussionCandidates": [],
        "addedActions": [],
        "addedDecisions": [],
        "addedDiscussionPoints": [],
    }
    if not backend.available:
        return None, diagnostics

    variant = deepcopy(baseline)
    existing_action_keys = {normalized_key(item.get("meetingActionPoint", "")) for item in variant.get("actions", [])}
    existing_decision_keys = {normalized_key(item) for item in variant.get("decisions", [])}
    existing_discussion_keys = {normalized_key(item) for item in variant.get("discussionPoints", [])}
    action_source_candidates = collect_action_candidates(intermediate)
    decision_source_candidates = collect_decision_candidates(intermediate)
    discussion_source_candidates = collect_discussion_candidates(intermediate)

    preload_texts = []
    preload_texts.extend(candidate["text"] for candidate in action_source_candidates)
    preload_texts.extend(candidate["text"] for candidate in decision_source_candidates)
    preload_texts.extend(candidate["text"] for candidate in discussion_source_candidates)
    for texts in PROTOTYPE_TEXTS.values():
        preload_texts.extend(texts)
    backend.encode_many(preload_texts)

    action_candidates = []
    for candidate in action_source_candidates:
        semantic = backend.score_against_prototypes(candidate["text"], "action")
        combined = round(candidate["baseScore"] * 0.55 + semantic * 0.45, 4)
        candidate["semanticScore"] = semantic
        candidate["combinedScore"] = combined
        action_candidates.append(candidate)
    action_candidates.sort(key=lambda item: item["combinedScore"], reverse=True)
    diagnostics["actionCandidates"] = action_candidates[:8]
    for candidate in action_candidates:
        if candidate["combinedScore"] < 0.62 or candidate["semanticScore"] < 0.45:
            continue
        key = normalized_key(candidate["text"])
        if key in existing_action_keys:
            continue
        action = {
            "meetingActionPoint": candidate["text"][:1].upper() + candidate["text"][1:] + ("" if candidate["text"].endswith(".") else "."),
            "meetingActionPointOwner": candidate["owner"] or "Owner not specified",
            "meetingActionPointDeadline": candidate["deadline"],
            "actionConfidence": round(candidate["combinedScore"], 2),
            "relatedMilestone": "experimental_minilm",
            "_evidence": [],
        }
        variant.setdefault("actions", []).append(action)
        existing_action_keys.add(key)
        diagnostics["addedActions"].append(action)
        if len(diagnostics["addedActions"]) >= 2:
            break

    decision_candidates = []
    for candidate in decision_source_candidates:
        semantic = backend.score_against_prototypes(candidate["text"], "decision")
        combined = round(candidate["baseScore"] * 0.6 + semantic * 0.4, 4)
        candidate["semanticScore"] = semantic
        candidate["combinedScore"] = combined
        decision_candidates.append(candidate)
    decision_candidates.sort(key=lambda item: item["combinedScore"], reverse=True)
    diagnostics["decisionCandidates"] = decision_candidates[:8]
    for candidate in decision_candidates:
        if candidate["combinedScore"] < 0.6 or candidate["semanticScore"] < 0.42:
            continue
        key = normalized_key(candidate["text"])
        if key in existing_decision_keys:
            continue
        text = candidate["text"]
        if text and not text.endswith("."):
            text += "."
        variant.setdefault("decisions", []).append(text[:1].upper() + text[1:] if text else text)
        existing_decision_keys.add(key)
        diagnostics["addedDecisions"].append(text)
        if len(diagnostics["addedDecisions"]) >= 2:
            break

    discussion_candidates = []
    for candidate in discussion_source_candidates:
        semantic_discussion = backend.score_against_prototypes(candidate["text"], "discussion")
        semantic_status = max(
            backend.score_against_prototypes(candidate["text"], "status"),
            backend.score_against_prototypes(candidate["text"], "blocker"),
            backend.score_against_prototypes(candidate["text"], "milestone"),
        )
        combined = round(candidate["baseScore"] * 0.45 + max(semantic_discussion, semantic_status) * 0.55, 4)
        candidate["semanticScore"] = max(semantic_discussion, semantic_status)
        candidate["combinedScore"] = combined
        discussion_candidates.append(candidate)
    discussion_candidates.sort(key=lambda item: item["combinedScore"], reverse=True)
    diagnostics["discussionCandidates"] = discussion_candidates[:10]
    for candidate in discussion_candidates:
        if candidate["combinedScore"] < 0.63 or candidate["semanticScore"] < 0.46:
            continue
        key = normalized_key(candidate["text"])
        if key in existing_discussion_keys:
            continue
        text = candidate["text"]
        if text and not text.endswith("."):
            text += "."
        variant.setdefault("discussionPoints", []).append(text[:1].upper() + text[1:] if text else text)
        existing_discussion_keys.add(key)
        diagnostics["addedDiscussionPoints"].append(text)
        if len(diagnostics["addedDiscussionPoints"]) >= 2:
            break

    variant["meetingActionPoint"] = [item["meetingActionPoint"] for item in variant.get("actions", [])]
    variant["meetingActionPointOwner"] = [item["meetingActionPointOwner"] for item in variant.get("actions", [])]
    variant["meetingActionPointDeadline"] = [item["meetingActionPointDeadline"] for item in variant.get("actions", [])]
    variant["discussionPoints"] = dedupe_values(variant.get("discussionPoints", []))
    variant["decisions"] = dedupe_values(variant.get("decisions", []))
    variant["actions"] = dedupe_action_objects(variant.get("actions", []))
    return variant, diagnostics


def failure_categories(failures: list[str]) -> dict[str, int]:
    counts = {"action": 0, "owner_deadline": 0, "decision": 0, "discussion_status": 0, "other": 0}
    for failure in failures:
        lowered = failure.lower()
        if "missing action" in lowered or "forbidden action" in lowered or "expected at least" in lowered and "actions" in lowered:
            counts["action"] += 1
        elif "owner" in lowered or "deadline" in lowered:
            counts["owner_deadline"] += 1
        elif "decision" in lowered:
            counts["decision"] += 1
        elif "discussion" in lowered or "executive summary" in lowered:
            counts["discussion_status"] += 1
        else:
            counts["other"] += 1
    return counts


def compare_fixture(
    folder: Path,
    expected_payload: dict[str, Any],
    backend: MiniLMBackend,
    richer_duplicate_decision_fixture: bool = False,
) -> dict[str, Any]:
    transcript_text = (folder / "transcript.txt").read_text(encoding="utf-8")
    start = time.perf_counter()
    baseline, intermediate = collect_experiment_context(transcript_text)
    baseline_runtime_ms = round((time.perf_counter() - start) * 1000, 2)
    baseline_eval = evaluate_output(folder.name, baseline, expected_payload, richer_duplicate_decision_fixture)

    minilm_runtime_ms = 0.0
    minilm_output = None
    diagnostics = {}
    if backend.available:
        minilm_start = time.perf_counter()
        minilm_output, diagnostics = build_minilm_variant(baseline, intermediate, backend)
        minilm_runtime_ms = round((time.perf_counter() - minilm_start) * 1000, 2)
    else:
        _, diagnostics = build_minilm_variant(baseline, intermediate, backend)

    minilm_eval = None
    if minilm_output is not None:
        minilm_eval = evaluate_output(folder.name, minilm_output, expected_payload, richer_duplicate_decision_fixture)

    verdict = "skipped"
    if minilm_eval is not None:
        if minilm_eval["failureCount"] < baseline_eval["failureCount"]:
            verdict = "improved"
        elif minilm_eval["failureCount"] > baseline_eval["failureCount"]:
            verdict = "worsened"
        else:
            verdict = "unchanged"

    return {
        "fixture": folder.name,
        "timingMs": {
            "baseline": baseline_runtime_ms,
            "minilm": minilm_runtime_ms,
            "total": round(baseline_runtime_ms + minilm_runtime_ms, 2),
        },
        "baseline": {
            "passed": baseline_eval["passed"],
            "failureCount": baseline_eval["failureCount"],
            "failures": baseline_eval["failures"],
            "categoryFailures": failure_categories(baseline_eval["failures"]),
            "output": {
                "discussionPoints": baseline.get("discussionPoints", []),
                "decisions": baseline.get("decisions", []),
                "actions": baseline.get("actions", []),
            },
        },
        "minilm": {
            "executed": minilm_eval is not None,
            "passed": None if minilm_eval is None else minilm_eval["passed"],
            "failureCount": None if minilm_eval is None else minilm_eval["failureCount"],
            "failures": [] if minilm_eval is None else minilm_eval["failures"],
            "categoryFailures": {} if minilm_eval is None else failure_categories(minilm_eval["failures"]),
            "output": None if minilm_output is None else {
                "discussionPoints": minilm_output.get("discussionPoints", []),
                "decisions": minilm_output.get("decisions", []),
                "actions": minilm_output.get("actions", []),
            },
            "diagnostics": diagnostics,
        },
        "expected": expected_payload,
        "differences": {
            "addedActions": diagnostics.get("addedActions", []),
            "addedDecisions": diagnostics.get("addedDecisions", []),
            "addedDiscussionPoints": diagnostics.get("addedDiscussionPoints", []),
        },
        "verdict": verdict,
    }


def find_test_folders(root: Path) -> list[Path]:
    folders = []
    for folder in sorted(root.iterdir()):
        if folder.is_dir() and (folder / "transcript.txt").exists() and (folder / "expected.json").exists():
            folders.append(folder)
    return folders


def filter_test_folders(folders: list[Path], folders_filter: list[str] | None = None, limit: int | None = None) -> list[Path]:
    selected = folders
    if folders_filter:
        wanted = set(folders_filter)
        selected = [folder for folder in selected if folder.name in wanted]
    if limit is not None:
        selected = selected[: max(limit, 0)]
    return selected


def has_richer_duplicate_decision_fixture(folder_name: str, transcript_hashes: dict[str, str], expected_cache: dict[str, dict[str, Any]]) -> bool:
    digest = transcript_hashes.get(folder_name)
    if not digest:
        return False
    peers = [name for name, peer_digest in transcript_hashes.items() if peer_digest == digest and name != folder_name]
    for peer_name in peers:
        peer_exp = expected_cache.get(peer_name, {})
        if peer_exp.get("mustContainDecisions"):
            return True
    return False


def build_summary(report: dict[str, Any]) -> str:
    summary = report["summary"]
    runtime_summary = "unknown in no-model mode" if not summary["modelAvailable"] else f"{summary['totalRuntimeSeconds']} seconds total"
    improvement_summary = (
        "Yes"
        if summary["improved"]
        else ("Not measured here because the model was unavailable." if not summary["modelAvailable"] else "No clear improvement in this run.")
    )
    integration_summary = (
        "Only if the report shows stable gains after installing MiniLM locally."
        if not summary["modelAvailable"]
        else ("Possibly, but only as a scoped assist layer." if summary["improved"] >= summary["worsened"] else "Not yet.")
    )
    lines = [
        "# MiniLM Comparison Summary",
        "",
        f"- Model available: `{summary['modelAvailable']}`",
        f"- Model reason: `{summary['modelReason']}`",
        f"- Total fixtures tested: `{summary['totalFixtures']}`",
        f"- Baseline pass count: `{summary['baselinePassed']}` / `{summary['totalFixtures']}`",
        f"- MiniLM pass count: `{summary['minilmPassed'] if summary['minilmPassed'] is not None else 'not executed'}`",
        f"- Improved: `{summary['improved']}`",
        f"- Worsened: `{summary['worsened']}`",
        f"- Unchanged: `{summary['unchanged']}`",
        f"- Skipped: `{summary['skipped']}`",
        f"- Total runtime seconds: `{summary['totalRuntimeSeconds']}`",
        "",
        "## Questions",
        "",
        f"- Did MiniLM improve anything against the existing fixtures? `{improvement_summary}`",
        f"- Which categories improved? `{', '.join(summary['improvedCategories']) if summary['improvedCategories'] else 'none measured'}`",
        f"- Which categories worsened? `{', '.join(summary['worsenedCategories']) if summary['worsenedCategories'] else 'none measured'}`",
        f"- Did runtime stay acceptable? `{runtime_summary}`",
        f"- Is it worth integrating into the main parser later? `{integration_summary}`",
        f"- What exact files changed? `{', '.join(summary['filesChanged'])}`",
        "",
        "## Examples",
        "",
    ]
    if report["summaryExamples"]["improved"]:
        lines.append("- Improved examples:")
        for item in report["summaryExamples"]["improved"][:5]:
            lines.append(f"  - `{item}`")
    else:
        lines.append("- Improved examples: none")
    if report["summaryExamples"]["worsened"]:
        lines.append("- Worsened examples:")
        for item in report["summaryExamples"]["worsened"][:5]:
            lines.append(f"  - `{item}`")
    else:
        lines.append("- Worsened examples: none")
    if report["summaryExamples"]["extraPlausibleCandidates"]:
        lines.append("- Extra plausible candidates:")
        for item in report["summaryExamples"]["extraPlausibleCandidates"][:5]:
            lines.append(f"  - `{item}`")
    else:
        lines.append("- Extra plausible candidates: none")
    if report["summaryExamples"]["falsePositives"]:
        lines.append("- Possible false positives:")
        for item in report["summaryExamples"]["falsePositives"][:5]:
            lines.append(f"  - `{item}`")
    else:
        lines.append("- Possible false positives: none")
    lines.append("")
    return "\n".join(lines)


def run_comparison(
    test_dir: Path,
    output_path: Path,
    summary_path: Path,
    *,
    limit: int | None = None,
    folders_filter: list[str] | None = None,
    enable_model: bool = True,
    dry_run: bool = False,
) -> dict[str, Any]:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.parent.mkdir(parents=True, exist_ok=True)

    folders = filter_test_folders(find_test_folders(test_dir), folders_filter=folders_filter, limit=limit)
    expected_cache = {
        folder.name: normalize_expected_payload(json.loads((folder / "expected.json").read_text(encoding="utf-8")))
        for folder in folders
    }
    transcript_hashes = {
        folder.name: folder.joinpath("transcript.txt").read_bytes().hex()[:64]
        for folder in folders
    }

    backend = MiniLMBackend.load(enabled=(enable_model and not dry_run))
    start = time.perf_counter()
    fixture_reports = []
    improved_examples = []
    worsened_examples = []
    extra_plausible = []
    false_positives = []

    for folder in folders:
        report = compare_fixture(
            folder,
            expected_cache[folder.name],
            backend,
            richer_duplicate_decision_fixture=has_richer_duplicate_decision_fixture(folder.name, transcript_hashes, expected_cache),
        )
        fixture_reports.append(report)
        if report["verdict"] == "improved":
            improved_examples.append(folder.name)
        elif report["verdict"] == "worsened":
            worsened_examples.append(folder.name)
        if report["differences"]["addedActions"] or report["differences"]["addedDecisions"] or report["differences"]["addedDiscussionPoints"]:
            extra_plausible.append(
                f"{folder.name}: +actions={len(report['differences']['addedActions'])}, +decisions={len(report['differences']['addedDecisions'])}, +discussion={len(report['differences']['addedDiscussionPoints'])}"
            )
        if report["verdict"] == "worsened":
            false_positives.append(
                f"{folder.name}: {report['differences']['addedActions'] or report['differences']['addedDecisions'] or report['differences']['addedDiscussionPoints']}"
            )

    baseline_passed = sum(1 for item in fixture_reports if item["baseline"]["passed"])
    minilm_executed = [item for item in fixture_reports if item["minilm"]["executed"]]
    minilm_passed = None if not minilm_executed else sum(1 for item in minilm_executed if item["minilm"]["passed"])
    improved = sum(1 for item in fixture_reports if item["verdict"] == "improved")
    worsened = sum(1 for item in fixture_reports if item["verdict"] == "worsened")
    unchanged = sum(1 for item in fixture_reports if item["verdict"] == "unchanged")
    skipped = sum(1 for item in fixture_reports if item["verdict"] == "skipped")

    improved_categories = set()
    worsened_categories = set()
    for item in fixture_reports:
        baseline_categories = item["baseline"]["categoryFailures"]
        minilm_categories = item["minilm"]["categoryFailures"] or {}
        for category, count in baseline_categories.items():
            if count > minilm_categories.get(category, count):
                improved_categories.add(category)
            elif minilm_categories.get(category, count) > count:
                worsened_categories.add(category)

    report = {
        "metadata": {
            "modelName": backend.model_name,
            "modelAvailable": backend.available,
            "modelReason": backend.reason,
            "dryRun": dry_run,
        },
        "summary": {
            "totalFixtures": len(fixture_reports),
            "baselinePassed": baseline_passed,
            "minilmPassed": minilm_passed,
            "improved": improved,
            "worsened": worsened,
            "unchanged": unchanged,
            "skipped": skipped,
            "modelAvailable": backend.available,
            "modelReason": backend.reason,
            "improvedCategories": sorted(improved_categories),
            "worsenedCategories": sorted(worsened_categories),
            "totalRuntimeSeconds": round(time.perf_counter() - start, 2),
            "filesChanged": [
                "scripts/meeting_minutes_minilm_experiment.py",
                "scripts/run_minilm_comparison.py",
                "tests/test_minilm_comparison.py",
                "requirements-experimental-minilm.txt",
            ],
        },
        "summaryExamples": {
            "improved": improved_examples,
            "worsened": worsened_examples,
            "extraPlausibleCandidates": extra_plausible,
            "falsePositives": false_positives,
        },
        "fixtures": fixture_reports,
    }

    output_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    summary_path.write_text(build_summary(report), encoding="utf-8")
    return report
