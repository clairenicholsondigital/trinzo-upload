#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path
from typing import Any

from google_ai_studio_minutes import (
    build_google_minutes_evidence_pack,
    generate_minutes_with_google_ai_studio,
    run_minilm_quality_control,
)
from meeting_minutes_final_colab_core import generate_polished_minutes_pass
from meeting_minutes_minilm_experiment import (
    MiniLMBackend,
    build_minilm_only_output,
    collect_minilm_only_context,
    infer_minilm_meeting_date,
    infer_minilm_meeting_title,
    parse_numeric_turns,
    synthesize_meeting_scope_objective,
)
from meeting_minutes_text import apply_british_english_to_payload

_TRANSCRIPTION_HOST_RE = re.compile(r"^(?P<name>.+?)\s+started transcription\b", re.IGNORECASE | re.MULTILINE)
_NON_PARTICIPANT_SPEAKER_NAMES = {
    "unknown", "speaker", "participant", "participants", "recording",
    "transcript", "action", "actions", "decision", "decisions",
}


def section(markdown: str, heading: str) -> str:
    pattern = re.compile(rf"^##\s+{re.escape(heading)}\s*$", re.IGNORECASE | re.MULTILINE)
    match = pattern.search(markdown)
    if not match:
        return ""
    rest = markdown[match.end() :]
    next_heading = re.search(r"^##\s+", rest, re.MULTILINE)
    return rest[: next_heading.start()] if next_heading else rest


def clean_line(value: Any) -> str:
    value = re.sub(r"_\(Sources?:.*?\)_", "", str(value or ""))
    return value.strip(" -")


def bullets(section_text: str) -> list[str]:
    values: list[str] = []
    for line in section_text.splitlines():
        stripped = line.strip()
        lowered = stripped.lower()
        if not stripped.startswith("- "):
            continue
        if lowered.startswith(("- none", "- no decisions", "- no action", "- no substantive")):
            continue
        values.append(clean_line(stripped))
    return values


def table_rows(section_text: str) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    headers: list[str] = []
    for line in section_text.splitlines():
        stripped = line.strip()
        if not stripped.startswith("|") or not stripped.endswith("|"):
            continue
        cells = [cell.strip() for cell in stripped.strip("|").split("|")]
        if not cells or all(set(cell) <= {"-"} for cell in cells):
            continue
        if not headers:
            headers = [cell.lower() for cell in cells]
            continue
        rows.append({headers[index]: cell for index, cell in enumerate(cells) if index < len(headers)})
    return rows


def parse_colab_minutes(markdown: str) -> dict[str, Any]:
    summary = bullets(section(markdown, "Summary"))
    discussion = bullets(section(markdown, "Discussion Points"))
    follow_up = bullets(section(markdown, "Follow-up / Open Questions"))
    decisions = bullets(section(markdown, "Decisions"))
    rows = table_rows(section(markdown, "Action Items"))
    actions = [
        {
            "meetingActionPoint": row.get("action", ""),
            "meetingActionPointOwner": row.get("owner", ""),
            "meetingActionPointDeadline": row.get("due / status", "")
            or row.get("deadline / status", "")
            or row.get("deadline", ""),
        }
        for row in rows
        if row.get("action")
    ]
    meeting_action_points = [action["meetingActionPoint"] for action in actions]
    meeting_action_owners = [action["meetingActionPointOwner"] for action in actions]
    meeting_action_deadlines = [action["meetingActionPointDeadline"] for action in actions]
    return {
        "meetingTitle": "",
        "meetingDate": "",
        "meetingLocation": "",
        "meetingDescription": "",
        "meetingObjectives": [],
        "participants": {"client": [], "trinzo": []},
        "executiveSummary": " ".join(summary),
        "discussionPoints": discussion + follow_up,
        "decisions": decisions,
        "meetingActionPoint": meeting_action_points,
        "meetingActionPointOwner": meeting_action_owners,
        "meetingActionPointDeadline": meeting_action_deadlines,
        "actions": actions,
        "meetingMinutes": [{"topic": "Discussion", "discussionPoints": discussion + follow_up}],
        "nextSteps": [
            {
                "action": action["meetingActionPoint"],
                "owner": action["meetingActionPointOwner"],
                "deadline": action["meetingActionPointDeadline"],
            }
            for action in actions
        ],
    }


def build_counts(payload: dict[str, Any]) -> dict[str, int]:
    return {
        "discussionPoints": len(payload.get("discussionPoints", [])),
        "decisions": len(payload.get("decisions", [])),
        "actions": len(payload.get("actions", [])),
    }


def _detect_participants(transcript_text: str) -> dict[str, list[str]]:
    """Best-effort speaker list for the fallback path, split into a host/team
    bucket (Trinzo) and everyone else (client).

    The Teams export names whoever started the recording, which in every
    sample transcript we have seen is the Trinzo facilitator running the
    call, so that speaker is used as the one reliable signal for the split.
    Everyone else is bucketed as "client" -- correct for the common case of
    an external client meeting, but a purely internal call will need the
    split corrected by whoever reviews the draft in the editable minutes UI.
    """

    host_match = _TRANSCRIPTION_HOST_RE.search(transcript_text)
    host_name = host_match.group("name").strip() if host_match else ""

    seen: set[str] = set()
    ordered_names: list[str] = []
    for turn in parse_numeric_turns(transcript_text):
        name = str(turn.get("speaker") or "").strip()
        key = name.lower()
        if not name or key in _NON_PARTICIPANT_SPEAKER_NAMES or key in seen:
            continue
        seen.add(key)
        ordered_names.append(name)

    if not ordered_names:
        return {"client": [], "trinzo": []}

    trinzo = [name for name in ordered_names if host_name and name.lower() == host_name.lower()]
    client = [name for name in ordered_names if name not in trinzo]
    if not trinzo:
        trinzo, client = client[:1], client[1:]
    return {"client": client, "trinzo": trinzo}


def enrich_fallback_meeting_fields(output: dict[str, Any], transcript_text: str) -> dict[str, Any]:
    enriched = dict(output)
    if not clean_line(enriched.get("meetingTitle", "")):
        enriched["meetingTitle"] = infer_minilm_meeting_title(transcript_text)
    if not clean_line(enriched.get("meetingDate", "")):
        enriched["meetingDate"] = infer_minilm_meeting_date(transcript_text)
    if not clean_line(enriched.get("meetingLocation", "")):
        enriched["meetingLocation"] = "Online"
    participants = enriched.get("participants")
    if not isinstance(participants, dict) or not (participants.get("client") or participants.get("trinzo")):
        enriched["participants"] = _detect_participants(transcript_text)
    if not enriched.get("meetingObjectives"):
        enriched["meetingObjectives"] = synthesize_meeting_scope_objective(enriched)
    if not clean_line(enriched.get("meetingDescription", "")):
        objectives = enriched.get("meetingObjectives") or []
        if objectives:
            enriched["meetingDescription"] = objectives[0]
    return enriched


def _source_items(values: Any, limit: int = 6) -> list[dict[str, str]]:
    sources: list[dict[str, str]] = []
    if not isinstance(values, list):
        return sources
    for value in values:
        if not isinstance(value, dict):
            continue
        text = clean_line(value.get("text", ""))
        if not text:
            continue
        speaker = clean_line(value.get("speaker", ""))
        sources.append({"speaker": speaker, "text": text})
        if len(sources) >= limit:
            break
    return sources


def _section_entry(text: Any, evidence: Any, *, owner: str = "", deadline: str = "") -> dict[str, Any] | None:
    cleaned = clean_line(text)
    if not cleaned:
        return None
    return {
        "speaker": "",
        "text": cleaned,
        "owner": clean_line(owner),
        "deadline": clean_line(deadline),
        "sources": _source_items(evidence),
    }


def _append_entry(entries: list[dict[str, Any]], text: Any, evidence: Any, *, owner: str = "", deadline: str = "") -> None:
    entry = _section_entry(text, evidence, owner=owner, deadline=deadline)
    if entry is not None:
        entries.append(entry)


def build_minilm_topic_sections(minilm_output: dict[str, Any], fallback_sections: dict[str, Any] | None = None) -> dict[str, Any]:
    """Adapt semantic MiniLM output into the existing Google evidence-pack shape.

    The older production writer already expects topic-group sections containing
    short public text plus direct transcript sources. This adapter lets the
    production route use the semantic MiniLM topic/action/decision selection
    without making the Gemini prompt or UI contract understand a second schema.
    """

    topics: list[dict[str, Any]] = []
    for topic in minilm_output.get("evidenceBackedTopics", []) or []:
        if not isinstance(topic, dict):
            continue
        evidence = _source_items(topic.get("directEvidence", []), limit=4)
        context = _source_items(topic.get("supportingContext", []), limit=3)
        sources = evidence + [source for source in context if source not in evidence]
        sections = {
            "Discussion points": [],
            "Responsibilities": [],
            "Evidence required": [],
            "Risks": [],
            "Open questions": [],
        }
        _append_entry(sections["Discussion points"], topic.get("topicLabel", ""), sources)
        for detail in topic.get("attributedDetailPoints", []) or []:
            _append_entry(sections["Discussion points"], detail, sources)
        for value in topic.get("candidateResponsibilitiesMentioned", []) or []:
            _append_entry(sections["Responsibilities"], value, sources)
        for value in topic.get("candidateDocumentsMentioned", []) or []:
            _append_entry(sections["Evidence required"], value, sources)
        for value in topic.get("candidateOpenQuestions", []) or []:
            _append_entry(sections["Open questions"], value, sources)
        for action in topic.get("candidateActionsOnlyIfExplicitlyStated", []) or []:
            if not isinstance(action, dict):
                continue
            _append_entry(
                sections["Discussion points"],
                action.get("action", ""),
                action.get("evidence", []) or sources,
                owner=action.get("owner", ""),
                deadline=action.get("deadline", ""),
            )
        sections = {name: entries for name, entries in sections.items() if entries}
        if not sections:
            continue
        topics.append(
            {
                "topic": clean_line(topic.get("themeLabel", "")) or clean_line(topic.get("topicLabel", "")) or "Discussion",
                "sections": sections,
            }
        )
        if len(topics) >= 12:
            break

    # This production hook is deliberately topic/discussion-only. The older
    # action/decision path has more fixture coverage and fewer false-positive
    # risks, so keep it as the source of actions/decisions until those MiniLM
    # selectors are separately re-baselined.
    fallback_sections = fallback_sections if isinstance(fallback_sections, dict) else {}
    return {
        "topics": topics,
        "actions": list(fallback_sections.get("actions", []) or []),
        "decisions": list(fallback_sections.get("decisions", []) or []),
    }


def merge_semantic_topics_into_fallback(keyword_output: dict[str, Any], semantic_output: dict[str, Any] | None) -> dict[str, Any]:
    if not semantic_output:
        return dict(keyword_output)
    merged = dict(keyword_output)
    for key in [
        "meetingTitle",
        "meetingDate",
        "meetingLocation",
        "participants",
        "meetingDescription",
        "meetingObjectives",
    ]:
        if semantic_output.get(key):
            merged[key] = semantic_output[key]
    if semantic_output.get("discussionPoints"):
        merged["discussionPoints"] = semantic_output["discussionPoints"]
        merged["meetingMinutes"] = semantic_output.get("meetingMinutes") or [
            {"topic": "Discussion", "discussionPoints": semantic_output["discussionPoints"]}
        ]
    for key in [
        "discussionPointDetails",
        "internalEvidence",
        "meetingOverview",
        "evidenceBackedTopics",
        "openQuestions",
        "documentsMentioned",
        "responsibilitiesMentioned",
        "excludedWeakCandidates",
    ]:
        if key in semantic_output:
            merged[key] = semantic_output[key]
    # Preserve the existing production action/decision extraction path.
    for key in [
        "decisions",
        "decisionDetails",
        "actions",
        "meetingActionPoint",
        "meetingActionPointOwner",
        "meetingActionPointDeadline",
        "nextSteps",
    ]:
        if key in keyword_output:
            merged[key] = keyword_output[key]
    return merged


def build_semantic_minilm_minutes(transcript_text: str, include_diagnostics: bool) -> tuple[dict[str, Any] | None, dict[str, Any], float]:
    start = time.perf_counter()
    diagnostics: dict[str, Any] = {
        "enabled": True,
        "used": False,
        "modelAvailable": False,
        "modelReason": "",
        "fallbackReason": "",
    }
    try:
        intermediate = collect_minilm_only_context(transcript_text)
        backend = MiniLMBackend.load(enabled=True)
        diagnostics["modelAvailable"] = backend.available
        diagnostics["modelReason"] = backend.reason
        output, minilm_diagnostics = build_minilm_only_output(
            transcript_text,
            intermediate,
            backend,
            rewriter=None,
            include_diagnostics=include_diagnostics,
        )
        if include_diagnostics:
            diagnostics["details"] = minilm_diagnostics
        if not output:
            diagnostics["fallbackReason"] = backend.reason or "MiniLM output was empty."
            return None, diagnostics, round((time.perf_counter() - start) * 1000, 2)
        counts = build_counts(output)
        has_topic_evidence = bool(output.get("evidenceBackedTopics"))
        if not has_topic_evidence and not any(counts.values()):
            diagnostics["fallbackReason"] = "MiniLM selected no usable discussion, decision, or action candidates."
            return None, diagnostics, round((time.perf_counter() - start) * 1000, 2)
        diagnostics["used"] = True
        diagnostics["counts"] = counts
        diagnostics["topicCount"] = len(output.get("evidenceBackedTopics", []) or [])
        return output, diagnostics, round((time.perf_counter() - start) * 1000, 2)
    except Exception as exc:  # pragma: no cover - exercised in production/runtime environments
        diagnostics["fallbackReason"] = f"MiniLM production extraction failed: {exc}"
        return None, diagnostics, round((time.perf_counter() - start) * 1000, 2)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the Colab-style meeting-minutes-final extractor.")
    parser.add_argument("transcript_path", help="Path to the transcript file.")
    parser.add_argument("--include-baseline-reference", action="store_true")
    parser.add_argument("--skip-diagnostics", action="store_true")
    parser.add_argument("--skip-rewrite", action="store_true")
    return parser.parse_args(argv)


def main() -> int:
    args = parse_args(sys.argv[1:])
    transcript_text = Path(args.transcript_path).read_text(encoding="utf-8")

    keyword_start = time.perf_counter()
    result = generate_polished_minutes_pass(transcript_text=transcript_text)
    keyword_runtime_ms = round((time.perf_counter() - keyword_start) * 1000, 2)
    keyword_fallback_output = apply_british_english_to_payload(enrich_fallback_meeting_fields(parse_colab_minutes(result["minutes"]), transcript_text))

    semantic_output, semantic_diagnostics, semantic_runtime_ms = build_semantic_minilm_minutes(
        transcript_text,
        include_diagnostics=not args.skip_diagnostics,
    )
    using_semantic_minilm = semantic_output is not None
    merged_fallback_output = merge_semantic_topics_into_fallback(keyword_fallback_output, semantic_output)
    fallback_output = apply_british_english_to_payload(
        enrich_fallback_meeting_fields(merged_fallback_output, transcript_text)
    )

    rewrite_start = time.perf_counter()
    evidence_sections = build_minilm_topic_sections(semantic_output, result.get("sections", {})) if semantic_output else result.get("sections", {})
    evidence_pack = build_google_minutes_evidence_pack(evidence_sections, fallback_output)
    if args.skip_rewrite:
        google_output, google_diagnostics = None, {
            "provider": "google_ai_studio",
            "model": None,
            "available": False,
            "used": False,
            "error": "Skipped via --skip-rewrite.",
        }
    else:
        google_output, google_diagnostics = generate_minutes_with_google_ai_studio(evidence_pack, fallback_output)
    rewrite_runtime_ms = round((time.perf_counter() - rewrite_start) * 1000, 2)

    output = apply_british_english_to_payload(google_output or fallback_output)
    qc_start = time.perf_counter()
    qc_diagnostics = run_minilm_quality_control(output, evidence_pack)
    qc_runtime_ms = round((time.perf_counter() - qc_start) * 1000, 2)
    runtime_ms = round(keyword_runtime_ms + semantic_runtime_ms + rewrite_runtime_ms + qc_runtime_ms, 2)

    payload: dict[str, Any] = {
        "mode": "meeting_minutes_final_hybrid",
        "executed": True,
        "modelAvailable": True,
        "modelName": "MiniLM evidence graph + Google AI Studio writing pass",
        "modelReason": "semantic_minilm_topics_google_first_pass_minilm_qc" if using_semantic_minilm else "keyword_topics_google_first_pass_minilm_qc_fallback",
        "rewriterAvailable": bool(google_diagnostics.get("available")),
        "rewriterModelName": google_diagnostics.get("model"),
        "rewriterModelPath": None,
        "rewriterReason": "Google AI Studio used." if google_diagnostics.get("used") else google_diagnostics.get("error", "Google AI Studio not used."),
        "rewriterTokenUsage": google_diagnostics.get("usageMetadata") or None,
        "output": output,
        "counts": build_counts(output),
        "timingMs": {
            "baseline": 0.0,
            "context": 0.0,
            "keywordExtractor": keyword_runtime_ms,
            "semanticMiniLM": semantic_runtime_ms,
            "minilm": semantic_runtime_ms,
            "rewrite": rewrite_runtime_ms,
            "qualityControl": qc_runtime_ms,
            "total": runtime_ms,
        },
    }

    if not args.skip_diagnostics:
        payload["diagnostics"] = {
            "scorecard": result.get("scorecard", {}),
            "evaluation": result.get("evaluation", {}),
            "markdownMinutes": result.get("minutes", ""),
            "productionTopicExtractor": {
                "used": "semantic_minilm" if using_semantic_minilm else "keyword_profile_fallback",
                "semanticMiniLM": semantic_diagnostics,
                "keywordProfileReference": {
                    "runtimeMs": keyword_runtime_ms,
                    "scorecard": result.get("scorecard", {}),
                    "evaluation": result.get("evaluation", {}),
                },
            },
            "googleAiStudio": google_diagnostics,
            "minilmQualityControl": qc_diagnostics,
        }

    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
