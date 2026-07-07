#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODELS = [
    # Verified with Claire's OpenRouter key on both short and ~36k-char transcripts.
    # Other free models are often blocked/rate-limited on this account, so keep this first.
    "tencent/hy3:free",
]


def load_local_env_if_needed() -> None:
    """Small dotenv fallback for Python child processes launched by PM2/Node.

    The Node app may load only its own required env vars at startup; this script
    also needs OpenRouter-specific values. Avoid a dependency on python-dotenv and
    never print secrets.
    """
    env_path = Path(__file__).resolve().parents[1] / ".env"
    if not env_path.exists():
        return
    wanted_prefixes = ("OPENROUTER_", "MEETING_MINUTES_FINAL_TIMEOUT_MS")
    try:
        lines = env_path.read_text(encoding="utf-8").splitlines()
    except Exception:
        return
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        key = key.strip()
        if not key.startswith(wanted_prefixes):
            continue
        value = value.strip().strip('"').strip("'")
        # Treat the checked-in deployment .env as authoritative for OpenRouter.
        # PM2 may retain stale/partial env values from earlier deploy attempts.
        if key.startswith("OPENROUTER_") or not os.environ.get(key):
            os.environ[key] = value


def clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())


def string_list(value: Any, limit: int = 20) -> list[str]:
    if not isinstance(value, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in value:
        text = clean_text(item)
        if not text:
            continue
        key = text.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(text)
        if len(out) >= limit:
            break
    return out


def normalise_action(action: Any) -> dict[str, str] | None:
    if not isinstance(action, dict):
        return None
    text = clean_text(action.get("meetingActionPoint") or action.get("action"))
    if not text:
        return None
    return {
        "meetingActionPoint": text,
        "meetingActionPointOwner": clean_text(action.get("meetingActionPointOwner") or action.get("owner")) or "Not stated",
        "meetingActionPointDeadline": clean_text(action.get("meetingActionPointDeadline") or action.get("deadline")) or "Not stated",
    }


def normalise_output(raw: dict[str, Any]) -> dict[str, Any]:
    participants = raw.get("participants") if isinstance(raw.get("participants"), dict) else {}
    actions = [item for item in (normalise_action(a) for a in (raw.get("actions") or [])) if item]
    discussion = string_list(raw.get("discussionPoints"), limit=30)
    minutes = []
    for item in raw.get("meetingMinutes") or []:
        if not isinstance(item, dict):
            continue
        points = string_list(item.get("discussionPoints"), limit=12)
        if points:
            minutes.append({"topic": clean_text(item.get("topic")) or "Discussion", "discussionPoints": points})
    if not minutes and discussion:
        minutes = [{"topic": "Discussion", "discussionPoints": discussion}]

    output = {
        "meetingTitle": clean_text(raw.get("meetingTitle")),
        "meetingDate": clean_text(raw.get("meetingDate")),
        "meetingLocation": clean_text(raw.get("meetingLocation")),
        "meetingDescription": clean_text(raw.get("meetingDescription")),
        "meetingObjectives": string_list(raw.get("meetingObjectives"), limit=8),
        "participants": {
            "client": string_list(participants.get("client"), limit=20),
            "trinzo": string_list(participants.get("trinzo"), limit=20),
        },
        "executiveSummary": clean_text(raw.get("executiveSummary")),
        "discussionPoints": discussion,
        "decisions": string_list(raw.get("decisions"), limit=15),
        "meetingActionPoint": [a["meetingActionPoint"] for a in actions],
        "meetingActionPointOwner": [a["meetingActionPointOwner"] for a in actions],
        "meetingActionPointDeadline": [a["meetingActionPointDeadline"] for a in actions],
        "actions": actions,
        "meetingMinutes": minutes,
        "nextSteps": [
            {"action": a["meetingActionPoint"], "owner": a["meetingActionPointOwner"], "deadline": a["meetingActionPointDeadline"]}
            for a in actions
        ],
        "openQuestions": string_list(raw.get("openQuestions"), limit=15),
    }
    return output


def extract_json(text: str) -> dict[str, Any]:
    cleaned = (text or "").strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.I)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    try:
        value = json.loads(cleaned)
        return value if isinstance(value, dict) else {}
    except json.JSONDecodeError:
        pass
    match = re.search(r"\{.*\}", cleaned, re.S)
    if not match:
        return {}
    try:
        value = json.loads(match.group(0))
        return value if isinstance(value, dict) else {}
    except json.JSONDecodeError:
        return {}


def prompt_for_transcript(transcript: str) -> str:
    return f"""You are preparing client-ready professional meeting minutes for Trinzo from a raw meeting transcript.

Your job is to write clean, useful minutes for the client. Use the transcript as evidence, but do not imitate transcript wording.

Critical rules:
- Return JSON only. No markdown, commentary, or code fences.
- Use concise UK business English.
- Write formal minutes, not transcript narration.
- Do NOT write repetitive speaker-attribution lines like "Jacqui said that..." unless the named person is responsible for an action/decision or attribution is essential.
- Do NOT include raw transcript artefacts: timestamps, speaker labels, "started transcription", "stopped transcription", filler, false starts, malformed grammar, duplicated names, or copied questions.
- Do NOT invent facts, dates, decisions, owners, deadlines, attendees, or technical details.
- Do NOT convert relative dates/deadlines into calendar dates. If the transcript says "Wednesday", "next week" or "the 20th", preserve that wording unless the exact calendar date is explicitly stated.
- If the transcript is unclear, omit the point or write "Not stated" for owner/deadline fields.
- Prefer fewer high-quality points over many weak points.
- Action items must be actual commitments or required follow-ups, not general discussion.
- Decisions must be actual decisions/confirmations, not every statement.
- Discussion points should be polished factual summaries of what matters.
- Preserve important names, dates, regulations, standards, product names, site names and project terms when clearly stated.

Return exactly this JSON shape:
{{
  "meetingTitle": "",
  "meetingDate": "",
  "meetingLocation": "",
  "meetingDescription": "",
  "meetingObjectives": [],
  "participants": {{"client": [], "trinzo": []}},
  "executiveSummary": "",
  "discussionPoints": [],
  "decisions": [],
  "actions": [{{"meetingActionPoint": "", "meetingActionPointOwner": "Not stated", "meetingActionPointDeadline": "Not stated"}}],
  "meetingMinutes": [{{"topic": "", "discussionPoints": []}}],
  "nextSteps": [{{"action": "", "owner": "Not stated", "deadline": "Not stated"}}],
  "openQuestions": []
}}

Transcript:
<<<TRANSCRIPT>>>
{transcript}
<<<END TRANSCRIPT>>>"""


def model_list() -> list[str]:
    configured = os.environ.get("OPENROUTER_MODEL", "").strip()
    fallback_env = os.environ.get("OPENROUTER_MODEL_FALLBACKS", "").strip()
    models = []
    if configured:
        models.append(configured)
    if fallback_env:
        models.extend([m.strip() for m in fallback_env.split(",") if m.strip()])
    models.extend(DEFAULT_MODELS)
    deduped: list[str] = []
    seen: set[str] = set()
    for model in models:
        if model not in seen:
            deduped.append(model)
            seen.add(model)
    return deduped


def empty_failure_output(error_message: str) -> dict[str, Any]:
    return {
        "meetingTitle": "Meeting minutes generation failed",
        "meetingDate": "",
        "meetingLocation": "",
        "meetingDescription": "The meeting minutes could not be generated automatically.",
        "meetingObjectives": [],
        "participants": {"client": [], "trinzo": []},
        "executiveSummary": error_message,
        "discussionPoints": [error_message],
        "decisions": [],
        "meetingActionPoint": [],
        "meetingActionPointOwner": [],
        "meetingActionPointDeadline": [],
        "actions": [],
        "meetingMinutes": [{"topic": "Generation issue", "discussionPoints": [error_message]}],
        "nextSteps": [],
        "openQuestions": [],
    }


def call_openrouter(transcript: str, timeout_seconds: int) -> tuple[dict[str, Any], dict[str, Any]]:
    api_key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not api_key:
        message = "OPENROUTER_API_KEY is not configured."
        return empty_failure_output(message), {"provider": "openrouter", "model": None, "used": False, "error": message}

    errors = []
    for model in model_list():
        body = {
            "model": model,
            "messages": [
                {"role": "system", "content": "You write accurate, client-ready professional meeting minutes from transcripts. Return valid JSON only."},
                {"role": "user", "content": prompt_for_transcript(transcript)},
            ],
            "temperature": 0.1,
            "max_tokens": 7000,
        }
        started = time.perf_counter()
        payload = None
        last_error = None
        for attempt in range(2):
            request = urllib.request.Request(
                OPENROUTER_URL,
                data=json.dumps(body).encode("utf-8"),
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {api_key}",
                    "HTTP-Referer": "https://trinzo.virtual-hub.online",
                    "X-Title": "Trinzo Meeting Minutes Final",
                },
                method="POST",
            )
            try:
                with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
                    payload = json.loads(response.read().decode("utf-8"))
                last_error = None
                break
            except urllib.error.HTTPError as exc:
                detail = ""
                try:
                    detail = json.loads(exc.read().decode("utf-8")).get("error", {}).get("message", "")
                except Exception:
                    pass
                last_error = f"HTTP {exc.code}: {clean_text(detail)[:240]}"
                if exc.code not in {429, 500, 502, 503, 504}:
                    break
                time.sleep(2.0)
            except Exception as exc:
                last_error = clean_text(str(exc))[:240]
                time.sleep(2.0)
        if payload is None:
            errors.append({"model": model, "error": last_error or "No response"})
            continue

        content = ""
        choices = payload.get("choices") or []
        if choices:
            content = choices[0].get("message", {}).get("content", "")
        parsed = extract_json(content)
        if not parsed:
            errors.append({"model": model, "error": "No parseable JSON returned"})
            continue
        diagnostics = {
            "provider": "openrouter",
            "model": model,
            "used": True,
            "errorsBeforeSuccess": errors,
            "runtimeMs": round((time.perf_counter() - started) * 1000, 2),
            "usage": payload.get("usage") or {},
        }
        return normalise_output(parsed), diagnostics

    message = "OpenRouter generation failed for all configured free models. Please retry; free models can be temporarily unavailable."
    return empty_failure_output(message), {
        "provider": "openrouter",
        "model": None,
        "used": False,
        "error": message,
        "errors": errors,
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate meeting minutes with one full-transcript OpenRouter prompt.")
    parser.add_argument("transcript_path")
    parser.add_argument("--skip-diagnostics", action="store_true")
    parser.add_argument("--include-baseline-reference", action="store_true")
    parser.add_argument("--skip-rewrite", action="store_true", help="Accepted for compatibility; ignored.")
    parser.add_argument("--timeout-seconds", type=int, default=int(os.environ.get("OPENROUTER_TIMEOUT_SECONDS", "120")))
    return parser.parse_args(argv)


def main() -> int:
    load_local_env_if_needed()
    args = parse_args(sys.argv[1:])
    transcript = Path(args.transcript_path).read_text(encoding="utf-8")
    started = time.perf_counter()
    output, diagnostics = call_openrouter(transcript, args.timeout_seconds)
    runtime_ms = round((time.perf_counter() - started) * 1000, 2)
    payload: dict[str, Any] = {
        "mode": "meeting_minutes_final_openrouter_full_transcript",
        "executed": True,
        "modelAvailable": True,
        "modelName": diagnostics.get("model"),
        "modelReason": "openrouter_full_transcript_single_prompt",
        "rewriterAvailable": bool(diagnostics.get("used")),
        "rewriterModelName": diagnostics.get("model"),
        "rewriterModelPath": None,
        "rewriterReason": "OpenRouter full-transcript LLM used." if diagnostics.get("used") else diagnostics.get("error", "OpenRouter was not used."),
        "rewriterTokenUsage": diagnostics.get("usage") or None,
        "rewriterDiagnosticsSummary": {
            "provider": diagnostics.get("provider"),
            "model": diagnostics.get("model"),
            "used": diagnostics.get("used"),
            "error": diagnostics.get("error"),
            "errors": diagnostics.get("errors", [])[:4],
        },
        "output": output,
        "counts": {
            "discussionPoints": len(output.get("discussionPoints", [])),
            "decisions": len(output.get("decisions", [])),
            "actions": len(output.get("actions", [])),
        },
        "timingMs": {"total": runtime_ms, "openrouter": diagnostics.get("runtimeMs", runtime_ms)},
    }
    if not args.skip_diagnostics:
        payload["diagnostics"] = {"openRouter": diagnostics}
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
