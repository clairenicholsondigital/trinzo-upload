#!/usr/bin/env python3
"""Turn a MiniLM-v3 denoised transcript into discussion or action records."""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import math
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

URL = "https://eu.router.trooper.ai/v1/chat/completions"
MODEL = "eu_liv_000099"
MAX_CHUNK_TURNS = 45

BOUNDARY_SCHEMA = {"type": "json_schema", "json_schema": {"name": "meeting_chunks", "strict": True, "schema": {
    "type": "object", "properties": {"chunks": {"type": "array", "items": {"type": "object", "properties": {
        "number": {"type": "integer"}, "start": {"type": "integer"}, "end": {"type": "integer"}},
        "required": ["number", "start", "end"], "additionalProperties": False}}},
    "required": ["chunks"], "additionalProperties": False}}}

DISCUSSION_SCHEMA = {"type": "json_schema", "json_schema": {"name": "meeting_discussion", "strict": True, "schema": {
    "type": "object", "properties": {"discussion": {"type": "array", "items": {"type": "object", "properties": {
        "topic": {"type": "string"}, "points": {"type": "array", "items": {"type": "string"}}},
        "required": ["topic", "points"], "additionalProperties": False}}},
    "required": ["discussion"], "additionalProperties": False}}}

ACTION_SCHEMA = {"type": "json_schema", "json_schema": {"name": "chunk_analysis", "strict": True, "schema": {
    "type": "object", "properties": {
        "discussionPoints": {"type": "array", "items": {"type": "object", "properties": {
            "heading": {"type": "string"}, "point": {"type": "string"},
            "evidenceTurns": {"type": "array", "items": {"type": "integer"}}},
            "required": ["heading", "point", "evidenceTurns"], "additionalProperties": False}},
        "actionCandidates": {"type": "array", "items": {"type": "object", "properties": {
            "action": {"type": "string"}, "status": {"type": "string", "enum": ["COMMITTED", "ASSIGNED", "REQUIRED", "PROPOSED", "COMPLETED"]},
            "owner": {"type": "string"}, "deadline": {"type": "string"},
            "taskEvidenceTurns": {"type": "array", "items": {"type": "integer"}},
            "commitmentEvidenceTurns": {"type": "array", "items": {"type": "integer"}},
            "ownerEvidenceTurns": {"type": "array", "items": {"type": "integer"}},
            "deadlineEvidenceTurns": {"type": "array", "items": {"type": "integer"}}},
            "required": ["action", "status", "owner", "deadline", "taskEvidenceTurns", "commitmentEvidenceTurns", "ownerEvidenceTurns", "deadlineEvidenceTurns"],
            "additionalProperties": False}}},
    "required": ["discussionPoints", "actionCandidates"], "additionalProperties": False}}}

BOUNDARY_PROMPT = """Divide this numbered meeting transcript into consecutive
sections for downstream action extraction. Your only output is the section start
and end turn numbers.

Start a new section at a clear sustained change of topic, project, agenda item,
deliverable, or conversational purpose. Do not split on speaker changes, short
acknowledgements, examples, greetings, meeting procedure, or brief digressions.
Keep each request or requirement with its response, acceptance, owner discussion,
deadline, qualifications, and later confirmation. Keep closely related tasks in
the same section, while separating genuinely different task families.

HARD SIZE RULES:
- Every section must contain at most 45 turns.
- Avoid sections under 8 turns unless needed for the final remainder or a clear sustained topic change.
- Prefer sections of 18-35 turns.
- If one topic exceeds 45 turns, split it at the least disruptive subtopic or conversational transition while keeping request/response evidence together.
- For this {total}-turn transcript, return between {minimum} and {maximum} sections.

Cover every turn 1 through {total} exactly once. Start at 1; each next section
starts immediately after the previous end; the final section ends at {total}.
No gaps or overlaps. Return boundaries only in the required JSON structure.

Before returning, verify every section is at most 45 turns and the ranges cover
1 through {total} exactly once.

TRANSCRIPT:
{numbered}"""

ACTION_PROMPT = """Review this coherent meeting-transcript section.

First identify concise, substantive discussion points. Then perform a separate
action sweep and identify every possible task with a distinct deliverable.

In the action sweep, check specifically for:
- I’ll, I can, we’ll, we need to, you need to;
- Review
- Resolve
- Arrange
- Plan
- Email
- requests followed by agreement;
- named assignments;
- documents or information to send, share or review;
- checks, confirmations, updates and follow-ups;
- meetings or calls to arrange;
- tasks linked to today, this week or another deadline.

Include proposed tasks as candidates. Give each candidate one status:
COMMITTED, ASSIGNED, REQUIRED, PROPOSED or COMPLETED.

Rules:
- State only the exact deliverable supported.
- Sending a document and reviewing it are separate deliverables.
- Split separate deliverables.
- Preserve every supported owner; do not mistake a recipient for an owner.
- An offer is PROPOSED unless another turn accepts it.
- Evidence for the task, commitment, owner and deadline may be in different turns.
- Exclude banter, travel, attendance and trivial meeting procedure.
- Before returning, rescan for missed SEND, SHARE, REVIEW, CONFIRM, ARRANGE,
  FOLLOW-UP, UPDATE and COMPLETE tasks.

Use only turn numbers in this section. Keep wording concise. Return at most two
discussion points and six action candidates. Return only the required JSON.

TRANSCRIPT SECTION:
{numbered_chunk}"""

DISCUSSION_PROMPT = """Write the Key discussion points for formal meeting minutes using only the denoised transcript below.

- Group related material under concise, useful topic headings.
- Under each heading, provide concise substantive points recording the current position, decisions, open questions, risks and dependencies.
- Keep distinct technical or regulatory workstreams separate and combine repeated discussion of the same workstream.
- Do not create actions, owners or deadlines here and do not invent facts.
- Preserve proposals and uncertainty as proposals and uncertainty.
- Use clear British English. Return only the required JSON.

DENOISED TRANSCRIPT:
{transcript}"""


def clean(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def numbered_turns(transcript: str) -> tuple[list[str], str]:
    turns = [line.strip() for line in transcript.splitlines() if line.strip()]
    return turns, "\n".join(f"[{index}] {line}" for index, line in enumerate(turns, 1))


def call_trooper(prompt: str, max_tokens: int, schema: dict[str, Any]) -> dict[str, Any]:
    key = clean(os.environ.get("TROOPER_API_KEY"))
    if not key:
        raise RuntimeError("TROOPER_API_KEY is not configured")
    body = json.dumps({
        "model": clean(os.environ.get("TROOPER_MODEL")) or MODEL,
        "messages": [{"role": "system", "content": "Use only transcript evidence. Return valid JSON only."}, {"role": "user", "content": prompt}],
        "temperature": 0.1, "max_tokens": max_tokens, "response_format": schema,
    }).encode()
    last: Exception | None = None
    for attempt in range(3):
        request = urllib.request.Request(clean(os.environ.get("TROOPER_CHAT_COMPLETIONS_URL")) or URL, data=body,
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                payload = json.loads(response.read().decode())
            content = payload.get("choices", [{}])[0].get("message", {}).get("content", "")
            start = content.find("{")
            if start < 0:
                raise RuntimeError("Trooper returned no JSON object")
            return json.JSONDecoder().raw_decode(content[start:])[0]
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, RuntimeError) as error:
            last = error
            if attempt < 2:
                time.sleep(2 ** attempt)
    raise RuntimeError(f"Trooper request failed: {type(last).__name__}")


def safe_boundaries(rows: Any, total: int) -> list[dict[str, int]]:
    ends = []
    expected = 1
    for row in rows if isinstance(rows, list) else []:
        start, end = row.get("start"), row.get("end")
        if start != expected or not isinstance(end, int) or end < start or end > total:
            continue
        while end - expected + 1 > MAX_CHUNK_TURNS:
            ends.append(expected + MAX_CHUNK_TURNS - 1)
            expected += MAX_CHUNK_TURNS
        ends.append(end)
        expected = end + 1
    if expected <= total:
        while total - expected + 1 > MAX_CHUNK_TURNS:
            ends.append(expected + MAX_CHUNK_TURNS - 1)
            expected += MAX_CHUNK_TURNS
        ends.append(total)
    output, start = [], 1
    for end in sorted(set(ends)):
        if end >= start:
            output.append({"number": len(output) + 1, "start": start, "end": end})
            start = end + 1
    if not output or output[-1]["end"] != total:
        raise RuntimeError("Could not build contiguous chunk boundaries")
    return output


def normalise_actions(result: dict[str, Any], chunk: dict[str, int]) -> list[dict[str, Any]]:
    output = []
    for row in result.get("actionCandidates", []) if isinstance(result.get("actionCandidates"), list) else []:
        if not isinstance(row, dict) or not clean(row.get("action")):
            continue
        evidence = []
        for field in ("taskEvidenceTurns", "commitmentEvidenceTurns", "ownerEvidenceTurns", "deadlineEvidenceTurns"):
            values = row.get(field) if isinstance(row.get(field), list) else []
            evidence.extend(v for v in values if isinstance(v, int) and not isinstance(v, bool) and chunk["start"] <= v <= chunk["end"])
        status = clean(row.get("status"))
        output.append({
            "owner": clean(row.get("owner")) or "Not stated",
            "action": clean(row.get("action")),
            "deadline": clean(row.get("deadline")) or "Not stated",
            "status": status or "PROPOSED", "evidenceIds": [f"turn_{n}" for n in sorted(set(evidence))],
        })
    return output


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("transcript")
    parser.add_argument("--stage", choices=("discussion", "actions"), required=True)
    args = parser.parse_args()
    transcript = Path(args.transcript).read_text(encoding="utf-8")
    turns, numbered = numbered_turns(transcript)
    if not turns:
        raise SystemExit("Denoised transcript has no turns")
    if args.stage == "discussion":
        result = call_trooper(DISCUSSION_PROMPT.format(transcript=transcript), 2200, DISCUSSION_SCHEMA)
        discussion = []
        for row in result.get("discussion", []):
            topic, points = clean(row.get("topic")), [clean(p) for p in row.get("points", []) if clean(p)]
            if topic and points:
                discussion.append({"topic": topic, "points": points[:6]})
        print(json.dumps({"stage": "discussion", "discussion": discussion}, ensure_ascii=False))
        return 0

    minimum = max(1, math.ceil(len(turns) / MAX_CHUNK_TURNS))
    maximum = max(minimum, math.ceil(len(turns) / 15))
    boundary_result = call_trooper(BOUNDARY_PROMPT.format(total=len(turns), minimum=minimum, maximum=maximum, numbered=numbered), 1400, BOUNDARY_SCHEMA)
    chunks = safe_boundaries(boundary_result.get("chunks"), len(turns))
    lines = numbered.splitlines()
    def analyse(chunk: dict[str, int]) -> list[dict[str, Any]]:
        prompt = ACTION_PROMPT.format(numbered_chunk="\n".join(lines[chunk["start"] - 1:chunk["end"]]))
        return normalise_actions(call_trooper(prompt, 1800, ACTION_SCHEMA), chunk)
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(4, len(chunks))) as pool:
        results = list(pool.map(analyse, chunks))
    actions = [action for group in results for action in group]
    print(json.dumps({"stage": "actions", "actions": actions, "chunkCount": len(chunks), "turnCount": len(turns)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
