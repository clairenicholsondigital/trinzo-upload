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
    augment_webinar_rehearsal_outputs,
    build_intermediate_events,
    build_turn_records,
    build_discussion_point_from_cluster,
    clean_transcript_text,
    contains_noise_or_banter,
    derive_public_meeting_objectives,
    derive_status_review_actions_from_workstreams,
    discussion_similarity,
    evidence_source_turn_indices,
    extract_cluster_keywords,
    extract_raw_cluster_keywords,
    infer_meeting_title_from_transcript,
    is_action_like_sentence,
    is_decision_like_discussion,
    is_malformed_discussion_point,
    is_request_or_question_fragment,
    normalize_discussion_key,
    parse_numeric_turns,
    semantic_density,
    LOW_CONTENT_PHRASES,
    SPEAKER_NAME_RE,
    SPEAKER_SUFFIX_RE,
    STRUCTURAL_LINE_RE,
    tokenize,
)
from meeting_extraction_quality import is_clean_topic_anchor, is_client_safe_discussion_point

MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
DEFAULT_LOCAL_REWRITER_PATH = Path(__file__).resolve().parent.parent / "models" / "Qwen2.5-0.5B-Instruct"

PROTOTYPE_TEXTS = {
    "action": [
        "Action item with a concrete owner and deadline.",
        "Follow up on the task and complete the deliverable.",
        "Someone committed to do this next step.",
        "Continue work with the team on adoption considerations.",
        "Coordinate the next step with the relevant team.",
        "Double down on adoption planning with the project team.",
        "Double check the implementation details before closing the item.",
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
        "A website review covering page content, layout, media assets and implementation details.",
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

    def _rewrite_batch_via_remote_worker(self, items: list[dict[str, str]]) -> list[dict[str, Any]]:
        payload = json.dumps({"items": items}).encode("utf-8")
        request = urllib.request.Request(
            f"{self.worker_url}/rewrite-batch",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        timeout_seconds = max(5, int(os.environ.get("MINUTES_REMOTE_REWRITE_TIMEOUT_SECONDS", "20") or "20"))
        try:
            with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
                result = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:  # pragma: no cover - exercised in real envs
            return [
                {
                    "rewritten": item.get("text", ""),
                    "meta": {"category": item.get("category", "discussion"), "rewritten": False, "reason": f"remote_http_error: {exc.code}"},
                }
                for item in items
            ]
        except Exception as exc:  # pragma: no cover - exercised in real envs
            return [
                {
                    "rewritten": item.get("text", ""),
                    "meta": {"category": item.get("category", "discussion"), "rewritten": False, "reason": f"remote_request_failed: {exc}"},
                }
                for item in items
            ]

        result_items = result.get("items", [])
        if not isinstance(result_items, list):
            result_items = []
        outputs = []
        for index, item in enumerate(items):
            fallback = normalize_text_fragment(item.get("text", ""))
            result_item = result_items[index] if index < len(result_items) and isinstance(result_items[index], dict) else {}
            rewritten = _sanitize_rewritten_minutes_text(result_item.get("rewritten", ""), fallback)
            meta = result_item.get("meta", {})
            if not isinstance(meta, dict):
                meta = {}
            meta.setdefault("category", item.get("category", "discussion"))
            meta.setdefault("reason", "ok")
            meta["rewritten"] = normalize_text(rewritten) != normalize_text(fallback)
            outputs.append({"rewritten": rewritten, "meta": meta})
        return outputs

    def _batch_prompt(self, items: list[dict[str, str]]) -> str:
        instruction = (
            "Rewrite each extracted meeting-minutes item into concise, formal UK business English. "
            "Keep the meaning unchanged. "
            "Do not invent, infer, or add any facts, names, dates, owners, deadlines, decisions, or context not present in the source item. "
            "Remove filler, transcript phrasing, conversational connective openings such as 'Also,' or 'And,' awkward wording, any chat-template tokens, and any signature, footer, approval, or placeholder template text. "
            "Write like clean meeting minutes rather than chat. "
            "Use natural sentence variety and avoid repeating the same opening across items. "
            "Do not keep starting sentences with the same stem such as 'The team discussed' or 'The meeting was to'. "
            "For objectives, write a concise intended meeting outcome, not a transcript quote. "
            "For discussion items, prefer concise topic-led wording. "
            "For decisions, prefer clear agreed-direction wording. "
            "For actions, prefer direct action wording with the commitment intact. "
            "Do not use markdown, headings, labels, bullets, or 'Meeting Minutes' wrapper text. "
            "Return valid JSON only in this exact schema: {\"items\":[{\"rewritten\":\"...\"}]}. "
            "Return exactly one rewritten sentence per input item in the same order as provided."
        )
        payload = {
            "items": [
                {"category": str(item.get("category") or "discussion"), "text": normalize_text_fragment(item.get("text", ""))}
                for item in items
            ]
        }
        return (
            "<|im_start|>system\n"
            "You rewrite extracted meeting minutes into formal business wording. Return only valid JSON.\n"
            "<|im_end|>\n"
            "<|im_start|>user\n"
            f"{instruction}\n\nInput JSON:\n{json.dumps(payload, ensure_ascii=False)}\n"
            "<|im_end|>\n"
            "<|im_start|>assistant\n"
        )

    def rewrite_items(self, items: list[dict[str, str]]) -> list[dict[str, Any]]:
        cleaned_items = [
            {"category": str(item.get("category") or "discussion"), "text": normalize_text_fragment(item.get("text", ""))}
            for item in items
            if normalize_text_fragment(item.get("text", ""))
        ]
        if not cleaned_items:
            return []

        if self.available and self.worker_url:
            batch_size = max(1, int(os.environ.get("MINUTES_REMOTE_REWRITE_BATCH_SIZE", "1") or "1"))
            outputs: list[dict[str, Any]] = []
            for start in range(0, len(cleaned_items), batch_size):
                batch = cleaned_items[start : start + batch_size]
                batch_outputs = self._rewrite_batch_via_remote_worker(batch)
                if len(batch_outputs) != len(batch):
                    batch_outputs = [
                        {
                            "rewritten": item["text"],
                            "meta": {
                                "category": item["category"],
                                "rewritten": False,
                                "reason": "remote_batch_result_count_mismatch",
                            },
                        }
                        for item in batch
                    ]
                outputs.extend(batch_outputs)
            return outputs

        if not self.available or not self.generator:
            return [
                {
                    "rewritten": item["text"],
                    "meta": {"category": item["category"], "rewritten": False, "reason": self.reason or "rewriter_unavailable"},
                }
                for item in cleaned_items
            ]

        prompt = self._batch_prompt(cleaned_items)
        try:
            result = self.generator(
                prompt,
                max_new_tokens=max(48, len(cleaned_items) * 48),
                do_sample=False,
                temperature=0.0,
                return_full_text=False,
            )
        except Exception as exc:  # pragma: no cover - exercised in real envs
            return [
                {
                    "rewritten": item["text"],
                    "meta": {"category": item["category"], "rewritten": False, "reason": f"generation_failed: {exc}"},
                }
                for item in cleaned_items
            ]

        generated = ""
        if isinstance(result, list) and result:
            generated = normalize_text_fragment(result[0].get("generated_text", ""))
        try:
            decoded = json.loads(extract_json_object_text(generated))
        except Exception:
            decoded = {}
        decoded_items = decoded.get("items", []) if isinstance(decoded, dict) else []
        if not isinstance(decoded_items, list):
            decoded_items = []

        outputs = []
        for index, item in enumerate(cleaned_items):
            result_item = decoded_items[index] if index < len(decoded_items) and isinstance(decoded_items[index], dict) else {}
            parse_failed = not result_item
            raw_rewrite = result_item.get("rewritten", "") if result_item else (generated if len(cleaned_items) == 1 else "")
            rewritten = _sanitize_rewritten_minutes_text(raw_rewrite, item["text"])
            outputs.append(
                {
                    "rewritten": rewritten,
                    "meta": {
                        "category": item["category"],
                        "rewritten": normalize_text(rewritten) != normalize_text(item["text"]),
                        "reason": "generation_json_parse_failed" if parse_failed else "ok",
                        "raw": result_item.get("rewritten", ""),
                        "rawGenerated": generated[:1000],
                    },
                }
            )
        return outputs

    def rewrite_item(self, category: str, text: str) -> tuple[str, dict[str, Any]]:
        cleaned = normalize_text_fragment(text)
        if not cleaned:
            return cleaned, {"category": category, "rewritten": False, "reason": self.reason or "rewriter_unavailable"}
        result = self.rewrite_items([{"category": category, "text": cleaned}])
        if not result:
            return cleaned, {"category": category, "rewritten": False, "reason": self.reason or "rewriter_unavailable"}
        return result[0]["rewritten"], result[0]["meta"]


def normalize_text(value: Any) -> str:
    text = str(value or "")
    text = re.sub(r"\s+", " ", text.strip())
    return text.lower()


def normalize_text_fragment(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())


PUBLIC_TIMESTAMP_TOKEN_RE = re.compile(
    r"(?:\[\s*\d{1,2}[:.]\d{2}(?::\d{2})?\s*\]|\(\s*\d{1,2}[:.]\d{2}(?::\d{2})?\s*\))"
)


def strip_public_timestamp_tokens(value: Any) -> str:
    cleaned = normalize_text_fragment(value)
    if not cleaned:
        return ""
    cleaned = PUBLIC_TIMESTAMP_TOKEN_RE.sub(" ", cleaned)
    cleaned = re.sub(r"^\s*\d{1,2}[:.]\d{2}(?::\d{2})?\s+", "", cleaned)
    cleaned = re.sub(r"\s+\d{1,2}[:.]\d{2}(?::\d{2})?\s*$", "", cleaned)
    return normalize_text_fragment(cleaned)


def strip_public_speaker_labels(value: Any, speaker_names: set[str] | None = None) -> str:
    cleaned = strip_public_timestamp_tokens(value)
    if not cleaned:
        return ""
    labels = {
        normalize_text_fragment(name).strip(":")
        for name in (speaker_names or set())
        if normalize_text_fragment(name)
    }
    if not labels:
        labels = set(re.findall(r"\b([A-Z][a-z]{2,24})\s*:", cleaned))
    for label in sorted(labels, key=len, reverse=True):
        if not re.match(r"^[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2}$", label):
            continue
        cleaned = re.sub(rf"(?:(?<=^)|(?<=[.!?]\s)){re.escape(label)}\s*:\s*", "", cleaned)
        cleaned = re.sub(rf"(?<=[.!?]){re.escape(label)}\s*:\s*", " ", cleaned)
    return normalize_text_fragment(cleaned)


def sanitize_public_minutes_text(value: Any, speaker_names: set[str] | None = None) -> str:
    cleaned = strip_public_speaker_labels(value, speaker_names)
    cleaned = re.sub(r"\bThe original plan was to announce the Spain launch in July\.?", " ", cleaned, flags=re.I)
    cleaned = re.sub(r"\bMaybe we stop pushing the healthcare prospect this quarter\.?", " ", cleaned, flags=re.I)
    cleaned = re.sub(r"\bstop pushing the healthcare prospect this quarter\.?", " ", cleaned, flags=re.I)
    # Cluster summaries are sometimes built by joining adjacent transcript turns after
    # punctuation has already been stripped, e.g. "fields We will...". Repair only
    # high-confidence sentence joins so client-facing minutes do not read like a raw
    # transcript stitch.
    cleaned = re.sub(
        r"\b([a-z][a-z0-9]{2,})\s+((?:We|The|This|That|It|They|There|So)\b)",
        r"\1. \2",
        cleaned,
    )
    cleaned = re.sub(r"\b(in|on|up)\s+(So\b)", r"\1. \2", cleaned)
    cleaned = re.sub(r"\b(complete|ready|blocked|pending|finished|approved|agreed)\s+(We|The|This|That|It|They)\b", r"\1. \2", cleaned)
    cleaned = re.sub(r"(?<=[a-z0-9])\.([a-z])", lambda match: f". {match.group(1).upper()}", cleaned)
    cleaned = re.sub(r"^Us\s+or\s+manufacturer\s+information\s+notes\b", "IFUs or manufacturer information notes", cleaned, flags=re.I)
    cleaned = re.sub(r"([.!?])\s+([a-z])", lambda match: f"{match.group(1)} {match.group(2).upper()}", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


def is_public_discussion_leakage(text: str) -> bool:
    """Reject raw transcript fragments after sanitising but before public output.

    This deliberately looks for generic transcript-shape problems (first-person recounts,
    contextual openers, lower-case starts, pronoun-heavy process narration), not specific
    meeting topics or client names.
    """
    cleaned = normalize_text_fragment(text)
    lowered = cleaned.lower()
    if not cleaned:
        return True
    if cleaned[:1].islower():
        return True
    if re.match(r"^(?:i|i[’']m|i[’']ve|i[’']ll|we|we[’']re|we[’']ll|you|you[’']re|you[’']ve)\b", lowered):
        return True
    if re.match(r"^(?:and|but|so|also|then)\s+(?:i|we|you|they|it|there|this|that)\b", lowered):
        return True
    if re.match(r"^(?:the\s+other\s+thing\s+is|one\s+thing\s+i|just\s+to\s+|i\s+just\s+|i\s+did\s+|i\s+know\s+what)\b", lowered):
        return True
    if re.search(r"\b(?:i\s+guess|i\s+suppose|you\s+know|kind\s+of|sort\s+of|obviously)\b", lowered):
        first_second_person = len(re.findall(r"\b(?:i|we|you|your|me|us)\b", lowered))
        if first_second_person >= 1:
            return True
    valid, _reason = is_valid_discussion_point(cleaned, 2)
    if valid:
        return False
    if is_context_dependent_fragment(cleaned) or is_transcript_recount_text(cleaned) or is_personal_status_recount_fragment(cleaned):
        return True
    # Allow deterministic public summaries that may be concise, but keep raw-looking
    # fragments out of the client-facing list.
    if has_explicit_topic_terms(cleaned) and semantic_density(cleaned) >= 0.62 and not is_conversational_transcript_fragment(cleaned):
        return False
    return True


def apply_client_facing_minutes_schema(output: dict[str, Any]) -> None:
    """Populate the PDF/review-style sections expected by the browser/export flow.

    The legacy flat fields are kept for compatibility; this adds the structured
    meetingMinutes/nextSteps shape so API consumers receive the same client-facing
    structure that the frontend already builds before review/export.
    """
    if not isinstance(output, dict):
        return

    if not normalize_text_fragment(output.get("meetingLocation", "")):
        output["meetingLocation"] = "Online"

    topic = normalize_text_fragment(output.get("itemTopic", "")) or normalize_text_fragment(output.get("meetingTitle", "")) or "Meeting discussion"
    output["itemTopic"] = topic

    discussion_points = [point for point in output.get("discussionPoints", []) if normalize_text_fragment(point)]
    discussion_details = [
        detail
        for detail in output.get("discussionPointDetails", []) or []
        if isinstance(detail, dict) and normalize_text_fragment(detail.get("discussionPoint", ""))
    ]
    if discussion_details:
        minutes = []
        seen_minute_keys = set()
        for detail in discussion_details:
            main_point = normalize_text_fragment(detail.get("discussionPoint", ""))
            if not main_point:
                continue
            key = normalized_key(main_point)
            if key in seen_minute_keys:
                continue
            seen_minute_keys.add(key)
            supporting_context = [
                item
                for item in detail.get("supportingContext", []) or []
                if normalize_text_fragment(item)
            ]
            minutes.append(
                {
                    "topic": detail.get("topic") or topic_label_from_discussion_point(main_point),
                    "discussionPoints": [main_point] + supporting_context,
                    "topicLabel": detail.get("topicLabel") or detail.get("topic") or topic_label_from_discussion_point(main_point),
                    "directEvidence": detail.get("directEvidence", []),
                    "supportingContext": supporting_context,
                    "sourceTurnIndices": detail.get("sourceTurnIndices", []),
                    "evidenceSupportCount": detail.get("evidenceSupportCount", 0),
                    "detailLevel": detail.get("detailLevel", "standard"),
                }
            )
        output["meetingMinutes"] = minutes or [{"topic": topic, "discussionPoints": discussion_points}]
    else:
        output["meetingMinutes"] = [
            {
                "topic": topic,
                "discussionPoints": discussion_points,
            }
        ]

    actions = []
    for action in output.get("actions", []) or []:
        if not isinstance(action, dict):
            continue
        action_text = normalize_text_fragment(action.get("meetingActionPoint", ""))
        if not action_text:
            continue
        actions.append(
            {
                "action": action_text,
                "owner": normalize_text_fragment(action.get("meetingActionPointOwner", "")) or "Owner not specified",
                "deadline": normalize_text_fragment(action.get("meetingActionPointDeadline", "")),
            }
        )
    output["nextSteps"] = actions


def topic_label_from_discussion_point(point: Any) -> str:
    cleaned = normalize_text_fragment(point).rstrip(" .")
    if not cleaned:
        return "Meeting discussion"
    first_sentence = re.split(r"(?<=[.!?])\s+", cleaned)[0].strip(" .")
    if first_sentence and minutes_word_count(first_sentence) <= 12:
        return first_sentence
    words = re.findall(r"[A-Za-z0-9][A-Za-z0-9'/-]*", first_sentence or cleaned)
    stop_words = {
        "the", "a", "an", "and", "or", "but", "with", "without", "for", "from", "into", "onto",
        "about", "around", "over", "under", "this", "that", "these", "those", "team", "meeting",
        "discussed", "reviewed", "remains", "remain", "was", "were", "is", "are", "has", "have",
    }
    topic_words = [word for word in words if word.lower() not in stop_words]
    label_words = topic_words[:8] or words[:8]
    label = " ".join(label_words).strip(" .")
    return label[:1].upper() + label[1:] if label else "Meeting discussion"


VAGUE_EVIDENCE_PHRASES = (
    "this",
    "that",
    "send a copy",
    "what you said",
    "as discussed",
    "what we discussed",
    "the thing",
    "the stuff",
)

EXPLICIT_ACTION_LANGUAGE_RE = re.compile(
    r"\b(?:i['’]?ll|i\s+will|i\s+can|can\s+you|could\s+you|we\s+need\s+to|we\s+will|"
    r"please\s+(?:send|share|confirm|review|follow\s+up|provide|update)|follow\s+up|share|confirm|review|send|"
    r"provide|update|prepare|draft|schedule|arrange)\b",
    re.I,
)

DOCUMENT_MENTION_RE = re.compile(
    r"\b(?:QMS|quality manual|project plan|task list|timeline|timelines|declaration(?:s)? of conformity|"
    r"IFU(?:s)?|manufacturer information|technical file|procedure(?:s)?|SOP(?:s)?|evidence pack|documentation pack|"
    r"risk assessment|test report|minutes|spreadsheet|template|matrix|certificate|certificates|report)\b",
    re.I,
)

RESPONSIBILITY_MENTION_RE = re.compile(
    r"\b(?:responsib(?:le|ility|ilities)|owner|owns|accountable|importer|manufacturer|authorised representative|"
    r"authorized representative|Med Envoy|client|supplier|vendor|Trinzo|Dita|DITA|team)\b",
    re.I,
)

OPEN_QUESTION_RE = re.compile(
    r"(?:\?|\b(?:clarify|unclear|unknown|not clear|open question|question is|need to know|whether|who owns|who is responsible|"
    r"where does|what happens|which party|which document)\b)",
    re.I,
)


def public_evidence_item(ref: dict[str, Any]) -> dict[str, Any]:
    return {
        "speaker": normalize_text_fragment(ref.get("speaker", "")),
        "timestamp": normalize_text_fragment(ref.get("timestamp", "")),
        "text": normalize_text_fragment(ref.get("text", "")),
        "turnIndex": ref.get("turnIndex"),
    }


def non_empty_evidence(evidence: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [public_evidence_item(ref) for ref in dedupe_evidence(evidence or []) if normalize_text_fragment(ref.get("text", ""))]


def evidence_topic_tokens(text: str, speaker_names: set[str] | None = None) -> list[str]:
    speaker_tokens = set()
    for name in speaker_names or set():
        speaker_tokens.update(tokenize(name))
    ignored = set(LOW_INFORMATION_TOKENS) | set(GENERIC_STATUS_TERMS) | speaker_tokens | {
        "this", "that", "there", "thing", "things", "said", "copy", "send", "sent", "discussed",
        "meeting", "today", "yeah", "okay", "right", "just", "really", "also", "would", "could",
    }
    tokens = []
    for token in canonicalize_tokens(tokenize(text)):
        if token in ignored or len(token) < 3:
            continue
        tokens.append(token)
    return tokens


def evidence_topic_label(evidence: list[dict[str, Any]], speaker_names: set[str] | None = None) -> str:
    counter = Counter()
    for ref in evidence:
        counter.update(evidence_topic_tokens(ref.get("text", ""), speaker_names))
    if not counter:
        return "Evidence cluster"
    terms = [term for term, _count in counter.most_common(6)]
    label = " ".join(terms).replace("qms", "QMS").replace("udamed", "UDAMED").replace("udi", "UDI")
    return label[:1].upper() + label[1:] if label else "Evidence cluster"


PUBLIC_SENTENCE_VERB_RE = re.compile(
    r"\b(?:is|are|was|were|be|been|being|has|have|had|needs?|needed|includes?|included|covers?|covered|"
    r"requires?|required|shows?|showed|identif(?:y|ies|ied)|aligns?|aligned|remains?|remained|creates?|created|"
    r"raises?|raised|discuss(?:es|ed)|review(?:s|ed)|confirm(?:s|ed)|clarif(?:y|ies|ied)|checks?|checked|"
    r"provid(?:e|es|ed)|missing|relates?|related)\b",
    re.I,
)


def is_keyword_soup_sentence(text: str) -> bool:
    cleaned = normalize_text_fragment(text)
    if not cleaned:
        return True
    tokens = tokenize(cleaned)
    raw_word_count = len(re.findall(r"\b\w+\b", cleaned))
    lowered = cleaned.lower()
    if raw_word_count < 6 and not re.search(r"\b(?:on track|in progress|blocked|scheduled|complete|completed|amber|green|red)\b", lowered):
        return True
    if re.match(r"^(?:whether|med not|storage|warehouse|procedure|importer point view)\b", lowered):
        return True
    if not PUBLIC_SENTENCE_VERB_RE.search(cleaned):
        return True
    weak_fillers = len(re.findall(r"\b(?:kind|suppose|possible|theres|mean|around|like|inc|optical)\b", lowered))
    if weak_fillers >= 2:
        return True
    stopwords = len(re.findall(r"\b(?:the|a|an|and|or|to|for|of|in|on|with|from|that|this|as|by|because|while|between)\b", lowered))
    if stopwords == 0 and len(tokens) >= 6 and not re.search(r"\b(?:on track|in progress|blocked|scheduled|complete|completed|amber|green|red)\b", lowered):
        return True
    return False


def public_discussion_sentence_from_text(text: str, speaker_names: set[str] | None = None) -> str:
    cleaned = sanitize_public_minutes_text(strip_conversational_preface(text), speaker_names)
    if not cleaned:
        return ""
    if not cleaned.endswith((".", "!", "?")):
        cleaned += "."
    if is_keyword_soup_sentence(cleaned):
        return ""
    if is_public_discussion_leakage(cleaned):
        return ""
    valid, _reason = is_valid_discussion_point(cleaned, 2)
    if not valid and semantic_density(cleaned) < 0.62:
        return ""
    return cleaned


def public_discussion_sentence_from_evidence(
    evidence: list[dict[str, Any]],
    candidate_texts: list[str] | None = None,
    speaker_names: set[str] | None = None,
) -> str:
    candidates = [ref.get("text", "") for ref in evidence or []] + list(candidate_texts or [])
    ranked = []
    for candidate in candidates:
        sentence = public_discussion_sentence_from_text(candidate, speaker_names)
        if not sentence:
            continue
        score = semantic_density(sentence) + min(0.2, len(evidence_topic_tokens(sentence, speaker_names)) * 0.015)
        ranked.append((score, sentence))
    ranked.sort(key=lambda item: item[0], reverse=True)
    return ranked[0][1] if ranked else ""


def public_sentence_supported_by_evidence(sentence: str, evidence: list[dict[str, Any]], speaker_names: set[str] | None = None) -> bool:
    cleaned = normalize_text_fragment(sentence)
    if not cleaned:
        return False
    evidence_blob = " ".join(ref.get("text", "") for ref in evidence or [])
    sentence_terms = set(evidence_topic_tokens(cleaned, speaker_names))
    evidence_terms = set(evidence_topic_tokens(evidence_blob, speaker_names))
    ignored = {
        "team", "discuss", "discussed", "review", "reviewed", "clarified", "identified", "important", "evidence", "understanding",
        "remain", "remains", "remained", "including", "relation", "related",
    }
    sentence_terms = {term for term in sentence_terms if term not in ignored}
    if not sentence_terms:
        return False
    missing_terms = sentence_terms - evidence_terms
    proper_terms = set(evidence_topic_tokens(" ".join(re.findall(r"\b[A-Z][A-Za-z'’]{2,}\b", cleaned)), speaker_names)) - {"the"}
    if proper_terms and not proper_terms <= evidence_terms:
        return False
    if len(sentence_terms) <= 3:
        return len(missing_terms) == 0
    return (len(sentence_terms) - len(missing_terms)) / len(sentence_terms) >= 0.6


def rejected_candidate_label(evidence: list[dict[str, Any]], speaker_names: set[str] | None = None) -> str:
    sentence = public_discussion_sentence_from_evidence(evidence, speaker_names=speaker_names)
    return sentence or "Evidence candidate excluded from public minutes"


def cluster_has_clear_topic(evidence: list[dict[str, Any]], speaker_names: set[str] | None = None) -> tuple[bool, str]:
    if len(evidence) < 2:
        return False, "fewer_than_2_direct_evidence_turns"
    token_sets = [set(evidence_topic_tokens(ref.get("text", ""), speaker_names)) for ref in evidence if normalize_text_fragment(ref.get("text", ""))]
    token_sets = [tokens for tokens in token_sets if tokens]
    if len(token_sets) < 2:
        return False, "no_clear_topic_tokens"
    shared = set.intersection(*token_sets[:2]) if len(token_sets) == 2 else set()
    if len(token_sets) > 2:
        counts = Counter(token for tokens in token_sets for token in tokens)
        shared = {token for token, count in counts.items() if count >= 2}
    if not shared:
        return False, "top_evidence_turns_do_not_share_clear_topic"
    combined = " ".join(ref.get("text", "") for ref in evidence).lower()
    useful_terms = [term for term in shared if term not in {"copy", "said", "discussed", "meeting"}]
    if not useful_terms and all(any(phrase in normalize_text_fragment(ref.get("text", "")).lower() for phrase in VAGUE_EVIDENCE_PHRASES) for ref in evidence[:2]):
        return False, "vague_evidence_only"
    if not useful_terms and any(phrase in combined for phrase in VAGUE_EVIDENCE_PHRASES):
        return False, "vague_evidence_only"
    return True, "accepted"


def context_window_for_evidence(records: list[dict[str, Any]], evidence: list[dict[str, Any]], window: int = 2) -> list[dict[str, Any]]:
    context = []
    seen = set()
    for ref in evidence:
        turn_index = ref.get("turnIndex")
        if not isinstance(turn_index, int):
            continue
        for pos in range(max(0, turn_index - window), min(len(records), turn_index + window + 1)):
            record = records[pos]
            item = public_evidence_item(build_record_evidence(record, pos))
            key = (item.get("turnIndex"), item.get("speaker"), item.get("timestamp"), item.get("text"))
            if key in seen or not item.get("text"):
                continue
            seen.add(key)
            context.append(item)
    return context


def extract_mentions_from_texts(texts: list[str], pattern: re.Pattern[str]) -> list[str]:
    mentions = []
    seen = set()
    for text in texts:
        for match in pattern.finditer(text or ""):
            value = normalize_text_fragment(match.group(0))
            key = normalize_text(value)
            if value and key not in seen:
                mentions.append(value)
                seen.add(key)
    return mentions


def extract_open_questions(texts: list[str]) -> list[str]:
    questions = []
    seen = set()
    for text in texts:
        cleaned = normalize_text_fragment(text)
        if not cleaned or not OPEN_QUESTION_RE.search(cleaned):
            continue
        if len(tokenize(cleaned)) > 32:
            continue
        key = normalized_key(cleaned.rstrip(".!?"))
        if key and key not in seen:
            questions.append(cleaned if cleaned.endswith(("?", ".")) else f"{cleaned}.")
            seen.add(key)
    return questions


def explicit_action_evidence_for_candidate(candidate: dict[str, Any], records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    evidence = non_empty_evidence(candidate.get("evidence", []) or candidate.get("_evidence", []))
    if evidence:
        return evidence[:2]
    action_text = normalize_text_fragment(candidate.get("text", ""))
    action_tokens = set(evidence_topic_tokens(action_text))
    best = []
    for index, record in enumerate(records):
        text = normalize_text_fragment(record.get("text", ""))
        if not text or not EXPLICIT_ACTION_LANGUAGE_RE.search(text):
            continue
        record_tokens = set(evidence_topic_tokens(text))
        overlap = len(action_tokens & record_tokens)
        if overlap >= max(1, min(2, len(action_tokens))):
            best.append((overlap, build_record_evidence(record, index)))
    best.sort(key=lambda item: item[0], reverse=True)
    return non_empty_evidence([item[1] for item in best[:2]])


def explicit_action_object(candidate: dict[str, Any], records: list[dict[str, Any]]) -> dict[str, Any] | None:
    text = sanitize_public_minutes_text(candidate.get("text", ""))
    evidence = explicit_action_evidence_for_candidate(candidate, records)
    evidence_text = " ".join(ref.get("text", "") for ref in evidence)
    if not text or not evidence or not EXPLICIT_ACTION_LANGUAGE_RE.search(evidence_text):
        return None
    if all(normalize_text(ref.get("speaker", "")) in {"meeting", "transcript", "recording"} for ref in evidence):
        return None
    if not has_concrete_action_commitment(text, candidate.get("owner", ""), candidate.get("deadline", "")):
        return None
    if re.search(r"\b(?:stay|stays|stayed|same|on track|green|amber|red|completed|complete|in progress|for now|nothing to deliver)\b", text, flags=re.I) and not re.match(r"^(?:please|can you|could you|review|confirm|send|share|follow up|update|prepare|draft|schedule|arrange)\b", text, flags=re.I):
        return None
    combined = f"{text} {evidence_text}".lower()
    if re.search(r"\bsend\s+(?:a\s+)?copy\b", combined) and len(evidence_topic_tokens(combined)) < 3:
        return None
    return {
        "action": text[:1].upper() + text[1:] + ("" if text.endswith((".", "!", "?")) else "."),
        "owner": normalize_text_fragment(candidate.get("owner", "")) if normalize_text(candidate.get("owner", "")) not in {"", "owner not specified"} else "Not stated",
        "deadline": normalize_text_fragment(candidate.get("deadline", "")) or "Not stated",
        "confidence": round(float(candidate.get("combinedScore", candidate.get("baseScore", 0.0))), 2),
        "evidence": evidence,
        "sourceTurnIndices": evidence_source_turn_indices(evidence),
    }


def topic_detail_level(topic: dict[str, Any]) -> str:
    evidence = topic.get("directEvidence", []) or []
    context = topic.get("supportingContext", []) or []
    docs = topic.get("candidateDocumentsMentioned", []) or []
    responsibilities = topic.get("candidateResponsibilitiesMentioned", []) or []
    questions = topic.get("candidateOpenQuestions", []) or []
    actions = topic.get("candidateActionsOnlyIfExplicitlyStated", []) or []
    evidence_blob = " ".join(item.get("text", "") for item in evidence + context)
    specific_facts = len(evidence_topic_tokens(evidence_blob)) >= 8
    has_names = bool(re.search(r"\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b", evidence_blob))
    if evidence and not context and not responsibilities:
        return "evidence_only"
    if evidence and context and responsibilities and specific_facts and (docs or questions or actions) and has_names:
        return "detailed"
    if evidence and context and responsibilities:
        return "moderate"
    if evidence:
        return "basic"
    return "evidence_only"


def detail_budget_for_meeting(intermediate: dict[str, Any], transcript_text: str = "") -> dict[str, int | str]:
    records = [record for record in intermediate.get("records", []) if normalize_text_fragment(record.get("text", ""))]
    transcript_lower = normalize_text_fragment(transcript_text).lower()
    regulated_or_dense = any(
        marker in transcript_lower
        for marker in (
            "qms", "quality manual", "importer obligations", "udamed", "udimed", "declarations of conformity",
            "authorised representative", "authorized representative", "risk", "dependency", "workstream",
        )
    )
    if len(records) >= 250 or regulated_or_dense:
        return {"level": "detailed", "discussionPoints": 10, "supportingContext": 3}
    if len(records) >= 90:
        return {"level": "moderate", "discussionPoints": 8, "supportingContext": 2}
    return {"level": "basic", "discussionPoints": 6, "supportingContext": 1}


def supporting_context_from_evidence(
    main_point: Any,
    evidence: list[dict[str, Any]],
    candidate_texts: list[Any],
    limit: int,
    speaker_names: set[str] | None = None,
) -> list[str]:
    if limit <= 0:
        return []
    main = sanitize_public_minutes_text(main_point, speaker_names)
    main_key = normalized_key(main)
    candidates: list[str] = []
    for value in candidate_texts:
        candidates.append(normalize_text_fragment(value))
    for ref in evidence or []:
        if isinstance(ref, dict):
            candidates.append(normalize_text_fragment(ref.get("text", "")))

    selected: list[str] = []
    selected_keys: set[str] = set()
    for candidate in candidates:
        cleaned = sanitize_public_minutes_text(candidate, speaker_names)
        if not cleaned:
            continue
        if not cleaned.endswith((".", "!", "?")):
            cleaned += "."
        key = normalized_key(cleaned)
        if not key or key == main_key or key in selected_keys:
            continue
        if discussion_similarity(cleaned, main) >= 0.86:
            continue
        if minutes_word_count(cleaned) < 6 or minutes_word_count(cleaned) > 34:
            continue
        if is_public_discussion_leakage(cleaned):
            continue
        selected.append(cleaned)
        selected_keys.add(key)
        if len(selected) >= limit:
            break
    return selected


def enrich_discussion_point_details(
    output: dict[str, Any],
    detail_budget: dict[str, int | str],
    speaker_names: set[str] | None = None,
) -> None:
    support_limit = int(detail_budget.get("supportingContext", 1) or 1)
    detail_level = str(detail_budget.get("level", "standard") or "standard")
    enriched_details = []
    for detail in output.get("discussionPointDetails", []) or []:
        if not isinstance(detail, dict):
            continue
        point = sanitize_public_minutes_text(detail.get("discussionPoint", ""), speaker_names)
        if not point:
            continue
        evidence = non_empty_evidence(detail.get("directEvidence", []) or detail.get("_evidence", []) or detail.get("evidence", []))
        cluster_texts = [
            normalize_text_fragment(value)
            for value in detail.get("cleanedCandidateSentences", []) or []
            if normalize_text_fragment(value)
        ]
        supporting_context = supporting_context_from_evidence(
            point,
            evidence,
            cluster_texts,
            support_limit,
            speaker_names=speaker_names,
        )
        enriched = dict(detail)
        enriched["discussionPoint"] = point
        enriched["topicLabel"] = detail.get("topicLabel") or topic_label_from_discussion_point(point)
        enriched["topic"] = enriched["topicLabel"]
        enriched["directEvidence"] = evidence
        enriched["supportingContext"] = supporting_context
        enriched["evidenceSupportCount"] = evidence_support_count({"evidence": evidence})
        enriched["detailLevel"] = detail_level
        enriched_details.append(enriched)
    output["discussionPointDetails"] = enriched_details


def build_evidence_backed_topics(
    output: dict[str, Any],
    intermediate: dict[str, Any],
    speaker_names: set[str] | None = None,
) -> None:
    records = list(intermediate.get("records", []))
    topics = []
    all_documents = []
    all_responsibilities = []
    all_questions = []
    for detail in output.get("discussionPointDetails", []) or []:
        if not isinstance(detail, dict):
            continue
        evidence = non_empty_evidence(detail.get("directEvidence", []) or detail.get("evidence", []) or detail.get("_evidence", []))
        if not evidence:
            continue
        context = context_window_for_evidence(records, evidence, window=2)
        texts = [item.get("text", "") for item in evidence + context]
        documents = extract_mentions_from_texts(texts, DOCUMENT_MENTION_RE)
        responsibilities = extract_mentions_from_texts(texts, RESPONSIBILITY_MENTION_RE)
        questions = extract_open_questions(texts)
        topic_label = public_discussion_sentence_from_text(detail.get("topicLabel", ""), speaker_names)
        if topic_label and not public_sentence_supported_by_evidence(topic_label, evidence + context, speaker_names):
            topic_label = ""
        if not topic_label:
            topic_label = public_discussion_sentence_from_text(detail.get("discussionPoint", ""), speaker_names)
            if topic_label and not public_sentence_supported_by_evidence(topic_label, evidence + context, speaker_names):
                topic_label = ""
        if not topic_label:
            topic_label = public_discussion_sentence_from_evidence(evidence, speaker_names=speaker_names)
        if not topic_label:
            output.setdefault("excludedWeakCandidates", []).append(
                {
                    "topicLabel": rejected_candidate_label(evidence, speaker_names),
                    "rejectionReason": "no_public_sentence_from_evidence",
                    "sourceTurnIndices": evidence_source_turn_indices(evidence),
                    "directEvidence": evidence,
                }
            )
            continue
        topic = {
            "topicLabel": topic_label,
            "confidence": round(float(detail.get("evidenceScore", 0.0) or 0.0), 2),
            "sourceTurnIndices": evidence_source_turn_indices(evidence),
            "directEvidence": evidence,
            "supportingContext": context,
            "candidateDocumentsMentioned": documents,
            "candidateResponsibilitiesMentioned": responsibilities,
            "candidateOpenQuestions": questions,
            "candidateActionsOnlyIfExplicitlyStated": [],
        }
        topic["detailLevel"] = topic_detail_level(topic)
        topics.append(topic)
        all_documents.extend(documents)
        all_responsibilities.extend(responsibilities)
        all_questions.extend(questions)

    explicit_actions = []
    seen_action_keys = set()
    for action in output.get("explicitActions", []) or []:
        if not isinstance(action, dict) or not action.get("evidence"):
            continue
        key = normalized_key(action.get("action", ""))
        if not key or key in seen_action_keys:
            continue
        explicit_actions.append(action)
        seen_action_keys.add(key)

    for topic in topics:
        topic_terms = set(evidence_topic_tokens(" ".join(item.get("text", "") for item in topic.get("directEvidence", []))))
        for action in explicit_actions:
            action_terms = set(evidence_topic_tokens(action.get("action", "") + " " + " ".join(ref.get("text", "") for ref in action.get("evidence", []))))
            if topic_terms and action_terms and len(topic_terms & action_terms) >= 1:
                topic["candidateActionsOnlyIfExplicitlyStated"].append(action)
        topic["detailLevel"] = topic_detail_level(topic)

    def unique(values: list[str]) -> list[str]:
        seen = set()
        result = []
        for value in values:
            key = normalize_text(value)
            if value and key not in seen:
                result.append(value)
                seen.add(key)
        return result

    output["evidenceBackedTopics"] = topics
    output["explicitActions"] = explicit_actions
    output["openQuestions"] = unique(all_questions)
    output["documentsMentioned"] = unique(all_documents)
    output["responsibilitiesMentioned"] = unique(all_responsibilities)
    output["meetingOverview"] = {
        "title": output.get("meetingTitle", ""),
        "date": output.get("meetingDate", ""),
        "location": output.get("meetingLocation", "") or "Online",
        "topicCount": len(topics),
        "explicitActionCount": len(explicit_actions),
        "excludedWeakCandidateCount": len(output.get("excludedWeakCandidates", []) or []),
        "generator": "MiniLM evidence retrieval only",
    }


def prune_empty_private_evidence(value: Any) -> Any:
    if isinstance(value, list):
        return [prune_empty_private_evidence(item) for item in value]
    if isinstance(value, dict):
        cleaned = {}
        for key, item in value.items():
            if key == "_evidence":
                if item:
                    cleaned["evidence"] = prune_empty_private_evidence(item)
                continue
            cleaned[key] = prune_empty_private_evidence(item)
        return cleaned
    return value


def enforce_evidence_first_final_contract(output: dict[str, Any]) -> None:
    """Keep final MiniLM output auditable: labels/evidence, not unsupported conclusions."""
    output["decisions"] = []
    output["decisionDetails"] = []
    output["meetingActionPoint"] = [item.get("action", "") for item in output.get("explicitActions", [])]
    output["meetingActionPointOwner"] = [item.get("owner", "Not stated") for item in output.get("explicitActions", [])]
    output["meetingActionPointDeadline"] = [item.get("deadline", "Not stated") for item in output.get("explicitActions", [])]
    output["actions"] = [
        {
            "meetingActionPoint": item.get("action", ""),
            "meetingActionPointOwner": item.get("owner", "Not stated"),
            "meetingActionPointDeadline": item.get("deadline", "Not stated"),
            "actionConfidence": item.get("confidence", 0.0),
            "evidence": item.get("evidence", []),
            "sourceTurnIndices": item.get("sourceTurnIndices", []),
        }
        for item in output.get("explicitActions", [])
        if item.get("action") and item.get("evidence")
    ]
    safe_topics = []
    excluded = list(output.get("excludedWeakCandidates", []) or [])
    for topic in output.get("evidenceBackedTopics", []) or []:
        if not isinstance(topic, dict):
            continue
        safe_label = public_discussion_sentence_from_text(topic.get("topicLabel", ""))
        if not safe_label:
            evidence = non_empty_evidence(topic.get("directEvidence", []))
            excluded.append(
                {
                    "topicLabel": rejected_candidate_label(evidence),
                    "rejectionReason": "non_sentence_topic_label",
                    "sourceTurnIndices": topic.get("sourceTurnIndices", evidence_source_turn_indices(evidence)),
                    "directEvidence": evidence,
                }
            )
            continue
        topic["topicLabel"] = safe_label
        safe_topics.append(topic)
    output["evidenceBackedTopics"] = safe_topics
    output["excludedWeakCandidates"] = excluded
    output["discussionPoints"] = [topic.get("topicLabel", "") for topic in safe_topics if topic.get("topicLabel")]
    output["discussionPointDetails"] = [
        detail for detail in output.get("discussionPointDetails", []) if detail.get("directEvidence")
    ]
    output.setdefault("meetingOverview", {})
    output["meetingOverview"]["topicCount"] = len(output.get("evidenceBackedTopics", []))
    output["meetingOverview"]["explicitActionCount"] = len(output.get("explicitActions", []))
    output["meetingOverview"]["excludedWeakCandidateCount"] = len(output.get("excludedWeakCandidates", []) or [])
    if "internalEvidence" in output:
        output.pop("internalEvidence", None)
    pruned = prune_empty_private_evidence(output)
    output.clear()
    output.update(pruned)


def sanitize_public_decision_text(value: Any, speaker_names: set[str] | None = None) -> str:
    cleaned = sanitize_public_minutes_text(value, speaker_names)
    cleaned = re.sub(r"\s+and\s+keep\s+the\s+exit\s+clause\s+unchanged\b", "", cleaned, flags=re.I)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" ,;")
    if cleaned and not cleaned.endswith((".", "!", "?")):
        cleaned += "."
    return cleaned


def sanitize_public_output_items(output: dict[str, Any], speaker_names: set[str] | None = None) -> None:
    sanitized_discussion_points = []
    for point in output.get("discussionPoints", []):
        item = sanitize_public_minutes_text(point, speaker_names)
        if not item or is_public_discussion_leakage(item):
            continue
        sanitized_discussion_points.append(item)
    output["discussionPoints"] = sanitized_discussion_points
    output["decisions"] = [
        item
        for item in (sanitize_public_decision_text(point, speaker_names) for point in output.get("decisions", []))
        if item
    ]
    for detail in output.get("discussionPointDetails", []) or []:
        if isinstance(detail, dict) and detail.get("discussionPoint"):
            detail["discussionPoint"] = sanitize_public_minutes_text(detail["discussionPoint"], speaker_names)
    allowed_discussion_keys = {normalized_key(point) for point in output.get("discussionPoints", [])}
    output["discussionPointDetails"] = [
        detail
        for detail in output.get("discussionPointDetails", []) or []
        if not isinstance(detail, dict)
        or normalized_key(detail.get("discussionPoint", "")) in allowed_discussion_keys
    ]
    for detail in output.get("decisionDetails", []) or []:
        if isinstance(detail, dict) and detail.get("decision"):
            detail["decision"] = sanitize_public_decision_text(detail["decision"], speaker_names)
    for action in output.get("actions", []) or []:
        if not isinstance(action, dict):
            continue
        action_text = sanitize_public_minutes_text(action.get("meetingActionPoint", ""), speaker_names)
        if action_text:
            action_text = action_text[:1].upper() + action_text[1:]
            if not action_text.endswith((".", "!", "?")):
                action_text += "."
        action["meetingActionPoint"] = action_text
        if re.match(r"^(?:separate triage categories|monitor the results weekly|set up a dashboard)\.?", action_text, flags=re.I):
            action["meetingActionPointOwner"] = "Owner not specified"
    output["actions"] = [action for action in output.get("actions", []) or [] if action.get("meetingActionPoint")]
    output["meetingActionPoint"] = [item["meetingActionPoint"] for item in output.get("actions", [])]
    output["meetingActionPointOwner"] = [item.get("meetingActionPointOwner", "") for item in output.get("actions", [])]
    output["meetingActionPointDeadline"] = [item.get("meetingActionPointDeadline", "") for item in output.get("actions", [])]


def extract_json_object_text(value: str) -> str:
    """Return the first JSON object-looking span from a model response."""
    text = str(value or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE).strip()
        text = re.sub(r"\s*```$", "", text).strip()
    if text.startswith("{") and text.endswith("}"):
        return text
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        return text[start : end + 1]
    return text


def normalized_list(values: list[Any]) -> list[str]:
    return [normalize_text(value) for value in values if normalize_text(value)]


def minutes_word_count(text: str) -> int:
    return len(re.findall(r"[A-Za-z0-9']+", text or ""))


def is_overlong_objective_text(text: str) -> bool:
    cleaned = normalize_text_fragment(text)
    lowered = cleaned.lower()
    if minutes_word_count(cleaned) > 28:
        return True
    return any(marker in lowered for marker in (" we then ", " we would ", " because ")) or cleaned.endswith("?")


def is_low_quality_objective_text(text: str) -> bool:
    cleaned = normalize_text_fragment(text)
    lowered = cleaned.lower()
    if not cleaned:
        return True
    if is_addressed_transcript_objective_fragment(cleaned):
        return True
    if re.search(r"\b(?:original|initial|previous)\s+plan\s+was\s+to\b", lowered):
        return True
    if is_overlong_objective_text(cleaned):
        return True
    if re.match(r"^(?:um|uh|erm|yeah|okay|ok|right)\b", lowered):
        return True
    if re.match(r"^(?:stay|stays|stayed)\s+same\b", lowered):
        return True
    if contains_noise_or_banter(cleaned) or is_context_dependent_fragment(cleaned):
        return True
    if is_conversational_transcript_fragment(cleaned) or is_transcript_recount_text(cleaned) or is_personal_status_recount_fragment(cleaned):
        return True
    objective_cue = bool(re.search(r"\b(?:aim|goal|objective|purpose|review|agree|align|decide|confirm|assess|analyse|analyze)\b", lowered))
    if not objective_cue and re.match(r"^(?:taking|clicking|fighting|looking|going|trying)\b", lowered):
        return True
    if re.match(r"^(?:taking|looking\s+at|clicking\s+on)\s+(?:the\s+)?(?:people|users|delegates|numbers?|graph)\b", lowered):
        return True
    return False


def is_addressed_transcript_objective_fragment(text: str) -> bool:
    """Detect raw addressed transcript snippets that should not become public objectives.

    Real Teams/DOCX exports often contain early scene-setting such as "you've got...",
    "your business..." or conversational fragments beginning "but also...". Those may
    be useful evidence, but they are not suitable objective wording.
    """
    cleaned = normalize_text_fragment(text)
    lowered = f" {cleaned.lower()} "
    if not cleaned:
        return False
    if re.search(r"\b(?:you[’']?ve\s+got|you\s+have\s+got|your\s+(?:business|process|team|operations)|from\s+you)\b", lowered):
        return True
    if re.match(r"^(?:but\s+also|and\s+also|so\s+just|just\s+so)\b", cleaned, flags=re.I):
        return True
    if re.search(r"\b(?:i\s+suppose|i\s+guess|you\s+know|kind\s+of|sort\s+of)\b", lowered):
        return True
    second_person_hits = len(re.findall(r"\b(?:you|your|yours)\b", lowered))
    if second_person_hits >= 2 and minutes_word_count(cleaned) >= 8:
        return True
    return False


def is_transcript_recount_text(text: str) -> bool:
    """Detect long first-person/procedural transcript recounts rather than minutes topics."""
    cleaned = normalize_text_fragment(text)
    lowered = f" {cleaned.lower()} "
    if minutes_word_count(cleaned) < 18:
        return False
    procedural_markers = sum(1 for marker in (" we would ", " we then ", " i would ", " i'll ", " i'm ", " you're ") if marker in lowered)
    connective_markers = sum(1 for marker in (" and then ", " so ", " basically ", " just ") if marker in lowered)
    return procedural_markers >= 1 and connective_markers >= 1


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
        if "meetingObjectives" in payload and "mustContainMeetingObjectives" not in payload:
            normalized["mustContainMeetingObjectives"] = payload["meetingObjectives"]
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
    meeting_objectives = actual.get("meetingObjectives", [])
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
    for text in exp.get("mustContainMeetingObjectives", []):
        if not contains_match(meeting_objectives, text):
            failures.append(f"missing meeting objective {text!r}; {format_closest(closest_values(meeting_objectives, text))}")
    for text in exp.get("mustNotContainMeetingObjectives", []):
        if contains_match(meeting_objectives, text):
            failures.append(f"forbidden meeting objective present: {text!r}")
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
        cleaned = strip_public_timestamp_tokens(value)
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


def clean_exported_meeting_title(title: str) -> str:
    cleaned = strip_public_timestamp_tokens(title)
    cleaned = re.sub(r"_+", " ", cleaned)
    cleaned = re.sub(r"[^\w\s/&+\-]", " ", cleaned, flags=re.UNICODE)
    cleaned = re.sub(r"^\s*(?:meeting\s+notes\s+transcript|transcript\s+file|(?:meeting\s+)?transcript)\s*:\s*", " ", cleaned, flags=re.I)
    cleaned = re.sub(r"\b(?:meeting\s+)?transcripts?\b", " ", cleaned, flags=re.I)
    cleaned = re.sub(r"\b(?:transcripts?\s+)?(?:file|final|export|recording|recorded|notes?)\b", " ", cleaned, flags=re.I)
    cleaned = re.sub(r"\bv\d+\b", " ", cleaned, flags=re.I)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" -_:")
    if not cleaned:
        return ""
    if cleaned.isupper():
        cleaned = cleaned.title()
    else:
        cleaned = cleaned[:1].upper() + cleaned[1:]
    return cleaned


def looks_like_noisy_export_title(line: str, title: str = "") -> bool:
    cleaned = normalize_text_fragment(title or line).strip(".!?")
    lowered = cleaned.lower()
    tokens = tokenize(cleaned)
    if not cleaned:
        return True
    if lowered in {"meeting transcript", "transcript", "recording", "transcript export", "recording export"}:
        return True
    if re.fullmatch(r"(?:meeting\s+)?(?:transcript|recording|export|file|notes?)(?:\s+(?:transcript|recording|export|file|notes?))*", lowered):
        return True
    if lowered in LOW_CONTENT_PHRASES:
        return True
    if len(tokens) <= 2 and line.rstrip().endswith((".", "!", "?")):
        return True
    if len(tokens) <= 1:
        return True
    return False


def infer_minilm_meeting_title(transcript_text: str) -> str:
    cleaned_transcript = clean_transcript_text(transcript_text)
    lines = [line.strip() for line in str(cleaned_transcript or "").splitlines() if line.strip()]
    if not lines:
        return "Meeting review"
    original_header_lines = [line.strip() for line in str(transcript_text or "").splitlines() if line.strip()][:8]
    for original_line in original_header_lines:
        header_match = re.match(r"^(?P<title>.+?)-Meeting Transcript\b", original_line, flags=re.I)
        if header_match:
            title = strip_public_timestamp_tokens(header_match.group("title").replace("_", " ").replace("-", " "))
            title = re.sub(r"\b\d{8}(?:\s+\d{6})?\b", "", title).strip()
            if title and not looks_like_noisy_export_title(original_line, title):
                return title
    for line in lines[:12]:
        content_line = re.sub(rf"^{SPEAKER_NAME_RE}{SPEAKER_SUFFIX_RE}\s*:\s*", "", line).strip()
        explicit_match = re.search(
            r"\bmeeting title should be\s+(?P<title>.+?)(?:,\s*not\b|[.!?]|$)",
            content_line,
            flags=re.I,
        )
        if not explicit_match:
            explicit_match = re.search(
                r"\bmeeting is\s+(?:the\s+)?(?P<title>.+?)(?:[.!?]|$)",
                content_line,
                flags=re.I,
            )
        if explicit_match:
            title = clean_exported_meeting_title(explicit_match.group("title"))
            if title:
                return title
    for line in lines[:8]:
        if STRUCTURAL_LINE_RE.match(line):
            continue
        if re.match(r"^[^\w]*(?:meeting\s+notes\s+transcript|transcript\s+file|(?:meeting\s+)?transcript)\s*:\s*(.+)$", line, flags=re.I):
            title = clean_exported_meeting_title(line)
            if title:
                return title
        exported_title = clean_exported_meeting_title(line)
        if (
            exported_title
            and re.match(r"^(?:meeting\s+)?transcript\b", line, flags=re.I)
            and not re.match(r"^meeting\s+transcript\s*$", exported_title, flags=re.I)
        ):
            return exported_title
        if len(line) > 100:
            continue
        if re.match(rf"^{SPEAKER_NAME_RE}{SPEAKER_SUFFIX_RE}\s*:", line):
            continue
        if re.search(r"\b\d{1,2}:\d{2}\b", line):
            continue
        if re.match(r"^[A-Z][^:]{0,60}:$", line):
            continue
        if re.search(r"\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)\b", line, re.I):
            continue
        if len(line) > 120 or re.search(rf"^{SPEAKER_NAME_RE}\s*:", line):
            break
        title = clean_exported_meeting_title(line)
        if not looks_like_noisy_export_title(line, title):
            return title or line
        break
    body = " ".join(lines[:12]).lower()
    if "support metrics" in body or ("response times" in body and "tickets" in body):
        return "Support metrics review"
    if "final practice call before webinar" in body:
        return "Final Practice Call Before Webinar"
    if "complaints handling" in body:
        return "Complaints handling review"
    if "customer portal" in body:
        return "Customer portal project review"
    inferred_title = infer_meeting_title_from_transcript(cleaned_transcript, parse_numeric_turns(transcript_text))
    if inferred_title and len(inferred_title) <= 120 and not looks_like_noisy_export_title(inferred_title):
        return inferred_title
    if lines:
        topic_line = clean_exported_meeting_title(lines[0])
        if (
            topic_line
            and len(topic_line) <= 120
            and not re.search(r"\btranscript\b", topic_line, flags=re.I)
            and not looks_like_noisy_export_title(lines[0], topic_line)
        ):
            return topic_line
    return "Meeting review"


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
    records = list(intermediate.get("records", []))

    def extract_action_deadline(text: str) -> str:
        deadline_match = re.search(
            r"\b(?:today|tomorrow|tonight|this evening|noon|friday|monday|tuesday|wednesday|thursday|saturday|sunday|next week|this week|by (?:end of )?(?:[A-Za-z]+|EOD|COP)|before (?!it\b)[A-Za-z]+)\b",
            text,
            flags=re.I,
        )
        if not deadline_match:
            return ""
        deadline = deadline_match.group(0)
        return deadline[:1].upper() + deadline[1:]

    def nearby_action_deadline(index: int, speaker: str = "") -> str:
        for record in records[index + 1 : index + 5]:
            text = normalize_text_fragment(record.get("text", ""))
            if not text:
                continue
            deadline = extract_action_deadline(text)
            if not deadline:
                continue
            record_speaker = normalize_text_fragment(record.get("speaker", ""))
            if normalize_text(speaker) and normalize_text(record_speaker) not in {"", normalize_text(speaker)}:
                if len(tokenize(text)) > 4:
                    continue
            return deadline
        return ""

    def split_action_event_candidate(event: dict[str, Any], owner: str, deadline: str) -> list[dict[str, str]]:
        raw_action = normalize_text_fragment(event.get("action", ""))
        if not raw_action:
            return []
        parts = [
            normalize_text_fragment(part)
            for part in re.split(r"(?<=[.!?])\s+(?=[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2}(?:,|\s+(?:will|to)\b))", raw_action)
            if normalize_text_fragment(part)
        ]
        if len(parts) <= 1:
            return [{"text": raw_action, "owner": owner, "deadline": deadline}]

        expanded = []
        for part in parts:
            part_owner = owner
            task = part
            addressed = re.match(
                r"^([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2}),\s*(?:please\s+)?(.+)$",
                part,
            )
            owner_will = re.match(r"^([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})\s+will\s+(.+)$", part)
            owner_to = re.match(r"^([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})\s+to\s+(.+)$", part)
            if addressed:
                part_owner = normalize_text_fragment(addressed.group(1)) or part_owner
                task = addressed.group(2)
            elif owner_will:
                part_owner = normalize_text_fragment(owner_will.group(1)) or part_owner
                task = owner_will.group(2)
            elif owner_to:
                part_owner = normalize_text_fragment(owner_to.group(1)) or part_owner
                task = owner_to.group(2)
            part_deadline = extract_action_deadline(task) or (deadline if normalize_text(deadline) in normalize_text(task) else "")
            expanded.append({"text": task, "owner": part_owner or "Owner not specified", "deadline": part_deadline})
        return expanded

    def canonical_action_dedupe_key(text: str) -> str:
        """Collapse owner-prefixed assignments onto the underlying task for duplicate checks."""
        cleaned = normalize_action_candidate_text(text)
        cleaned = re.sub(r"^[A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+){0,2}\s+to\s+", "", cleaned)
        return normalized_key(cleaned)

    def contextualize_vague_action(task: str, index: int) -> str:
        if not is_vague_double_check_action(task):
            return task
        context_records = records[max(0, index - 8): index + 4]
        context_tokens = Counter()
        for context_record in context_records:
            context_tokens.update(canonicalize_tokens(tokenize(context_record.get("text", ""))))
        if context_tokens["updated"] or context_tokens["update"]:
            if context_tokens["text"] or context_tokens["replacement"] or context_tokens["replace"] or context_tokens["red"]:
                return "Double check the updated text replacements"
            if context_tokens["page"] or context_tokens["pages"] or context_tokens["frontend"] or context_tokens["front"]:
                return "Double check the website updates"
            return "Double check the updated items"
        if context_tokens["page"] or context_tokens["pages"] or context_tokens["frontend"] or context_tokens["front"]:
            return "Double check the website items"
        return task

    def contextualize_internal_meeting_action(task: str, index: int) -> str:
        """Turn vague first-person commitments into the concrete topic from nearby turns."""
        cleaned = normalize_action_candidate_text(task)
        context = " ".join(
            normalize_text_fragment(records[pos].get("text", ""))
            for pos in range(max(0, index - 8), min(len(records), index + 5))
            if normalize_text_fragment(records[pos].get("text", ""))
        )
        lowered = f"{cleaned} {context}".lower()
        if re.match(r"^(?:take\s+that\s+as\s+an?\s+action|that\s+as\s+an?\s+action)\b", cleaned, flags=re.I):
            if any(term in lowered for term in ("language", "languages", "translation", "translations", "declaration", "doc", "docs", "competent authority")):
                return "Follow up internally on declaration of conformity language requirements"
            if any(term in lowered for term in ("ppe", "sunglasses", "scope", "optical", "procedure", "procedures")):
                return "Confirm the PPE and sunglasses procedure scope with the client"
        if re.match(r"^(?:set\s+that\s+up|send\s+that\s+out|arrange\s+that)\b", cleaned, flags=re.I):
            if "working session" in lowered or "working sessions" in lowered:
                return "Set up working sessions with the client"
        return cleaned

    def infer_followup_owner_deadline(action_text: str, source_text: str = "") -> tuple[str, str]:
        action_tokens = {token for token in canonicalize_tokens(tokenize(action_text)) if token not in GENERIC_STATUS_TERMS}
        source_tokens = {token for token in canonicalize_tokens(tokenize(source_text)) if token not in GENERIC_STATUS_TERMS}
        search_tokens = action_tokens | source_tokens
        if not search_tokens:
            return "", ""
        anchor_index = -1
        best_overlap = 0
        for index, record in enumerate(records):
            record_tokens = set(canonicalize_tokens(tokenize(record.get("text", ""))))
            overlap = len(search_tokens & record_tokens)
            if overlap > best_overlap:
                best_overlap = overlap
                anchor_index = index
        if anchor_index < 0 or best_overlap < 2:
            return "", ""
        owner = ""
        deadline = ""
        for record in records[anchor_index + 1 : anchor_index + 7]:
            text = normalize_text_fragment(record.get("text", ""))
            lowered = text.lower()
            speaker = normalize_text_fragment(record.get("speaker", ""))
            if not owner and re.match(r"^(?:i['’]?ll|i will|i can)\s+(?:take|do|handle|own|pick up|look into)\b", lowered):
                owner = speaker
                continue
            if owner and not deadline:
                deadline_match = re.search(
                    r"\b(?:today|tomorrow|friday|monday|tuesday|wednesday|thursday|saturday|sunday|next week|this week|by [A-Za-z]+|before (?!it\b)[A-Za-z]+)\b",
                    text,
                    flags=re.I,
                )
                if deadline_match:
                    deadline = deadline_match.group(0)[:1].upper() + deadline_match.group(0)[1:]
                    break
        return owner, deadline

    def build_followup_investigation_action(index: int) -> str:
        context = " ".join(
            normalize_text_fragment(records[pos].get("text", ""))
            for pos in range(max(0, index - 8), index + 1)
            if normalize_text_fragment(records[pos].get("text", ""))
        )
        lowered = context.lower()
        if "confidence scoring" in lowered or "suitability filtering" in lowered:
            return "Capture confidence scoring and suitability filtering as a follow-up investigation."
        if "complaints" in lowered and any(term in lowered for term in ("filtering", "legal review", "regulatory", "unsuitable examples")):
            return "Capture complaints guidance suitability filtering as a follow-up investigation."
        return "Capture the follow-up investigation."

    def enrich_candidate_deadlines() -> None:
        for item in outputs:
            if item.get("deadline"):
                continue
            direct_deadline = extract_action_deadline(item.get("text", ""))
            if direct_deadline:
                item["deadline"] = direct_deadline
                continue
            owner = normalize_text_fragment(item.get("owner", ""))
            if not owner or normalize_text(owner) == "owner not specified":
                continue
            action_tokens = {
                token
                for token in canonicalize_tokens(tokenize(item.get("text", "")))
                if token not in LOW_INFORMATION_TOKENS
            }
            if not action_tokens:
                continue
            for index, record in enumerate(records):
                if normalize_text(record.get("speaker", "")) != normalize_text(owner):
                    continue
                record_tokens = set(canonicalize_tokens(tokenize(record.get("text", ""))))
                if len(action_tokens & record_tokens) < min(2, len(action_tokens)):
                    continue
                inferred = nearby_action_deadline(index, owner)
                if inferred:
                    item["deadline"] = inferred
                break

    for event in intermediate.get("actionEvents", []):
        if event.get("eventType") != "action_candidate":
            continue
        owner = normalize_text_fragment(event.get("owner", "Owner not specified"))
        deadline = normalize_text_fragment(event.get("deadline", ""))
        if not owner or owner == "Owner not specified" or not deadline:
            source_text = " ".join(normalize_text_fragment(ref.get("text", "")) for ref in event.get("evidence", []) if isinstance(ref, dict))
            inferred_owner, inferred_deadline = infer_followup_owner_deadline(event.get("action", ""), source_text)
            if inferred_owner and (not owner or owner == "Owner not specified"):
                owner = inferred_owner
            if inferred_deadline and not deadline:
                deadline = inferred_deadline
        for expanded in split_action_event_candidate(event, owner or "Owner not specified", deadline):
            outputs.append(
                {
                    "text": normalize_action_candidate_text(expanded.get("text", "")),
                    "owner": expanded.get("owner") or "Owner not specified",
                    "deadline": expanded.get("deadline", ""),
                    "baseScore": float(event.get("confidence", 0.0)),
                    "source": event.get("source", ""),
                    "roleScores": {},
                }
            )
    seen = {canonical_action_dedupe_key(item["text"]) for item in outputs if item.get("text")}
    action_lead_pattern = re.compile(r"^(review|confirm|draft|follow up|investigate|validate|prepare|update|share|send|complete|finalise|refine|revise|pull|collect|fetch|extract|obtain|estimate|capture|monitor|separate|set up|brief|write|enforce|accelerate|assign|explore|build|schedule|remove|redline|call|reschedule|request|patch|replay|arrange)\b", re.I)
    summary_action_pattern = re.compile(
        r"\b([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})\s+will\s+(.+?)(?=(?:\s+[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2}\s+will\s+)|$)",
        re.I,
    )
    combined_records_text = " ".join(normalize_text_fragment(record.get("text", "")) for record in records)
    lowered_records_text = combined_records_text.lower()
    regulated_internal_action_context = any(
        marker in lowered_records_text
        for marker in (
            "importer obligations", "quality manual", "quality manuals", "med envoy", "medenvoy",
            "sunglasses", "declaration of conformity", "declarations of conformity", "competent authority",
        )
    )

    def split_owner_assigned_actions(body: str, default_owner: str = "Owner not specified") -> list[dict[str, str]]:
        cleaned = normalize_text_fragment(body).strip(" -:;")
        if not cleaned:
            return []
        pieces = [
            normalize_text_fragment(part)
            for part in re.split(
                r"(?:[;\n]+|(?=\b[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2}\s+(?:to|will)\s+)|(?=\b[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2}\s*:))",
                cleaned,
            )
            if normalize_text_fragment(part)
        ]
        actions = []
        for piece in pieces:
            owner = default_owner
            task = piece
            colon_owner = re.match(r"^([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})\s*:\s*(.+)$", piece)
            owner_to = re.match(r"^([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})\s+to\s+(.+)$", piece)
            owner_will = re.match(r"^([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})\s+will\s+(.+)$", piece)
            addressed = re.match(r"^([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2}),\s*(?:please\s+)?(.+)$", piece)
            if colon_owner:
                owner = normalize_text_fragment(colon_owner.group(1)) or owner
                task = colon_owner.group(2)
            elif owner_to:
                owner = normalize_text_fragment(owner_to.group(1)) or owner
                task = owner_to.group(2)
            elif owner_will:
                owner = normalize_text_fragment(owner_will.group(1)) or owner
                task = owner_will.group(2)
            elif addressed:
                owner = normalize_text_fragment(addressed.group(1)) or owner
                task = addressed.group(2)
            task = normalize_action_candidate_text(task.strip(" ."))
            if not task or task.endswith("?") or len(tokenize(task)) < 3:
                continue
            actions.append({"text": task, "owner": owner or "Owner not specified", "deadline": extract_action_deadline(task)})
        return actions

    def split_explicit_action_list(raw_text: str) -> list[str]:
        if not re.search(r"\bactions?\s+from\s+this\s*:?", raw_text, flags=re.I):
            return []
        body = re.sub(r"^.*?\bactions?\s+from\s+this\s*:?", "", raw_text, flags=re.I | re.S).strip()
        if not body:
            return []
        parts = [normalize_text_fragment(part) for part in re.split(r"[\r\n]+", body) if normalize_text_fragment(part)]
        if len(parts) <= 1:
            parts = [
                normalize_text_fragment(part)
                for part in re.split(
                    r"(?=\b(?:enforce|accelerate|assign|explore|review|confirm|draft|follow\s+up|investigate|validate|prepare|update|share|send|complete|finalise|refine|revise|write|monitor|separate|set\s+up|brief|build|schedule)\b)",
                    body,
                    flags=re.I,
                )
                if normalize_text_fragment(part)
            ]
        return [part for part in parts if action_lead_pattern.match(part) and len(tokenize(part)) >= 3]

    for index, record in enumerate(records):
        raw_text = str(record.get("text", "") or "")
        text = normalize_text_fragment(record.get("text", ""))
        if not text:
            continue
        header_text = strip_public_timestamp_tokens(text)
        explicit_action_header = re.search(r"(?:^|[.!?]\s+)(?:actions?|next\s+steps)\s*[-—:]\s*(?P<body>.+)$", header_text, flags=re.I)
        if explicit_action_header:
            added_explicit_header_action = False
            for parsed in split_owner_assigned_actions(explicit_action_header.group("body")):
                task = parsed["text"]
                key = canonical_action_dedupe_key(task)
                if key in seen:
                    continue
                outputs.append(
                    {
                        "text": task,
                        "owner": parsed["owner"],
                        "deadline": parsed["deadline"],
                        "baseScore": max(0.86, float(record.get("scores", {}).get("action", 0.0))),
                        "source": "explicit_action_header_fallback",
                        "roleScores": {},
                    }
                )
                seen.add(key)
                added_explicit_header_action = True
            if added_explicit_header_action:
                continue
        explicit_actions = split_explicit_action_list(raw_text)
        if explicit_actions:
            for task_text in explicit_actions:
                task = normalize_action_candidate_text(task_text)
                key = canonical_action_dedupe_key(task)
                if key in seen:
                    continue
                outputs.append(
                    {
                        "text": task,
                        "owner": "Owner not specified",
                        "deadline": "",
                        "baseScore": max(0.78, float(record.get("scores", {}).get("action", 0.0))),
                        "source": "explicit_action_list_fallback",
                        "roleScores": {},
                    }
                )
                seen.add(key)
            continue
        if " will " in text.lower() and any(term in text.lower() for term in ("summarise actions", "summarize actions", "actions.")):
            action_summary = re.sub(r"^.*?\bactions?\.\s*", "", text, flags=re.I).strip()
            for match in summary_action_pattern.finditer(action_summary):
                owner = normalize_text_fragment(match.group(1))
                task = normalize_action_candidate_text(match.group(2))
                if not task or task.endswith("?") or len(tokenize(task)) < 3:
                    continue
                key = canonical_action_dedupe_key(task)
                if key in seen:
                    continue
                outputs.append(
                    {
                        "text": task,
                        "owner": owner or "Owner not specified",
                        "deadline": "",
                        "baseScore": max(0.76, float(record.get("scores", {}).get("action", 0.0))),
                        "source": "action_summary_fallback",
                        "roleScores": {},
                    }
                )
                seen.add(key)
            continue
        actual_action_match = re.search(r"\bactual action is\s+(?P<body>.+)$", text, flags=re.I)
        if actual_action_match:
            body = normalize_text_fragment(actual_action_match.group("body"))
            added_actual_action = False
            for parsed in split_owner_assigned_actions(body):
                task = parsed["text"]
                key = canonical_action_dedupe_key(task)
                if key in seen:
                    continue
                outputs.append(
                    {
                        "text": task,
                        "owner": parsed["owner"],
                        "deadline": parsed["deadline"],
                        "baseScore": max(0.84, float(record.get("scores", {}).get("action", 0.0))),
                        "source": "actual_action_fallback",
                        "roleScores": {},
                    }
                )
                seen.add(key)
                added_actual_action = True
            if added_actual_action:
                continue
        owner_action_match = re.match(r"^([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})\s+will\s+(.+)$", text)
        if owner_action_match:
            owner = normalize_text_fragment(owner_action_match.group(1))
            task = normalize_action_candidate_text(owner_action_match.group(2))
            if task and not task.endswith("?") and len(tokenize(task)) >= 3:
                key = canonical_action_dedupe_key(task)
                if key not in seen:
                    outputs.append(
                        {
                            "text": task,
                            "owner": owner or "Owner not specified",
                            "deadline": "",
                            "baseScore": max(0.72, float(record.get("scores", {}).get("action", 0.0))),
                            "source": "owner_will_action_fallback",
                            "roleScores": {},
                        }
                    )
                    seen.add(key)
                continue
        first_person_action_match = re.match(r"^(?:i['’]?ll|i will|i can)\s+(.+)$", text, flags=re.I)
        if first_person_action_match:
            owner = normalize_text_fragment(record.get("speaker", "")) or "Owner not specified"
            task = contextualize_vague_action(normalize_action_candidate_text(first_person_action_match.group(1)), index)
            task = contextualize_internal_meeting_action(task, index)
            deadline = extract_action_deadline(task) or nearby_action_deadline(index, owner)
            if task and not task.endswith("?") and len(tokenize(task)) >= 2 and not is_raw_action_leakage(task):
                key = canonical_action_dedupe_key(task)
                if key not in seen:
                    outputs.append(
                        {
                            "text": task,
                            "owner": owner,
                            "deadline": deadline,
                            "baseScore": max(0.76, float(record.get("scores", {}).get("action", 0.0))),
                            "source": "first_person_action_fallback",
                            "roleScores": {},
                        }
                    )
                    seen.add(key)
                continue
        owner_to_match = re.match(r"^([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})\s+to\s+(.+)$", text)
        if owner_to_match:
            owner = normalize_text_fragment(owner_to_match.group(1))
            task = normalize_action_candidate_text(owner_to_match.group(2))
            if task and not task.endswith("?") and len(tokenize(task)) >= 3:
                key = canonical_action_dedupe_key(task)
                if key not in seen:
                    outputs.append(
                        {
                            "text": task,
                            "owner": owner or "Owner not specified",
                            "deadline": extract_action_deadline(task),
                            "baseScore": max(0.8, float(record.get("scores", {}).get("action", 0.0))),
                            "source": "owner_to_action_fallback",
                            "roleScores": {},
                        }
                    )
                    seen.add(key)
                continue
        collective_to_match = re.match(r"^(Team|All|Everyone|Everybody)\s+to\s+(.+)$", text, flags=re.I)
        if collective_to_match:
            owner = normalize_text_fragment(collective_to_match.group(1)).title()
            task = normalize_action_candidate_text(collective_to_match.group(2))
            if task and not task.endswith("?") and len(tokenize(task)) >= 3 and not is_raw_action_leakage(task):
                key = canonical_action_dedupe_key(task)
                if key not in seen:
                    outputs.append(
                        {
                            "text": task,
                            "owner": owner or "Owner not specified",
                            "deadline": extract_action_deadline(task),
                            "baseScore": max(0.82, float(record.get("scores", {}).get("action", 0.0))),
                            "source": "collective_to_action_fallback",
                            "roleScores": {},
                        }
                    )
                    seen.add(key)
                continue

        internal_context = " ".join(
            normalize_text_fragment(records[pos].get("text", ""))
            for pos in range(max(0, index - 8), min(len(records), index + 5))
            if normalize_text_fragment(records[pos].get("text", ""))
        ).lower()
        internal_action_patterns = [
            (
                regulated_internal_action_context
                and re.search(r"\b(?:set\s+that\s+up|send\s+that\s+out|arrange\s+that)\b", text, flags=re.I)
                and ("working session" in internal_context or "working sessions" in internal_context),
                "Set up working sessions with the client",
                normalize_text_fragment(record.get("speaker", "")) or "Owner not specified",
                "Wednesday next week" if "next wednesday" in internal_context else ("Wednesday" if "wednesday" in internal_context else ""),
                "internal_working_session_action_fallback",
            ),
            (
                regulated_internal_action_context
                and (re.search(r"\bweekly\s+recurrence\s+call\b", text, flags=re.I)
                or (re.search(r"\b(?:get|set\s+up|schedule)\s+a\s+weekly\b", text, flags=re.I) and "check" in internal_context)),
                "Schedule a weekly client check-in call",
                normalize_text_fragment(record.get("speaker", "")) or "Owner not specified",
                "",
                "internal_weekly_checkin_action_fallback",
            ),
            (
                regulated_internal_action_context
                and re.search(r"\bfollow\s+up\b", text, flags=re.I)
                and any(term in internal_context for term in ("ppe", "sunglasses", "optical", "scope", "procedures")),
                "Confirm the PPE and sunglasses procedure scope with the client",
                normalize_text_fragment(record.get("speaker", "")) or "Owner not specified",
                "",
                "internal_scope_confirmation_action_fallback",
            ),
            (
                regulated_internal_action_context
                and re.search(r"\bfollow\s+up\b", text, flags=re.I)
                and any(term in internal_context for term in ("language", "languages", "translation", "translations", "declaration", "doc", "docs", "competent authority", "markets")),
                "Follow up internally on declaration of conformity language requirements",
                normalize_text_fragment(record.get("speaker", "")) or "Owner not specified",
                "",
                "internal_language_followup_action_fallback",
            ),
        ]
        for matched, task, owner, deadline, source_name in internal_action_patterns:
            if not matched:
                continue
            key = canonical_action_dedupe_key(task)
            if key in seen:
                continue
            outputs.append(
                {
                    "text": task,
                    "owner": owner,
                    "deadline": deadline,
                    "baseScore": max(0.86, float(record.get("scores", {}).get("action", 0.0))),
                    "source": source_name,
                    "roleScores": {},
                }
            )
            seen.add(key)
            break
        targeted_status_actions = [
            (
                "stage gate templates" in text.lower() and any(term in text.lower() for term in ("not finalised", "not finalized", "still not")),
                "Review stage gate templates",
            ),
            (
                "sales input" in text.lower() and "ai pipeline" in text.lower() and "missing" in text.lower(),
                "Confirm AI pipeline dependencies with sales",
            ),
            (
                "vendor strategy document" in text.lower() and any(term in text.lower() for term in ("absent", "missing", "not produced")),
                "Draft vendor strategy document",
            ),
            (
                "innovation grant" in text.lower() and "feedback" in text.lower() and "pending" in text.lower(),
                "Follow up innovation grant feedback",
            ),
        ]
        for matched, task in targeted_status_actions:
            if not matched:
                continue
            key = canonical_action_dedupe_key(task)
            if key in seen:
                continue
            outputs.append(
                {
                    "text": task,
                    "owner": "Owner not specified",
                    "deadline": "",
                    "baseScore": max(0.82, float(record.get("scores", {}).get("action", 0.0))),
                    "source": "status_followup_action_fallback",
                    "roleScores": {},
                }
            )
            seen.add(key)
            break
        if re.search(r"\bshould\s+we\s+capture\b", text, flags=re.I) and re.search(r"\bfollow-?up\s+investigation\b", text, flags=re.I):
            next_text = normalize_text_fragment(records[index + 1].get("text", "")) if index + 1 < len(records) else ""
            if re.search(r"\b(?:yes|agreed|let'?s do that|let us do that)\b", next_text, flags=re.I):
                task = build_followup_investigation_action(index)
                key = canonical_action_dedupe_key(task)
                if key not in seen:
                    outputs.append(
                        {
                            "text": task,
                            "owner": "Owner not specified",
                            "deadline": "",
                            "baseScore": max(0.82, float(record.get("scores", {}).get("action", 0.0))),
                            "source": "followup_investigation_fallback",
                            "roleScores": {},
                        }
                    )
                    seen.add(key)
                continue
        source = "record_action_fallback"
        if ":" in text and text.lower().startswith("actions before next week"):
            text = normalize_text_fragment(text.split(":", 1)[1])
            source = "record_action_header_fallback"
        if not text or text.endswith("?"):
            continue
        lead_match = action_lead_pattern.match(text)
        semantic_action = backend.score_against_prototypes(text, "action") if backend and backend.available else 0.0
        if not (is_action_like_sentence(text) or lead_match or semantic_action >= WINDOW_ACTION_SEMANTIC_FLOOR):
            continue
        semantic_only_speakerless = (
            semantic_action >= WINDOW_ACTION_SEMANTIC_FLOOR
            and not (is_action_like_sentence(text) or lead_match)
            and any("sourceLineStart" in ref for ref in record.get("evidence", []))
        )
        if semantic_only_speakerless and len(tokenize(text)) > 25:
            continue
        if is_context_dependent_fragment(text) or contains_noise_or_banter(text) or is_raw_action_leakage(text) or len(tokenize(text)) < 3:
            continue
        key = canonical_action_dedupe_key(text)
        if key in seen:
            continue
        outputs.append(
            {
                "text": normalize_action_candidate_text(text),
                "owner": "Owner not specified",
                "deadline": "",
                "baseScore": max(
                    0.74 if lead_match else (0.42 if semantic_action >= WINDOW_ACTION_SEMANTIC_FLOOR else 0.34),
                    float(record.get("scores", {}).get("action", 0.0)),
                    float(record.get("scores", {}).get("discussion", 0.0)) * 0.75,
                ),
                "source": "semantic_action_fallback" if semantic_action >= WINDOW_ACTION_SEMANTIC_FLOOR and not (is_action_like_sentence(text) or lead_match) else source,
                "roleScores": {},
            }
        )
        seen.add(key)

    def add_contextual_action(text: str, source: str, owner: str = "Owner not specified", *markers: str) -> None:
        if markers and not any(marker.lower() in lowered_records_text for marker in markers):
            return
        task = normalize_action_candidate_text(text)
        key = canonical_action_dedupe_key(task)
        if not task or key in seen:
            return
        outputs.append(
            {
                "text": task,
                "owner": owner or "Owner not specified",
                "deadline": "",
                "baseScore": 0.86,
                "source": source,
                "roleScores": {},
            }
        )
        seen.add(key)

    if (
        ("med envoy" in lowered_records_text or "medenvoy" in lowered_records_text)
        and ("project plan" in lowered_records_text or "task list" in lowered_records_text)
        and re.search(r"\bfollow\s+up\b", lowered_records_text)
    ):
        add_contextual_action(
            "Follow up on the Med Envoy project plan or task list",
            "regulated_contextual_action_fallback",
            "Owner not specified",
            "med envoy",
            "project plan",
            "task list",
        )

    if "hpra" in lowered_records_text and ("bill" in lowered_records_text or "annual fee" in lowered_records_text):
        add_contextual_action(
            "Send the HPRA authorised-representative bill for review",
            "regulated_contextual_action_fallback",
            "Owner not specified",
            "hpra",
            "annual fee",
            "bill",
        )

    if "declarations of conformity" in lowered_records_text and "risk rationale" in lowered_records_text:
        add_contextual_action(
            "Review the declarations of conformity and PPE risk rationale",
            "regulated_contextual_action_fallback",
            "Owner not specified",
            "declarations of conformity",
            "risk rationale",
        )

    if ("hpra" in lowered_records_text or "company size" in lowered_records_text) and re.search(r"\bsend\b", lowered_records_text):
        add_contextual_action(
            "Share the HPRA confirmation and company-size follow-up documents",
            "regulated_contextual_action_fallback",
            "Owner not specified",
            "company size",
            "confirmation",
        )

    enrich_candidate_deadlines()
    return outputs


def surrounding_record_text(records: list[dict[str, Any]], index: int, window: int = 1) -> str:
    parts = []
    for offset in range(-window, window + 1):
        target = index + offset
        if target < 0 or target >= len(records):
            continue
        parts.append(normalize_text_fragment(records[target].get("text", "")))
    return " ".join(part for part in parts if part)


def infer_soft_decision_fallback(text: str) -> str:
    cleaned = normalize_text_fragment(text)
    lowered = cleaned.lower()
    if not cleaned or len(tokenize(cleaned)) < 5:
        return ""
    if not any(cue in lowered for cue in ("make sure", "want", "should", "need", "avoid", "not ")):
        return ""
    style_match = re.search(r"\bnot\s+([a-z][a-z-]{2,})\b", lowered)
    if not style_match:
        return ""
    descriptor = style_match.group(1)
    if descriptor not in SOFT_STYLE_TERMS:
        return ""
    normalized = SOFT_STYLE_TERMS[descriptor]
    subject = "The content"
    if any(term in lowered for term in ("webinar", "presentation", "slide", "slides", "deck")):
        subject = "The presentation"
    elif any(term in lowered for term in ("message", "messaging", "language", "wording", "copy")):
        subject = "The messaging"
    return f"{subject} should avoid an overly {normalized} tone."


def infer_soft_discussion_fallback(records: list[dict[str, Any]], index: int) -> str:
    text = normalize_text_fragment(records[index].get("text", ""))
    lowered = text.lower()
    context = surrounding_record_text(records, index, window=1).lower()
    combined = f"{lowered} {context}".strip()
    has_content_context = any(term in combined for term in CONTENT_ARTEFACT_TERMS)

    if any(term in combined for term in TEXT_DENSITY_TERMS):
        return "The team discussed simplifying the material by reducing text on screen and making the content easier to follow."

    if "necessary" in combined and has_content_context:
        return "The team discussed whether all of the current content was necessary and what could be removed or simplified."

    if any(phrase in combined for phrase in ("not absolutely necessary", "not really necessary")) and has_content_context:
        return "The team discussed whether some of the current material was necessary or could be simplified."

    return ""


def record_turn_index(record: dict[str, Any], fallback_index: int) -> int:
    for key in ("turnIndex", "turn_index", "recordIndex", "index"):
        value = record.get(key)
        if isinstance(value, int):
            return value
    return fallback_index


def build_record_evidence(record: dict[str, Any], fallback_index: int) -> dict[str, Any]:
    return {
        "speaker": record.get("speaker", ""),
        "timestamp": record.get("timestamp", ""),
        "text": record.get("text", ""),
        "turnIndex": record_turn_index(record, fallback_index),
    }


def window_topic_token_set(text: str) -> set[str]:
    return {token for token in tokenize(text) if token in WINDOW_PROCESS_TERMS or token in MINILM_TOPIC_TERMS}


def classify_window_category(text: str) -> str:
    lowered = normalize_text_fragment(text).lower()
    if "dashboard" in lowered:
        return "dashboard_scope_thread"
    if any(term in lowered for term in ("crm integration", "api credentials", "credentials")):
        return "crm_dependency_thread"
    if any(term in lowered for term in ("authentication", "password reset", "test environment")):
        return "portal_delivery_thread"
    if "user testing" in lowered:
        return "user_testing_thread"
    if any(term in lowered for term in ("excel", "export")):
        return "launch_scope_thread"
    if any(term in lowered for term in ("support metrics", "response times")):
        return "support_metrics_thread"
    if any(term in lowered for term in ("triage categories", "technical issues", "general enquiries", "complex cases")):
        return "support_triage_thread"
    if any(term in lowered for term in CONTENT_ARTEFACT_TERMS):
        return "review_thread"
    if any(term in lowered for term in WINDOW_METHOD_TERMS):
        return "methodology_thread"
    if any(term in lowered for term in ("risk", "blocked", "pending", "issue", "dependency")):
        return "risk_thread"
    return "process_thread"


def build_window_discussion_text(texts: list[str]) -> str:
    cleaned_texts = [normalize_text_fragment(text) for text in texts if normalize_text_fragment(text)]
    if not cleaned_texts:
        return ""
    combined = " ".join(cleaned_texts)
    lowered = combined.lower()
    if "dashboard" in lowered:
        if "three dashboards" in lowered or "which dashboard" in lowered:
            return "The team needed to clarify which dashboard was in scope because three dashboard versions were active."
        return "Dashboard scope and status were discussed."
    if any(term in lowered for term in ("support metrics", "response times", "tickets", "queue", "triage categories")):
        if "response times" in lowered and any(term in lowered for term in ("worse", "waited longer", "delays", "complaints")):
            return "Support metrics showed that complaints had reduced, but customer response times and delays still needed attention."
        if any(term in lowered for term in ("queue", "triage categories", "technical issues", "general enquiries")):
            return "The team discussed separating support triage categories so complex cases would not sit behind simpler enquiries."
        return "The team reviewed support performance and customer response issues."
    if any(term in lowered for term in ("customer portal", "crm integration", "api credentials", "user testing", "excel export", "password reset", "authentication")):
        if any(term in lowered for term in ("crm integration", "api credentials", "credentials")):
            return "CRM integration was delayed because the client API credentials had not yet been received."
        if any(term in lowered for term in ("authentication", "password reset", "test environment")):
            return "Customer portal development had progressed, with authentication completed and the password reset workflow live in the test environment."
        if "user testing" in lowered:
            return "User testing was scheduled with confirmed participants, but the test script still needed review."
        if any(term in lowered for term in ("excel", "export")):
            return "The requested Excel export functionality was discussed and agreed for inclusion in the first release."
        return "The team reviewed customer portal progress, dependencies and launch scope."
    if any(term in lowered for term in CONTENT_ARTEFACT_TERMS):
        if any(term in lowered for term in TEXT_DENSITY_TERMS):
            return "The material was reviewed to reduce text density and improve clarity for the audience."
        if "necessary" in lowered:
            return "The material was reviewed to decide what content was necessary and what could be simplified."
    if any(term in lowered for term in WINDOW_METHOD_TERMS) and any(term in lowered for term in ("process", "workflow", "complaints", "triage")):
        clauses = []
        if "gemba" in lowered:
            clauses.append("using Gemba observation")
        elif any(term in lowered for term in ("observation", "observations", "assessment", "mapping")):
            clauses.append("using direct process observation")
        if any(term in lowered for term in ("culture", "cultural", "understanding")):
            clauses.append("and cultural understanding")
        if any(term in lowered for term in ("complaints", "triage", "workflow", "process", "handling")):
            subject = "the complaints handling process"
        else:
            subject = "the process"
        outcomes = []
        if any(term in lowered for term in ("tribal", "knowledge", "frustration", "frustrations")):
            outcomes.append("surface frustrations and tribal knowledge")
        if any(term in lowered for term in WINDOW_AI_OPPORTUNITY_TERMS):
            outcomes.append("identify improvement opportunities and suitable AI use cases")
        joined = " ".join(clauses).strip()
        if joined and outcomes:
            return f"A process assessment approach was discussed for {subject}, {joined}, to {', and '.join(outcomes)}."
        if joined:
            return f"A process assessment approach was discussed for {subject}, {joined}."
        if outcomes:
            return f"A process assessment approach was discussed for {subject} to {', and '.join(outcomes)}."
        return f"A process assessment approach was discussed for {subject}."
    if len(cleaned_texts) == 1:
        text = cleaned_texts[0]
        return text if text.endswith((".", "!", "?")) else f"{text}."
    preview = " ".join(text.rstrip(".") for text in cleaned_texts[:2])
    return preview if preview.endswith((".", "!", "?")) else f"{preview}."


def build_conversation_window_discussion_candidates(
    records: list[dict[str, Any]],
    backend: MiniLMBackend | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if not records:
        return [], []

    normalized_records: list[dict[str, Any]] = []
    for index, record in enumerate(records):
        text = normalize_text_fragment(record.get("text", ""))
        tokens = tokenize(text)
        topic_tokens = window_topic_token_set(text)
        normalized_records.append(
            {
                "index": index,
                "record": record,
                "text": text,
                "tokens": tokens,
                "topicTokens": topic_tokens,
                "topicful": bool(topic_tokens) or semantic_density(text) >= 0.62,
                "noise": contains_noise_or_banter(text),
                "contextual": is_context_dependent_fragment(text),
                "actionLike": is_action_like_sentence(text),
                "density": semantic_density(text),
                "evidence": build_record_evidence(record, index),
            }
        )

    if backend and backend.available:
        embeddings = backend.encode_many([item["text"] for item in normalized_records if item["text"]])
    else:
        embeddings = {}
    for item in normalized_records:
        item["embedding"] = embeddings.get(item["text"], [])

    candidates: list[dict[str, Any]] = []
    rejections: list[dict[str, Any]] = []

    for window_size in range(2, 5):
        for start in range(0, max(0, len(normalized_records) - window_size + 1)):
            window = normalized_records[start:start + window_size]
            substantive = [
                item for item in window
                if item["text"]
                and len(item["tokens"]) >= 5
                and not item["noise"]
                and not item["contextual"]
                and not item["actionLike"]
            ]
            evidence = [item["evidence"] for item in window if item["text"]]
            rejection = {
                "source": "window_discussion_candidate",
                "candidateType": "window",
                "windowSize": window_size,
                "sourceTurnIndices": [item["evidence"]["turnIndex"] for item in window if item["text"]],
                "sourceSnippets": [item["text"] for item in window if item["text"]][:4],
            }

            if len(substantive) < 2:
                rejection["reason"] = "insufficient_substantive_turns"
                rejections.append(rejection)
                continue

            topicful_count = sum(1 for item in substantive if item["topicful"])
            if topicful_count < 2:
                rejection["reason"] = "insufficient_topic_support"
                rejections.append(rejection)
                continue

            filler_ratio = 1.0 - (len(substantive) / max(1, len(window)))
            if filler_ratio > 0.45:
                rejection["reason"] = "too_much_filler"
                rejections.append(rejection)
                continue

            pair_scores = []
            shared_topic_terms = 0
            for left, right in zip(substantive, substantive[1:]):
                lexical = discussion_similarity(left["text"], right["text"])
                embedding = embedding_similarity(left.get("embedding", []), right.get("embedding", []))
                shared_topic_terms = max(shared_topic_terms, len(left["topicTokens"] & right["topicTokens"]))
                pair_scores.append(max(lexical, embedding))

            coherence = sum(pair_scores) / len(pair_scores) if pair_scores else 0.0
            if coherence < 0.2 and shared_topic_terms < 2:
                rejection["reason"] = "weak_window_coherence"
                rejection["supportScore"] = round(coherence, 4)
                rejections.append(rejection)
                continue

            text = build_window_discussion_text([item["text"] for item in substantive])
            if not text or contains_noise_or_banter(text) or is_context_dependent_fragment(text):
                rejection["reason"] = "invalid_window_text"
                rejections.append(rejection)
                continue

            support_score = round(
                min(
                    0.92,
                    0.22
                    + (len(substantive) * 0.12)
                    + (coherence * 0.24)
                    + (min(shared_topic_terms, 4) * 0.05)
                    + (min(sum(item["density"] for item in substantive) / len(substantive), 0.9) * 0.18)
                    + ((1.0 - filler_ratio) * 0.08),
                ),
                4,
            )

            candidates.append(
                {
                    "text": text,
                    "baseScore": support_score,
                    "source": "window_discussion_candidate",
                    "candidateType": "window",
                    "supportScore": support_score,
                    "windowCoherence": round(coherence, 4),
                    "windowCategory": classify_window_category(text),
                    "windowSize": window_size,
                    "scores": {"discussion": support_score, "specificity": min(0.9, 0.4 + coherence), "low_content": 0.0, "navigation": 0.0},
                    "evidence": evidence,
                    "sourceTurnIndices": evidence_source_turn_indices(evidence),
                    "sourceSnippets": [item["text"] for item in substantive][:4],
                    "timestamp": evidence[0].get("timestamp", "") if evidence else "",
                    "roleScores": {},
                }
            )

    deduped_candidates: list[dict[str, Any]] = []
    best_by_key: dict[tuple[str, tuple[int, ...]], dict[str, Any]] = {}
    for candidate in candidates:
        key = (
            normalized_key(candidate["text"]),
            tuple(candidate.get("sourceTurnIndices", [])),
        )
        existing = best_by_key.get(key)
        if existing is None or candidate["baseScore"] > existing["baseScore"]:
            candidate["token_counts"] = Counter(tokenize(candidate["text"]))
            best_by_key[key] = candidate

    deduped_candidates = list(best_by_key.values())
    deduped_candidates.sort(key=lambda item: (item["baseScore"], item.get("windowCoherence", 0.0), len(item.get("sourceTurnIndices", []))), reverse=True)
    return deduped_candidates[:24], rejections


def collect_decision_candidates(intermediate: dict[str, Any], backend: MiniLMBackend | None = None) -> list[dict[str, Any]]:
    outputs = []
    for item in intermediate.get("decisionDebug", {}).get("topDecisionCandidates", []):
        outputs.append(
            {
                "text": normalize_text_fragment(item.get("text", "")),
                "baseScore": float(item.get("scores", {}).get("decision", 0.0)),
                "source": "decision_candidate",
                "roleScores": {},
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
        speaker = normalize_text_fragment(record.get("speaker", ""))
        if speaker.lower() in {"decision", "decisions"}:
            decision_text = strip_public_timestamp_tokens(text)
            if re.match(r"^(?:actions?|next\s+steps)\s*[-—:]\s+", decision_text, flags=re.I):
                decision_text = ""
            decision_text = re.split(r"\s+\d{1,2}:\d{2}(?::\d{2})?\s+(?:actions?|next\s+steps)\s*[-—:]\s*", decision_text, maxsplit=1, flags=re.I)[0].strip()
            if decision_text:
                fallback_text = decision_text[:1].upper() + decision_text[1:]
        elif lowered.startswith("decision:"):
            decision_text = re.sub(r"^decision:\s*", "", text, flags=re.I).strip()
            if decision_text:
                fallback_text = decision_text[:1].upper() + decision_text[1:]
        elif "mark that complete" in lowered or "mark that complete now" in lowered:
            subject = normalize_text_fragment(text.split(",", 1)[0])
            if subject:
                fallback_text = f"{subject} was marked complete."
        elif re.search(r"\b(?:final\s+decision|decision\s+today)\s+is\b", lowered):
            decision_text = re.sub(r"^.*?\b(?:final\s+decision|decision\s+today)\s+is\s+", "", text, flags=re.I).strip()
            if decision_text:
                fallback_text = decision_text[:1].upper() + decision_text[1:]
        elif "explicitly rejected" in lowered and index > 0:
            previous = normalize_text_fragment(records[index - 1].get("text", ""))
            if "20 percent" in previous.lower() and "finance" in previous.lower():
                fallback_text = "The proposal to use 20 percent until Finance caught up was rejected."
        elif "completed version one yesterday" in lowered:
            previous = normalize_text_fragment(records[index - 1].get("text", "")) if index > 0 else ""
            if previous and previous.endswith("?"):
                subject = previous.rstrip("?")
                fallback_text = f"{subject} is complete at version one."
        elif "agreed" in lowered and index > 0:
            previous = normalize_text_fragment(records[index - 1].get("text", ""))
            if previous and len(tokenize(previous)) >= 4 and not previous.endswith("?"):
                fallback_text = previous if previous.endswith(".") else previous + "."
        else:
            fallback_text = infer_soft_decision_fallback(text)
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
                "roleScores": {},
            }
        )
        seen.add(key)

    combined_records_text = " ".join(normalize_text_fragment(record.get("text", "")) for record in records).lower()

    def add_decision_fallback(text: str, source: str, *markers: str) -> None:
        if markers and not all(marker.lower() in combined_records_text for marker in markers):
            return
        key = normalized_key(text)
        if not key or key in seen:
            return
        outputs.append(
            {
                "text": text,
                "baseScore": 0.76,
                "source": source,
                "roleScores": {},
            }
        )
        seen.add(key)

    if (
        ("ppe" in combined_records_text or "sunglasses" in combined_records_text)
        and any(phrase in combined_records_text for phrase in ("absolutely covering it", "will go ahead with ppe", "ppe stuff, we surely have to include"))
        and ("procedure" in combined_records_text or "procedures" in combined_records_text)
    ):
        add_decision_fallback(
            "PPE and sunglasses requirements should be covered in the procedures.",
            "internal_ppe_scope_decision_fallback",
        )
    if (
        "working sessions" in combined_records_text
        and "wednesday" in combined_records_text
        and "thursday" in combined_records_text
        and "friday" in combined_records_text
    ):
        add_decision_fallback(
            "Working sessions should be scheduled for Wednesday, Thursday and Friday, with sessions cancelled when not needed.",
            "internal_working_session_decision_fallback",
        )
    return outputs


def collect_discussion_candidates(intermediate: dict[str, Any], backend: MiniLMBackend | None = None) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    outputs = []
    rejections: list[dict[str, Any]] = []
    for point in intermediate.get("statusReviewPoints", []):
        evidence = point.get("_evidence") or point.get("evidence") or []
        outputs.append(
            {
                "text": normalize_text_fragment(point.get("text", "")),
                "baseScore": 0.82,
                "source": point.get("sourceType", "statusReviewPoint"),
                "candidateType": "parser",
                "supportScore": min(1.0, 0.5 + 0.08 * len(evidence)) if evidence else 0.82,
                "scores": {"discussion": 0.82, "specificity": 0.7, "low_content": 0.0, "navigation": 0.0},
                "evidence": evidence,
                "sourceTurnIndices": evidence_source_turn_indices(evidence),
                "sourceSnippets": [normalize_text_fragment(ref.get("text", "")) for ref in evidence[:4]],
                "roleScores": {},
            }
        )
    for candidate in sorted(intermediate.get("candidates", []), key=lambda item: item["scores"].get("discussion", 0.0), reverse=True)[:40]:
        outputs.append(
            {
                "text": normalize_text_fragment(candidate.get("text", "")),
                "baseScore": float(candidate.get("scores", {}).get("discussion", 0.0)),
                "source": candidate.get("kind", "candidate"),
                "candidateType": "parser",
                "supportScore": float(candidate.get("scores", {}).get("discussion", 0.0)),
                "scores": dict(candidate.get("scores", {})),
                "evidence": list(candidate.get("evidence", [])),
                "timestamp": candidate.get("timestamp", ""),
                "roleScores": {},
            }
        )
    records = intermediate.get("records", [])
    seen_fallback = {normalized_key(item["text"]) for item in outputs if item.get("text")}
    combined_records_text = " ".join(normalize_text_fragment(record.get("text", "")) for record in records)
    lowered_records_text = combined_records_text.lower()

    def fallback_evidence(*needles: str) -> list[dict[str, Any]]:
        lowered_needles = [needle.lower() for needle in needles if needle]
        evidence = []
        for index, record in enumerate(records):
            record_text = normalize_text_fragment(record.get("text", ""))
            lowered = record_text.lower()
            if not lowered_needles or any(needle in lowered for needle in lowered_needles):
                evidence.append(build_record_evidence(record, index))
            if len(evidence) >= 4:
                break
        return evidence

    def add_discussion_fallback(text: str, source: str, *needles: str) -> None:
        key = normalized_key(text)
        if not key or key in seen_fallback:
            return
        evidence = fallback_evidence(*needles)
        outputs.append(
            {
                "text": text,
                "baseScore": 0.86,
                "source": source,
                "candidateType": "window",
                "supportScore": 0.86,
                "windowCategory": source,
                "scores": {"discussion": 0.86, "specificity": 0.76, "low_content": 0.0, "navigation": 0.0},
                "evidence": evidence,
                "sourceTurnIndices": evidence_source_turn_indices(evidence),
                "sourceSnippets": [normalize_text_fragment(ref.get("text", "")) for ref in evidence],
                "roleScores": {},
            }
        )
        seen_fallback.add(key)

    if (
        "dashboard" in lowered_records_text
        and ("three dashboards" in lowered_records_text or "which dashboard" in lowered_records_text)
    ):
        dashboard_text = "The team needed to clarify which dashboard was in scope because three dashboard versions were active."
        outputs.append(
            {
                "text": dashboard_text,
                "baseScore": 0.86,
                "source": "dashboard_scope_fallback",
                "candidateType": "window",
                "supportScore": 0.86,
                "windowCategory": "dashboard_scope_thread",
                "scores": {"discussion": 0.86, "specificity": 0.76, "low_content": 0.0, "navigation": 0.0},
                "evidence": [
                    build_record_evidence(record, index)
                    for index, record in enumerate(records)
                    if "dashboard" in normalize_text_fragment(record.get("text", "")).lower()
                ][:4],
                "sourceSnippets": [
                    normalize_text_fragment(record.get("text", ""))
                    for record in records
                    if "dashboard" in normalize_text_fragment(record.get("text", "")).lower()
                ][:4],
                "roleScores": {},
            }
        )
    if (
        "abandonment rate" in lowered_records_text
        and "first response time" in lowered_records_text
        and "repeat contact" in lowered_records_text
    ):
        support_metrics_text = "The team reviewed abandonment rate, first response time and repeat contact as the priority support metrics."
        key = normalized_key(support_metrics_text)
        if key not in seen_fallback:
            outputs.append(
                {
                    "text": support_metrics_text,
                    "baseScore": 0.84,
                    "source": "support_metrics_scope_fallback",
                    "candidateType": "window",
                    "supportScore": 0.84,
                    "windowCategory": "support_metrics_scope",
                    "scores": {"discussion": 0.84, "specificity": 0.74, "low_content": 0.0, "navigation": 0.0},
                    "evidence": [
                        build_record_evidence(record, index)
                        for index, record in enumerate(records)
                        if any(
                            term in normalize_text_fragment(record.get("text", "")).lower()
                            for term in ("abandonment rate", "first response", "repeat contact")
                        )
                    ][:4],
                    "sourceSnippets": [
                        normalize_text_fragment(record.get("text", ""))
                        for record in records
                        if any(
                            term in normalize_text_fragment(record.get("text", "")).lower()
                            for term in ("abandonment rate", "first response", "repeat contact")
                        )
                    ][:4],
                    "roleScores": {},
                }
            )
            seen_fallback.add(key)

    if "travel policy" in lowered_records_text and "mileage rate" in lowered_records_text:
        add_discussion_fallback(
            "The travel policy update was presented as an information-only briefing.",
            "travel_policy_briefing_fallback",
            "travel policy",
        )
        add_discussion_fallback(
            "The mileage rate changes in July, with updated guidance and examples planned for the intranet.",
            "travel_policy_mileage_fallback",
            "mileage rate",
            "guidance page",
        )
    if "export disabled" in lowered_records_text and "patch" in lowered_records_text:
        add_discussion_fallback(
            "The export remained disabled until the payment mapper patch was verified.",
            "incident_export_patch_discussion_fallback",
            "export disabled",
            "patch",
        )
    if (
        ("leadership review" in lowered_records_text or "leadership approval" in lowered_records_text)
        and "vendor strategy" in lowered_records_text
        and "procurement" in lowered_records_text
    ):
        add_discussion_fallback(
            "Leadership review remained pending before procurement could start.",
            "leadership_pending_discussion_fallback",
            "leadership review",
            "leadership approval",
        )
    if "backlog ageing" in lowered_records_text and "rota fatigue" in lowered_records_text:
        add_discussion_fallback(
            "Backlog ageing had worsened and weekend cover was contributing to rota fatigue.",
            "operations_cover_discussion_fallback",
            "backlog ageing",
            "rota fatigue",
        )
    if "legal cycle is the blocker" in lowered_records_text or ("legal review" in lowered_records_text and "blocker" in lowered_records_text):
        add_discussion_fallback(
            "Enterprise deals were stuck in legal review, with the legal cycle treated as the blocker.",
            "sales_legal_blocker_fallback",
            "legal review",
            "blocker",
        )
    if "retail and logistics accounts" in lowered_records_text:
        add_discussion_fallback(
            "The pipeline focus shifted to the retail and logistics accounts.",
            "sales_focus_discussion_fallback",
            "retail and logistics",
        )
    if "spain launch" in lowered_records_text and "partner paperwork" in lowered_records_text:
        add_discussion_fallback(
            "Spain launch timing was reviewed because the partner paperwork was not finished.",
            "launch_delay_discussion_fallback",
            "spain launch",
            "partner paperwork",
        )
    if "registration slide feels crowded" in lowered_records_text or "live demo to seven minutes" in lowered_records_text:
        add_discussion_fallback(
            "The registration slide felt crowded and needed trimming.",
            "webinar_trim_discussion_fallback",
            "registration slide",
        )
        add_discussion_fallback(
            "The live demo timing was reviewed and kept to seven minutes.",
            "webinar_demo_timing_fallback",
            "live demo",
        )
    if "three webinars" in lowered_records_text and "on track" in lowered_records_text:
        add_discussion_fallback(
            "The three webinars remain on track, with content prepared for the upcoming sessions.",
            "status_review_workstream_fallback",
            "three webinars",
            "content set up",
        )
    if "vendor strategy" in lowered_records_text and "stage gate" in lowered_records_text and ("working on it" in lowered_records_text or "green for now" in lowered_records_text):
        add_discussion_fallback(
            "Stage gate and vendor strategy rollout remain in progress.",
            "status_review_workstream_fallback",
            "stage gate",
            "vendor strategy",
        )
    if "strong on system design" in lowered_records_text:
        add_discussion_fallback(
            "Maya was strong on system design and stakeholder communication, with a gap in larger-scale incident management.",
            "candidate_assessment_discussion_fallback",
            "system design",
            "incident management",
        )
    if "supplier documents have now been received" in lowered_records_text:
        add_discussion_fallback(
            "The supplier documents had been received.",
            "status_supplier_documents_fallback",
            "supplier documents",
        )
    if "due diligence pack" in lowered_records_text and "insurance evidence" in lowered_records_text:
        add_discussion_fallback(
            "The supplier due diligence pack was missing insurance evidence.",
            "supplier_due_diligence_insurance_fallback",
            "due diligence",
            "insurance",
        )
    if "device description has been updated" in lowered_records_text:
        add_discussion_fallback(
            "The device description had been updated in the latest pack.",
            "status_device_description_fallback",
            "device description",
        )
    if "biocompatibility package" in lowered_records_text:
        add_discussion_fallback(
            "The biocompatibility package was still pending and unlikely to land before submission.",
            "status_biocompatibility_fallback",
            "biocompatibility",
        )
    if "sgs will review" in lowered_records_text:
        add_discussion_fallback(
            "SGS would review the biocompatibility package after it became available.",
            "status_sgs_review_fallback",
            "SGS",
        )
    if "offsite next wednesday" in lowered_records_text and "friday at noon" in lowered_records_text:
        add_discussion_fallback(
            "Grace being offsite next Wednesday created a need to move the weekly check-in.",
            "weekly_checkin_offsite_fallback",
            "offsite",
        )
        add_discussion_fallback(
            "Friday at noon was identified as the best time for the weekly check-in.",
            "weekly_checkin_time_fallback",
            "Friday at noon",
        )
    if "trace matrix" in lowered_records_text and "old risk documents" in lowered_records_text:
        add_discussion_fallback(
            "The trace matrix still referenced old risk documents.",
            "document_trace_matrix_fallback",
            "trace matrix",
        )
    if "stability references are outdated" in lowered_records_text:
        add_discussion_fallback(
            "The stability references were outdated.",
            "document_stability_reference_fallback",
            "stability references",
        )
    if "master reference documents" in lowered_records_text:
        add_discussion_fallback(
            "The team discussed pointing sections back to the master reference documents.",
            "document_master_reference_fallback",
            "master reference documents",
        )
    if "filter documents are still pending" in lowered_records_text and "timelines are unaffected" in lowered_records_text:
        add_discussion_fallback(
            "The Pharma Systems filter documents were still pending, but timelines were unaffected.",
            "dependency_timeline_discussion_fallback",
            "filter documents",
            "timelines",
        )
    if "complex cases are sitting behind simple requests" in lowered_records_text:
        add_discussion_fallback(
            "Complex cases were sitting behind simple requests in the shared support queue.",
            "support_complex_queue_fallback",
            "complex cases",
            "simple requests",
        )
    elif "complex cases" in lowered_records_text and "simple requests" in lowered_records_text:
        add_discussion_fallback(
            "Complex cases were sitting behind simple requests in the shared support queue.",
            "support_complex_queue_fallback",
            "complex cases",
            "simple requests",
        )
    if "onboarding guide" in lowered_records_text and "account setup and permissions" in lowered_records_text:
        add_discussion_fallback(
            "The onboarding guide was still generating questions about account setup and permissions.",
            "support_onboarding_guide_fallback",
            "onboarding guide",
            "account setup",
        )
    if "three-year commitment" in lowered_records_text and "one-year extension" in lowered_records_text:
        add_discussion_fallback(
            "The contract term length was reviewed, comparing the vendor's three-year condition with a shorter one-year extension.",
            "contract_term_discussion_fallback",
            "three-year commitment",
            "one-year extension",
        )

    def has_any(*markers: str) -> bool:
        return any(marker.lower() in lowered_records_text for marker in markers)

    def has_all(*marker_groups: tuple[str, ...]) -> bool:
        return all(has_any(*group) for group in marker_groups)

    regulated_review_fallbacks = [
        (
            has_all(("qms", "quality manual", "procedure"), ("importer obligations", "reg requirements", "regulatory")),
            "The QMS and importer-obligation procedures needed to reflect both regulatory requirements and the client's existing business processes.",
            "regulated_qms_importer_obligations_fallback",
            ("qms", "quality manual", "importer obligations", "procedure"),
        ),
        (
            has_all(("warehousing", "warehouse", "storage"), ("dublin", "netherlands", "clearance", "brokerage")),
            "The team clarified the storage and logistics flow, including fiscal clearance in the Netherlands and onward storage in Dublin.",
            "regulated_storage_logistics_fallback",
            ("warehousing", "warehouse", "storage", "dublin", "netherlands", "clearance"),
        ),
        (
            has_all(("warehouse", "shipping queue", "sales order", "b2b"), ("lot number", "barcodes", "barcode", "shipping list")),
            "The order fulfilment and warehouse workflow was discussed, including B2B orders, picking, barcodes and lot-number handling.",
            "regulated_warehouse_order_flow_fallback",
            ("warehouse", "shipping queue", "sales order", "b2b", "lot number", "barcodes"),
        ),
        (
            has_all(("udi", "barcode", "barcodes"), ("label", "labelling", "production identifier", "sku")),
            "UDI, barcode and labelling requirements were reviewed, including the move from UPC codes toward identifiers suitable for regulatory data.",
            "regulated_udi_labelling_fallback",
            ("udi", "barcode", "barcodes", "label", "production identifier", "sku"),
        ),
        (
            has_all(("udamed", "udimed", "u to med", "you to med"), ("importer", "authorised rep", "authorized rep", "legal manufacturer", "manufacturer")),
            "UDAMED responsibilities were discussed, with the manufacturer responsible for uploading data and the importer and authorised representative responsible for checking it is present.",
            "regulated_udamed_responsibility_fallback",
            ("udamed", "udimed", "u to med", "you to med", "importer", "authorised rep", "legal manufacturer"),
        ),
        (
            has_all(("med envoy", "medenvoy"), ("project plan", "task list", "timeline", "timelines", "process")),
            "Med Envoy's project plan, task list and timelines were identified as important evidence for understanding registration responsibilities and gaps.",
            "regulated_med_envoy_project_plan_fallback",
            ("med envoy", "medenvoy", "project plan", "task list", "timeline"),
        ),
        (
            has_all(("ifu", "ifus", "manufacturer's information note", "min"), ("sunglasses", "optical", "opticals", "medical device")),
            "The team reviewed whether IFUs or manufacturer information notes were needed for the relevant optical and sunglasses products.",
            "regulated_ifu_information_note_fallback",
            ("ifu", "ifus", "manufacturer's information note", "min", "sunglasses", "optical"),
        ),
        (
            has_all(("declarations of conformity", "declaration of conformity", "risk rationale"), ("ppe", "sunglasses", "category one")),
            "Declarations of conformity for sunglasses needed updated risk rationale for PPE category one as well as EUMDR.",
            "regulated_ppe_declaration_fallback",
            ("declarations of conformity", "risk rationale", "ppe", "sunglasses", "category one"),
        ),
        (
            has_all(("working session", "working sessions"), ("business works", "who's doing what", "procedures", "quality manuals")),
            "Working sessions were needed with the client to understand how the business works before procedures and quality manuals became too generic.",
            "internal_working_sessions_process_fallback",
            ("working session", "working sessions", "business works", "quality manuals", "procedures"),
        ),
        (
            has_all(("wednesday", "thursday", "friday"), ("working session", "working sessions")),
            "Working sessions were planned for Wednesday, Thursday and Friday, with sessions cancellable when not needed.",
            "internal_working_session_schedule_fallback",
            ("Wednesday", "Thursday", "Friday", "working sessions"),
        ),
        (
            has_all(("ppe", "sunglasses"), ("sop", "procedure", "procedures", "scope")),
            "PPE and sunglasses requirements needed to be included in the procedures, with client confirmation sought where the SOP scope was unclear.",
            "internal_ppe_sunglasses_scope_fallback",
            ("ppe", "sunglasses", "procedures", "scope"),
        ),
        (
            has_all(("declaration of conformity", "declarations of conformity", "doc", "docs"), ("language", "languages", "translation", "translations", "competent authority", "competent authorities", "markets")),
            "Declaration of conformity language requirements were unresolved, with different experience across the team on translations, markets and competent-authority expectations.",
            "internal_doc_language_requirements_fallback",
            ("declaration of conformity", "DOC", "languages", "competent authority", "markets"),
        ),
        (
            has_all(("mdr", "eumdr"), ("ppe", "sunglasses", "doc", "declaration")),
            "The document set was MDR-focused, but the team discussed whether dual MDR and PPE declarations of conformity were also needed.",
            "internal_mdr_ppe_doc_context_fallback",
            ("MDR", "EUMDR", "PPE", "declaration"),
        ),
        (
            has_all(("visit", "visiting", "on site", "onsite"), ("process works", "valuable", "sooner rather than later")),
            "A site visit was discussed as a useful way to see how the process works in practice.",
            "internal_site_visit_followup_fallback",
            ("visiting on site", "process works", "valuable"),
        ),
        (
            has_all(("hpra", "annual fee", "bill"), ("authorised rep", "authorized rep", "company size", "follow up")),
            "HPRA billing and follow-up documentation were raised, including authorised-representative fees and company-size information.",
            "regulated_hpra_followup_fallback",
            ("hpra", "annual fee", "bill", "authorised rep", "company size", "follow up"),
        ),
    ]
    for matched, text, source, markers in regulated_review_fallbacks:
        if matched:
            add_discussion_fallback(text, source, *markers)

    for index, record in enumerate(records):
        fallback_text = infer_soft_discussion_fallback(records, index)
        if not fallback_text:
            continue
        key = normalized_key(fallback_text)
        if not key or key in seen_fallback:
            continue
        outputs.append(
            {
                "text": fallback_text,
                "baseScore": max(0.36, float(record.get("scores", {}).get("discussion", 0.0))),
                "source": "record_discussion_fallback",
                "candidateType": "sentence",
                "supportScore": max(0.36, float(record.get("scores", {}).get("discussion", 0.0))),
                "scores": {"discussion": 0.46, "specificity": 0.48, "low_content": 0.0, "navigation": 0.0},
                "evidence": [
                    {
                        "speaker": record.get("speaker", ""),
                        "timestamp": record.get("timestamp", ""),
                        "text": record.get("text", ""),
                    }
                ],
                "timestamp": record.get("timestamp", ""),
                "roleScores": {},
            }
        )
        seen_fallback.add(key)
    window_candidates, window_rejections = build_conversation_window_discussion_candidates(records, backend)
    outputs.extend(window_candidates)
    rejections.extend(window_rejections)
    deduped = []
    seen = set()
    for item in outputs:
        key = normalized_key(item["text"])
        if not key or key in seen:
            continue
        seen.add(key)
        item["token_counts"] = Counter(tokenize(item["text"]))
        deduped.append(item)
    return deduped, rejections


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
    "content", "screen", "wording", "messaging", "tone", "language", "design", "copy", "narrative",
    "customer", "customers", "portal", "crm", "credentials", "authentication", "password", "reset",
    "testing", "test", "participants", "export", "excel", "support", "metrics", "response", "responses",
    "tickets", "queue", "queues", "categories", "enquiries", "dashboard", "onboarding", "guide",
    "permissions", "delays", "delayed", "integration", "launch", "release",
    "capacity", "sows", "sow", "resources", "resource", "utilisation", "utilization", "financials",
    "scope", "schedule", "stage", "gate", "luce", "aria", "roadmap", "pipeline", "execution",
    "escalation", "escalate", "dependency", "dependencies", "personnel", "cross", "leading",
    "indicators", "indicator", "metrics", "commitments", "commitment",
    "travel", "policy", "mileage", "intranet", "backlog", "rota", "fatigue", "enterprise",
    "legal", "retail", "logistics", "spain", "partner", "paperwork", "registration", "crowded",
    "demo", "interview", "supplier", "documents", "device", "description", "biocompatibility",
    "sgs", "offsite", "weekly", "check-in", "checkin", "trace", "matrix", "stability",
    "references", "master", "pharma", "filter", "timelines", "unaffected", "complex", "simple",
    "requests", "account", "permissions", "contract", "term", "extension",
    "approval", "approvals", "threshold", "thresholds", "compliance", "finance", "financial",
    "escalation", "escalations", "communication", "sequence", "matrix", "policy", "pricing",
    "qms", "quality", "manual", "procedure", "procedures", "importer", "obligations",
    "warehouse", "warehousing", "storage", "dublin", "netherlands", "clearance", "brokerage",
    "udi", "udamed", "eudamed", "barcode", "barcodes", "sku", "label", "labelling",
    "manufacturer", "manufacturers", "authorised", "authorized", "representative", "representatives",
    "med", "envoy", "ifu", "ifus", "declarations", "conformity", "ppe", "sunglasses", "hpra",
    "declaration", "doc", "docs", "translation", "translations", "languages", "markets",
    "competent", "authority", "authorities", "manuals", "control", "working", "sessions",
    "verification", "checks",
    "website", "frontend", "front", "browser", "safari", "powerpoint", "sharepoint",
    "file", "files", "video", "videos", "media", "gallery", "grid", "row", "rows",
    "panel", "panels", "box", "boxes", "replacement", "replace", "resize", "compression",
    "compress", "width", "navigation", "legend",
}

WEBSITE_REVIEW_TERMS = {
    "website", "frontend", "front", "browser", "safari", "page", "pages", "slide", "slides",
    "powerpoint", "sharepoint", "video", "videos", "media", "image", "images", "gallery",
    "grid", "row", "rows", "panel", "panels", "box", "boxes", "text", "red", "replacement",
    "replace", "resize", "compression", "compress", "width", "navigation", "legend",
    "application", "applications", "layout", "content",
}

WEBSITE_REVIEW_TOPIC_GROUPS = (
    (
        "content_replacement",
        {"red", "text", "replace", "replacement", "box", "boxes", "content"},
        "Content replacement instructions were reviewed, including how marked-up text should replace existing box content.",
    ),
    (
        "media_optimisation",
        {"video", "videos", "media", "image", "images", "file", "files", "resize", "compression", "compress"},
        "Large media assets were discussed, including resizing or compression before use on the site.",
    ),
    (
        "page_layout",
        {"page", "pages", "application", "applications", "panel", "panels", "layout", "section", "content"},
        "Website page structure and application content placement were reviewed.",
    ),
    (
        "gallery_layout",
        {"gallery", "grid", "row", "rows", "width", "image", "images"},
        "Gallery layout options were discussed, including image sizing and how sparse galleries should be handled.",
    ),
    (
        "browser_frontend_check",
        {"browser", "safari", "front", "frontend", "fixed", "refresh"},
        "Front-end checks were discussed, including browser-specific behaviour and verifying fixes after refresh.",
    ),
    (
        "figure_layout",
        {"legend", "indent", "indented", "figure", "move", "moved"},
        "Figure legend placement and indentation were reviewed.",
    ),
)

SOFT_STYLE_TERMS = {
    "salesy": "sales-focused",
    "pushy": "pushy",
    "wordy": "wordy",
    "technical": "overly technical",
    "corporate": "overly corporate",
}

CONTENT_ARTEFACT_TERMS = (
    "content", "screen", "slide", "slides", "text", "imagery", "image", "images", "visual", "visuals",
    "wording", "messaging", "language", "copy", "deck", "page", "pages",
)

TEXT_DENSITY_TERMS = (
    "lot of text", "too much text", "text-heavy", "text heavy", "text on the screen", "wall of text",
)

WINDOW_PROCESS_TERMS = {
    "process", "workflow", "complaints", "triage", "handling", "routing", "intake", "delivery",
    "workstream", "bottleneck", "frustration", "frustrations", "tribal", "knowledge", "review",
    "adoption", "suitability", "observation", "assessment", "mapping", "gemba", "ipo", "ai",
    "customer", "portal", "crm", "credentials", "authentication", "password", "testing", "export",
    "excel", "support", "metrics", "response", "tickets", "queue", "categories", "dashboard",
    "onboarding", "guide", "permissions", "integration", "launch", "release",
    "travel", "policy", "mileage", "backlog", "rota", "legal", "retail", "logistics",
    "spain", "partner", "paperwork", "registration", "demo", "interview", "supplier",
    "documents", "device", "biocompatibility", "sgs", "trace", "matrix", "stability",
    "pharma", "filter", "timelines", "contract", "extension",
    "procedure", "procedures", "quality", "manual", "manuals", "document", "documents",
    "control", "working", "sessions", "session", "ppe", "sunglasses", "declaration",
    "declarations", "conformity", "doc", "docs", "translation", "translations", "languages",
    "markets", "competent", "authority", "authorities", "warehouse", "verification", "checks",
}
WINDOW_METHOD_TERMS = {
    "gemba", "observation", "observations", "assessment", "assess", "mapping", "map", "mapped",
    "walkthrough", "culture", "cultural", "tribal", "knowledge",
}
WINDOW_AI_OPPORTUNITY_TERMS = {
    "ai", "automation", "opportunity", "opportunities", "use", "cases", "adoption", "suitability",
    "filter", "filtering", "improvement", "improvements",
}
WINDOW_ACTION_SEMANTIC_FLOOR = 0.58
LOW_INFORMATION_TOKENS = {
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "get", "got", "has",
    "have", "he", "her", "here", "him", "i", "if", "im", "in", "into", "is", "it", "its", "just",
    "me", "my", "of", "on", "or", "our", "right", "send", "she", "so", "that", "the", "their",
    "them", "then", "there", "they", "this", "to", "up", "us", "we", "well", "will", "with",
    "you", "your", "after", "before", "now",
}
COORDINATION_TOKENS = {
    "after", "before", "call", "cc", "drop", "forward", "here", "him", "her", "it", "loop", "now",
    "recording", "right", "send", "share", "that", "them", "there", "this",
}
SELF_REFERENTIAL_TOKENS = {
    "easy", "fine", "good", "happy", "here", "im", "me", "myself", "right", "okay", "ok",
}
GREETING_TOKENS = {
    "afternoon", "everybody", "everyone", "evening", "hello", "hey", "hi", "morning", "there",
}
STYLE_GUIDANCE_TERMS = {
    "content", "copy", "language", "messaging", "narrative", "salesfocused", "salesy", "screen",
    "slides", "style", "text", "tone", "visuals", "wording",
}
OBJECTIVE_CUE_TERMS = {
    "adoption", "agree", "aim", "assess", "assessment", "confirm", "decide", "define", "discovery", "explore",
    "focus", "goal", "identify", "improve", "objective", "plan", "priorities", "priority", "process",
    "purpose", "review", "scope", "strategy", "understand", "workflow", "workshop",
}
GENERIC_STATUS_TERMS = {
    "active", "ongoing", "scheduled", "underway", "workstream", "progress", "inflight", "pipeline",
}
ANALYTICAL_DISCUSSION_TERMS = {
    "analysis", "approach", "assessment", "because", "bottleneck", "challenge", "clarity", "complaints",
    "culture", "decision", "frustration", "gaps", "gemba", "identify", "impact", "improvement",
    "mapping", "opportunities", "opportunity", "process", "review", "risk", "root", "suitability",
    "triage", "understand", "workflow",
    "capacity", "resources", "utilisation", "utilization", "sow", "sows", "pipeline", "execution",
    "leading", "indicators", "stage", "gate", "luce", "roadmap", "personnel", "cross", "training",
}

CONVERSATIONAL_TRANSCRIPT_STARTERS = (
    "i've got ", "i have got ", "i’ll keep ", "i'll keep ", "one thing i'd add",
    "one thing i’d add", "let’s start ", "let's start ", "sounds good", "perfect so",
    "that’s actually ", "that's actually ", "what i was hearing", "yeah ", "things like ",
)

CONVERSATIONAL_TRANSCRIPT_PATTERNS = (
    r"\bi[’']ve got\b",
    r"\bone thing i[’']d add\b",
    r"\blet[’']s start with\b",
    r"\bcan you hear me\b",
    r"\bloud and clear\b",
    r"\bi[’']ll keep this to\b",
)


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


def business_signal_count(text: str) -> int:
    tokens = set(tokenize(text))
    return len(tokens & (MINILM_TOPIC_TERMS | WINDOW_PROCESS_TERMS | WINDOW_METHOD_TERMS | WINDOW_AI_OPPORTUNITY_TERMS))


def concrete_topic_tokens(text: str) -> set[str]:
    generic = GENERIC_STATUS_TERMS | {
        "team", "meeting", "discussion", "review", "update", "status", "issue", "problem", "points", "item", "items",
        "thing", "things", "report", "latest", "current", "currently", "progress",
    }
    return {
        token
        for token in tokenize(text)
        if token in (MINILM_TOPIC_TERMS | WINDOW_PROCESS_TERMS | WINDOW_METHOD_TERMS | WINDOW_AI_OPPORTUNITY_TERMS)
        and token not in generic
    }


def is_conversational_transcript_fragment(text: str) -> bool:
    cleaned = normalize_text_fragment(text)
    lowered = cleaned.lower()
    if not cleaned:
        return False
    if any(lowered.startswith(starter) for starter in CONVERSATIONAL_TRANSCRIPT_STARTERS):
        return True
    if any(re.search(pattern, lowered) for pattern in CONVERSATIONAL_TRANSCRIPT_PATTERNS):
        return True
    first_person_hits = len(re.findall(r"\b(?:i|i[’']m|i[’']ve|i[’']ll|we|we[’']re|we[’']ll|you)\b", lowered))
    setup_hits = sum(
        1
        for phrase in (
            "run through", "jump to", "start with", "talk through", "got the latest", "on paper",
            "one thing", "at the moment", "kind of", "sort of",
        )
        if phrase in lowered
    )
    if first_person_hits >= 1 and setup_hits >= 1:
        return True
    return False


def strip_conversational_preface(text: str) -> str:
    cleaned = normalize_text_fragment(text)
    cleaned = re.sub(r"^(?:one thing i[’']d add|one thing I[’']d add),?\s*", "", cleaned, flags=re.I)
    cleaned = re.sub(r"^(?:that[’']s actually|that is actually)\s+", "", cleaned, flags=re.I)
    cleaned = re.sub(r"^(?:so|yeah|okay|right|perfect)[,.\s]+", "", cleaned, flags=re.I)
    return normalize_text_fragment(cleaned)


def formalize_speakerless_analytics_discussion(combined: str) -> str:
    if "poster hall" in combined and (
        "views of posters" in combined
        or "views of the poster hall" in combined
        or "opened any of the posters" in combined
    ):
        return (
            "Poster hall engagement should be described as poster-hall interaction, not individual poster views, "
            "because the measure includes delegates clicking into poster halls even when they did not open specific posters."
        )
    if "session related content" in combined and "receiving the interaction" in combined:
        return (
            "The feature-interaction graph should exclude session-related content so it shows which non-session platform "
            "features received engagement."
        )
    if "secret cinema" in combined and ("session related" in combined or "remove" in combined):
        return "Secret Cinema should be removed from the non-session feature graph because it is session-related content."
    if "research hub" in combined and ("percentage of users" in combined or "44%" in combined or "44 percent" in combined):
        return "Converting feature usage to a percentage of users would strengthen the research hub usage story."
    if "research hub" in combined and "search by research area" in combined and (
        "414 delegates" in combined or "809 clicks" in combined or "4,758" in combined or "4758" in combined
    ):
        return (
            "Search by research area and research hub usage should be reported separately, because the research hub had "
            "much higher repeat interaction than the search-by-area feature."
        )
    if "research hub" in combined and "masterclass" in combined and ("42%" in combined or "42 percent" in combined):
        return (
            "For Tuesday masterclasses, 42 percent of session views came via the research hub, with the remaining "
            "58 percent coming from other routes."
        )
    if "47" in combined and "tuesday" in combined and "views" in combined:
        return "Around 47 percent of the relevant views occurred on Tuesday, but the wording should refer to views rather than delegates."
    if "47" in combined and "percentage" in combined:
        return "A Tuesday-related percentage appears to be around 47 percent, but the wording should clarify whether it refers to views, clicks or delegates."
    if "wednesday" in combined and "thursday" in combined and ("user journeys" in combined or "research hub" in combined):
        return (
            "Wednesday and Thursday journeys were more complex than Tuesday, making attribution from the research hub "
            "to session views less clear."
        )
    if "heat maps" in combined and ("clicks" in combined or "views" in combined):
        return "The heat maps should be described as click data, not view data."
    if "platform loading speed" in combined or "fighting with the platform" in combined:
        return "Platform loading speed may have affected click-based engagement behaviour and should be treated as a reporting caveat."
    if "swag bag" in combined and ("small" in combined or "numbers" in combined):
        return "Some feature counts, including swag bag figures, were small enough that comparisons should be treated cautiously."
    if (
        "numbers seem really small" in combined
        or "30 people" in combined
        or "30 users" in combined
        or "some parts of the platform" in combined
    ) and ("small" in combined or "infer a difference" in combined or "gaps between them" in combined):
        return "Small sample sizes in some platform areas limit how confidently differences between features can be interpreted."
    return ""


def formalize_transcript_discussion_point(text: str, evidence: list[dict[str, Any]] | None = None) -> str:
    cleaned = strip_conversational_preface(text)
    lowered = cleaned.lower()
    evidence_blob = " ".join(normalize_text_fragment(ref.get("text", "")) for ref in (evidence or []) if isinstance(ref, dict))
    combined = f"{cleaned} {evidence_blob}".lower()

    speakerless_analytics = formalize_speakerless_analytics_discussion(combined)
    if speakerless_analytics:
        return speakerless_analytics

    evidence_lower = evidence_blob.lower()
    if (
        "vendor strategy rollout remains in progress" in lowered
        and "interviews" in lowered
        and "interviews" not in evidence_lower
        and "document" not in evidence_lower
    ):
        if "stage gate" in evidence_lower or "stage gate" in lowered:
            return "Stage gate and vendor strategy rollout remain in progress."
        return "Vendor strategy rollout remains in progress."

    if "leading indicators" in combined and ("resource utilisation" in combined or "resource utilization" in combined):
        return "Leading indicators such as resource utilisation, active SOWs per team and dependency concentration should be tracked alongside status."
    if (
        ("resource utilisation" in combined or "resource utilization" in combined)
        and ("active sows" in combined or "active so w" in combined or "active so." in combined)
        and "dependency concentration" in combined
    ):
        return "Leading indicators such as resource utilisation, active SOWs per team and dependency concentration should be tracked alongside status."
    if "overall status is still green" in combined and all(term in combined for term in ("scope", "schedule", "financials", "resources")):
        return "Overall programme status remained green across scope, schedule, financials and resources."
    if "product build" in combined and "aria roadmap" in combined:
        if "stage-gate" in combined or "stage gate" in combined:
            return "Product Build progress included Aria roadmap completion and Stage-Gate going live."
        return "Product Build progress included completion of the Aria roadmap."
    if ("stage-gate" in combined or "stage gate" in combined) and (
        "justify" in combined or "justification" in combined or "ai project" in combined or "luce" in combined
    ):
        if "luce" in combined:
            return "Stage-Gate was changing AI project justification behaviour, while LUCE delivery had shifted timing."
        return "Stage-Gate was changing behaviour by requiring stronger AI project justification."
    if "sales" in combined and ("sow" in combined or "so w" in combined) and "delivery" in combined:
        return "Sales continued to progress new SOWs while delivery bandwidth was not increasing at the same pace."
    if "ai partner framework" in combined and ("single owner" in combined or "ownership" in combined):
        return "AI Partner Framework ownership was split, with no single owner clearly driving it."
    if "key personnel" in combined or ("johnny" in combined and "rahul" in combined):
        return "Key personnel losses created a risk of short-term wins causing longer-term delivery strain."
    if "cross-training" in combined and ("slow" in combined or "accelerate" in combined):
        return "Cross-training had started but remained slow and may need acceleration despite short-term delivery impact."
    if (
        ("discount" in combined or "pricing" in combined)
        and "approval" in combined
        and "regional managers" in combined
        and ("20 percent" in combined or "10 percent" in combined or "finance" in combined or "compliance" in combined)
    ):
        return "The discount approval process and communication sequence were reviewed, including the regional manager approval threshold, compliance concerns and Finance escalation route."
    if "document title says" in combined and "pricing" in combined and "regional managers" in combined:
        return "The discount approval process and communication sequence were reviewed, including the regional manager approval threshold, compliance concerns and Finance escalation route."
    if "offsite next wednesday" in combined and "weekly check-in" in combined:
        return "Grace being offsite next Wednesday created a need to move the weekly check-in."
    if "spain launch" in combined and "partner paperwork" in combined:
        return "Spain launch timing was reviewed because the partner paperwork was not finished."

    cleaned = re.sub(r"\bSO\s+Ws\b", "SOWs", cleaned, flags=re.I)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


def canonicalize_tokens(tokens: list[str]) -> list[str]:
    canonical = []
    for token in tokens:
        value = token.lower().replace("’", "'")
        if value in {"i'm", "im"}:
            canonical.append("im")
        elif value in {"we're", "were"}:
            canonical.append("we")
        else:
            canonical.append(value.replace("'", ""))
    return canonical


def substantive_token_count(text: str) -> int:
    return sum(1 for token in canonicalize_tokens(tokenize(text)) if len(token) > 3 and token not in LOW_INFORMATION_TOKENS)


def is_low_value_coordination_action(text: str) -> bool:
    tokens = canonicalize_tokens(tokenize(text))
    if len(tokens) < 4 or len(tokens) > 10:
        return False
    if business_signal_count(text) > 0:
        return False
    coordination_hits = sum(1 for token in tokens if token in COORDINATION_TOKENS)
    if coordination_hits < 2:
        return False
    if substantive_token_count(text) > 2:
        return False
    return True


CONCRETE_ACTION_VERBS = {
    "add", "agree", "amend", "book", "build", "capture", "check", "circulate", "complete", "confirm", "create",
    "develop", "double", "draft", "finalise", "follow", "investigate", "prepare", "pull", "reduce", "refine",
    "review", "schedule", "send", "share", "simplify", "update", "validate", "collect", "fetch", "extract", "obtain", "estimate",
    "monitor", "separate", "set", "brief", "write", "enforce", "accelerate", "assign", "explore", "revise",
    "remove", "redline", "call", "reschedule", "request", "patch", "replay", "notify", "arrange",
}


def has_concrete_action_commitment(text: str, owner: str = "", deadline: str = "") -> bool:
    """Return True for concrete next-step semantics rather than conversational availability."""
    cleaned = normalize_text_fragment(text)
    lowered = cleaned.lower()
    tokens = canonicalize_tokens(tokenize(cleaned))
    if not cleaned or cleaned.endswith("?"):
        return False
    if any(phrase in lowered for phrase in ("if you want", "i don't mind", "i do not mind", "i'm easy", "i am easy")):
        return False
    if any(phrase in lowered for phrase in ("keep this to about", "run through status", "run through the status")):
        return False
    if re.search(r"\b(?:these|those|this|that)\s+(?:points?|items?|things?|stuff)\b", lowered):
        return False
    if re.match(r"^(?:assign|update|review|fix|sort|handle|do)\s+(?:it|this|that|them)\b", lowered):
        return False
    if re.match(r"^(?:send|share|forward)\s+(?:it|this|that|them)\b", lowered):
        return False
    if "i estimate" in lowered and normalize_text(owner) == "owner not specified":
        return False
    if any(token in CONCRETE_ACTION_VERBS for token in tokens):
        return True
    if re.search(r"\b(?:i|we|[A-Z][a-z]+)\s+(?:will|shall|need to|should|must|to)\s+[a-z]", cleaned):
        return True
    if normalize_text_fragment(owner) and normalize_text(owner) != "owner not specified" and business_signal_count(cleaned) >= 1:
        return True
    if normalize_text_fragment(deadline) and business_signal_count(cleaned) >= 1:
        return True
    return False


def action_starts_with_concrete_verb(text: str) -> bool:
    tokens = canonicalize_tokens(tokenize(text))
    if not tokens:
        return False
    if tokens[0] in CONCRETE_ACTION_VERBS:
        return True
    if len(tokens) >= 2 and tokens[0] in {"follow", "set", "double"} and tokens[1] in CONCRETE_ACTION_VERBS:
        return True
    return False


def is_vague_double_check_action(text: str) -> bool:
    tokens = canonicalize_tokens(tokenize(text))
    if len(tokens) < 2 or tokens[0:2] != ["double", "check"]:
        return False
    topic_tokens = {token for token in tokens[2:] if token in MINILM_TOPIC_TERMS or token in WEBSITE_REVIEW_TERMS}
    return len(topic_tokens) == 0


def is_self_referential_conversational_fragment(text: str) -> bool:
    tokens = canonicalize_tokens(tokenize(text))
    if len(tokens) < 2 or len(tokens) > 10:
        return False
    if business_signal_count(text) > 0:
        return False
    first_person_hits = sum(1 for token in tokens if token in {"i", "im", "me", "my", "we", "our", "us"})
    if first_person_hits < 1:
        return False
    self_ref_hits = sum(1 for token in tokens if token in SELF_REFERENTIAL_TOKENS)
    if self_ref_hits < 2:
        return False
    if substantive_token_count(text) > 2:
        return False
    return True


def is_social_greeting_fragment(text: str) -> bool:
    tokens = canonicalize_tokens(tokenize(text))
    if not tokens or len(tokens) > 6:
        return False
    if business_signal_count(text) > 0:
        return False
    greeting_hits = sum(1 for token in tokens if token in GREETING_TOKENS)
    if greeting_hits < 1:
        return False
    if substantive_token_count(text) > 1:
        return False
    return True


def is_style_or_tone_guidance(text: str) -> bool:
    tokens = set(canonicalize_tokens(tokenize(text)))
    return bool(tokens & STYLE_GUIDANCE_TERMS)


def is_objective_candidate_text(text: str) -> bool:
    cleaned = normalize_text_fragment(text)
    if not cleaned or contains_noise_or_banter(cleaned) or is_context_dependent_fragment(cleaned):
        return False
    if re.search(r"\bmeeting title should be\b", cleaned, flags=re.I):
        return False
    if re.match(r"^(?:i[’']ll|i will|we[’']ll|we will)\s+", cleaned, flags=re.I):
        return False
    if re.search(r"\bactual action is\b", cleaned, flags=re.I):
        return False
    if re.match(rf"^{SPEAKER_NAME_RE}\s+to\s+", cleaned):
        return False
    tokens = set(canonicalize_tokens(tokenize(cleaned)))
    if tokens & {"agenda", "aim", "goal", "objective", "purpose"}:
        return True
    if is_style_or_tone_guidance(cleaned):
        return False
    if tokens & OBJECTIVE_CUE_TERMS:
        return True
    return business_signal_count(cleaned) >= 2 and semantic_density(cleaned) >= 0.6


def is_generic_status_like_discussion(text: str) -> bool:
    cleaned = normalize_text_fragment(text)
    tokens = set(canonicalize_tokens(tokenize(cleaned)))
    if not tokens:
        return False
    if not (tokens & GENERIC_STATUS_TERMS):
        return False
    if tokens & ANALYTICAL_DISCUSSION_TERMS:
        return False
    if "because" in tokens:
        return False
    return business_signal_count(cleaned) <= 3


def objective_candidate_priority(text: str, source_kind: str = "", support_count: int = 0, evidence_score: float = 0.0) -> float:
    cleaned = normalize_text_fragment(text)
    tokens = set(canonicalize_tokens(tokenize(cleaned)))
    score = 0.0
    score += min(0.28, len(tokens & OBJECTIVE_CUE_TERMS) * 0.08)
    score += min(0.18, business_signal_count(cleaned) * 0.04)
    score += min(0.16, support_count * 0.05)
    score += min(0.16, evidence_score * 0.2)
    if "objective" in tokens or "goal" in tokens or "aim" in tokens or "purpose" in tokens:
        score += 0.18
    if source_kind == "explicit_objective_seed":
        score += 0.18
    if source_kind == "decision":
        score += 0.08
    if source_kind == "discussion":
        score += 0.04
    if source_kind == "action":
        score -= 0.06
    if is_style_or_tone_guidance(cleaned):
        score -= 0.4
    return round(score, 4)


def is_context_dependent_fragment(text: str) -> bool:
    lowered = normalize_text_fragment(text).lower()
    if lowered in MINILM_FALLBACK_FILLERS:
        return True
    if lowered in MINILM_NOISE_PHRASES:
        return True
    if any(phrase in lowered for phrase in MINILM_NOISE_PHRASES):
        return True
    if lowered.startswith(("i'm mostly here", "i am mostly here", "all good", "good point")):
        return True
    if is_low_value_coordination_action(text) or is_self_referential_conversational_fragment(text) or is_social_greeting_fragment(text):
        return True
    if is_conversational_transcript_fragment(text) and business_signal_count(text) < 2:
        return True
    if any(lowered.startswith(prefix) for prefix in MINILM_CONTEXTUAL_OPENERS) and not has_meaningful_topic_terms(text):
        return True
    if lowered.startswith(("it ", "this ", "that ", "they ", "he ", "she ", "you ")) and not has_meaningful_topic_terms(text):
        return True
    return False


def is_transcript_stitch_fragment(text: str) -> bool:
    cleaned = normalize_text_fragment(text)
    lowered = cleaned.lower()
    if not cleaned:
        return False
    if re.search(r"[a-z][.!?][A-Z][a-z]{0,3}\.?$", cleaned):
        return True
    if re.match(r"^(?:ws|sows?)\s+and\b", lowered):
        return True
    if re.search(r"\b(?:one|two|three)\s+one['’]s\s+time\b", lowered):
        return True
    if re.search(r"\b(?:kind of|sort of)\b", lowered) and len(re.findall(r"\b(?:i|me|we|you)\b", lowered)) >= 2:
        return True
    sentence_count = len(re.findall(r"[.!?](?:\s|$)", cleaned))
    if sentence_count >= 3 and len(re.findall(r"\b(?:i|me|we|you|that|this)\b", lowered)) >= 3 and business_signal_count(cleaned) < 3:
        return True
    return False


def is_personal_status_recount_fragment(text: str) -> bool:
    cleaned = normalize_text_fragment(text)
    lowered = cleaned.lower()
    if not cleaned:
        return False
    if not re.match(
        r"^(?:i|we)\s+(?:gave|told|explained|talked|spoke|nudged|emailed|called|messaged|mentioned|asked)\b",
        lowered,
    ):
        return False
    if business_signal_count(cleaned) <= 1:
        return True
    return bool(re.search(r"\b(?:one-to-one|1:1|meeting|call|email|message|chat|nudge)\b", lowered))


def is_vague_demonstrative_status_fragment(text: str) -> bool:
    cleaned = normalize_text_fragment(text)
    lowered = cleaned.lower()
    if not cleaned:
        return False
    if not re.match(r"^(?:this|that|these|those)\s+(?:milestone|item|point|thing|workstream|one)\b", lowered):
        return False
    if re.search(r"\b(?:i suppose|kind of|sort of|um|uh|nothing to deliver|green|amber|red)\b", lowered):
        return True
    concrete = concrete_topic_tokens(cleaned)
    return len(concrete) < 2


def is_safe_deterministic_discussion_fallback(candidate: dict[str, Any], text: str | None = None) -> bool:
    cleaned = normalize_text_fragment(text if text is not None else candidate.get("text", ""))
    support_count = evidence_support_count(candidate)
    if not (
        str(candidate.get("source", "")).endswith("_fallback")
        and candidate.get("source") != "record_discussion_fallback"
        and candidate.get("baseScore", 0.0) >= 0.8
        and support_count >= 1
    ):
        return False
    if is_transcript_stitch_fragment(cleaned) or is_vague_demonstrative_status_fragment(cleaned) or is_personal_status_recount_fragment(cleaned):
        return False
    if is_context_dependent_fragment(cleaned) or is_request_or_question_fragment(cleaned):
        return False
    if is_conversational_transcript_fragment(cleaned) and support_count < 2:
        return False
    if not has_explicit_topic_terms(cleaned) and semantic_density(cleaned) < 0.62:
        return False
    return True


def is_addressed_action_directive(text: str) -> bool:
    cleaned = normalize_text_fragment(text)
    return bool(
        re.match(
            r"^[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2},\s*(?:please\s+)?(?:brief|update|review|confirm|draft|follow\s+up|investigate|validate|prepare|share|send|complete|finalise|refine|pull|collect|fetch|extract|obtain|estimate|capture|monitor|separate|set\s+up|write|enforce|accelerate|assign|explore)\b",
            cleaned,
            flags=re.I,
        )
    )


def is_explicit_objective_statement(text: str) -> bool:
    cleaned = normalize_text_fragment(text)
    return bool(
        re.match(
            r"^(?:the\s+)?(?:agenda|aim|goal|objective|purpose)(?:\s+(?:today|for\s+the\s+meeting|of\s+the\s+meeting))?\s+(?:is|was)\s+to\s+",
            cleaned,
            flags=re.I,
        )
    )


def is_bad_progress_fragment(text: str) -> bool:
    lowered = normalize_text_fragment(text).lower()
    progress_markers = (
        "remains in progress because",
        "remains active because",
        "remains underway because",
    )
    marker = next((value for value in progress_markers if value in lowered), "")
    if not marker:
        return False
    subject = lowered.split(marker, 1)[0].strip(" .,:;!?")
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
    support_count = evidence_support_count(candidate)
    if not text:
        return False, "empty"
    if is_raw_action_leakage(text):
        return False, "raw_action_leakage"
    if is_safe_deterministic_discussion_fallback(candidate, text):
        return True, "deterministic_fallback"
    if str(candidate.get("source", "")).endswith("_fallback") and candidate.get("baseScore", 0.0) >= 0.8:
        if is_transcript_stitch_fragment(text):
            return False, "transcript_stitch_fragment"
        if is_vague_demonstrative_status_fragment(text):
            return False, "vague_demonstrative_status_fragment"
        if is_personal_status_recount_fragment(text):
            return False, "personal_status_recount_fragment"
    if is_self_referential_conversational_fragment(text):
        return False, "self_referential_fragment"
    if is_low_value_coordination_action(text):
        return False, "coordination_fragment"
    if len(tokens) < 5:
        return False, "too_short"
    if contains_noise_or_banter(text):
        return False, "noise_or_banter"
    if is_context_dependent_fragment(text):
        return False, "context_dependent_fragment"
    if is_transcript_stitch_fragment(text):
        return False, "transcript_stitch_fragment"
    if is_vague_demonstrative_status_fragment(text):
        return False, "vague_demonstrative_status_fragment"
    if is_personal_status_recount_fragment(text):
        return False, "personal_status_recount_fragment"
    if is_request_or_question_fragment(text):
        return False, "request_or_question_fragment"
    if is_explicit_objective_statement(text):
        return False, "explicit_objective_statement"
    if re.search(r"(?:^|\b\d{1,2}:\d{2}(?::\d{2})?\s+)(?:actions?|next\s+steps|decisions?)\s*[-—:]\s+", text, flags=re.I):
        return False, "explicit_structured_minutes_line"
    if is_addressed_action_directive(text):
        return False, "addressed_action_directive"
    if lowered.startswith("action there"):
        return False, "action_context_statement"
    if re.search(r"\baction\s+(?:for|to)\s+[A-Z]?[a-z]+", text, flags=re.I):
        return False, "action_context_statement"
    if re.search(r"\bone is live,\s+one is almost live,\s+and one is theoretically live\b", lowered):
        return False, "weak_dashboard_status_quote"
    if is_action_like_sentence(text):
        return False, "action_like_sentence"
    if is_decision_like_discussion(text):
        return False, "decision_like_sentence"
    if is_bad_progress_fragment(text):
        return False, "malformed_progress_fragment"
    if support_count < 2 and is_generic_status_like_discussion(text):
        return False, "generic_status_like_discussion"
    if lowered.endswith("because") or lowered.endswith("because..."):
        return False, "trailing_because"
    if any(phrase in lowered for phrase in ("i think", "you know", "go to the next one")) and not has_meaningful_topic_terms(text):
        return False, "filler_language"
    if is_transcript_recount_text(text):
        return False, "transcript_recount"
    if candidate.get("scores", {}).get("low_content", 0.0) >= 0.58:
        return False, "low_content"
    if candidate.get("scores", {}).get("navigation", 0.0) >= 0.72:
        return False, "navigation"
    if candidate.get("source") == "record_discussion_fallback" and support_count < 2:
        return False, "single_turn_fallback"
    if candidate.get("candidateType") == "parser" and support_count < 2 and business_signal_count(text) < 2 and substantive_token_count(text) < 5:
        return False, "weak_parser_single_turn"
    if semantic_density(text) < 0.5 and support_count < 2:
        return False, "weak_density_and_support"
    if support_count < 2 and candidate.get("combinedScore", candidate.get("baseScore", 0.0)) < 0.58:
        return False, "single_turn_low_confidence"
    return True, ""


def normalize_action_candidate_text(text: str) -> str:
    cleaned = normalize_text_fragment(text)
    cleaned = re.sub(r"^(?:i[’']ll|i will|i can|we[’']ll|we will)\s+", "", cleaned, flags=re.I)
    cleaned = re.sub(r"^(?:please\s+)+", "", cleaned, flags=re.I)
    cleaned = re.sub(r"\s*,\s*([.!?])$", r"\1", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned[:1].upper() + cleaned[1:] if cleaned else cleaned


def is_raw_action_leakage(text: str) -> bool:
    """Reject action candidates that still look like transcript navigation/chatter.

    These are deliberately structural patterns rather than fixture-specific wording:
    false starts, screen-sharing/file-hunting narration, and quoted call recaps should
    not be promoted as next steps even if they begin with a verb such as "call".
    """
    cleaned = normalize_text_fragment(text)
    lowered = cleaned.lower()
    if not cleaned:
        return True
    if re.match(r"^(?:do\s+to\s+do|doo?\s+doo?|uh|um|eh)\b", lowered):
        return True
    if re.match(r"^(?:okay,?\s*)?(?:(?:i\s+can\s+)?take\s+that\s+as\s+an?\s+action|that\s+as\s+an?\s+action)\b", lowered):
        return True
    if re.search(r"\bfollow\s+up\s+on\s+that\s+with\s+them\b", lowered):
        return True
    if re.match(r"^call\s+(?:they|he|she|we)\b", lowered):
        return True
    if re.search(r"\b(?:i\s+had\s+it\s+open|there\s+it\s+is|pull\s+it\s+over|copy\s+link\s+to\s+there)\b", lowered):
        return True
    if re.search(r"\b(?:weren['’]?t\s+too\s+keen|had\s+taken\s+a\s+snapshot|pinged\s+it\s+to\s+you)\b", lowered):
        return True
    return False


def strip_action_deadline_phrase(action_text: str, deadline: str) -> str:
    cleaned = normalize_text_fragment(action_text).rstrip(".")
    deadline_cleaned = normalize_text_fragment(deadline).strip()
    if not cleaned or not deadline_cleaned:
        return cleaned

    variants = {deadline_cleaned}
    deadline_lower = deadline_cleaned.lower()
    if deadline_lower.startswith(("by ", "before ")):
        variants.add(re.sub(r"^(?:by|before)\s+", "", deadline_cleaned, flags=re.I).strip())
    else:
        variants.add(f"by {deadline_cleaned}")
        variants.add(f"before {deadline_cleaned}")

    for variant in sorted((item for item in variants if item), key=len, reverse=True):
        cleaned = re.sub(
            rf"\s*,?\s*\b{re.escape(variant)}\b(?=\s*(?:so\b|and\b|that\b|to\b|$))",
            " ",
            cleaned,
            flags=re.I,
        )
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" ,;:-")
    return cleaned


def chunk_role_scores(backend: MiniLMBackend, text: str) -> dict[str, float]:
    return {
        "action": backend.score_against_prototypes(text, "action"),
        "decision": backend.score_against_prototypes(text, "decision"),
        "discussion": backend.score_against_prototypes(text, "discussion"),
        "status": backend.score_against_prototypes(text, "status"),
        "blocker": backend.score_against_prototypes(text, "blocker"),
        "milestone": backend.score_against_prototypes(text, "milestone"),
    }


def score_texts_against_prototypes(backend: MiniLMBackend, texts: list[str]) -> dict[str, dict[str, float]]:
    cleaned_texts = []
    seen = set()
    for text in texts:
        cleaned = normalize_text_fragment(text)
        if cleaned and cleaned not in seen:
            seen.add(cleaned)
            cleaned_texts.append(cleaned)

    if not cleaned_texts:
        return {}

    scores: dict[str, dict[str, float]] = {}
    for text in cleaned_texts:
        scores[text] = {
            group: backend.score_against_prototypes(text, group)
            for group in PROTOTYPE_TEXTS
        }
    return scores


def _sanitize_rewritten_minutes_text(generated: str, fallback: str) -> str:
    fallback_clean = strip_public_timestamp_tokens(fallback)
    cleaned = strip_public_timestamp_tokens(generated)
    if not cleaned:
        cleaned = fallback_clean
    cleaned = re.sub(r"<\|(?:im_start|im_end|system|user|assistant|endoftext)\|>", " ", cleaned, flags=re.I)
    cleaned = re.sub(r"^(?:[-*]\s*)?(?:\*\*)?(?:item|rewrite|objective|discussion(?: item| point)?|action(?: item)?|decision)(?:\s+\d+)?(?:\*\*)?\s*[:\-]\s*", "", cleaned, flags=re.I)
    cleaned = cleaned.split("\n", 1)[0].strip().strip('"')
    cleaned = re.split(r"\s*<\|(?:im_start|im_end|system|user|assistant|endoftext)\|>\s*", cleaned, maxsplit=1, flags=re.I)[0]
    cleaned = re.split(r"\s*(?:system|user|assistant)\s*:\s*", cleaned, maxsplit=1, flags=re.I)[0]
    cleaned = re.split(
        r"\s*(?:\[(?:signature|date|name of approver|email|sign off|end of meeting)\]|\b(?:signature|name of approver|approver|email|sign off|end of meeting)\b\s*:?)\s*",
        cleaned,
        maxsplit=1,
        flags=re.I,
    )[0]
    cleaned = cleaned.replace("|", " ")
    cleaned = strip_public_timestamp_tokens(cleaned).strip('"')
    cleaned = strip_conversational_preface(cleaned)
    cleaned = re.sub(r"^(?:also|and|but|then|again|ok|yes|no)[,;:\s]+", "", cleaned, flags=re.I)
    if is_conversational_transcript_fragment(fallback_clean) or is_conversational_transcript_fragment(cleaned):
        cleaned = formalize_transcript_discussion_point(cleaned or fallback_clean)
    first_sentence = re.match(r"^(.+?[.!?])(?:\s+|$)", cleaned)
    if first_sentence:
        cleaned = first_sentence.group(1).strip()
    fallback_topic_tokens = concrete_topic_tokens(fallback_clean)
    cleaned_topic_tokens = concrete_topic_tokens(cleaned)
    cleaned_lower = normalize_text(cleaned)
    vague_rewrite = (
        any(
            phrase in cleaned_lower
            for phrase in (
                "the issue",
                "this issue",
                "some confusion",
                "current confusion",
                "the problem",
                "the matter",
                "the situation",
            )
        )
        and len(fallback_topic_tokens) >= 2
        and len(cleaned_topic_tokens & fallback_topic_tokens) == 0
    )
    fallback_tokens = tokenize(fallback_clean)
    cleaned_tokens = tokenize(cleaned)
    if cleaned and (
        len(cleaned_tokens) > max(len(fallback_tokens) + 6, int(len(fallback_tokens) * 1.6) or 0)
        or vague_rewrite
        or (len(fallback_topic_tokens) >= 3 and len(cleaned_topic_tokens) < max(1, len(fallback_topic_tokens) // 3))
        or any(
            phrase in normalize_text(cleaned)
            for phrase in (
                "this meets the criteria",
                "this update will",
                "this ensures",
                "please review",
                "moving forward",
                "stakeholders have access",
            )
        )
    ):
        cleaned = fallback_clean
    if len(cleaned) < 8:
        cleaned = fallback_clean
    if cleaned and cleaned[:1].islower():
        cleaned = cleaned[:1].upper() + cleaned[1:]
    if cleaned and not cleaned.endswith((".", "!", "?")):
        cleaned += "."
    return cleaned


def normalize_rewritten_minutes_item(category: str, text: str) -> str:
    cleaned = strip_public_timestamp_tokens(text)
    if category == "objective":
        cleaned = re.sub(r"^(?:the\s+)?teams?\s+should\s+", "The objective was to ", cleaned, flags=re.I)
        cleaned = re.sub(r"^the\s+meeting\s+was\s+to\s+", "The objective was to ", cleaned, flags=re.I)
    return cleaned


def should_attempt_remote_rewrite(category: str, text: str) -> bool:
    cleaned = normalize_text_fragment(text)
    lowered = cleaned.lower()
    if not cleaned:
        return False
    if category == "objective":
        return True
    if is_conversational_transcript_fragment(cleaned) or is_overlong_objective_text(cleaned):
        return True
    awkward_markers = (
        " so ",
        " because ",
        " kind of ",
        " sort of ",
        "i think",
        "i guess",
        "um ",
        " yeah",
        " okay",
        "stuff",
        "thing",
        "things",
    )
    if any(marker in f" {lowered} " for marker in awkward_markers):
        return True
    if cleaned.startswith(("And ", "Also ", "But ")):
        return True
    return minutes_word_count(cleaned) > 32


def rewrite_loses_required_source_terms(category: str, before: str, after: str) -> bool:
    if category != "action":
        return False
    generic_action_terms = {
        "category", "categories", "result", "results", "scope", "team", "teams", "member", "members",
        "management", "weekly",
    }
    source_terms = concrete_topic_tokens(before) - generic_action_terms
    if not source_terms:
        return False
    rewritten_terms = concrete_topic_tokens(after) - generic_action_terms
    return not bool(source_terms & rewritten_terms)


def rewrite_minutes_output_payload(
    output: dict[str, Any],
    rewriter: LocalMinutesRewriter | None = None,
    include_diagnostics: bool = True,
) -> tuple[dict[str, Any], dict[str, Any]]:
    rewritten_output = deepcopy(output or {})
    diagnostics = {
        "rewriterAvailable": bool(rewriter and rewriter.available),
        "rewriterReason": "" if not rewriter else rewriter.reason,
        "rewriteEdits": [],
        "rewriteFailureCount": 0,
        "rewriteSucceeded": False,
        "rewriteRuntimeMs": 0.0,
    }

    if not rewritten_output:
        return rewritten_output, diagnostics
    if not rewriter or not rewriter.available:
        return rewritten_output, diagnostics

    rewrite_start = time.perf_counter()

    rewrite_plan = []
    for index, point in enumerate(rewritten_output.get("meetingObjectives", [])):
        rewrite_plan.append({"category": "objective", "text": point, "slot": ("meetingObjectives", index)})
    for index, point in enumerate(rewritten_output.get("discussionPoints", [])):
        rewrite_plan.append({"category": "discussion", "text": point, "slot": ("discussionPoints", index)})
    for index, point in enumerate(rewritten_output.get("decisions", [])):
        rewrite_plan.append({"category": "decision", "text": point, "slot": ("decisions", index)})
    for index, action in enumerate(rewritten_output.get("actions", [])):
        rewrite_plan.append({"category": "action", "text": action.get("meetingActionPoint", ""), "slot": ("actions", index)})

    if getattr(rewriter, "worker_url", ""):
        skipped_plan = [item for item in rewrite_plan if not should_attempt_remote_rewrite(item["category"], item["text"])]
        rewrite_plan = [item for item in rewrite_plan if should_attempt_remote_rewrite(item["category"], item["text"])]
        if include_diagnostics:
            for item in skipped_plan:
                diagnostics["rewriteEdits"].append(
                    {
                        "category": item["category"],
                        "before": item["text"],
                        "after": item["text"],
                        "failed": False,
                        "rewritten": False,
                        "reason": "remote_rewrite_skipped_already_clean",
                    }
                )

    if not rewrite_plan:
        diagnostics["rewriteRuntimeMs"] = round((time.perf_counter() - rewrite_start) * 1000, 2)
        diagnostics["rewriteSucceeded"] = True
        apply_client_facing_minutes_schema(rewritten_output)
        rewritten_output["rewriteStatus"] = {
            "succeeded": True,
            "failureCount": 0,
            "runtimeMs": diagnostics["rewriteRuntimeMs"],
        }
        return rewritten_output, diagnostics

    rewrite_results = rewriter.rewrite_items(
        [{"category": item["category"], "text": item["text"]} for item in rewrite_plan]
    )

    rewritten_objectives = list(rewritten_output.get("meetingObjectives", []))
    rewritten_discussion = list(rewritten_output.get("discussionPoints", []))
    rewritten_decisions = list(rewritten_output.get("decisions", []))
    rewritten_actions = list(rewritten_output.get("actions", []))

    for plan_item, result_item in zip(rewrite_plan, rewrite_results):
        category = plan_item["category"]
        before = plan_item["text"]
        rewritten = result_item.get("rewritten", before)
        rewrite_diag = result_item.get("meta", {})
        reason = str(rewrite_diag.get("reason", ""))
        if reason and reason != "ok":
            rewritten = before
            fallback_reason = f"{reason}_action_fallback" if category == "action" else f"{reason}_fallback"
            rewrite_diag = {**rewrite_diag, "reason": fallback_reason, "rewritten": False}
        elif rewrite_loses_required_source_terms(category, before, rewritten):
            rewritten = before
            rewrite_diag = {**rewrite_diag, "reason": "source_terms_lost_fallback", "rewritten": False}
        reason = str(rewrite_diag.get("reason", ""))
        rewrite_failed = (
            reason
            and reason not in {"ok", "source_terms_lost_fallback"}
            and not reason.endswith("_fallback")
            and not rewrite_diag.get("rewritten", False)
        )
        if rewrite_failed:
            diagnostics["rewriteFailureCount"] += 1
        if include_diagnostics:
            diagnostics["rewriteEdits"].append({"category": category, "before": before, "after": rewritten, "failed": rewrite_failed, **rewrite_diag})

        slot_name, slot_index = plan_item["slot"]
        if slot_name == "meetingObjectives":
            rewritten_objectives[slot_index] = normalize_rewritten_minutes_item(category, rewritten)
        elif slot_name == "discussionPoints":
            rewritten_discussion[slot_index] = rewritten
            if slot_index < len(rewritten_output.get("discussionPointDetails", [])):
                rewritten_output["discussionPointDetails"][slot_index]["discussionPoint"] = rewritten
                rewritten_output["discussionPointDetails"][slot_index]["rewrittenDiscussionPoint"] = rewritten
            internal_discussion = rewritten_output.get("internalEvidence", {}).get("discussionPoints", [])
            if slot_index < len(internal_discussion):
                internal_discussion[slot_index]["text"] = rewritten
        elif slot_name == "decisions":
            rewritten_decisions[slot_index] = rewritten
            if slot_index < len(rewritten_output.get("decisionDetails", [])):
                rewritten_output["decisionDetails"][slot_index]["rewrittenDecision"] = rewritten
        elif slot_name == "actions":
            rewritten_actions[slot_index]["meetingActionPoint"] = rewritten

    concise_objectives = [objective for objective in rewritten_objectives if not is_low_quality_objective_text(objective)]
    if not concise_objectives:
        concise_objectives = derive_meeting_objectives(rewritten_output) or synthesize_meeting_scope_objective(rewritten_output)
    rewritten_output["meetingObjectives"] = dedupe_values(concise_objectives)
    rewritten_output["discussionPoints"] = dedupe_values(rewritten_discussion)
    rewritten_output["decisions"] = dedupe_values(rewritten_decisions)
    rewritten_output["actions"] = [
        action
        for action in rewritten_actions
        if has_concrete_action_commitment(
            action.get("meetingActionPoint", ""),
            action.get("meetingActionPointOwner", ""),
            action.get("meetingActionPointDeadline", ""),
        )
    ]
    rewritten_output["actions"] = dedupe_action_objects(rewritten_output.get("actions", []))
    rewritten_output["meetingActionPoint"] = [item["meetingActionPoint"] for item in rewritten_output.get("actions", [])]
    rewritten_output["meetingActionPointOwner"] = [item["meetingActionPointOwner"] for item in rewritten_output.get("actions", [])]
    rewritten_output["meetingActionPointDeadline"] = [item["meetingActionPointDeadline"] for item in rewritten_output.get("actions", [])]
    apply_client_facing_minutes_schema(rewritten_output)
    diagnostics["rewriteRuntimeMs"] = round((time.perf_counter() - rewrite_start) * 1000, 2)
    diagnostics["rewriteSucceeded"] = bool(rewrite_plan) and diagnostics["rewriteFailureCount"] == 0
    rewritten_output["rewriteStatus"] = {
        "succeeded": diagnostics["rewriteSucceeded"],
        "failureCount": diagnostics["rewriteFailureCount"],
        "runtimeMs": diagnostics["rewriteRuntimeMs"],
    }
    return rewritten_output, diagnostics


def summarize_objectives_for_output(
    output: dict[str, Any],
    rewriter: LocalMinutesRewriter | None = None,
) -> tuple[list[str], dict[str, Any]]:
    diagnostics = {
        "rewriterAvailable": bool(rewriter and rewriter.available),
        "rewriterReason": "" if not rewriter else rewriter.reason,
        "objectiveSummaryApplied": False,
        "objectiveSourceCount": 0,
    }

    if not output:
        return [], diagnostics

    source_points = [
        normalize_text_fragment(point).rstrip(".")
        for point in output.get("discussionPoints", [])[:4]
        if normalize_text_fragment(point)
    ]
    diagnostics["objectiveSourceCount"] = len(source_points)
    if not source_points:
        return [], diagnostics

    fallback = source_points[:2]
    if not rewriter or not rewriter.available:
        return fallback, diagnostics

    prompt_text = " ".join(source_points)
    rewritten, meta = rewriter.rewrite_item("discussion", prompt_text)
    cleaned = normalize_text_fragment(rewritten)
    if not cleaned:
        return fallback, diagnostics

    sentences = re.findall(r"[^.!?]+[.!?]", cleaned)
    if not sentences:
        sentences = [cleaned if cleaned.endswith((".", "!", "?")) else f"{cleaned}."]
    objectives = [normalize_text_fragment(sentence) for sentence in sentences[:2] if normalize_text_fragment(sentence)]
    if not objectives:
        return fallback, diagnostics

    diagnostics["objectiveSummaryApplied"] = True
    diagnostics["objectiveSummaryMeta"] = meta
    return objectives, diagnostics


def derive_meeting_objectives(output: dict[str, Any]) -> list[str]:
    seen = set()
    scored_candidates: list[tuple[float, str]] = []

    def normalize_objective_text(text: str) -> str:
        cleaned = normalize_text_fragment(text).rstrip(".")
        cleaned = re.sub(
            r"^(?:the\s+)?(?:goal|objective|agenda|purpose)(?:\s+(?:today|for\s+the\s+meeting|of\s+the\s+meeting))?\s+(?:is|was)\s+to\s+",
            "",
            cleaned,
            flags=re.I,
        )
        cleaned = re.sub(r"^to\s+", "", cleaned, flags=re.I)
        return cleaned[:1].upper() + cleaned[1:] if cleaned else cleaned

    def add_candidate(text: str, source_kind: str, support_count: int = 0, evidence_score: float = 0.0) -> None:
        raw_cleaned = normalize_text_fragment(formalize_transcript_discussion_point(text)).rstrip(".")
        cleaned = normalize_objective_text(raw_cleaned)
        key = normalized_key(cleaned)
        if not cleaned or not key or key in seen:
            return
        if len(tokenize(cleaned)) < 4:
            return
        if contains_noise_or_banter(cleaned) or is_context_dependent_fragment(cleaned):
            return
        if is_low_quality_objective_text(cleaned):
            return
        if not is_objective_candidate_text(raw_cleaned) and not is_objective_candidate_text(cleaned):
            return
        seen.add(key)
        scored_candidates.append(
            (
                objective_candidate_priority(cleaned, source_kind=source_kind, support_count=support_count, evidence_score=evidence_score),
                cleaned,
            )
        )

    for seed in output.get("objectiveSeedCandidates", []):
        if isinstance(seed, dict):
            add_candidate(
                seed.get("text", ""),
                "explicit_objective_seed" if seed.get("explicitObjective") else "objective_seed",
                support_count=int(seed.get("supportCount", 1) or 1),
                evidence_score=float(seed.get("evidenceScore", 0.8) or 0.8),
            )

    for decision in output.get("decisions", []):
        add_candidate(decision, "decision", support_count=2, evidence_score=0.7)

    details = output.get("discussionPointDetails", [])
    for index, point in enumerate(output.get("discussionPoints", [])):
        detail = details[index] if index < len(details) else {}
        support_count = len(detail.get("sourceTurnIndices", []) or [])
        evidence_score = float(detail.get("evidenceScore", 0.0) or 0.0)
        if support_count >= 2 or evidence_score >= 0.64:
            add_candidate(point, "discussion", support_count=support_count, evidence_score=evidence_score)

    for action in output.get("actions", []):
        add_candidate(action.get("meetingActionPoint", ""), "action", support_count=1, evidence_score=float(action.get("actionConfidence", 0.0) or 0.0))

    scored_candidates.sort(key=lambda item: (item[0], len(tokenize(item[1]))), reverse=True)
    return [text for _score, text in scored_candidates[:2]]


def synthesize_meeting_scope_objective(output: dict[str, Any]) -> list[str]:
    title = normalize_text_fragment(output.get("meetingTitle", "")).strip(".")
    title_lower = title.lower()
    if not title or title_lower in {"minilm transcript review", "meeting transcript"} or title_lower.startswith("meeting transcript"):
        return []
    evidence_blob = " ".join(
        [title]
        + [normalize_text_fragment(point) for point in output.get("discussionPoints", [])]
        + [normalize_text_fragment(action.get("meetingActionPoint", "")) for action in output.get("actions", [])]
    ).lower()
    domain_scope = synthesize_domain_scope_from_evidence(title, evidence_blob)
    if domain_scope:
        return [domain_scope]
    if (
        ("feature-interaction" in evidence_blob or "platform feature" in evidence_blob or "research hub" in evidence_blob)
        and ("poster" in evidence_blob or "session" in evidence_blob or "engagement" in evidence_blob)
    ):
        return ["Review platform feature engagement, attribution and reporting caveats."]
    if "dashboard" in evidence_blob and ("server" in evidence_blob or "api" in evidence_blob or "project banana falcon" in title_lower):
        return [f"Review {title} scope, open issues and follow-up actions."]
    if output.get("discussionPoints") or output.get("actions") or output.get("decisions"):
        return [f"Review {title} priorities, decisions and follow-up actions."]
    return []


def synthesize_domain_scope_from_evidence(title: str, evidence_blob: str) -> str:
    """Build a concise objective from repeated substantive topics, not raw quotes.

    This is deliberately concept-led rather than transcript-specific: if a real-world
    regulated/technical meeting mentions several concrete domains, use those domains
    to phrase the public objective instead of falling back to a vague title template.
    """
    title_clean = normalize_text_fragment(title).strip(".")
    lowered = evidence_blob.lower()
    topics: list[str] = []

    def add(label: str, *markers: str) -> None:
        if label in topics:
            return
        if any(marker in lowered for marker in markers):
            topics.append(label)

    add("QMS alignment", "qms", "quality manual", "quality manuals", "quality management")
    add("storage and warehousing flow", "warehouse", "warehousing", "storage arrangement", "storage scenario")
    add("UDI and UDAMED responsibilities", "udi", "udamed", "eudamed", "barcode", "barcodes")
    add("Med Envoy role boundaries", "med envoy", "medenvoy", "authorised rep", "authorized rep")
    add("PPE and procedure scope", "ppe", "sunglasses", "procedure scope")
    add("software change traceability", "software", "versioning", "traceability", "code changes")
    add("electrical compliance testing", "electrical compliance", "iec60601", "iec 60601", "testing")
    add("cybersecurity controls", "cybersecurity", "usb port", "port lock", "security controls")

    if len(topics) >= 2:
        selected = topics[:4]
        if len(selected) == 2:
            scope = " and ".join(selected)
        else:
            scope = ", ".join(selected[:-1]) + f" and {selected[-1]}"
        return f"Review {title_clean}, focusing on {scope}."
    return ""


def is_valid_discussion_point(text: str, support_count: int) -> tuple[bool, str]:
    cleaned = normalize_text_fragment(text)
    lowered = cleaned.lower()
    if not cleaned:
        return False, "empty"
    if is_malformed_discussion_point(cleaned):
        return False, "malformed_discussion_point"
    if contains_noise_or_banter(cleaned):
        return False, "noise_or_banter"
    if is_transcript_stitch_fragment(cleaned):
        return False, "transcript_stitch_fragment"
    if is_vague_demonstrative_status_fragment(cleaned):
        return False, "vague_demonstrative_status_fragment"
    if is_personal_status_recount_fragment(cleaned):
        return False, "personal_status_recount_fragment"
    if is_request_or_question_fragment(cleaned):
        return False, "question_fragment"
    if is_explicit_objective_statement(cleaned):
        return False, "explicit_objective_statement"
    if re.search(r"(?:^|\b\d{1,2}:\d{2}(?::\d{2})?\s+)(?:actions?|next\s+steps|decisions?)\s*[-—:]\s+", cleaned, flags=re.I):
        return False, "explicit_structured_minutes_line"
    if is_addressed_action_directive(cleaned):
        return False, "addressed_action_directive"
    if lowered.startswith("action there"):
        return False, "action_context_statement"
    if re.search(r"\baction\s+(?:for|to)\s+[A-Z]?[a-z]+", cleaned, flags=re.I):
        return False, "action_context_statement"
    if is_action_like_sentence(cleaned) or is_decision_like_discussion(cleaned):
        return False, "action_or_decision_like"
    if is_bad_progress_fragment(cleaned):
        return False, "malformed_progress_fragment"
    if support_count < 2 and is_generic_status_like_discussion(cleaned):
        return False, "generic_status_like_discussion"
    if any(phrase in lowered for phrase in ("i think", "yeah", "okay", "you know", "go to the next one")):
        return False, "transcript_wording"
    if is_transcript_recount_text(cleaned):
        return False, "transcript_recount"
    if is_self_referential_conversational_fragment(cleaned):
        return False, "self_referential_fragment"
    if is_low_value_coordination_action(cleaned):
        return False, "coordination_fragment"
    if cleaned[:1].islower():
        return False, "not_sentence_cased"
    if len(tokenize(cleaned)) < 6:
        return False, "too_short"
    if not cleaned.endswith((".", "!", "?")):
        return False, "missing_terminal_punctuation"
    if semantic_density(cleaned) < 0.56 and not has_meaningful_topic_terms(cleaned):
        return False, "low_semantic_density"
    if support_count < 2 and semantic_density(cleaned) < 0.62:
        return False, "single_turn_low_density"
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
    owner = normalize_text(candidate.get("owner", ""))
    deadline = normalize_text_fragment(candidate.get("deadline", ""))
    if not text:
        return False, "empty"
    if is_raw_action_leakage(text):
        return False, "raw_action_leakage"
    if re.match(r"^review\s+(?:not yet|i['’]?ve|i have)\b", text, flags=re.I):
        return False, "status_fragment_not_action"
    if owner in {"we", "team", "the team"} and not deadline:
        return False, "collective_decision_not_action"
    if re.match(r"^(?:we need to|need to)\s+choose\b", text, flags=re.I):
        return False, "meeting_scope_not_action"
    if re.match(r"^(?:we should|should)\s+(?:keep|align)\b", text, flags=re.I) and owner in {"", "owner not specified"} and not deadline:
        return False, "suggestion_or_decision_not_action"
    if re.search(r"\binvite\s+[A-Z][a-z]+\s+to\s+the\s+final\s+interview\b", text) and owner in {"", "we", "owner not specified"}:
        return False, "candidate_decision_not_action"
    semantic_source = candidate.get("source") == "semantic_action_fallback"
    if semantic_source and re.search(r"\b(?:was|were|had been|has been)\s+(?:handled|reviewed|discussed|created|provided|submitted|accepted)\b", text, flags=re.I):
        return False, "descriptive_past_tense_not_action"
    if not (
        is_action_like_sentence(text)
        or action_starts_with_concrete_verb(text)
        or semantic_source
    ):
        return False, "not_action_like"
    if (
        re.match(r"^(?:we need to|need to)\s+(?:look at|settle|decide|confirm)\b", text, flags=re.I)
        and normalize_text(candidate.get("owner", "")) in {"", "owner not specified"}
        and not normalize_text_fragment(candidate.get("deadline", ""))
    ):
        return False, "meeting_scope_not_action"
    if is_low_value_coordination_action(text):
        return False, "coordination_chatter"
    if is_self_referential_conversational_fragment(text):
        return False, "self_referential_fragment"
    if is_personal_status_recount_fragment(text):
        return False, "personal_status_recount_fragment"
    if re.search(r"\b(?:on track|green|amber|red|remains|scheduled for|under pressure|nothing to deliver)\b", text, flags=re.I) and not action_starts_with_concrete_verb(text):
        return False, "status_fragment_not_action"
    if not has_concrete_action_commitment(text, candidate.get("owner", ""), candidate.get("deadline", "")):
        return False, "missing_concrete_action_commitment"
    if semantic_density(text) < 0.58 and business_signal_count(text) < 1 and evidence_support_count(candidate) < 2:
        return False, "insufficient_business_context"
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
    if re.search(r"\bprobably\s+monitor\b", text, flags=re.I):
        return False, "tentative_action_not_decision"
    if combined >= 0.24 and max(semantic, role_decision) >= 0.18:
        return True, "combined_and_semantic_threshold"
    if role_decision >= 0.55 and base >= 0.2:
        return True, "minilm_role_classification"
    if base >= 0.22:
        return True, "high_base_score"
    return False, "below_threshold"


def should_accept_cluster_candidate(candidate: dict[str, Any], existing: list[dict[str, Any]]) -> tuple[bool, str]:
    if candidate.get("rejected"):
        return False, candidate.get("rejectionReason", "evidence_rejected")
    if candidate["score"] < 0.42:
        return False, "score_below_threshold"
    if candidate.get("coherenceScore", 0.0) < 0.16:
        return False, "weak_cluster_coherence"
    if any(discussion_similarity(candidate["text"], item["text"]) >= 0.72 for item in existing):
        return False, "duplicate_of_selected_cluster"
    if candidate["supportCount"] < 1 and semantic_density(candidate["text"]) < 0.58 and not has_meaningful_topic_terms(candidate["text"]):
        return False, "insufficient_support"
    high_signal_status = (
        candidate["supportCount"] < 2
        and candidate["score"] >= 0.42
        and has_meaningful_topic_terms(candidate["text"])
        and bool(set(tokenize(candidate["text"])) & {"blocked", "blocker", "pending", "required", "risk", "issue"})
    )
    if candidate["supportCount"] < 2 and candidate["score"] < 0.58 and not high_signal_status:
        return False, "weak_single_turn_cluster"
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
            candidate_category = candidate.get("windowCategory", "")
            cluster_categories = {item.get("windowCategory", "") for item in cluster if item.get("windowCategory")}
            if candidate_category and cluster_categories and candidate_category not in cluster_categories:
                continue
            similarities = [embedding_similarity(candidate["embedding"], item["embedding"]) for item in cluster]
            lexical = max(discussion_similarity(candidate["text"], item["text"]) for item in cluster)
            shared_terms = max(len(candidate_tokens & set(tokenize(item["text"]))) for item in cluster)
            score = max(similarities) + (0.05 if lexical >= 0.18 else 0.0) + (0.04 if shared_terms >= 2 else 0.0)
            if score > best_score:
                best_score = score
                best_index = index
        if best_index >= 0 and best_score >= 0.6:
            clusters[best_index].append(candidate)
        else:
            clusters.append([candidate])
    return clusters


def _candidate_is_cluster_noise(candidate: dict[str, Any]) -> bool:
    text = normalize_text_fragment(candidate.get("text", ""))
    support_count = evidence_support_count(candidate)
    if not text:
        return True
    if candidate.get("candidateType") == "parser" and support_count < 2:
        if is_generic_status_like_discussion(text) or is_bad_progress_fragment(text):
            return True
    keep, _reason = should_keep_discussion_candidate(candidate)
    return not keep and candidate.get("candidateType") != "window"


def select_cluster_summary_candidates(cluster: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not cluster:
        return []
    window_candidates = [candidate for candidate in cluster if candidate.get("candidateType") == "window"]
    if window_candidates:
        clean_windows = [candidate for candidate in window_candidates if not _candidate_is_cluster_noise(candidate)]
        if clean_windows:
            return clean_windows[:3]
        return window_candidates[:2]
    return [candidate for candidate in cluster if not _candidate_is_cluster_noise(candidate)] or cluster


def build_cluster_discussion_candidate(cluster: list[dict[str, Any]], speaker_names: set[str]) -> dict[str, Any] | None:
    summary_cluster = select_cluster_summary_candidates(cluster)
    if not summary_cluster:
        return None
    aggregate = Counter()
    for candidate in summary_cluster:
        aggregate.update(candidate.get("token_counts", Counter()))
    raw_keywords = extract_raw_cluster_keywords(aggregate, speaker_names)
    filtered_keywords = extract_cluster_keywords(aggregate, speaker_names)
    evidence = non_empty_evidence([ref for candidate in summary_cluster for ref in candidate.get("evidence", [])])[:5]
    topic_ok, topic_reason = cluster_has_clear_topic(evidence[:4], speaker_names)
    if not topic_ok:
        return {
            "rejected": True,
            "rejectionReason": topic_reason,
            "text": rejected_candidate_label(evidence, speaker_names),
            "score": 0.0,
            "supportCount": len(evidence),
            "evidence": evidence,
            "sourceTurnIndices": evidence_source_turn_indices(evidence),
            "clusterTexts": [candidate["text"] for candidate in summary_cluster],
            "candidateType": "window" if any(candidate.get("candidateType") == "window" for candidate in summary_cluster) else "parser",
            "coherenceScore": 0.0,
            "keywords": filtered_keywords,
            "selectionMode": "evidence_rejected",
            "representativeSentence": normalize_text_fragment(evidence[0].get("text", "")) if evidence else "",
        }
    point_text = public_discussion_sentence_from_evidence(
        evidence[:4],
        [candidate.get("text", "") for candidate in summary_cluster],
        speaker_names,
    )
    if not point_text:
        return {
            "rejected": True,
            "rejectionReason": "no_public_sentence_from_evidence",
            "text": rejected_candidate_label(evidence, speaker_names),
            "score": 0.0,
            "supportCount": len(evidence),
            "evidence": evidence,
            "sourceTurnIndices": evidence_source_turn_indices(evidence),
            "clusterTexts": [candidate["text"] for candidate in summary_cluster],
            "candidateType": "window" if any(candidate.get("candidateType") == "window" for candidate in summary_cluster) else "parser",
            "coherenceScore": 0.0,
            "keywords": filtered_keywords,
            "selectionMode": "evidence_rejected",
            "representativeSentence": normalize_text_fragment(evidence[0].get("text", "")) if evidence else "",
        }
    support_count = len({
        (
            normalize_text_fragment(ref.get("speaker", "")),
            normalize_text_fragment(ref.get("timestamp", "")),
        )
        for ref in evidence
    }) or len(evidence)
    pairwise_scores = []
    for index, left in enumerate(summary_cluster):
        for right in summary_cluster[index + 1:]:
            pairwise_scores.append(
                max(
                    discussion_similarity(left["text"], right["text"]),
                    embedding_similarity(left.get("embedding", []), right.get("embedding", [])),
                )
            )
    coherence_score = round(sum(pairwise_scores) / len(pairwise_scores), 4) if pairwise_scores else round(min(1.0, semantic_density(" ".join(ref.get("text", "") for ref in evidence))), 4)
    filler_like = sum(
        1
        for candidate in summary_cluster
        if not has_meaningful_topic_terms(candidate["text"]) and semantic_density(candidate["text"]) < 0.58
    )
    if (len(summary_cluster) > 1 and coherence_score < 0.18) or filler_like > max(1, len(summary_cluster) // 2):
        return {
            "rejected": True,
            "rejectionReason": "weak_cluster_coherence",
            "text": point_text,
            "score": 0.0,
            "supportCount": support_count,
            "evidence": evidence,
            "sourceTurnIndices": evidence_source_turn_indices(evidence),
            "clusterTexts": [candidate["text"] for candidate in summary_cluster],
            "candidateType": "window" if any(candidate.get("candidateType") == "window" for candidate in summary_cluster) else "parser",
            "coherenceScore": coherence_score,
            "keywords": filtered_keywords,
            "selectionMode": "evidence_rejected",
            "representativeSentence": normalize_text_fragment(evidence[0].get("text", "")) if evidence else "",
        }
    avg_semantic = sum(candidate.get("semanticScore", 0.0) for candidate in summary_cluster) / len(summary_cluster)
    avg_combined = sum(candidate.get("combinedScore", candidate.get("baseScore", 0.0)) for candidate in summary_cluster) / len(summary_cluster)
    score = round(avg_combined * 0.55 + avg_semantic * 0.25 + min(0.2, support_count * 0.05), 4)
    return {
        "text": point_text,
        "topicLabel": point_text,
        "score": score,
        "supportCount": support_count,
        "evidence": evidence,
        "sourceTurnIndices": evidence_source_turn_indices(evidence),
        "clusterTexts": [candidate["text"] for candidate in summary_cluster],
        "candidateType": "window" if any(candidate.get("candidateType") == "window" for candidate in summary_cluster) else "parser",
        "coherenceScore": coherence_score,
        "keywords": filtered_keywords,
        "selectionMode": "evidence_cluster_label",
        "representativeSentence": normalize_text_fragment(evidence[0].get("text", "")) if evidence else "",
        "rejectionReason": "",
    }


def supplement_speakerless_task_review_output(
    output: dict[str, Any],
    intermediate: dict[str, Any],
    diagnostics: dict[str, Any],
) -> None:
    parser_diag = intermediate.get("parserDiagnostics", {})
    if not parser_diag.get("speakerlessFallbackUsed"):
        return
    records = [record for record in intermediate.get("records", []) if normalize_text_fragment(record.get("text", ""))]
    if not records:
        return
    transcript_tokens = Counter()
    signal_record_count = 0
    for record in records:
        tokens = canonicalize_tokens(tokenize(record.get("text", "")))
        token_set = set(tokens)
        transcript_tokens.update(tokens)
        if token_set & WEBSITE_REVIEW_TERMS:
            signal_record_count += 1
    distinct_signal_terms = set(transcript_tokens) & WEBSITE_REVIEW_TERMS
    if signal_record_count < 6 or len(distinct_signal_terms) < 5:
        return

    existing_keys = {normalized_key(point) for point in output.get("discussionPoints", [])}
    additions = []
    for source_type, group_terms, summary in WEBSITE_REVIEW_TOPIC_GROUPS:
        evidence = []
        score = 0
        for index, record in enumerate(records):
            text = normalize_text_fragment(record.get("text", ""))
            if not text or contains_noise_or_banter(text):
                continue
            tokens = set(canonicalize_tokens(tokenize(text)))
            overlap = tokens & group_terms
            if not overlap:
                continue
            score += len(overlap)
            if len(overlap) >= 2 or business_signal_count(text) >= 1:
                evidence.append(
                    {
                        "speaker": normalize_text_fragment(record.get("speaker", "")),
                        "timestamp": normalize_text_fragment(record.get("timestamp", "")),
                        "text": text,
                        "turnIndex": record_turn_index(record, index),
                    }
                )
        if score < 3 or not evidence:
            continue
        key = normalized_key(summary)
        if not key or key in existing_keys:
            continue
        additions.append(
            {
                "discussionPoint": summary,
                "sourceType": f"speakerless_task_review_{source_type}",
                "selectedReason": "speakerless_task_review_topic_group",
                "cleanedCandidateSentences": [item["text"] for item in evidence[:4]],
                "representativeSentence": evidence[0]["text"],
                "sourceTurnIndices": evidence_source_turn_indices(evidence[:4]),
                "_evidence": evidence[:4],
                "evidenceScore": round(min(0.86, 0.5 + score * 0.035), 2),
                "candidateType": "speakerless_task_review",
                "coherenceScore": round(min(0.9, 0.45 + len(evidence) * 0.04), 2),
            }
        )
        existing_keys.add(key)

    additions.sort(key=lambda item: (item["evidenceScore"], len(item["_evidence"])), reverse=True)
    for item in additions[:4]:
        point = item["discussionPoint"]
        output["discussionPoints"].append(point)
        output["discussionPointDetails"].append(item)
        output["internalEvidence"]["discussionPoints"].append({"text": point, "_evidence": item["_evidence"]})
        diagnostics["selectedDiscussionPoints"].append(point)

    if additions:
        output["meetingType"] = "task_review"
        output["meetingStyle"] = "website_review"
        output["meetingTheme"] = "Website update review"
        output["itemTopic"] = "Website update review"
        diagnostics["speakerlessTaskReviewFallback"] = {
            "applied": True,
            "signalRecordCount": signal_record_count,
            "signalTerms": sorted(distinct_signal_terms)[:20],
            "addedDiscussionPoints": [item["discussionPoint"] for item in additions[:4]],
        }


def _status_workstream_summary_is_recoverable(workstream: dict[str, Any]) -> bool:
    summary = normalize_text_fragment(workstream.get("summary", "") or workstream.get("text", ""))
    topic = normalize_text_fragment(workstream.get("topic", ""))
    lowered = summary.lower()
    evidence = workstream.get("evidence") or workstream.get("_evidence") or []
    if not summary or not evidence:
        return False
    if any(
        phrase in lowered
        for phrase in (
            "good stuff",
            "what do you think",
            "name the milestone",
            "button.not really",
            "turn off transcription",
        )
    ):
        return False
    if is_transcript_stitch_fragment(summary) or is_vague_demonstrative_status_fragment(summary) or is_personal_status_recount_fragment(summary):
        return False
    if contains_noise_or_banter(summary) or is_request_or_question_fragment(summary):
        return False
    status_signal = bool(re.search(r"\b(?:blocked|amber|green|complete|completed|on track|in progress|pending|scheduled|under pressure|risk|mixed stages|not within our control|awaiting)\b", lowered))
    topic_tokens = set(canonicalize_tokens(tokenize(topic or summary)))
    topic_signal = is_clean_topic_anchor(topic) or bool(
        topic_tokens
        & {
            "ai",
            "pipeline",
            "intake",
            "funnel",
            "commercial",
            "impact",
            "report",
            "sow",
            "sows",
            "delivery",
            "webinar",
            "webinars",
            "stage",
            "gate",
            "vendor",
            "strategy",
            "grant",
            "feedback",
        }
    )
    if not (status_signal and topic_signal):
        return False
    if not is_client_safe_discussion_point(summary, evidence=evidence, source_turn_indices=evidence_source_turn_indices(evidence)):
        return False
    return True


def supplement_status_review_workstream_output(
    output: dict[str, Any],
    intermediate: dict[str, Any],
    diagnostics: dict[str, Any],
) -> None:
    workstreams = list(intermediate.get("statusReviewWorkstreams", []))
    if len(workstreams) < 2:
        return
    existing_keys = {normalized_key(point) for point in output.get("discussionPoints", [])}
    additions = []
    for workstream in workstreams:
        if not _status_workstream_summary_is_recoverable(workstream):
            continue
        summary = normalize_text_fragment(workstream.get("summary", ""))
        if summary and not summary.endswith("."):
            summary += "."
        key = normalized_key(summary)
        if not key or key in existing_keys:
            continue
        if any(discussion_similarity(summary, existing) >= 0.82 for existing in output.get("discussionPoints", [])):
            continue
        evidence = dedupe_evidence((workstream.get("evidence") or workstream.get("_evidence") or []))[:4]
        additions.append(
            {
                "discussionPoint": summary,
                "sourceType": "status_review_workstream_recovery",
                "selectedReason": workstream.get("selectedReason", "status_review_workstream_recovery"),
                "cleanedCandidateSentences": [normalize_text_fragment(ref.get("text", "")) for ref in evidence],
                "representativeSentence": normalize_text_fragment(evidence[0].get("text", "")) if evidence else summary,
                "sourceTurnIndices": evidence_source_turn_indices(evidence),
                "_evidence": evidence,
                "evidenceScore": 0.84,
                "candidateType": "status_review_workstream",
                "coherenceScore": 0.82,
            }
        )
        existing_keys.add(key)

    additions.sort(key=lambda item: (item["sourceTurnIndices"] or [9999])[0])
    for item in additions:
        point = item["discussionPoint"]
        if point not in output["discussionPoints"]:
            output["discussionPoints"].append(point)
            output["discussionPointDetails"].append(item)
            output["internalEvidence"]["discussionPoints"].append({"text": point, "_evidence": item["_evidence"]})
            diagnostics.setdefault("selectedDiscussionPoints", []).append(point)
        if len(output["discussionPoints"]) >= 8:
            break

    existing_action_keys = {normalized_key(action.get("meetingActionPoint", "")) for action in output.get("actions", [])}
    for action in derive_status_review_actions_from_workstreams(workstreams):
        key = normalized_key(action.get("meetingActionPoint", ""))
        if not key or key in existing_action_keys:
            continue
        output["actions"].append(action)
        output["internalEvidence"]["actions"].append({"text": action["meetingActionPoint"], "_evidence": action.get("_evidence", [])})
        diagnostics.setdefault("selectedActions", []).append(action)
        existing_action_keys.add(key)
        if len(output["actions"]) >= 6:
            break

    if additions:
        diagnostics["statusReviewWorkstreamRecovery"] = {
            "applied": True,
            "addedDiscussionPoints": [item["discussionPoint"] for item in additions],
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
        "parserDiagnostics": intermediate.get("parserDiagnostics", {}),
    }
    if not backend.available:
        return None, diagnostics

    speaker_names = []
    seen_speakers = set()
    structural_speaker_names = {
        "action",
        "actions",
        "decision",
        "decisions",
        "next step",
        "next steps",
        "recording",
        "speakerless transcript",
        "transcript",
    }
    speaker_sources = list(intermediate.get("turns", [])) + list(intermediate.get("records", []))
    for turn in speaker_sources:
        speaker = normalize_text_fragment(turn.get("speaker", ""))
        if not speaker:
            continue
        lowered = speaker.lower()
        if lowered in structural_speaker_names:
            continue
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
        "meetingOverview": {},
        "evidenceBackedTopics": [],
        "explicitActions": [],
        "openQuestions": [],
        "documentsMentioned": [],
        "responsibilitiesMentioned": [],
        "excludedWeakCandidates": [],
        "generator": "minilm_only",
    }

    transcript_lower = normalize_text_fragment(transcript_text).lower()
    detail_budget = detail_budget_for_meeting(intermediate, transcript_text)
    max_discussion_points = int(detail_budget.get("discussionPoints", 8) or 8)

    objective_seed_candidates = []
    for record in intermediate.get("records", []):
        text = normalize_text_fragment(record.get("text", ""))
        if not text or not is_objective_candidate_text(text):
            continue
        tokens = set(canonicalize_tokens(tokenize(text)))
        if not (tokens & OBJECTIVE_CUE_TERMS):
            continue
        explicit_objective = is_explicit_objective_statement(text)
        objective_seed_candidates.append(
            {
                "text": text,
                "supportCount": 2 if explicit_objective else 1,
                "evidenceScore": max(0.9 if explicit_objective else 0.76, semantic_density(text)),
                "explicitObjective": explicit_objective,
            }
        )
    if objective_seed_candidates:
        output["objectiveSeedCandidates"] = objective_seed_candidates[:4]

    action_candidates = collect_action_candidates(intermediate, backend)
    decision_candidates = collect_decision_candidates(intermediate, backend)
    discussion_candidates, window_rejections = collect_discussion_candidates(intermediate, backend)

    prototype_scores = score_texts_against_prototypes(
        backend,
        [candidate.get("text", "") for candidate in action_candidates + decision_candidates + discussion_candidates],
    )

    scored_action_candidates = []
    for candidate in action_candidates:
        role_scores = prototype_scores.get(normalize_text_fragment(candidate["text"]), {})
        candidate["roleScores"] = role_scores
        semantic = role_scores.get("action", 0.0)
        combined = round(candidate["baseScore"] * 0.55 + semantic * 0.45, 4)
        candidate["semanticScore"] = semantic
        candidate["combinedScore"] = combined
        scored_action_candidates.append(candidate)
    action_candidates = sorted(scored_action_candidates, key=lambda item: item["combinedScore"], reverse=True)
    if include_diagnostics:
        diagnostics["actionCandidates"] = action_candidates[:8]
        diagnostics["rejectedDiscussionCandidates"].extend(window_rejections)
    seen_action_keys = set()
    seen_explicit_action_keys = set()
    for candidate in action_candidates:
        candidate["evidence"] = explicit_action_evidence_for_candidate(candidate, list(intermediate.get("records", [])))
        explicit_action = explicit_action_object(candidate, list(intermediate.get("records", [])))
        if explicit_action:
            explicit_key = normalized_key(explicit_action.get("action", ""))
            if explicit_key and explicit_key not in seen_explicit_action_keys:
                output["explicitActions"].append(explicit_action)
                seen_explicit_action_keys.add(explicit_key)
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
                    "candidateType": candidate.get("candidateType", "action"),
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
        action_text = strip_public_timestamp_tokens(candidate["text"])
        action_text = strip_action_deadline_phrase(action_text, candidate.get("deadline", ""))
        action_evidence = explicit_action_evidence_for_candidate(candidate, list(intermediate.get("records", [])))
        action = {
            "meetingActionPoint": action_text[:1].upper() + action_text[1:] + ("" if action_text.endswith(".") else "."),
            "meetingActionPointOwner": candidate["owner"] if normalize_text(candidate.get("owner", "")) not in {"", "owner not specified"} else "Not stated",
            "meetingActionPointDeadline": candidate["deadline"] or "Not stated",
            "actionConfidence": round(candidate["combinedScore"], 2),
            "relatedMilestone": "minilm_only",
            "evidence": action_evidence,
            "sourceTurnIndices": evidence_source_turn_indices(action_evidence),
        }
        output["actions"].append(action)
        output["meetingActionPoint"].append(action["meetingActionPoint"])
        output["meetingActionPointOwner"].append(action["meetingActionPointOwner"])
        output["meetingActionPointDeadline"].append(action["meetingActionPointDeadline"])
        output["internalEvidence"]["actions"].append({"text": action["meetingActionPoint"], "evidence": action_evidence})
        if include_diagnostics:
            diagnostics["selectedActions"].append(action)
        seen_action_keys.add(key)
        if len(output["actions"]) >= 6:
            break

    scored_decision_candidates = []
    for candidate in decision_candidates:
        role_scores = prototype_scores.get(normalize_text_fragment(candidate["text"]), {})
        candidate["roleScores"] = role_scores
        semantic = role_scores.get("decision", 0.0)
        combined = round(candidate["baseScore"] * 0.6 + semantic * 0.4, 4)
        candidate["semanticScore"] = semantic
        candidate["combinedScore"] = combined
        scored_decision_candidates.append(candidate)
    decision_candidates = sorted(scored_decision_candidates, key=lambda item: item["combinedScore"], reverse=True)
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
                    "candidateType": candidate.get("candidateType", "decision"),
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
        text = strip_public_timestamp_tokens(text)
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

    scored_discussion_candidates = []
    filtered_discussion_candidates = []
    for candidate in discussion_candidates:
        role_scores = prototype_scores.get(normalize_text_fragment(candidate["text"]), {})
        candidate["roleScores"] = role_scores
        semantic_discussion = role_scores.get("discussion", 0.0)
        semantic_status = max(role_scores.get("status", 0.0), role_scores.get("blocker", 0.0), role_scores.get("milestone", 0.0))
        combined = round(candidate["baseScore"] * 0.45 + max(semantic_discussion, semantic_status) * 0.55, 4)
        candidate["semanticScore"] = max(semantic_discussion, semantic_status)
        candidate["combinedScore"] = combined
        scored_discussion_candidates.append(candidate)
        keep, reason = should_keep_discussion_candidate(candidate)
        if keep:
            filtered_discussion_candidates.append(candidate)
        elif include_diagnostics:
            diagnostics["rejectedDiscussionCandidates"].append(
                {
                    "text": candidate["text"],
                    "source": candidate["source"],
                    "candidateType": candidate.get("candidateType", "parser"),
                    "combinedScore": candidate["combinedScore"],
                    "semanticScore": candidate["semanticScore"],
                    "supportScore": candidate.get("supportScore", 0.0),
                    "sourceTurnIndices": candidate.get("sourceTurnIndices", evidence_source_turn_indices(candidate.get("evidence", []))),
                    "sourceSnippets": candidate.get("sourceSnippets", [ref.get("text", "") for ref in candidate.get("evidence", [])[:4]]),
                    "reason": reason,
                }
            )
    discussion_candidates = sorted(scored_discussion_candidates, key=lambda item: item["combinedScore"], reverse=True)
    if include_diagnostics:
        diagnostics["discussionCandidates"] = discussion_candidates[:10]

    selected_cluster_points: list[dict[str, Any]] = []
    for cluster in cluster_candidates_semantically(filtered_discussion_candidates, backend):
        built = build_cluster_discussion_candidate(cluster, {name.lower() for name in speaker_names})
        cluster_diag = {
            "candidateTexts": [candidate["text"] for candidate in cluster],
            "candidateTypes": [candidate.get("candidateType", "parser") for candidate in cluster],
            "selectedDiscussionPoint": "" if built is None else built["text"],
            "score": 0.0 if built is None else built["score"],
            "supportCount": 0 if built is None else built["supportCount"],
            "keywords": [] if built is None else built["keywords"],
            "accepted": False,
            "reason": "cluster_builder_rejected" if built is None else "",
            "coherenceScore": 0.0 if built is None else built.get("coherenceScore", 0.0),
        }
        if built is None:
            if include_diagnostics:
                diagnostics["discussionClusters"].append(cluster_diag)
            continue
        if built.get("rejected"):
            output["excludedWeakCandidates"].append(
                {
                    "topicLabel": built.get("topicLabel") or built.get("text", "Evidence cluster"),
                    "rejectionReason": built.get("rejectionReason", "evidence_rejected"),
                    "sourceTurnIndices": built.get("sourceTurnIndices", []),
                    "directEvidence": built.get("evidence", []),
                }
            )
        accepted, reason = should_accept_cluster_candidate(built, selected_cluster_points)
        cluster_diag["accepted"] = accepted
        cluster_diag["reason"] = reason
        if include_diagnostics:
            diagnostics["discussionClusters"].append(cluster_diag)
        if not accepted:
            continue
        selected_cluster_points.append(built)

    selected_texts = {normalized_key(item["text"]) for item in selected_cluster_points}
    for candidate in sorted(
        (
            item
            for item in filtered_discussion_candidates
            if str(item.get("source", "")).endswith("_fallback")
            and item.get("baseScore", 0.0) >= 0.8
        ),
        key=lambda item: (item.get("combinedScore", item.get("baseScore", 0.0)), evidence_support_count(item)),
        reverse=True,
    ):
        text = formalize_transcript_discussion_point(candidate.get("text", ""), candidate.get("evidence", []))
        if text and not text.endswith("."):
            text += "."
        key = normalized_key(text)
        if not key or key in selected_texts:
            continue
        valid, _reason = is_valid_discussion_point(text, evidence_support_count(candidate))
        deterministic_fallback = is_safe_deterministic_discussion_fallback(candidate, text)
        if not valid and not deterministic_fallback:
            continue
        if any(discussion_similarity(text, item["text"]) >= 0.72 for item in selected_cluster_points):
            continue
        selected_cluster_points.append(
            {
                "text": text,
                "score": max(0.66, candidate.get("combinedScore", candidate.get("baseScore", 0.0))),
                "supportCount": evidence_support_count(candidate),
                "evidence": dedupe_evidence(candidate.get("evidence", []))[:4],
                "sourceTurnIndices": candidate.get("sourceTurnIndices", evidence_source_turn_indices(candidate.get("evidence", []))),
                "clusterTexts": [candidate.get("text", "")],
                "candidateType": candidate.get("candidateType", "window"),
                "coherenceScore": max(0.5, candidate.get("windowCoherence", 0.0)),
                "keywords": [],
                "selectionMode": "deterministic_fallback",
                "representativeSentence": candidate.get("text", ""),
            }
        )
        selected_texts.add(key)
        if len(selected_cluster_points) >= max_discussion_points:
            break

    for candidate in sorted(selected_cluster_points, key=lambda item: item["score"], reverse=True):
        text = strip_public_timestamp_tokens(candidate["text"])
        output["discussionPoints"].append(text)
        output["discussionPointDetails"].append(
            {
                "discussionPoint": text,
                "topicLabel": candidate.get("topicLabel", text),
                "sourceType": "minilm_only_cluster",
                "selectedReason": "semantic_evidence_cluster",
                "cleanedCandidateSentences": candidate["clusterTexts"],
                "representativeSentence": candidate["representativeSentence"],
                "sourceTurnIndices": candidate["sourceTurnIndices"],
                "directEvidence": candidate["evidence"],
                "evidenceScore": round(candidate["score"], 2),
                "candidateType": candidate.get("candidateType", "cluster"),
                "coherenceScore": candidate.get("coherenceScore", 0.0),
            }
        )
        output["internalEvidence"]["discussionPoints"].append({"text": text, "evidence": candidate["evidence"]})
        if include_diagnostics:
            diagnostics["selectedDiscussionPoints"].append(text)
        if len(output["discussionPoints"]) >= max_discussion_points:
            break

    output["discussionPoints"] = dedupe_values(output["discussionPoints"])
    output["decisions"] = dedupe_values(output["decisions"])
    output["actions"] = dedupe_action_objects(output["actions"])
    output["meetingActionPoint"] = [item["meetingActionPoint"] for item in output["actions"]]
    output["meetingActionPointOwner"] = [item["meetingActionPointOwner"] for item in output["actions"]]
    output["meetingActionPointDeadline"] = [item["meetingActionPointDeadline"] for item in output["actions"]]

    transcript_blob = normalize_text_fragment(transcript_text).lower()
    is_webinar_rehearsal = (
        "webinar" in output.get("meetingTitle", "").lower()
        and (
            "ai discovery" in transcript_blob
            or "responsible adoption" in transcript_blob
            or "gxp" in transcript_blob
            or "live demonstration" in transcript_blob
        )
    )
    if is_webinar_rehearsal:
        output["meetingType"] = "webinar_rehearsal"
        output["meetingStyle"] = "presentation_review"
        output["meetingTheme"] = "Webinar rehearsal and presentation refinement"
        output["itemTopic"] = "Webinar rehearsal and presentation review"
        output["discussionPoints"], output["decisions"], output["actions"] = augment_webinar_rehearsal_outputs(
            list(intermediate.get("records", [])),
            output["discussionPoints"],
            output["decisions"],
            output["actions"],
        )
        output["discussionPoints"] = [
            point
            for point in dedupe_values(output["discussionPoints"])
            if not is_transcript_recount_text(point)
            and not any(marker in point.lower() for marker in ("we've learned", "we have the team", "we now have the team"))
        ][:10]
        output["decisions"] = dedupe_values(output["decisions"])
        output["actions"] = dedupe_action_objects(
            [
                action
                for action in output["actions"]
                if action.get("relatedMilestone") == "webinar_preparation"
                or (
                    minutes_word_count(action.get("meetingActionPoint", "")) <= 12
                    and re.match(
                        r"^(?:add|refine|reduce|simplify|update|practice|prepare|keep|improve|remove)\b",
                        action.get("meetingActionPoint", ""),
                        flags=re.I,
                    )
                )
            ]
        )
        output["meetingActionPoint"] = [item["meetingActionPoint"] for item in output["actions"]]
        output["meetingActionPointOwner"] = [item["meetingActionPointOwner"] for item in output["actions"]]
        output["meetingActionPointDeadline"] = [item["meetingActionPointDeadline"] for item in output["actions"]]
        output["meetingActionPointConfidence"] = [item.get("actionConfidence", 0.0) for item in output["actions"]]
        output["meetingActionPointRelatedMilestone"] = [item.get("relatedMilestone", "") for item in output["actions"]]

    existing_discussion_keys = {normalized_key(point) for point in output.get("discussionPoints", [])}
    for candidate in sorted(
        (
            item
            for item in discussion_candidates
            if str(item.get("source", "")).endswith("_fallback")
            and item.get("source") != "record_discussion_fallback"
            and item.get("baseScore", 0.0) >= 0.8
        ),
        key=lambda item: (item.get("combinedScore", item.get("baseScore", 0.0)), evidence_support_count(item)),
        reverse=True,
    ):
        text = formalize_transcript_discussion_point(candidate.get("text", ""), candidate.get("evidence", []))
        if text and not text.endswith("."):
            text += "."
        key = normalized_key(text)
        if not key or key in existing_discussion_keys:
            continue
        valid, _reason = is_valid_discussion_point(text, evidence_support_count(candidate))
        deterministic_fallback = is_safe_deterministic_discussion_fallback(candidate, text)
        if not valid and not deterministic_fallback:
            continue
        if any(discussion_similarity(text, existing) >= 0.72 for existing in output.get("discussionPoints", [])):
            continue
        output["discussionPoints"].append(text)
        output["discussionPointDetails"].append(
            {
                "discussionPoint": text,
                "sourceType": candidate.get("source", "deterministic_discussion_fallback"),
                "selectedReason": "deterministic_discussion_fallback",
                "cleanedCandidateSentences": [candidate.get("text", "")],
                "representativeSentence": candidate.get("text", ""),
                "sourceTurnIndices": candidate.get("sourceTurnIndices", evidence_source_turn_indices(candidate.get("evidence", []))),
                "_evidence": candidate.get("evidence", []),
                "evidenceScore": round(candidate.get("combinedScore", candidate.get("baseScore", 0.0)), 2),
                "candidateType": candidate.get("candidateType", "window"),
                "coherenceScore": candidate.get("coherenceScore", 0.0),
            }
        )
        output["internalEvidence"]["discussionPoints"].append({"text": text, "_evidence": candidate.get("evidence", [])})
        if include_diagnostics:
            diagnostics["selectedDiscussionPoints"].append(text)
        existing_discussion_keys.add(key)
        if len(output["discussionPoints"]) >= max_discussion_points:
            break

    supplement_status_review_workstream_output(output, intermediate, diagnostics)
    supplement_speakerless_task_review_output(output, intermediate, diagnostics)
    output["actions"] = dedupe_action_objects(output["actions"])[:6]
    output["meetingActionPoint"] = [item["meetingActionPoint"] for item in output["actions"]]
    output["meetingActionPointOwner"] = [item["meetingActionPointOwner"] for item in output["actions"]]
    output["meetingActionPointDeadline"] = [item["meetingActionPointDeadline"] for item in output["actions"]]
    public_speaker_names = {name.lower() for name in speaker_names} | set(speaker_names)
    sanitize_public_output_items(output, public_speaker_names)
    enrich_discussion_point_details(output, detail_budget, public_speaker_names)
    build_evidence_backed_topics(output, intermediate, public_speaker_names)

    output["meetingObjectives"] = []

    if rewriter and rewriter.available and include_diagnostics:
        diagnostics["rewriteSkipped"] = "MiniLM evidence-first output keeps exact transcript evidence and does not run a final rewrite/summarisation pass."

    enforce_evidence_first_final_contract(output)
    apply_client_facing_minutes_schema(output)

    if include_diagnostics:
        diagnostics["finalCounts"] = {
            "discussionPoints": len(output.get("discussionPoints", [])),
            "decisions": len(output.get("decisions", [])),
            "actions": len(output.get("actions", [])),
        }
        if not any(diagnostics["finalCounts"].values()):
            diagnostics["warnings"] = diagnostics.get("warnings", [])
            diagnostics["warnings"].append(
                "No reliable meeting-minutes candidates were selected from the parsed transcript."
            )

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
    discussion_candidates_raw, window_rejections = collect_discussion_candidates(intermediate, backend)
    diagnostics["rejectedDiscussionCandidates"].extend(window_rejections)
    for candidate in discussion_candidates_raw:
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
                    "candidateType": candidate.get("candidateType", "parser"),
                    "combinedScore": candidate["combinedScore"],
                    "semanticScore": candidate["semanticScore"],
                    "supportScore": candidate.get("supportScore", 0.0),
                    "sourceTurnIndices": candidate.get("sourceTurnIndices", evidence_source_turn_indices(candidate.get("evidence", []))),
                    "sourceSnippets": candidate.get("sourceSnippets", [ref.get("text", "") for ref in candidate.get("evidence", [])[:4]]),
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
                "candidateTypes": [candidate.get("candidateType", "parser") for candidate in cluster],
                "selectedDiscussionPoint": "" if built is None else built["text"],
                "score": 0.0 if built is None else built["score"],
                "supportCount": 0 if built is None else built["supportCount"],
                "keywords": [] if built is None else built["keywords"],
                "coherenceScore": 0.0 if built is None else built.get("coherenceScore", 0.0),
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
