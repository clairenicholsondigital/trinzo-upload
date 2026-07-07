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

TROOPER_URL_DEFAULT = "https://eu.router.trooper.ai/v1/chat/completions"
TROOPER_MODEL_DEFAULT = "eu_liv_000099"


def load_local_env_if_needed() -> None:
    """Load deployment .env values needed by this child process without printing secrets."""
    candidates = [
        Path(__file__).resolve().parents[1] / ".env",
        Path("/data/.openclaw/workspace/.secrets/trooper.env"),
    ]
    wanted_prefixes = ("TROOPER_", "MEETING_MINUTES_FINAL_TIMEOUT_MS")
    for env_path in candidates:
        if not env_path.exists():
            continue
        try:
            lines = env_path.read_text(encoding="utf-8").splitlines()
        except Exception:
            continue
        for line in lines:
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, value = stripped.split("=", 1)
            key = key.strip()
            if not key.startswith(wanted_prefixes):
                continue
            value = value.strip().strip('"').strip("'")
            if key.startswith("TROOPER_") or not os.environ.get(key):
                os.environ[key] = value


def clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())


def string_list(value: Any, limit: int = 20) -> list[str]:
    if isinstance(value, str):
        value = [value]
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
        text = clean_text(action)
        if not text:
            return None
        return {
            "meetingActionPoint": text,
            "meetingActionPointOwner": "Not stated",
            "meetingActionPointDeadline": "Not stated",
        }
    text = clean_text(
        action.get("meetingActionPoint")
        or action.get("action")
        or action.get("task")
        or action.get("description")
    )
    if not text:
        return None
    owner = clean_text(action.get("meetingActionPointOwner") or action.get("owner")) or "Not stated"
    deadline = clean_text(action.get("meetingActionPointDeadline") or action.get("deadline")) or "Not stated"
    if deadline.lower() in {"none", "null", "unknown", "no deadline", "no deadline agreed"}:
        deadline = "Not stated"
    return {
        "meetingActionPoint": text,
        "meetingActionPointOwner": owner,
        "meetingActionPointDeadline": deadline,
    }


def normalise_participants(value: Any) -> dict[str, list[str]]:
    if isinstance(value, dict):
        return {
            "client": string_list(value.get("client"), limit=20),
            "trinzo": string_list(value.get("trinzo"), limit=20),
        }
    # If the model only returns a flat participant list, avoid guessing client vs Trinzo.
    return {"client": string_list(value, limit=20), "trinzo": []}


def discussion_list(value: Any, limit: int = 30) -> list[str]:
    if isinstance(value, str):
        return string_list([value], limit=limit)
    if not isinstance(value, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in value:
        candidates: list[str] = []
        if isinstance(item, dict):
            topic = clean_text(item.get("topic") or item.get("title"))
            points = item.get("discussionPoints") or item.get("points") or item.get("details")
            point_list = string_list(points, limit=12)
            if point_list:
                candidates.extend([f"{topic}: {point}" if topic else point for point in point_list])
            else:
                text = clean_text(item.get("summary") or item.get("description") or item.get("discussionPoint"))
                if text:
                    candidates.append(f"{topic}: {text}" if topic else text)
        else:
            candidates.append(clean_text(item))
        for text in candidates:
            if not text:
                continue
            key = text.lower()
            if key in seen:
                continue
            seen.add(key)
            out.append(text)
            if len(out) >= limit:
                return out
    return out


def normalise_minutes(raw: dict[str, Any], discussion: list[str]) -> list[dict[str, Any]]:
    minutes: list[dict[str, Any]] = []
    for item in raw.get("meetingMinutes") or raw.get("minutes") or []:
        if not isinstance(item, dict):
            continue
        points = string_list(item.get("discussionPoints") or item.get("points"), limit=12)
        if points:
            minutes.append({"topic": clean_text(item.get("topic")) or "Discussion", "discussionPoints": points})
    if not minutes:
        grouped = raw.get("discussionSections") or raw.get("discussion")
        if isinstance(grouped, list):
            for item in grouped:
                if isinstance(item, dict):
                    points = string_list(item.get("discussionPoints") or item.get("points") or item.get("details"), limit=12)
                    if points:
                        minutes.append({"topic": clean_text(item.get("topic") or item.get("title")) or "Discussion", "discussionPoints": points})
    if not minutes and discussion:
        minutes = [{"topic": "Discussion", "discussionPoints": discussion}]
    return minutes


def normalise_output(raw: dict[str, Any]) -> dict[str, Any]:
    discussion = discussion_list(raw.get("discussionPoints"), limit=30)
    if not discussion and isinstance(raw.get("risks"), list):
        risk_points = []
        for item in raw.get("risks") or []:
            if isinstance(item, dict):
                risk_points.append(clean_text(item.get("risk") or item.get("description")))
            else:
                risk_points.append(clean_text(item))
        discussion = string_list(risk_points, limit=30)

    actions = [item for item in (normalise_action(a) for a in (raw.get("actions") or raw.get("nextSteps") or [])) if item]
    deduped_actions: list[dict[str, str]] = []
    seen_actions: set[tuple[str, str]] = set()
    for action in actions:
        key = (action["meetingActionPoint"].lower(), action["meetingActionPointOwner"].lower())
        if key in seen_actions:
            continue
        seen_actions.add(key)
        deduped_actions.append(action)

    output = {
        "meetingTitle": clean_text(raw.get("meetingTitle")) or "Meeting minutes",
        "meetingDate": clean_text(raw.get("meetingDate")),
        "meetingLocation": clean_text(raw.get("meetingLocation")),
        "meetingDescription": clean_text(raw.get("meetingDescription") or raw.get("executiveSummary") or raw.get("summary")),
        "meetingObjectives": string_list(raw.get("meetingObjectives"), limit=8),
        "participants": normalise_participants(raw.get("participants")),
        "executiveSummary": clean_text(raw.get("executiveSummary") or raw.get("summary")),
        "discussionPoints": discussion,
        "decisions": string_list(raw.get("decisions"), limit=15),
        "meetingActionPoint": [a["meetingActionPoint"] for a in deduped_actions],
        "meetingActionPointOwner": [a["meetingActionPointOwner"] for a in deduped_actions],
        "meetingActionPointDeadline": [a["meetingActionPointDeadline"] for a in deduped_actions],
        "actions": deduped_actions,
        "meetingMinutes": normalise_minutes(raw, discussion),
        "nextSteps": [
            {"action": a["meetingActionPoint"], "owner": a["meetingActionPointOwner"], "deadline": a["meetingActionPointDeadline"]}
            for a in deduped_actions
        ],
        "openQuestions": string_list(raw.get("openQuestions") or raw.get("unresolvedQuestions"), limit=15),
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
    return f"""[CMD]@meeting-minutes|verify=true|detail=9|creativity=1|format=json|audience=client|language=en-GB
[INPUT]
{transcript}
[/INPUT]
-bannedWords=["game-changing","revolutionary","seamless","world-class","obviously","basically"]

Return valid JSON only, with exactly this shape:
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

Operator rules for this task:
- Write client-ready professional meeting minutes, not a transcript summary.
- Use concise UK business English.
- Do not imitate transcript wording or include speaker labels, timestamps, filler, false starts, transcription artefacts, copied malformed questions, or meta-comments about the transcript.
- Do not invent facts, dates, attendees, decisions, owners, deadlines, regulations, standards, site names or actions.
- Deadlines and owners must be explicitly evidenced; otherwise use "Not stated".
- Preserve relative deadlines exactly when stated, e.g. "next week" or "Wednesday". Do not convert them into calendar dates.
- Actions must be actual commitments or required follow-ups, not general discussion.
- Decisions must be actual decisions/confirmations, not every statement.
- Prefer fewer high-quality points over many weak points.
- Deduplicate repeated actions and repeated discussion points.
- If evidence is weak, omit the point or state "Not stated" rather than filling gaps.
"""


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


def call_trooper(transcript: str, timeout_seconds: int) -> tuple[dict[str, Any], dict[str, Any]]:
    api_key = os.environ.get("TROOPER_API_KEY", "").strip()
    if not api_key:
        message = "TROOPER_API_KEY is not configured."
        return empty_failure_output(message), {"provider": "trooper", "model": None, "used": False, "error": message}

    model = os.environ.get("TROOPER_MODEL", TROOPER_MODEL_DEFAULT).strip() or TROOPER_MODEL_DEFAULT
    url = os.environ.get("TROOPER_CHAT_COMPLETIONS_URL", TROOPER_URL_DEFAULT).strip() or TROOPER_URL_DEFAULT
    body = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": "You operate HelixScribe's behavioural stabilisation operator. Interpret [CMD] operator parameters exactly. Return valid JSON only when format=json.",
            },
            {"role": "user", "content": prompt_for_transcript(transcript)},
        ],
        "temperature": 0.1,
        "max_tokens": int(os.environ.get("TROOPER_MAX_TOKENS", "4000")),
        "response_format": {"type": "json_object"},
    }

    started = time.perf_counter()
    errors = []
    for attempt in range(2):
        request = urllib.request.Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
                payload = json.loads(response.read().decode("utf-8"))
            choices = payload.get("choices") or []
            content = choices[0].get("message", {}).get("content", "") if choices else ""
            parsed = extract_json(content)
            if not parsed:
                errors.append({"attempt": attempt + 1, "error": "No parseable JSON returned"})
                time.sleep(1.0)
                continue
            diagnostics = {
                "provider": "trooper",
                "model": model,
                "used": True,
                "errorsBeforeSuccess": errors,
                "runtimeMs": round((time.perf_counter() - started) * 1000, 2),
                "usage": payload.get("usage") or {},
            }
            return normalise_output(parsed), diagnostics
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = json.loads(exc.read().decode("utf-8")).get("error", {}).get("message", "")
            except Exception:
                pass
            errors.append({"attempt": attempt + 1, "error": f"HTTP {exc.code}: {clean_text(detail)[:240]}"})
            if exc.code not in {429, 500, 502, 503, 504}:
                break
            time.sleep(2.0)
        except Exception as exc:
            errors.append({"attempt": attempt + 1, "error": clean_text(str(exc))[:240]})
            time.sleep(2.0)

    message = "Trooper Liv generation failed. Please retry; the API may be temporarily unavailable."
    return empty_failure_output(message), {"provider": "trooper", "model": model, "used": False, "error": message, "errors": errors}


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate meeting minutes with Trooper Liv and HelixScribe operator syntax.")
    parser.add_argument("transcript_path")
    parser.add_argument("--skip-diagnostics", action="store_true")
    parser.add_argument("--include-baseline-reference", action="store_true")
    parser.add_argument("--skip-rewrite", action="store_true", help="Accepted for compatibility; ignored.")
    parser.add_argument("--timeout-seconds", type=int, default=int(os.environ.get("TROOPER_TIMEOUT_SECONDS", "120")))
    return parser.parse_args(argv)


def main() -> int:
    load_local_env_if_needed()
    args = parse_args(sys.argv[1:])
    transcript = Path(args.transcript_path).read_text(encoding="utf-8")
    started = time.perf_counter()
    output, diagnostics = call_trooper(transcript, args.timeout_seconds)
    runtime_ms = round((time.perf_counter() - started) * 1000, 2)
    payload: dict[str, Any] = {
        "mode": "meeting_minutes_final_trooper_operator_full_transcript",
        "executed": True,
        "modelAvailable": True,
        "modelName": diagnostics.get("model"),
        "modelReason": "trooper_liv_operator_full_transcript",
        "rewriterAvailable": bool(diagnostics.get("used")),
        "rewriterModelName": diagnostics.get("model"),
        "rewriterModelPath": None,
        "rewriterReason": "Trooper Liv HelixScribe operator used." if diagnostics.get("used") else diagnostics.get("error", "Trooper was not used."),
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
        "timingMs": {"total": runtime_ms, "trooper": diagnostics.get("runtimeMs", runtime_ms)},
    }
    if not args.skip_diagnostics:
        payload["diagnostics"] = {"trooper": diagnostics}
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
