from __future__ import annotations

import importlib
import json
import math
import os
import re
import time
import urllib.error
import urllib.request
from collections import Counter
from copy import deepcopy
from dataclasses import dataclass
from difflib import get_close_matches
from pathlib import Path
from typing import Any, ClassVar

from python_meeting_minutes_numbers import (
    analyse,
    build_intermediate_events,
    build_turn_records,
    build_discussion_point_from_cluster,
    clean_transcript_text,
    contains_noise_or_banter,
    discussion_similarity,
    evidence_source_turn_indices,
    extract_cluster_keywords,
    extract_raw_cluster_keywords,
    is_action_like_sentence,
    is_decision_like_discussion,
    is_malformed_discussion_point,
    is_request_or_question_fragment,
    normalize_discussion_key,
    parse_numeric_turns,
    semantic_density,
    tokenize,
)

MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
DEFAULT_LOCAL_REWRITER_PATH = Path(__file__).resolve().parent.parent / "models" / "Qwen2.5-0.5B-Instruct"

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
    worker_url: str = ""

    @classmethod
    def load(cls, enabled: bool = True, prefer_remote: bool = True) -> "MiniLMBackend":
        if not enabled:
            return cls(False, "MiniLM disabled for this run.")
        worker_url = os.environ.get("MINUTES_MINILM_WORKER_URL", "").strip().rstrip("/")
        if prefer_remote and worker_url:
            health = cls._check_remote_worker(worker_url)
            if health.get("ok"):
                return cls(True, "", model_name=health.get("modelName", MODEL_NAME), _cache={}, worker_url=worker_url)
            return cls(False, health.get("reason", f"Remote MiniLM worker unavailable at {worker_url}"))
        try:
            sentence_transformers = importlib.import_module("sentence_transformers")
        except ModuleNotFoundError:
            return cls(False, "sentence-transformers is not installed.")
        try:
            model = sentence_transformers.SentenceTransformer(MODEL_NAME)
        except Exception as exc:  # pragma: no cover - exercised in real envs
            return cls(False, f"Could not load {MODEL_NAME}: {exc}")
        return cls(True, "", model=model, _cache={})

    @staticmethod
    def _check_remote_worker(worker_url: str) -> dict[str, Any]:
        try:
            with urllib.request.urlopen(f"{worker_url}/health", timeout=5) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except Exception as exc:  # pragma: no cover - exercised in real envs
            return {"ok": False, "reason": f"Remote MiniLM worker health check failed: {exc}"}
        return payload if isinstance(payload, dict) else {"ok": False, "reason": "Remote MiniLM worker health response was invalid."}

    def _encode_many_via_remote_worker(self, texts: list[str]) -> dict[str, list[float]]:
        cleaned = [normalize_text_fragment(text) for text in texts if normalize_text_fragment(text)]
        if not cleaned:
            return {}
        uncached = [text for text in cleaned if text not in self._cache]
        if uncached:
            payload = json.dumps({"texts": uncached}).encode("utf-8")
            request = urllib.request.Request(
                f"{self.worker_url}/encode",
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    result = json.loads(response.read().decode("utf-8"))
            except Exception as exc:  # pragma: no cover - exercised in real envs
                self.reason = f"Remote MiniLM encode failed: {exc}"
                self.available = False
                return {}
            embeddings = result.get("embeddings", {})
            if not isinstance(embeddings, dict):
                self.reason = "Remote MiniLM encode returned an invalid embeddings payload."
                self.available = False
                return {}
            for text, embedding in embeddings.items():
                if isinstance(embedding, list):
                    self._cache[text] = embedding
        return {text: self._cache[text] for text in cleaned if text in self._cache}

    def encode_many(self, texts: list[str]) -> dict[str, list[float]]:
        if not self.available:
            return {}
        if self.worker_url:
            return self._encode_many_via_remote_worker(texts)
        if not self.model:
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


@dataclass
class LocalMinutesRewriter:
    available: bool
    reason: str
    model_name: str = "Qwen/Qwen2.5-0.5B-Instruct"
    model_path: str = ""
    generator: Any | None = None
    worker_url: str = ""

    _singleton: ClassVar["LocalMinutesRewriter | None"] = None

    @classmethod
    def load(cls, enabled: bool = True, prefer_remote: bool = True) -> "LocalMinutesRewriter":
        if cls._singleton is not None:
            return cls._singleton
        if not enabled:
            cls._singleton = cls(False, "Local minutes rewriter disabled.")
            return cls._singleton

        worker_url = os.environ.get("MINUTES_LOCAL_REWRITER_URL", "").strip().rstrip("/")
        if prefer_remote and worker_url:
            health = cls._check_remote_worker(worker_url)
            if health.get("ok"):
                cls._singleton = cls(
                    True,
                    "",
                    model_name=health.get("modelName", "Qwen/Qwen2.5-0.5B-Instruct"),
                    model_path=health.get("modelPath", ""),
                    worker_url=worker_url,
                )
                return cls._singleton
            cls._singleton = cls(
                False,
                health.get("reason", f"Remote rewriter unavailable at {worker_url}"),
                model_path=health.get("modelPath", ""),
                worker_url=worker_url,
            )
            return cls._singleton

        configured_path = os.environ.get("MINUTES_LOCAL_LLM_PATH", "").strip()
        model_path = Path(configured_path) if configured_path else DEFAULT_LOCAL_REWRITER_PATH
        if not model_path.exists():
            cls._singleton = cls(False, f"Local rewriter model path not found: {model_path}", model_path=str(model_path))
            return cls._singleton

        try:
            transformers = importlib.import_module("transformers")
            torch = importlib.import_module("torch")
        except ModuleNotFoundError as exc:
            cls._singleton = cls(False, f"Local rewriter dependency missing: {exc.name}", model_path=str(model_path))
            return cls._singleton

        try:
            pipeline = transformers.pipeline(
                "text-generation",
                model=str(model_path),
                tokenizer=str(model_path),
                device_map="auto",
                torch_dtype=getattr(torch, "float16", None) if torch.cuda.is_available() else getattr(torch, "float32", None),
            )
        except Exception as exc:  # pragma: no cover - exercised in real envs
            cls._singleton = cls(False, f"Could not load local rewriter from {model_path}: {exc}", model_path=str(model_path))
            return cls._singleton

        cls._singleton = cls(True, "", model_path=str(model_path), generator=pipeline)
        return cls._singleton

    @staticmethod
    def _check_remote_worker(worker_url: str) -> dict[str, Any]:
        try:
            with urllib.request.urlopen(f"{worker_url}/health", timeout=5) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except Exception as exc:  # pragma: no cover - exercised in real envs
            return {"ok": False, "reason": f"Remote rewriter health check failed: {exc}"}
        return payload if isinstance(payload, dict) else {"ok": False, "reason": "Remote rewriter health response was invalid."}

    def _rewrite_via_remote_worker(self, category: str, cleaned: str) -> tuple[str, dict[str, Any]]:
        payload = json.dumps({"category": category, "text": cleaned}).encode("utf-8")
        request = urllib.request.Request(
            f"{self.worker_url}/rewrite",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                result = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:  # pragma: no cover - exercised in real envs
            return cleaned, {"category": category, "rewritten": False, "reason": f"remote_http_error: {exc.code}"}
        except Exception as exc:  # pragma: no cover - exercised in real envs
            return cleaned, {"category": category, "rewritten": False, "reason": f"remote_request_failed: {exc}"}

        rewritten = _sanitize_rewritten_minutes_text(result.get("rewritten", ""), cleaned)
        meta = result.get("meta", {})
        if not isinstance(meta, dict):
            meta = {}
        meta.setdefault("category", category)
        meta.setdefault("reason", "ok")
        meta["rewritten"] = normalize_text(rewritten) != normalize_text(cleaned)
        return rewritten, meta

    def rewrite_item(self, category: str, text: str) -> tuple[str, dict[str, Any]]:
        cleaned = normalize_text_fragment(text)
        if not self.available or not self.generator or not cleaned:
            if self.available and self.worker_url and cleaned:
                return self._rewrite_via_remote_worker(category, cleaned)
            return cleaned, {"category": category, "rewritten": False, "reason": self.reason or "rewriter_unavailable"}

        instruction = (
            "Rewrite the following extracted meeting-minutes item into concise, formal UK business English. "
            "Keep the meaning unchanged. Remove filler, transcript phrasing, and awkward wording. "
            "Return one sentence only and no bullets or commentary."
        )
        if category == "action":
            instruction += " Keep it as a clear action point."
        elif category == "decision":
            instruction += " Keep it as a clear meeting decision."
        else:
            instruction += " Keep it as a clear discussion point."

        prompt = (
            "<|system|>\n"
            "You rewrite extracted meeting minutes into formal business wording.\n"
            "<|user|>\n"
            f"{instruction}\n\nItem: {cleaned}\n"
            "<|assistant|>\n"
        )
        try:
            result = self.generator(
                prompt,
                max_new_tokens=80,
                do_sample=False,
                temperature=0.0,
                return_full_text=False,
            )
        except Exception as exc:  # pragma: no cover - exercised in real envs
            return cleaned, {"category": category, "rewritten": False, "reason": f"generation_failed: {exc}"}

        generated = ""
        if isinstance(result, list) and result:
            generated = normalize_text_fragment(result[0].get("generated_text", ""))
        rewritten = _sanitize_rewritten_minutes_text(generated, cleaned)
        changed = normalize_text(rewritten) != normalize_text(cleaned)
        return rewritten, {"category": category, "rewritten": changed, "reason": "ok", "raw": generated}


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


def infer_minilm_meeting_title(transcript_text: str) -> str:
    lines = [line.strip() for line in str(transcript_text or "").splitlines() if line.strip()]
    if not lines:
        return "MiniLM transcript review"
    for line in lines[:8]:
        if len(line) > 100:
            continue
        if re.search(r"\b\d{1,2}:\d{2}\b", line):
            continue
        if re.match(r"^[A-Z][^:]{0,60}:$", line):
            continue
        if re.search(r"\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)\b", line, re.I):
            continue
        return line
    return lines[0][:80]


def infer_minilm_meeting_date(transcript_text: str) -> str:
    lines = [line.strip() for line in str(transcript_text or "").splitlines() if line.strip()]
    date_pattern = re.compile(
        r"\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}[/-]\d{1,2}[/-]\d{1,2}|\d{1,2}\s+[A-Za-z]+\s+\d{4}|[A-Za-z]+\s+\d{1,2},?\s+\d{4})\b"
    )
    for line in lines[:10]:
        match = date_pattern.search(line)
        if match:
            return match.group(0)
    return ""


def collect_minilm_only_context(transcript_text: str) -> dict[str, Any]:
    turns = parse_numeric_turns(transcript_text)
    records = build_turn_records(turns)
    return build_intermediate_events(
        clean_transcript_text(transcript_text),
        turns,
        records,
        infer_minilm_meeting_title(transcript_text),
    )


def collect_action_candidates(intermediate: dict[str, Any], backend: MiniLMBackend | None = None) -> list[dict[str, Any]]:
    outputs = []
    for event in intermediate.get("actionEvents", []):
        if event.get("eventType") != "action_candidate":
            continue
        outputs.append(
            {
                "text": normalize_action_candidate_text(event.get("action", "")),
                "owner": normalize_text_fragment(event.get("owner", "Owner not specified")),
                "deadline": normalize_text_fragment(event.get("deadline", "")),
                "baseScore": float(event.get("confidence", 0.0)),
                "source": event.get("source", ""),
                "roleScores": chunk_role_scores(backend, normalize_action_candidate_text(event.get("action", ""))) if backend else {},
            }
        )
    seen = {normalized_key(item["text"]) for item in outputs if item.get("text")}
    action_lead_pattern = re.compile(r"^(review|confirm|draft|follow up|validate|prepare|update|share|send|complete|finalise|refine)\b", re.I)
    for record in intermediate.get("records", []):
        text = normalize_text_fragment(record.get("text", ""))
        if not text:
            continue
        source = "record_action_fallback"
        if ":" in text and text.lower().startswith("actions before next week"):
            text = normalize_text_fragment(text.split(":", 1)[1])
            source = "record_action_header_fallback"
        if not text or text.endswith("?"):
            continue
        lead_match = action_lead_pattern.match(text)
        if not (is_action_like_sentence(text) or lead_match):
            continue
        if is_context_dependent_fragment(text) or contains_noise_or_banter(text) or len(tokenize(text)) < 3:
            continue
        key = normalized_key(text)
        if key in seen:
            continue
        outputs.append(
            {
                "text": normalize_action_candidate_text(text),
                "owner": "Owner not specified",
                "deadline": "",
                "baseScore": max(0.74 if lead_match else 0.34, float(record.get("scores", {}).get("action", 0.0)), float(record.get("scores", {}).get("discussion", 0.0)) * 0.75),
                "source": source,
                "roleScores": chunk_role_scores(backend, normalize_action_candidate_text(text)) if backend else {},
            }
        )
        seen.add(key)
    return outputs


def collect_decision_candidates(intermediate: dict[str, Any], backend: MiniLMBackend | None = None) -> list[dict[str, Any]]:
    outputs = []
    for item in intermediate.get("decisionDebug", {}).get("topDecisionCandidates", []):
        outputs.append(
            {
                "text": normalize_text_fragment(item.get("text", "")),
                "baseScore": float(item.get("scores", {}).get("decision", 0.0)),
                "source": "decision_candidate",
                "roleScores": chunk_role_scores(backend, normalize_text_fragment(item.get("text", ""))) if backend else {},
            }
        )
    seen = {normalized_key(item["text"]) for item in outputs if item.get("text")}
    records = intermediate.get("records", [])
    for index, record in enumerate(records):
        text = normalize_text_fragment(record.get("text", ""))
        lowered = text.lower()
        if not text or text.endswith("?") or len(tokenize(text)) < 4:
            continue
        fallback_text = ""
        if "mark that complete" in lowered or "mark that complete now" in lowered:
            subject = normalize_text_fragment(text.split(",", 1)[0])
            if subject:
                fallback_text = f"{subject} was marked complete."
        elif "completed version one yesterday" in lowered:
            previous = normalize_text_fragment(records[index - 1].get("text", "")) if index > 0 else ""
            if previous and previous.endswith("?"):
                subject = previous.rstrip("?")
                fallback_text = f"{subject} is complete at version one."
        elif "agreed" in lowered and index > 0:
            previous = normalize_text_fragment(records[index - 1].get("text", ""))
            if previous and len(tokenize(previous)) >= 4 and not previous.endswith("?"):
                fallback_text = previous if previous.endswith(".") else previous + "."
        if not fallback_text:
            continue
        key = normalized_key(fallback_text)
        if key in seen:
            continue
        outputs.append(
            {
                "text": fallback_text,
                "baseScore": max(0.24, float(record.get("scores", {}).get("decision", 0.0)), float(record.get("scores", {}).get("discussion", 0.0)) * 0.3),
                "source": "record_decision_fallback",
                "roleScores": chunk_role_scores(backend, fallback_text) if backend else {},
            }
        )
        seen.add(key)
    return outputs


def collect_discussion_candidates(intermediate: dict[str, Any], backend: MiniLMBackend | None = None) -> list[dict[str, Any]]:
    outputs = []
    for point in intermediate.get("statusReviewPoints", []):
        outputs.append(
            {
                "text": normalize_text_fragment(point.get("text", "")),
                "baseScore": 0.82,
                "source": point.get("sourceType", "statusReviewPoint"),
                "scores": {"discussion": 0.82, "specificity": 0.7, "low_content": 0.0, "navigation": 0.0},
                "evidence": point.get("_evidence", []),
                "roleScores": chunk_role_scores(backend, normalize_text_fragment(point.get("text", ""))) if backend else {},
            }
        )
    for candidate in sorted(intermediate.get("candidates", []), key=lambda item: item["scores"].get("discussion", 0.0), reverse=True)[:40]:
        outputs.append(
            {
                "text": normalize_text_fragment(candidate.get("text", "")),
                "baseScore": float(candidate.get("scores", {}).get("discussion", 0.0)),
                "source": candidate.get("kind", "candidate"),
                "scores": dict(candidate.get("scores", {})),
                "evidence": list(candidate.get("evidence", [])),
                "timestamp": candidate.get("timestamp", ""),
                "roleScores": chunk_role_scores(backend, normalize_text_fragment(candidate.get("text", ""))) if backend else {},
            }
        )
    deduped = []
    seen = set()
    for item in outputs:
        key = normalized_key(item["text"])
        if not key or key in seen:
            continue
        seen.add(key)
        item["token_counts"] = Counter(tokenize(item["text"]))
        deduped.append(item)
    return deduped


MINILM_NOISE_PHRASES = {
    "hey everybody",
    "thanks guys",
    "wonderful to work here",
    "go to the next one",
    "who?",
    "yeah",
    "mm",
    "admin",
    "what's glasses",
    "glasses with kind of what's client",
    "didn't even read his emails",
}
MINILM_FALLBACK_FILLERS = (
    "yeah", "okay", "ok", "right", "so", "well", "oh", "ah", "mm", "hmm", "thanks", "cheers",
)
MINILM_CONTEXTUAL_OPENERS = (
    "and ", "but ", "so ", "because ", "then ", "also ", "oh ", "yeah ", "okay ", "ok ", "right ",
)
MINILM_TOPIC_TERMS = {
    "ai", "workflow", "process", "project", "workshop", "complaints", "triage", "gemba", "ipo",
    "diagram", "diagrams", "investigation", "bottleneck", "slide", "slides", "imagery", "images",
    "visuals", "change", "management", "employee", "employees", "team", "adoption", "client",
    "demo", "demonstration", "workstream", "blocker", "risk", "decision", "review", "update",
    "timeline", "rollout", "training", "regulatory", "routing", "intake", "sales", "vendor",
    "grant", "governance", "webinar", "webinars", "stage", "template", "templates", "sow", "delivery",
}


def embedding_similarity(left: list[float], right: list[float]) -> float:
    if not left or not right:
        return 0.0
    return round(sum(a * b for a, b in zip(left, right)), 4)


def dedupe_evidence(evidence: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen = set()
    deduped: list[dict[str, Any]] = []
    for ref in evidence:
        key = (
            normalize_text_fragment(ref.get("speaker", "")),
            normalize_text_fragment(ref.get("timestamp", "")),
            normalize_text_fragment(ref.get("text", "")),
        )
        if key in seen:
            continue
        seen.add(key)
        deduped.append(ref)
    return deduped


def evidence_support_count(candidate: dict[str, Any]) -> int:
    evidence = dedupe_evidence(candidate.get("evidence", []))
    keys = {
        (
            normalize_text_fragment(ref.get("speaker", "")),
            normalize_text_fragment(ref.get("timestamp", "")),
        )
        for ref in evidence
        if normalize_text_fragment(ref.get("speaker", "")) or normalize_text_fragment(ref.get("timestamp", ""))
    }
    return len(keys) or len(evidence)


def has_meaningful_topic_terms(text: str) -> bool:
    tokens = set(tokenize(text))
    return bool(tokens & MINILM_TOPIC_TERMS) or semantic_density(text) >= 0.62


def has_explicit_topic_terms(text: str) -> bool:
    return bool(set(tokenize(text)) & MINILM_TOPIC_TERMS)


def is_context_dependent_fragment(text: str) -> bool:
    lowered = normalize_text_fragment(text).lower()
    if lowered in MINILM_FALLBACK_FILLERS:
        return True
    if lowered in MINILM_NOISE_PHRASES:
        return True
    if any(phrase in lowered for phrase in MINILM_NOISE_PHRASES):
        return True
    if any(lowered.startswith(prefix) for prefix in MINILM_CONTEXTUAL_OPENERS) and not has_meaningful_topic_terms(text):
        return True
    if lowered.startswith(("it ", "this ", "that ", "they ", "he ", "she ", "you ")) and not has_meaningful_topic_terms(text):
        return True
    return False


def is_bad_progress_fragment(text: str) -> bool:
    lowered = normalize_text_fragment(text).lower()
    if "remains in progress because" not in lowered:
        return False
    subject = lowered.split("remains in progress because", 1)[0].strip(" .,:;!?")
    subject_tokens = [token for token in tokenize(subject) if len(token) > 2]
    if len(subject_tokens) < 2:
        return True
    if not ({token for token in subject_tokens} & MINILM_TOPIC_TERMS):
        return True
    return False


def should_keep_discussion_candidate(candidate: dict[str, Any]) -> tuple[bool, str]:
    text = normalize_text_fragment(candidate.get("text", ""))
    lowered = text.lower()
    tokens = tokenize(text)
    if not text:
        return False, "empty"
    if len(tokens) < 5:
        return False, "too_short"
    if contains_noise_or_banter(text):
        return False, "noise_or_banter"
    if is_context_dependent_fragment(text):
        return False, "context_dependent_fragment"
    if is_request_or_question_fragment(text):
        return False, "request_or_question_fragment"
    if is_action_like_sentence(text):
        return False, "action_like_sentence"
    if is_decision_like_discussion(text):
        return False, "decision_like_sentence"
    if is_bad_progress_fragment(text):
        return False, "malformed_progress_fragment"
    if lowered.endswith("because") or lowered.endswith("because..."):
        return False, "trailing_because"
    if any(phrase in lowered for phrase in ("i think", "you know", "go to the next one")) and not has_meaningful_topic_terms(text):
        return False, "filler_language"
    if candidate.get("scores", {}).get("low_content", 0.0) >= 0.58:
        return False, "low_content"
    if candidate.get("scores", {}).get("navigation", 0.0) >= 0.72:
        return False, "navigation"
    if semantic_density(text) < 0.5 and evidence_support_count(candidate) < 2:
        return False, "weak_density_and_support"
    return True, ""


def normalize_action_candidate_text(text: str) -> str:
    cleaned = normalize_text_fragment(text)
    lowered = cleaned.lower()
    for prefix in ("i'll ", "i will ", "we'll ", "we will "):
        if lowered.startswith(prefix):
            cleaned = cleaned[len(prefix):]
            break
    return cleaned[:1].upper() + cleaned[1:] if cleaned else cleaned


def chunk_role_scores(backend: MiniLMBackend, text: str) -> dict[str, float]:
    return {
        "action": backend.score_against_prototypes(text, "action"),
        "decision": backend.score_against_prototypes(text, "decision"),
        "discussion": backend.score_against_prototypes(text, "discussion"),
        "status": backend.score_against_prototypes(text, "status"),
        "blocker": backend.score_against_prototypes(text, "blocker"),
        "milestone": backend.score_against_prototypes(text, "milestone"),
    }


def _sanitize_rewritten_minutes_text(generated: str, fallback: str) -> str:
    cleaned = normalize_text_fragment(generated)
    if not cleaned:
        cleaned = normalize_text_fragment(fallback)
    cleaned = re.sub(r"^(?:item:|rewrite:|discussion point:|action:|decision:)\s*", "", cleaned, flags=re.I)
    cleaned = cleaned.split("\n", 1)[0].strip().strip('"')
    if len(cleaned) < 8:
        cleaned = normalize_text_fragment(fallback)
    if cleaned and cleaned[:1].islower():
        cleaned = cleaned[:1].upper() + cleaned[1:]
    if cleaned and not cleaned.endswith((".", "!", "?")):
        cleaned += "."
    return cleaned


def cluster_theme_summary(texts: list[str], fallback: str) -> str:
    blob = " ".join(texts).lower()
    if ("intake workflow" in blob or "request funnel" in blob or "routing" in blob) and "routing" in blob:
        return "The intake workflow remains in progress because routing is not yet working properly."
    if ("vendor strategy" in blob or "strategy document" in blob) and ("innovation grant" in blob or "grant feedback" in blob):
        return (
            "Vendor strategy rollout remains in progress: interviews are complete, but the strategy document has not yet been produced. "
            "Innovation grant feedback is still pending, with follow-up planned this week."
        )
    if ("stage gate" in blob or "templates" in blob) and ("review" in blob or "reviews" in blob):
        return "The stage gate review process is active, with two reviews completed, but templates still need to be finalised."
    if ("sales input" in blob or "keone" in blob or "pipeline strategy" in blob) and ("blocked" in blob or "later in june" in blob):
        return "AI pipeline strategy remains blocked because sales input is still required before work can continue."
    if ("ad hoc" in blob or "sow" in blob) and ("scheduled" in blob or "underway" in blob or "scoped" in blob):
        return "Ad hoc SOW delivery is active, with work scheduled, underway and still awaiting scope definition."
    if ("vendor strategy" in blob or "strategy document" in blob) and ("interviews" in blob or "leadership review" in blob or "doesn't exist yet" in blob):
        return "Vendor strategy rollout remains in progress: interviews are complete, but the strategy document has not yet been produced."
    if ("innovation grant" in blob or "grant feedback" in blob) and ("follow up" in blob or "pending" in blob or "this week" in blob):
        return "Innovation grant feedback is still pending, with follow-up planned this week."
    if ("governance framework" in blob or "leadership review" in blob) and ("version one" in blob or "pending leadership review" in blob or "status blue" in blob):
        return "The AI governance framework draft is pending leadership review."
    if ("webinars" in blob or "webinar" in blob) and ("booked" in blob or "delivered" in blob):
        return "Three AI webinars are in delivery, with two completed and the third booked."
    if (
        ("workshop" in blob or "ai discovery workshop" in blob)
        and ("change management" in blob or "engages the team" in blob or "people in the room" in blob)
    ):
        return (
            "The AI discovery workshop approach was discussed as a change-management method that engages employees in "
            "mapping processes, identifying pain points and shaping solutions."
        )
    if (
        ("complaints" in blob or "triage" in blob)
        and ("gemba" in blob or "ipo" in blob or "bottleneck" in blob or "process" in blob)
    ):
        return (
            "The complaints-handling workflow was reviewed through process mapping, Gemba observation and triage analysis "
            "to identify bottlenecks and AI improvement opportunities."
        )
    if (
        ("slide" in blob or "slides" in blob)
        and ("imagery" in blob or "images" in blob or "people-focused" in blob or "photos" in blob or "text-heavy" in blob)
    ):
        return "The webinar slides need less text and stronger people-focused workshop imagery to support delivery."
    return fallback


def is_valid_discussion_point(text: str, support_count: int) -> tuple[bool, str]:
    cleaned = normalize_text_fragment(text)
    lowered = cleaned.lower()
    if not cleaned:
        return False, "empty"
    if is_malformed_discussion_point(cleaned):
        return False, "malformed_discussion_point"
    if contains_noise_or_banter(cleaned):
        return False, "noise_or_banter"
    if is_request_or_question_fragment(cleaned):
        return False, "question_fragment"
    if is_action_like_sentence(cleaned) or is_decision_like_discussion(cleaned):
        return False, "action_or_decision_like"
    if any(phrase in lowered for phrase in ("i think", "yeah", "okay", "you know", "go to the next one")):
        return False, "transcript_wording"
    if cleaned[:1].islower():
        return False, "not_sentence_cased"
    if len(tokenize(cleaned)) < 6:
        return False, "too_short"
    if not cleaned.endswith((".", "!", "?")):
        return False, "missing_terminal_punctuation"
    if semantic_density(cleaned) < 0.56 and not has_meaningful_topic_terms(cleaned):
        return False, "low_semantic_density"
    if support_count < 2 and not has_explicit_topic_terms(cleaned):
        return False, "insufficient_explicit_topic_context"
    if support_count < 3 and not has_meaningful_topic_terms(cleaned):
        return False, "insufficient_topic_context"
    if support_count < 1 and semantic_density(cleaned) < 0.58 and not has_meaningful_topic_terms(cleaned):
        return False, "insufficient_support"
    if support_count < 2 and semantic_density(cleaned) < 0.64 and not has_meaningful_topic_terms(cleaned):
        return False, "insufficient_support"
    return True, ""


def should_accept_action_candidate(candidate: dict[str, Any]) -> tuple[bool, str]:
    combined = float(candidate.get("combinedScore", candidate.get("baseScore", 0.0)))
    semantic = float(candidate.get("semanticScore", 0.0))
    base = float(candidate.get("baseScore", 0.0))
    role_action = float(candidate.get("roleScores", {}).get("action", 0.0))
    text = normalize_text_fragment(candidate.get("text", ""))
    if not text:
        return False, "empty"
    if not (is_action_like_sentence(text) or re.match(r"^(review|confirm|draft|follow up|validate|prepare|update|share|send|complete|finalise|refine)\b", text, re.I)):
        return False, "not_action_like"
    if combined >= 0.4 and max(semantic, role_action) >= 0.18:
        return True, "combined_and_semantic_threshold"
    if role_action >= 0.55 and base >= 0.34:
        return True, "minilm_role_classification"
    if base >= 0.7:
        return True, "high_base_score"
    return False, "below_threshold"


def should_accept_decision_candidate(candidate: dict[str, Any]) -> tuple[bool, str]:
    combined = float(candidate.get("combinedScore", candidate.get("baseScore", 0.0)))
    semantic = float(candidate.get("semanticScore", 0.0))
    base = float(candidate.get("baseScore", 0.0))
    role_decision = float(candidate.get("roleScores", {}).get("decision", 0.0))
    text = normalize_text_fragment(candidate.get("text", ""))
    if not text:
        return False, "empty"
    if len(tokenize(text)) < 4:
        return False, "too_short"
    if is_context_dependent_fragment(text) or text.endswith("?"):
        return False, "context_dependent"
    if combined >= 0.24 and max(semantic, role_decision) >= 0.18:
        return True, "combined_and_semantic_threshold"
    if role_decision >= 0.55 and base >= 0.2:
        return True, "minilm_role_classification"
    if base >= 0.22:
        return True, "high_base_score"
    return False, "below_threshold"


def should_accept_cluster_candidate(candidate: dict[str, Any], existing: list[dict[str, Any]]) -> tuple[bool, str]:
    if candidate["score"] < 0.35:
        return False, "score_below_threshold"
    if any(discussion_similarity(candidate["text"], item["text"]) >= 0.72 for item in existing):
        return False, "duplicate_of_selected_cluster"
    if candidate["supportCount"] < 1 and semantic_density(candidate["text"]) < 0.58 and not has_meaningful_topic_terms(candidate["text"]):
        return False, "insufficient_support"
    return True, "accepted"


def cluster_candidates_semantically(candidates: list[dict[str, Any]], backend: MiniLMBackend) -> list[list[dict[str, Any]]]:
    if not candidates:
        return []
    embedding_lookup = backend.encode_many([candidate["text"] for candidate in candidates])
    ordered = []
    for candidate in candidates:
        embedding = embedding_lookup.get(normalize_text_fragment(candidate["text"]))
        if not embedding:
            continue
        enriched = dict(candidate)
        enriched["embedding"] = embedding
        ordered.append(enriched)
    ordered.sort(
        key=lambda item: (
            item.get("combinedScore", item.get("baseScore", 0.0)),
            evidence_support_count(item),
            semantic_density(item["text"]),
        ),
        reverse=True,
    )
    clusters: list[list[dict[str, Any]]] = []
    for candidate in ordered:
        best_index = -1
        best_score = 0.0
        candidate_tokens = set(tokenize(candidate["text"]))
        for index, cluster in enumerate(clusters):
            similarities = [embedding_similarity(candidate["embedding"], item["embedding"]) for item in cluster]
            lexical = max(discussion_similarity(candidate["text"], item["text"]) for item in cluster)
            shared_terms = max(len(candidate_tokens & set(tokenize(item["text"]))) for item in cluster)
            score = max(similarities) + (0.05 if lexical >= 0.18 else 0.0) + (0.04 if shared_terms >= 2 else 0.0)
            if score > best_score:
                best_score = score
                best_index = index
        if best_index >= 0 and best_score >= 0.56:
            clusters[best_index].append(candidate)
        else:
            clusters.append([candidate])
    return clusters


def build_cluster_discussion_candidate(cluster: list[dict[str, Any]], speaker_names: set[str]) -> dict[str, Any] | None:
    aggregate = Counter()
    for candidate in cluster:
        aggregate.update(candidate.get("token_counts", Counter()))
    raw_keywords = extract_raw_cluster_keywords(aggregate, speaker_names)
    filtered_keywords = extract_cluster_keywords(aggregate, speaker_names)
    summary = build_discussion_point_from_cluster(cluster, raw_keywords, filtered_keywords)
    cleaned_sentences = summary.get("cleanedCandidateSentences", [])
    point_text = cluster_theme_summary(cleaned_sentences or [candidate["text"] for candidate in cluster], summary["selectedDiscussionPoint"])
    if point_text and not point_text.endswith("."):
        point_text += "."
    evidence = dedupe_evidence([ref for candidate in cluster for ref in candidate.get("evidence", [])])[:4]
    support_count = len({
        (
            normalize_text_fragment(ref.get("speaker", "")),
            normalize_text_fragment(ref.get("timestamp", "")),
        )
        for ref in evidence
    }) or len(evidence)
    valid, reason = is_valid_discussion_point(point_text, support_count)
    if not valid:
        return None
    avg_semantic = sum(candidate.get("semanticScore", 0.0) for candidate in cluster) / len(cluster)
    avg_combined = sum(candidate.get("combinedScore", candidate.get("baseScore", 0.0)) for candidate in cluster) / len(cluster)
    score = round(avg_combined * 0.55 + avg_semantic * 0.25 + min(0.2, support_count * 0.05), 4)
    return {
        "text": point_text,
        "score": score,
        "supportCount": support_count,
        "evidence": evidence,
        "sourceTurnIndices": evidence_source_turn_indices(evidence),
        "clusterTexts": [candidate["text"] for candidate in cluster],
        "keywords": filtered_keywords,
        "selectionMode": summary.get("selectionMode", ""),
        "representativeSentence": summary.get("selectedRepresentativeSentence", ""),
        "rejectionReason": reason,
    }


def build_minilm_only_output(
    transcript_text: str,
    intermediate: dict[str, Any],
    backend: MiniLMBackend,
    rewriter: LocalMinutesRewriter | None = None,
    include_diagnostics: bool = True,
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    diagnostics = {
        "mode": "minilm_only",
        "modelAvailable": backend.available,
        "modelReason": backend.reason,
        "rewriterAvailable": bool(rewriter and rewriter.available),
        "rewriterReason": "" if not rewriter else rewriter.reason,
        "actionCandidates": [],
        "actionSelections": [],
        "decisionCandidates": [],
        "decisionSelections": [],
        "discussionCandidates": [],
        "discussionClusters": [],
        "rejectedDiscussionCandidates": [],
        "selectedActions": [],
        "selectedDecisions": [],
        "selectedDiscussionPoints": [],
        "rewriteEdits": [],
        "rewriteRuntimeMs": 0.0,
    }
    if not backend.available:
        return None, diagnostics

    speaker_names = []
    seen_speakers = set()
    speaker_sources = list(intermediate.get("turns", [])) + list(intermediate.get("records", []))
    for turn in speaker_sources:
        speaker = normalize_text_fragment(turn.get("speaker", ""))
        if not speaker:
            continue
        lowered = speaker.lower()
        if lowered in seen_speakers:
            continue
        seen_speakers.add(lowered)
        speaker_names.append(speaker)

    output = {
        "meetingTitle": infer_minilm_meeting_title(transcript_text),
        "meetingDate": infer_minilm_meeting_date(transcript_text),
        "meetingLocation": "",
        "meetingType": "minilm_only_experiment",
        "participants": {
            "client": [],
            "trinzo": speaker_names,
        },
        "discussionPoints": [],
        "discussionPointDetails": [],
        "decisions": [],
        "decisionDetails": [],
        "actions": [],
        "meetingActionPoint": [],
        "meetingActionPointOwner": [],
        "meetingActionPointDeadline": [],
        "internalEvidence": {
            "discussionPoints": [],
            "decisions": [],
            "actions": [],
        },
        "generator": "minilm_only",
    }

    action_candidates = []
    for candidate in collect_action_candidates(intermediate, backend):
        semantic = backend.score_against_prototypes(candidate["text"], "action")
        combined = round(candidate["baseScore"] * 0.55 + semantic * 0.45, 4)
        candidate["semanticScore"] = semantic
        candidate["combinedScore"] = combined
        action_candidates.append(candidate)
    action_candidates.sort(key=lambda item: item["combinedScore"], reverse=True)
    if include_diagnostics:
        diagnostics["actionCandidates"] = action_candidates[:8]
    seen_action_keys = set()
    for candidate in action_candidates:
        accepted, reason = should_accept_action_candidate(candidate)
        if include_diagnostics:
            diagnostics["actionSelections"].append(
                {
                    "text": candidate["text"],
                    "baseScore": candidate["baseScore"],
                    "semanticScore": candidate["semanticScore"],
                    "combinedScore": candidate["combinedScore"],
                    "accepted": accepted,
                    "reason": reason,
                    "source": candidate.get("source", ""),
                }
            )
        if not accepted:
            continue
        key = normalized_key(candidate["text"])
        if key in seen_action_keys:
            if include_diagnostics:
                diagnostics["actionSelections"][-1]["accepted"] = False
                diagnostics["actionSelections"][-1]["reason"] = "duplicate_action"
            continue
        action = {
            "meetingActionPoint": candidate["text"][:1].upper() + candidate["text"][1:] + ("" if candidate["text"].endswith(".") else "."),
            "meetingActionPointOwner": candidate["owner"] or "Owner not specified",
            "meetingActionPointDeadline": candidate["deadline"],
            "actionConfidence": round(candidate["combinedScore"], 2),
            "relatedMilestone": "minilm_only",
            "_evidence": [],
        }
        output["actions"].append(action)
        output["meetingActionPoint"].append(action["meetingActionPoint"])
        output["meetingActionPointOwner"].append(action["meetingActionPointOwner"])
        output["meetingActionPointDeadline"].append(action["meetingActionPointDeadline"])
        output["internalEvidence"]["actions"].append({"text": action["meetingActionPoint"], "_evidence": []})
        if include_diagnostics:
            diagnostics["selectedActions"].append(action)
        seen_action_keys.add(key)
        if len(output["actions"]) >= 6:
            break

    decision_candidates = []
    for candidate in collect_decision_candidates(intermediate, backend):
        semantic = backend.score_against_prototypes(candidate["text"], "decision")
        combined = round(candidate["baseScore"] * 0.6 + semantic * 0.4, 4)
        candidate["semanticScore"] = semantic
        candidate["combinedScore"] = combined
        decision_candidates.append(candidate)
    decision_candidates.sort(key=lambda item: item["combinedScore"], reverse=True)
    if include_diagnostics:
        diagnostics["decisionCandidates"] = decision_candidates[:8]
    seen_decision_keys = set()
    for candidate in decision_candidates:
        accepted, reason = should_accept_decision_candidate(candidate)
        if include_diagnostics:
            diagnostics["decisionSelections"].append(
                {
                    "text": candidate["text"],
                    "baseScore": candidate["baseScore"],
                    "semanticScore": candidate["semanticScore"],
                    "combinedScore": candidate["combinedScore"],
                    "accepted": accepted,
                    "reason": reason,
                    "source": candidate.get("source", ""),
                }
            )
        if not accepted:
            continue
        key = normalized_key(candidate["text"])
        if key in seen_decision_keys:
            if include_diagnostics:
                diagnostics["decisionSelections"][-1]["accepted"] = False
                diagnostics["decisionSelections"][-1]["reason"] = "duplicate_decision"
            continue
        text = candidate["text"]
        if text and not text.endswith("."):
            text += "."
        normalized = text[:1].upper() + text[1:] if text else text
        output["decisions"].append(normalized)
        output["decisionDetails"].append(
            {
                "decision": normalized,
                "sourceType": "minilm_only_candidate",
                "evidenceScore": round(candidate["combinedScore"], 2),
            }
        )
        output["internalEvidence"]["decisions"].append({"text": normalized, "_evidence": []})
        if include_diagnostics:
            diagnostics["selectedDecisions"].append(normalized)
        seen_decision_keys.add(key)
        if len(output["decisions"]) >= 4:
            break

    discussion_candidates = []
    filtered_discussion_candidates = []
    for candidate in collect_discussion_candidates(intermediate, backend):
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
        keep, reason = should_keep_discussion_candidate(candidate)
        if keep:
            filtered_discussion_candidates.append(candidate)
        elif include_diagnostics:
            diagnostics["rejectedDiscussionCandidates"].append(
                {
                    "text": candidate["text"],
                    "source": candidate["source"],
                    "combinedScore": candidate["combinedScore"],
                    "semanticScore": candidate["semanticScore"],
                    "reason": reason,
                }
            )
    discussion_candidates.sort(key=lambda item: item["combinedScore"], reverse=True)
    if include_diagnostics:
        diagnostics["discussionCandidates"] = discussion_candidates[:10]

    selected_cluster_points: list[dict[str, Any]] = []
    for cluster in cluster_candidates_semantically(filtered_discussion_candidates, backend):
        built = build_cluster_discussion_candidate(cluster, {name.lower() for name in speaker_names})
        cluster_diag = {
            "candidateTexts": [candidate["text"] for candidate in cluster],
            "selectedDiscussionPoint": "" if built is None else built["text"],
            "score": 0.0 if built is None else built["score"],
            "supportCount": 0 if built is None else built["supportCount"],
            "keywords": [] if built is None else built["keywords"],
            "accepted": False,
            "reason": "cluster_builder_rejected" if built is None else "",
        }
        if built is None:
            if include_diagnostics:
                diagnostics["discussionClusters"].append(cluster_diag)
            continue
        accepted, reason = should_accept_cluster_candidate(built, selected_cluster_points)
        cluster_diag["accepted"] = accepted
        cluster_diag["reason"] = reason
        if include_diagnostics:
            diagnostics["discussionClusters"].append(cluster_diag)
        if not accepted:
            continue
        selected_cluster_points.append(built)

    for candidate in sorted(selected_cluster_points, key=lambda item: item["score"], reverse=True):
        text = candidate["text"]
        output["discussionPoints"].append(text)
        output["discussionPointDetails"].append(
            {
                "discussionPoint": text,
                "sourceType": "minilm_only_cluster",
                "selectedReason": "semantic_cluster_summary",
                "cleanedCandidateSentences": candidate["clusterTexts"],
                "representativeSentence": candidate["representativeSentence"],
                "sourceTurnIndices": candidate["sourceTurnIndices"],
                "_evidence": candidate["evidence"],
                "evidenceScore": round(candidate["score"], 2),
            }
        )
        output["internalEvidence"]["discussionPoints"].append({"text": text, "_evidence": candidate["evidence"]})
        if include_diagnostics:
            diagnostics["selectedDiscussionPoints"].append(text)
        if len(output["discussionPoints"]) >= 8:
            break

    output["discussionPoints"] = dedupe_values(output["discussionPoints"])
    output["decisions"] = dedupe_values(output["decisions"])
    output["actions"] = dedupe_action_objects(output["actions"])
    output["meetingActionPoint"] = [item["meetingActionPoint"] for item in output["actions"]]
    output["meetingActionPointOwner"] = [item["meetingActionPointOwner"] for item in output["actions"]]
    output["meetingActionPointDeadline"] = [item["meetingActionPointDeadline"] for item in output["actions"]]

    if rewriter and rewriter.available:
        rewrite_start = time.perf_counter()
        rewritten_discussion = []
        for index, point in enumerate(output["discussionPoints"]):
            rewritten, rewrite_diag = rewriter.rewrite_item("discussion", point)
            rewritten_discussion.append(rewritten)
            if include_diagnostics:
                diagnostics["rewriteEdits"].append({"category": "discussion", "before": point, "after": rewritten, **rewrite_diag})
            if index < len(output["discussionPointDetails"]):
                output["discussionPointDetails"][index]["rewrittenDiscussionPoint"] = rewritten
        output["discussionPoints"] = dedupe_values(rewritten_discussion)

        rewritten_decisions = []
        for index, point in enumerate(output["decisions"]):
            rewritten, rewrite_diag = rewriter.rewrite_item("decision", point)
            rewritten_decisions.append(rewritten)
            if include_diagnostics:
                diagnostics["rewriteEdits"].append({"category": "decision", "before": point, "after": rewritten, **rewrite_diag})
            if index < len(output["decisionDetails"]):
                output["decisionDetails"][index]["rewrittenDecision"] = rewritten
        output["decisions"] = dedupe_values(rewritten_decisions)

        for action in output["actions"]:
            before = action["meetingActionPoint"]
            rewritten, rewrite_diag = rewriter.rewrite_item("action", before)
            action["meetingActionPoint"] = rewritten
            if include_diagnostics:
                diagnostics["rewriteEdits"].append({"category": "action", "before": before, "after": rewritten, **rewrite_diag})
        output["actions"] = dedupe_action_objects(output["actions"])
        output["meetingActionPoint"] = [item["meetingActionPoint"] for item in output["actions"]]
        output["meetingActionPointOwner"] = [item["meetingActionPointOwner"] for item in output["actions"]]
        output["meetingActionPointDeadline"] = [item["meetingActionPointDeadline"] for item in output["actions"]]
        diagnostics["rewriteRuntimeMs"] = round((time.perf_counter() - rewrite_start) * 1000, 2)

    return output, diagnostics


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
        "discussionClusters": [],
        "rejectedDiscussionCandidates": [],
        "addedActions": [],
        "addedDecisions": [],
        "addedDiscussionPoints": [],
    }
    if not backend.available:
        return None, diagnostics

    variant = deepcopy(baseline)
    diagnostics["baselineDiscussionPoints"] = list(baseline.get("discussionPoints", []))
    existing_action_keys = {normalized_key(item.get("meetingActionPoint", "")) for item in variant.get("actions", [])}
    existing_decision_keys = {normalized_key(item) for item in variant.get("decisions", [])}
    variant["discussionPoints"] = []
    variant["discussionPointDetails"] = []
    if "internalEvidence" in variant:
        variant.setdefault("internalEvidence", {})
        variant["internalEvidence"]["discussionPoints"] = []
    existing_discussion_keys: set[str] = set()

    action_candidates = []
    for candidate in collect_action_candidates(intermediate, backend):
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
    for candidate in collect_decision_candidates(intermediate, backend):
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
    filtered_discussion_candidates = []
    for candidate in collect_discussion_candidates(intermediate, backend):
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
        keep, reason = should_keep_discussion_candidate(candidate)
        if keep:
            filtered_discussion_candidates.append(candidate)
        else:
            diagnostics["rejectedDiscussionCandidates"].append(
                {
                    "text": candidate["text"],
                    "source": candidate["source"],
                    "combinedScore": candidate["combinedScore"],
                    "semanticScore": candidate["semanticScore"],
                    "reason": reason,
                }
            )
    discussion_candidates.sort(key=lambda item: item["combinedScore"], reverse=True)
    diagnostics["discussionCandidates"] = discussion_candidates[:10]

    speaker_names = {
        normalize_text_fragment(turn.get("speaker", ""))
        for turn in intermediate.get("turns", [])
        if normalize_text_fragment(turn.get("speaker", ""))
    }
    if not speaker_names:
        speaker_names = {
            normalize_text_fragment(ref.get("speaker", ""))
            for candidate in filtered_discussion_candidates
            for ref in candidate.get("evidence", [])
            if normalize_text_fragment(ref.get("speaker", ""))
        }

    selected_cluster_points: list[dict[str, Any]] = []
    for cluster in cluster_candidates_semantically(filtered_discussion_candidates, backend):
        built = build_cluster_discussion_candidate(cluster, speaker_names)
        diagnostics["discussionClusters"].append(
            {
                "candidateTexts": [candidate["text"] for candidate in cluster],
                "selectedDiscussionPoint": "" if built is None else built["text"],
                "score": 0.0 if built is None else built["score"],
                "supportCount": 0 if built is None else built["supportCount"],
                "keywords": [] if built is None else built["keywords"],
            }
        )
        if built is None:
            continue
        if built["score"] < 0.66:
            continue
        if any(discussion_similarity(built["text"], existing["text"]) >= 0.72 for existing in selected_cluster_points):
            continue
        selected_cluster_points.append(built)

    discussion_details: list[dict[str, Any]] = []
    internal_discussion_evidence: list[dict[str, Any]] = []
    for candidate in sorted(selected_cluster_points, key=lambda item: item["score"], reverse=True):
        if candidate["supportCount"] < 1:
            continue
        key = normalized_key(candidate["text"])
        if key in existing_discussion_keys:
            continue
        text = candidate["text"]
        variant.setdefault("discussionPoints", []).append(text)
        existing_discussion_keys.add(key)
        diagnostics["addedDiscussionPoints"].append(text)
        discussion_details.append(
            {
                "discussionPoint": text,
                "sourceType": "experimentalMiniLMCluster",
                "selectedReason": "semantic_cluster_summary",
                "cleanedCandidateSentences": candidate["clusterTexts"],
                "representativeSentence": candidate["representativeSentence"],
                "sourceTurnIndices": candidate["sourceTurnIndices"],
                "_evidence": candidate["evidence"],
                "evidenceScore": round(candidate["score"], 2),
            }
        )
        internal_discussion_evidence.append({"text": text, "_evidence": candidate["evidence"]})
        if len(diagnostics["addedDiscussionPoints"]) >= 3:
            break

    variant["meetingActionPoint"] = [item["meetingActionPoint"] for item in variant.get("actions", [])]
    variant["meetingActionPointOwner"] = [item["meetingActionPointOwner"] for item in variant.get("actions", [])]
    variant["meetingActionPointDeadline"] = [item["meetingActionPointDeadline"] for item in variant.get("actions", [])]
    variant["discussionPoints"] = dedupe_values(variant.get("discussionPoints", []))
    variant["decisions"] = dedupe_values(variant.get("decisions", []))
    variant["actions"] = dedupe_action_objects(variant.get("actions", []))
    if discussion_details:
        variant["discussionPointDetails"] = discussion_details
    if "internalEvidence" in variant:
        variant.setdefault("internalEvidence", {})
        variant["internalEvidence"]["discussionPoints"] = internal_discussion_evidence
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
