from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from copy import deepcopy
from typing import Any

DEFAULT_GOOGLE_AI_STUDIO_MODEL = "gemini-2.5-flash"
GOOGLE_AI_STUDIO_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"


def _clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())


def _string_list(values: Any, limit: int = 12) -> list[str]:
    if not isinstance(values, list):
        return []
    result = []
    for value in values:
        cleaned = _clean_text(value)
        if cleaned:
            result.append(cleaned)
        if len(result) >= limit:
            break
    return result


def _is_admin_logistics_text(text: str) -> bool:
    lowered = f" {_clean_text(text).lower()} "
    if not lowered.strip():
        return False
    admin_markers = (
        " external access ",
        " sharepoint ",
        " access to the ",
        " get you access ",
        " give you access ",
        " hotel ",
        " reservation ",
        " calendar invite ",
        " teams invite ",
        " meeting invite ",
        " dial in ",
        " dial-in ",
        " before we start ",
        " before the monday ",
    )
    return any(marker in lowered for marker in admin_markers)


def _is_low_quality_decision_text(text: str) -> bool:
    lowered = f" {_clean_text(text).lower()} "
    if not lowered.strip():
        return True
    if re.search(r"\b\d{1,2}:\d{2}(?::\d{2})?(?:yes|no|yep|yeah)?[. ]", lowered):
        return True
    if re.search(r"\b(?:i[’']ll|i will)\s+share\b", lowered):
        return True
    if " frees us up " in lowered:
        return True
    if re.search(r"^\s*(?:and\s+)?it\s+also\s+means\b", lowered.strip()):
        return True
    return False


def _public_objectives(values: Any, fallback_values: Any) -> list[str]:
    objectives = [
        value
        for value in _string_list(values, limit=8)
        if not _is_admin_logistics_text(value)
    ]
    if objectives:
        return objectives
    return [
        value
        for value in _string_list(fallback_values, limit=8)
        if not _is_admin_logistics_text(value)
    ]


def _source_snippets(item: dict[str, Any], limit: int = 3) -> list[str]:
    snippets = []
    for source in item.get("sources", []) or []:
        if not isinstance(source, dict):
            continue
        text = _clean_text(source.get("text", ""))
        if text:
            snippets.append(text[:600])
        if len(snippets) >= limit:
            break
    return snippets


def _evidence_items(items: Any, limit: int = 8) -> list[dict[str, Any]]:
    result = []
    if not isinstance(items, list):
        return result
    for item in items:
        if not isinstance(item, dict):
            continue
        text = _clean_text(item.get("text", ""))
        if not text:
            continue
        result.append(
            {
                "text": text,
                "evidence": _source_snippets(item),
                "owner": _clean_text(item.get("owner", "")),
                "deadline": _clean_text(item.get("deadline", "")),
            }
        )
        if len(result) >= limit:
            break
    return result


def build_google_minutes_evidence_pack(sections: dict[str, Any], fallback_output: dict[str, Any]) -> dict[str, Any]:
    topics = []
    for topic in sections.get("topics", []) or []:
        if not isinstance(topic, dict):
            continue
        topic_sections = topic.get("sections", {}) if isinstance(topic.get("sections"), dict) else {}
        topics.append(
            {
                "topic": _clean_text(topic.get("topic", "Discussion")),
                "discussionPoints": _evidence_items(topic_sections.get("Discussion points"), limit=8),
                "responsibilities": _evidence_items(topic_sections.get("Responsibilities"), limit=6),
                "evidenceRequired": _evidence_items(topic_sections.get("Evidence required"), limit=6),
                "risks": _evidence_items(topic_sections.get("Risks"), limit=6),
                "openQuestions": _evidence_items(topic_sections.get("Open questions"), limit=6),
            }
        )
        if len(topics) >= 10:
            break

    return {
        "topics": topics,
        "actions": _evidence_items(sections.get("actions"), limit=14),
        "decisions": _evidence_items(sections.get("decisions"), limit=10),
        "fallbackOutput": {
            "meetingTitle": _clean_text(fallback_output.get("meetingTitle", "")),
            "meetingDate": _clean_text(fallback_output.get("meetingDate", "")),
            "meetingLocation": _clean_text(fallback_output.get("meetingLocation", "")),
            "participants": {
                "client": _string_list((fallback_output.get("participants") or {}).get("client"), limit=12),
                "trinzo": _string_list((fallback_output.get("participants") or {}).get("trinzo"), limit=12),
            },
            "meetingObjectives": _string_list(fallback_output.get("meetingObjectives"), limit=6),
            "executiveSummary": _clean_text(fallback_output.get("executiveSummary", "")),
            "discussionPoints": _string_list(fallback_output.get("discussionPoints"), limit=16),
            "decisions": _string_list(fallback_output.get("decisions"), limit=10),
            "actions": [
                {
                    "meetingActionPoint": _clean_text(action.get("meetingActionPoint", "")),
                    "meetingActionPointOwner": _clean_text(action.get("meetingActionPointOwner", "")) or "Not stated",
                    "meetingActionPointDeadline": _clean_text(action.get("meetingActionPointDeadline", "")) or "Not stated",
                }
                for action in fallback_output.get("actions", []) or []
                if isinstance(action, dict) and _clean_text(action.get("meetingActionPoint", ""))
            ][:14],
        },
    }


def _prompt_for_evidence_pack(evidence_pack: dict[str, Any]) -> str:
    return "\n".join(
        [
            "Write thorough, specific, client-ready meeting minutes from this MiniLM evidence pack.",
            "Each topic below carries a generic 'text' label plus real quoted transcript evidence in its",
            "'evidence' array (and per-item source snippets). The label is only a category name for you to",
            "orient by -- treat it as a heading, never as a sentence to copy into the output. Every discussion",
            "point, risk, and open question you write must be built from the concrete facts in the quoted",
            "evidence: names, numbers, dates, versions, standard/regulation codes, product or system names,",
            "quantities, colours, thresholds, and specific commitments. If a topic's evidence contains several",
            "distinct facts, write a separate discussion point for each one rather than one blended sentence.",
            "Rules:",
            "- Use only the evidence supplied. Do not invent dates, attendees, owners, deadlines, decisions, or claims.",
            "- If a detail is not explicitly supported, use an empty string, an empty list, or 'Not stated'.",
            "- Never write generic meta-commentary such as 'the discussion covered X, Y and Z' or 'open questions",
            "  remain around X' -- state the actual fact, risk, or question itself.",
            "- Do not merge several unrelated facts from one topic into a single vague sentence; split them out.",
            "- Write every discussion point, decision, and open question as a complete, self-contained sentence a",
            "  reader could understand without having read the transcript -- never a fragment, and never dependent",
            "  on a category label next to it for meaning.",
            "- Keep British English spelling.",
            "- Write everything in third person, formal minutes style. Never keep a speaker's first-person",
            "  phrasing (\"I will\", \"I'm\", \"we can\", \"my team\") verbatim -- convert it to a third-person",
            "  statement of fact (e.g. a quoted \"I'll send the report\" becomes \"[Name] will send the report\").",
            "- Do not mention MiniLM, Gemini, evidence packs, prompts, or source snippets in the public output.",
            "- Actions must be real commitments only; do not turn vague discussion into actions.",
            "- Write at most 6 action items. If the evidence contains more than 6 distinct commitments, merge",
            "  closely related ones (e.g. several steps of the same review or the same follow-up task) into a",
            "  single action rather than listing every micro-step separately -- keep the most concrete owner and",
            "  deadline when merging. Never pad the count with restated or duplicate commitments to reach 6.",
            "- Preserve the specific nouns, product/system names, codes, and abbreviations exactly as they appear",
            "  in the evidence (e.g. standard numbers, acronyms, product names) -- do not paraphrase them into",
            "  vaguer terms. If an abbreviation's expansion is stated in the evidence, use the full expansion on",
            "  first mention; otherwise keep the abbreviation as given rather than guessing what it stands for.",
            "- The meeting title and objectives should describe the actual meeting purpose. Do not use admin logistics such as SharePoint access, hotel arrangements, calendar invites, or meeting setup as the overview, objectives, or decisions.",
            "- fallbackOutput.meetingDate, meetingLocation and participants were extracted heuristically from the",
            "  transcript header and speaker list. Reuse them unless the evidence clearly contradicts or refines",
            "  them (for example, moving a name between participants.client and participants.trinzo based on",
            "  context in the discussion, such as someone being referred to as part of the client's team or as",
            "  Trinzo/the audit or project team). Do not blank a field just because you are unsure -- keep the",
            "  fallback value in that case.",
            "- Return JSON only with this shape:",
            '{"meetingTitle":"","meetingDate":"","meetingLocation":"","meetingDescription":"","meetingObjectives":[],"participants":{"client":[],"trinzo":[]},"executiveSummary":"","discussionPoints":[],"decisions":[],"meetingActionPoint":[],"meetingActionPointOwner":[],"meetingActionPointDeadline":[],"actions":[{"meetingActionPoint":"","meetingActionPointOwner":"Not stated","meetingActionPointDeadline":"Not stated"}],"meetingMinutes":[{"topic":"","discussionPoints":[]}],"nextSteps":[{"action":"","owner":"Not stated","deadline":"Not stated"}],"openQuestions":[]}',
            "",
            "MiniLM evidence pack:",
            json.dumps(evidence_pack, ensure_ascii=False),
        ]
    )


def _extract_json_object(text: str) -> dict[str, Any]:
    cleaned = str(text or "").strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.I)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    try:
        payload = json.loads(cleaned)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", cleaned, re.S)
        if not match:
            return {}
        try:
            payload = json.loads(match.group(0))
        except json.JSONDecodeError:
            return {}
    return payload if isinstance(payload, dict) else {}


def _normalise_minutes_output(output: dict[str, Any], fallback_output: dict[str, Any]) -> dict[str, Any]:
    normalised = deepcopy(fallback_output)
    if not isinstance(output, dict):
        return normalised

    meeting_title = _clean_text(output.get("meetingTitle", "")) or _clean_text(fallback_output.get("meetingTitle", ""))
    meeting_date = _clean_text(output.get("meetingDate", "")) or _clean_text(fallback_output.get("meetingDate", ""))
    meeting_location = _clean_text(output.get("meetingLocation", "")) or _clean_text(fallback_output.get("meetingLocation", ""))
    meeting_description = _clean_text(output.get("meetingDescription", "")) or _clean_text(fallback_output.get("meetingDescription", ""))
    executive_summary = _clean_text(output.get("executiveSummary", "")) or _clean_text(fallback_output.get("executiveSummary", ""))

    discussion_points = _string_list(output.get("discussionPoints"), limit=18) or _string_list(fallback_output.get("discussionPoints"), limit=18)
    decisions = [
        value
        for value in _string_list(output.get("decisions"), limit=10)
        if not _is_admin_logistics_text(value) and not _is_low_quality_decision_text(value)
    ]
    if not decisions:
        decisions = [
            value
            for value in _string_list(fallback_output.get("decisions"), limit=10)
            if not _is_admin_logistics_text(value) and not _is_low_quality_decision_text(value)
        ]
    open_questions = _string_list(output.get("openQuestions"), limit=10) or _string_list(fallback_output.get("openQuestions"), limit=10)

    normalised.update(
        {
            "meetingTitle": meeting_title,
            "meetingDate": meeting_date,
            "meetingLocation": meeting_location,
            "meetingDescription": meeting_description,
            "meetingObjectives": _public_objectives(output.get("meetingObjectives"), fallback_output.get("meetingObjectives")),
            "executiveSummary": executive_summary,
            "discussionPoints": discussion_points,
            "decisions": decisions,
            "openQuestions": open_questions,
        }
    )

    participants = output.get("participants") if isinstance(output.get("participants"), dict) else {}
    client_participants = _string_list(participants.get("client"), limit=12)
    trinzo_participants = _string_list(participants.get("trinzo"), limit=12)
    if not client_participants and not trinzo_participants:
        fallback_participants = fallback_output.get("participants") if isinstance(fallback_output.get("participants"), dict) else {}
        client_participants = _string_list(fallback_participants.get("client"), limit=12)
        trinzo_participants = _string_list(fallback_participants.get("trinzo"), limit=12)
    normalised["participants"] = {"client": client_participants, "trinzo": trinzo_participants}

    actions = []
    for action in output.get("actions", []) or []:
        if not isinstance(action, dict):
            continue
        text = _clean_text(action.get("meetingActionPoint") or action.get("action"))
        if not text:
            continue
        actions.append(
            {
                "meetingActionPoint": text,
                "meetingActionPointOwner": _clean_text(action.get("meetingActionPointOwner") or action.get("owner")) or "Not stated",
                "meetingActionPointDeadline": _clean_text(action.get("meetingActionPointDeadline") or action.get("deadline")) or "Not stated",
            }
        )
    normalised["actions"] = actions[:14]
    normalised["meetingActionPoint"] = [action["meetingActionPoint"] for action in normalised["actions"]]
    normalised["meetingActionPointOwner"] = [action["meetingActionPointOwner"] for action in normalised["actions"]]
    normalised["meetingActionPointDeadline"] = [action["meetingActionPointDeadline"] for action in normalised["actions"]]
    normalised["nextSteps"] = [
        {
            "action": action["meetingActionPoint"],
            "owner": action["meetingActionPointOwner"],
            "deadline": action["meetingActionPointDeadline"],
        }
        for action in normalised["actions"]
    ]

    minutes = []
    for minute in output.get("meetingMinutes", []) or []:
        if not isinstance(minute, dict):
            continue
        topic = _clean_text(minute.get("topic", "Discussion")) or "Discussion"
        points = _string_list(minute.get("discussionPoints"), limit=8)
        if points:
            minutes.append({"topic": topic, "discussionPoints": points})
    normalised["meetingMinutes"] = minutes or [{"topic": "Discussion", "discussionPoints": normalised["discussionPoints"]}]

    return normalised


def generate_minutes_with_google_ai_studio(
    evidence_pack: dict[str, Any],
    fallback_output: dict[str, Any],
    api_key: str | None = None,
    model: str | None = None,
    timeout_seconds: int = 45,
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    resolved_key = (api_key or os.environ.get("GOOGLE_AI_STUDIO_API_KEY") or os.environ.get("GEMINI_API_KEY") or "").strip()
    resolved_model = (model or os.environ.get("GOOGLE_AI_STUDIO_MODEL") or DEFAULT_GOOGLE_AI_STUDIO_MODEL).strip()
    diagnostics: dict[str, Any] = {
        "provider": "google_ai_studio",
        "model": resolved_model,
        "available": bool(resolved_key),
        "used": False,
        "error": "",
    }
    if not resolved_key:
        diagnostics["error"] = "GOOGLE_AI_STUDIO_API_KEY is not configured."
        return None, diagnostics

    body = {
        "contents": [{"role": "user", "parts": [{"text": _prompt_for_evidence_pack(evidence_pack)}]}],
        "generationConfig": {
            "temperature": 0.1,
            "topP": 0.8,
            "maxOutputTokens": 12288,
            "responseMimeType": "application/json",
        },
    }
    url = GOOGLE_AI_STUDIO_ENDPOINT.format(model=resolved_model)
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-goog-api-key": resolved_key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            response_payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            error_payload = json.loads(exc.read().decode("utf-8"))
            detail = _clean_text(error_payload.get("error", {}).get("message", ""))[:240]
        except Exception:
            detail = ""
        diagnostics["error"] = f"Google AI Studio HTTP {exc.code}" + (f": {detail}" if detail else "")
        return None, diagnostics
    except Exception as exc:
        diagnostics["error"] = f"Google AI Studio request failed: {exc}"
        return None, diagnostics

    text = ""
    candidates = response_payload.get("candidates", [])
    if candidates:
        parts = candidates[0].get("content", {}).get("parts", [])
        text = "\n".join(str(part.get("text", "")) for part in parts if isinstance(part, dict))
        diagnostics["finishReason"] = candidates[0].get("finishReason", "")
    parsed = _extract_json_object(text)
    if not parsed:
        diagnostics["error"] = "Google AI Studio returned no parseable JSON."
        return None, diagnostics

    diagnostics["used"] = True
    return _normalise_minutes_output(parsed, fallback_output), diagnostics


def _public_items(output: dict[str, Any]) -> list[dict[str, str]]:
    items = []
    for point in output.get("discussionPoints", []) or []:
        text = _clean_text(point)
        if text:
            items.append({"type": "discussion", "text": text})
    for decision in output.get("decisions", []) or []:
        text = _clean_text(decision)
        if text:
            items.append({"type": "decision", "text": text})
    for action in output.get("actions", []) or []:
        if isinstance(action, dict):
            text = _clean_text(action.get("meetingActionPoint", ""))
            if text:
                items.append({"type": "action", "text": text})
    return items


def _evidence_texts(evidence_pack: dict[str, Any]) -> list[str]:
    texts = []
    for topic in evidence_pack.get("topics", []) or []:
        if not isinstance(topic, dict):
            continue
        for key in ("discussionPoints", "responsibilities", "evidenceRequired", "risks", "openQuestions"):
            for item in topic.get(key, []) or []:
                if isinstance(item, dict) and _clean_text(item.get("text", "")):
                    texts.append(_clean_text(item["text"]))
    for key in ("actions", "decisions"):
        for item in evidence_pack.get(key, []) or []:
            if isinstance(item, dict) and _clean_text(item.get("text", "")):
                texts.append(_clean_text(item["text"]))
    return texts


def run_minilm_quality_control(output: dict[str, Any], evidence_pack: dict[str, Any]) -> dict[str, Any]:
    evidence_texts = _evidence_texts(evidence_pack)
    items = _public_items(output)
    diagnostics: dict[str, Any] = {
        "mode": "minilm_evidence_comparison",
        "modelAvailable": False,
        "modelReason": "",
        "checkedItems": len(items),
        "unsupportedItems": [],
        "minimumSimilarity": None,
    }
    if not items or not evidence_texts:
        diagnostics["modelReason"] = "No public items or evidence items to compare."
        return diagnostics

    backend = None
    try:
        from meeting_minutes_minilm_experiment import MiniLMBackend

        backend = MiniLMBackend.load(enabled=True)
    except Exception as exc:
        diagnostics["modelReason"] = f"MiniLM QC unavailable: {exc}"
        backend = None

    diagnostics["modelAvailable"] = bool(backend and backend.available)
    diagnostics["modelReason"] = "" if diagnostics["modelAvailable"] else (getattr(backend, "reason", "") or diagnostics["modelReason"])

    min_similarity = 1.0
    unsupported = []
    for item in items:
        if backend and backend.available:
            score = max((backend.similarity(item["text"], evidence) for evidence in evidence_texts), default=0.0)
            threshold = 0.46
        else:
            item_tokens = set(re.findall(r"[a-z0-9]{4,}", item["text"].lower()))
            score = max(
                (len(item_tokens & set(re.findall(r"[a-z0-9]{4,}", evidence.lower()))) / max(1, len(item_tokens)) for evidence in evidence_texts),
                default=0.0,
            )
            threshold = 0.28
        min_similarity = min(min_similarity, score)
        if score < threshold:
            unsupported.append({"type": item["type"], "text": item["text"], "bestSimilarity": round(score, 4)})

    diagnostics["minimumSimilarity"] = round(min_similarity, 4)
    diagnostics["unsupportedItems"] = unsupported[:12]
    return diagnostics
