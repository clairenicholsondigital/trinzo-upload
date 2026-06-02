#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from uuid import uuid4

DEFAULT_BASE_URL = "https://trinzo.virtual-hub.online"
DEFAULT_FIXTURE = Path("scripts/transcript-tests/051_real_webinar_rehearsal/transcript.txt")
FORBIDDEN_PATTERNS = [
    "Hey there",
    "I don't mind",
    "And I'm easy",
    "So is it repetitive?",
]
RAW_CHUNK_HINTS = [
    "Go through this side",
    "Person who paid for it",
    "sit back, be quiet, observe",
]


def multipart_form(fields: dict[str, str], files: dict[str, tuple[str, bytes, str]]) -> tuple[bytes, str]:
    boundary = f"openclaw-{uuid4().hex}"
    parts: list[bytes] = []
    for name, value in fields.items():
        parts.append(f"--{boundary}\r\n".encode())
        parts.append(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
        parts.append(str(value).encode())
        parts.append(b"\r\n")
    for name, (filename, content, content_type) in files.items():
        parts.append(f"--{boundary}\r\n".encode())
        parts.append(f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'.encode())
        parts.append(f"Content-Type: {content_type}\r\n\r\n".encode())
        parts.append(content)
        parts.append(b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), boundary


def post_json(url: str, payload: dict, timeout: int) -> dict:
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, method="POST", headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def post_transcript(url: str, transcript_path: Path, timeout: int) -> dict:
    body, boundary = multipart_form(
        {},
        {"file": (transcript_path.name, transcript_path.read_bytes(), "text/plain")},
    )
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def output_payload(response: dict) -> dict:
    return ((response.get("result") or {}).get("output") or {}) if isinstance(response, dict) else {}


def flat_text(value: object) -> str:
    return json.dumps(value, ensure_ascii=False)


def visible_minutes_payload(output: dict) -> dict:
    """Return the user-visible minutes fields, excluding raw evidence/diagnostics."""
    return {
        "meetingObjectives": output.get("meetingObjectives") or [],
        "discussionPoints": output.get("discussionPoints") or [],
        "decisions": output.get("decisions") or [],
        "meetingActionPoint": output.get("meetingActionPoint") or [],
        "meetingActionPointOwner": output.get("meetingActionPointOwner") or [],
        "meetingActionPointDeadline": output.get("meetingActionPointDeadline") or [],
    }


def word_count(text: str) -> int:
    return len(re.findall(r"[A-Za-z0-9']+", text or ""))


def quality_failures(output: dict, *, require_rewrite_status: bool = False) -> list[str]:
    failures: list[str] = []
    visible = visible_minutes_payload(output)
    flat = flat_text(visible).lower()
    for pattern in FORBIDDEN_PATTERNS + RAW_CHUNK_HINTS:
        if pattern.lower() in flat:
            failures.append(f"forbidden raw/conversational text present: {pattern!r}")

    objectives = [str(item) for item in output.get("meetingObjectives") or []]
    for objective in objectives:
        if word_count(objective) > 28:
            failures.append(f"objective too transcript-like/long: {objective!r}")
        if any(mark in objective for mark in [" So ", " Because ", "?", "we then", "we would"]):
            failures.append(f"objective has conversational/raw phrasing: {objective!r}")

    actions = [str(item) for item in output.get("meetingActionPoint") or []]
    for action in actions:
        if not re.search(r"\b(update|refine|add|reduce|review|prepare|confirm|send|agree|create|share|follow up|complete|check)\b", action, re.I):
            failures.append(f"action does not look like a concrete next step: {action!r}")

    if require_rewrite_status:
        status = output.get("rewriteStatus") or {}
        if status.get("succeeded") is not True:
            failures.append(f"rewrite did not fully succeed: {status!r}")
    return failures


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Run a live regression check against the Trinzo meeting-minutes final API.")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--fixture", default=str(DEFAULT_FIXTURE))
    parser.add_argument("--out-dir", default="reports/live-baseline")
    parser.add_argument("--timeout", type=int, default=240)
    parser.add_argument("--skip-improve", action="store_true")
    args = parser.parse_args(argv)

    fixture = Path(args.fixture)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())

    base_url = args.base_url.rstrip("/")
    first_url = f"{base_url}/api/meeting-minutes-final?includeDiagnostics=true"
    improve_url = f"{base_url}/api/meeting-minutes-final/improve?includeDiagnostics=true"

    first = post_transcript(first_url, fixture, args.timeout)
    first_path = out_dir / f"meeting-minutes-final-live-{fixture.stem}-{stamp}.json"
    first_path.write_text(json.dumps(first, ensure_ascii=False, indent=2), encoding="utf-8")

    first_output = output_payload(first)
    first_failures = quality_failures(first_output)

    improved = None
    improved_failures: list[str] = []
    improved_path = None
    if not args.skip_improve:
        improved = post_json(improve_url, {"output": first_output}, args.timeout)
        improved_path = out_dir / f"meeting-minutes-final-live-{fixture.stem}-{stamp}-improved.json"
        improved_path.write_text(json.dumps(improved, ensure_ascii=False, indent=2), encoding="utf-8")
        improved_failures = quality_failures(output_payload(improved), require_rewrite_status=True)

    report = {
        "fixture": str(fixture),
        "firstPath": str(first_path),
        "improvedPath": str(improved_path) if improved_path else None,
        "firstExecuted": (first.get("result") or {}).get("executed"),
        "firstModelAvailable": (first.get("result") or {}).get("modelAvailable"),
        "firstCounts": (first.get("result") or {}).get("counts"),
        "firstFailures": first_failures,
        "improvedRewriteSucceeded": None if not improved else (improved.get("result") or {}).get("rewriteSucceeded"),
        "improvedRewriteFailureCount": None if not improved else (improved.get("result") or {}).get("rewriteFailureCount"),
        "improvedCounts": None if not improved else (improved.get("result") or {}).get("counts"),
        "improvedFailures": improved_failures,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if first_failures or improved_failures else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        print(json.dumps({"error": f"HTTP {exc.code}", "body": body[:1000]}, indent=2), file=sys.stderr)
        raise SystemExit(2)
