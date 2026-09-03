#!/usr/bin/env python3
"""Experimental denoised-transcript -> Trooper discussion/action pipeline.

Transcript content is never logged. JSON is written to stdout; operational messages
go to stderr so the Node caller can parse stdout safely.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any


TROOPER_URL = "https://eu.router.trooper.ai/v1/chat/completions"
TROOPER_MODEL = "eu_liv_000099"
MAX_CHUNKS = 40
MAX_CANDIDATES = 100


@dataclass(frozen=True)
class Chunk:
    number: int
    start: int
    end: int
    text: str


def clean(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def numbered_turns(transcript: str) -> tuple[list[str], str]:
    turns = [line.strip() for line in transcript.splitlines() if line.strip()]
    numbered_transcript = "\n".join(
        f"[{index}] {line}" for index, line in enumerate(turns, start=1)
    )
    return turns, numbered_transcript


def chunk_prompt(numbered_transcript: str, total_turns: int) -> str:
    return f"""You are dividing a meeting transcript into coherent conversation chunks.

Your job is ONLY to decide where each chunk starts and ends.

A chunk should contain consecutive transcript turns that belong to the
same topic, task, decision, question, or conversational purpose.

Important:

- Do NOT split simply because the speaker changes.
- Keep related questions and answers together.
- Keep related back-and-forth discussion together.
- Prefer broader coherent chunks over lots of tiny chunks.
- Start a new chunk only when the conversation clearly moves to a
  different topic or purpose.
- Every transcript turn must belong to exactly one chunk.
- Do not overlap chunks.
- Do not omit turns.
- Do not summarise the transcript.
- Do not rewrite transcript text.
- Do not reproduce the transcript.
- Return ONLY chunk boundaries.

Return exactly this format:

Chunk 1: 1-15
Chunk 2: 16-37
Chunk 3: 38-61

Rules:

- Chunk 1 must start at turn 1.
- Each new chunk starts immediately after the previous chunk ends.
- The final chunk must end at turn {total_turns}.
- Every turn must occur exactly once.
- There must be no gaps.
- There must be no overlap.

TRANSCRIPT:

{numbered_transcript}
"""


def action_prompt(chunk_text: str) -> str:
    return f"""You are reviewing ONE coherent section of a meeting transcript.

Identify every genuine action arising from this section.

An action is something that a person or group has agreed, committed,
been asked, instructed, expected, or clearly needs to do.

Important:

- Look across the whole conversation section.
- An action may be expressed across several speaker turns.
- Use surrounding discussion to understand what the action actually is.
- Do not treat general discussion, background information, opinions,
  explanations, possibilities, or completed past activity as actions.
- Do not invent an owner.
- Do not invent a deadline.
- If the owner is genuinely unclear, write "Unclear".
- If no deadline is stated, write "Not stated".
- Preserve useful specificity from the transcript.
- Include every genuine action you can identify.
- If there are no actions, return exactly: NO ACTIONS

For each action return:

ACTION: [concise description]
OWNER: [person/group or Unclear]
DEADLINE: [deadline or Not stated]
EVIDENCE: [short verbatim transcript evidence]

Do not add commentary before or after the actions.

TRANSCRIPT SECTION:

{chunk_text}
"""


def filter_prompt(action: str, owner: str, deadline: str, evidence: str) -> str:
    return f"""You are deciding whether ONE candidate from a meeting transcript is a
genuine meeting action.

Return ONLY one of:

REAL ACTION

PLANNED ACTIVITY

NOT ACTION

A REAL ACTION is a meaningful future task, commitment, requirement,
follow-up, or agreed next step that somebody genuinely needs to carry out.

A REAL ACTION should usually involve at least one of:

- a concrete deliverable
- arranging or providing access
- sending or sharing a document or information after the meeting
- completing a required task
- preparing something for another person
- reviewing or investigating something
- following up on an issue
- completing something by a deadline
- taking an operational next step that would reasonably appear on an action tracker

Examples of REAL ACTIONS:

- "I will send you the document tomorrow."
- "We need to get you access to SharePoint."
- "Niamh must complete the training before the audit."
- "I'll share the risk analysis with you before you arrive."

PLANNED ACTIVITY is future activity that is expected or scheduled,
but does not represent a specific follow-up task or deliverable.

Examples of PLANNED ACTIVITY:

- "We will be on site on the 20th."
- "The audit will run for five days."
- "We will meet at the hotel."
- "Report writing will happen afterwards."
- "Training will take place next week."

Return NOT ACTION if the evidence is mainly:

- background information
- explanation
- clarification
- a statement of fact
- attendance information
- description of a role
- description of normal process
- speculation
- general conversation
- something already completed
- a question without a genuine commitment in the evidence
- conversational housekeeping
- a trivial immediate activity happening during the meeting
- something too small or routine to belong on a meaningful action tracker

IMPORTANT:

Do NOT label something REAL ACTION merely because it contains:
"I will", "we will", "I'll", "we need to", or other future language.

The task must be meaningful enough that someone would reasonably want
to track whether it was completed after the meeting.

Tiny conversational actions are NOT ACTION.

Examples:

"I will quickly share some key points."
= NOT ACTION

"Let me pull that up."
= NOT ACTION

"I'll go down the list."
= NOT ACTION

"I'll quickly show you this."
= NOT ACTION

"Let's move to the next point."
= NOT ACTION

A question is NOT automatically an action.

Example:

"So will I have access to the folders?"

= NOT ACTION

unless the supplied evidence also contains a genuine commitment such as:

"We will arrange access for you."

Likewise:

"The audit is a normal audit."
= NOT ACTION

"Karen is attending the audit."
= NOT ACTION

"Be on site on the 20th."
= PLANNED ACTIVITY

"I will send you the code of conduct today."
= REAL ACTION

Use this decision test:

REAL ACTION:
Would somebody reasonably put this on an action tracker and later ask,
"Has this been done?"

PLANNED ACTIVITY:
Is this something expected to happen in the future, but without a
specific tracked deliverable?

NOT ACTION:
Is this context, discussion, housekeeping, clarification, or something
too trivial to track?

Do not judge whether the candidate wording sounds action-like.

Judge ONLY whether the supplied evidence establishes a meaningful,
trackable future task.

Do not invent context that is not in the evidence.

CANDIDATE ACTION:
{action}

OWNER:
{owner}

DEADLINE:
{deadline}

EVIDENCE:
{evidence}

Return ONLY REAL ACTION, PLANNED ACTIVITY, or NOT ACTION."""


def discussion_prompt(transcript: str) -> str:
    return f"""Write a concise Discussion section for formal meeting minutes using only
the denoised transcript below.

- Group related material under short, useful topic headings.
- Record the substantive current position, decisions, open questions, risks and dependencies.
- Do not create an Actions table or a separate action list.
- Do not turn proposals or completed work into future commitments.
- Do not invent facts, people, decisions or dates.
- Use clear British English.
- Return only the Discussion section, with simple headings and paragraphs or bullets.

DENOISED TRANSCRIPT:

{transcript}
"""


def call_trooper(prompt: str, max_tokens: int, task: str) -> tuple[str, dict[str, Any] | None]:
    api_key = clean(os.environ.get("TROOPER_API_KEY"))
    if not api_key:
        raise RuntimeError("TROOPER_API_KEY is not configured.")
    url = clean(os.environ.get("TROOPER_CHAT_COMPLETIONS_URL")) or TROOPER_URL
    model = clean(os.environ.get("TROOPER_MODEL")) or TROOPER_MODEL
    body = json.dumps(
        {
            "model": model,
            "messages": [
                {"role": "system", "content": "Follow the user's task exactly. Do not add unsupported content."},
                {"role": "user", "content": prompt},
            ],
            "temperature": 0.1,
            "max_tokens": max_tokens,
        },
        ensure_ascii=False,
    ).encode("utf-8")
    last_error: Exception | None = None
    for attempt in range(3):
        request = urllib.request.Request(
            url,
            data=body,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            started = time.monotonic()
            with urllib.request.urlopen(request, timeout=180) as response:
                payload = json.loads(response.read().decode("utf-8"))
            content = payload.get("choices", [{}])[0].get("message", {}).get("content")
            if not isinstance(content, str) or not content.strip():
                raise RuntimeError(f"Trooper returned no text for {task}.")
            print(
                f"trooper task={task} attempt={attempt + 1} ms={round((time.monotonic() - started) * 1000)}",
                file=sys.stderr,
                flush=True,
            )
            return content.strip(), payload.get("usage")
        except urllib.error.HTTPError as error:
            last_error = error
            if error.code not in {429, 500, 502, 503, 504} or attempt == 2:
                raise RuntimeError(f"Trooper {task} failed with HTTP {error.code}.") from error
            retry_after = error.headers.get("Retry-After")
            wait_seconds = float(retry_after) if retry_after and retry_after.isdigit() else 2 ** attempt
            time.sleep(min(max(wait_seconds, 1), 15))
        except (urllib.error.URLError, TimeoutError) as error:
            last_error = error
            if attempt == 2:
                break
            time.sleep(2 ** attempt)
    raise RuntimeError(f"Trooper {task} failed after retries: {type(last_error).__name__}")


def parse_boundaries(raw: str, turns: list[str]) -> list[Chunk]:
    lines = [line.strip() for line in raw.splitlines() if line.strip()]
    if not lines or len(lines) > MAX_CHUNKS:
        raise ValueError(f"Trooper returned an invalid number of chunks ({len(lines)}).")
    chunks: list[Chunk] = []
    expected_start = 1
    for expected_number, line in enumerate(lines, start=1):
        match = re.fullmatch(r"Chunk\s+(\d+)\s*:\s*(\d+)\s*-\s*(\d+)", line, re.I)
        if not match:
            raise ValueError(f"Invalid chunk boundary line: {line[:120]}")
        number, start, end = map(int, match.groups())
        if number != expected_number or start != expected_start or end < start or end > len(turns):
            raise ValueError(f"Non-contiguous or invalid chunk boundary: {line[:120]}")
        chunks.append(Chunk(number, start, end, "\n".join(turns[start - 1 : end])))
        expected_start = end + 1
    if expected_start != len(turns) + 1:
        raise ValueError(f"Chunk boundaries ended at turn {expected_start - 1}, expected {len(turns)}.")
    return chunks


def parse_action_candidates(raw: str, chunk: Chunk) -> list[dict[str, Any]]:
    if clean(raw).upper() == "NO ACTIONS":
        return []
    pattern = re.compile(
        r"(?:^|\n)\s*ACTION:\s*(.*?)\s*\n\s*OWNER:\s*(.*?)\s*\n\s*DEADLINE:\s*(.*?)\s*\n\s*EVIDENCE:\s*(.*?)(?=\n\s*ACTION:|\Z)",
        re.I | re.S,
    )
    matches = list(pattern.finditer(raw.strip()))
    if not matches:
        raise ValueError(f"Trooper action output for chunk {chunk.number} did not follow the required format.")
    candidates = []
    normalized_chunk = clean(chunk.text).casefold()
    for match in matches:
        action, owner, deadline, evidence = [clean(value) for value in match.groups()]
        if not action or not evidence:
            continue
        evidence_valid = clean(evidence).casefold() in normalized_chunk
        candidates.append(
            {
                "action": action,
                "owner": owner or "Unclear",
                "deadline": deadline or "Not stated",
                "evidence": evidence,
                "evidenceValid": evidence_valid,
                "chunkNumber": chunk.number,
                "turnRange": f"{chunk.start}-{chunk.end}",
            }
        )
    return candidates


def normalized_key(candidate: dict[str, Any]) -> tuple[str, str, str]:
    normalize = lambda value: re.sub(r"[^a-z0-9]+", " ", clean(value).casefold()).strip()
    return normalize(candidate["action"]), normalize(candidate["owner"]), normalize(candidate["deadline"])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("transcript", type=Path)
    args = parser.parse_args()
    transcript = args.transcript.read_text(encoding="utf-8")
    turns, numbered = numbered_turns(transcript)
    if not turns:
        raise RuntimeError("The denoised transcript contains no turns.")

    started = time.monotonic()
    boundary_raw, boundary_usage = call_trooper(chunk_prompt(numbered, len(turns)), 1000, "chunk_boundaries")
    chunks = parse_boundaries(boundary_raw, turns)
    discussion, discussion_usage = call_trooper(discussion_prompt(transcript), 1800, "discussion")

    candidates: list[dict[str, Any]] = []
    action_usage = []
    for chunk in chunks:
        raw, usage = call_trooper(action_prompt(chunk.text), 1000, f"actions_chunk_{chunk.number}")
        action_usage.append(usage)
        candidates.extend(parse_action_candidates(raw, chunk))
        if len(candidates) > MAX_CANDIDATES:
            raise RuntimeError(f"Trooper returned more than {MAX_CANDIDATES} action candidates.")

    classified = []
    filter_usage = []
    for index, candidate in enumerate(candidates, start=1):
        if not candidate["evidenceValid"]:
            verdict = "NOT ACTION"
            usage = None
            reason = "Evidence was not a verbatim substring of the source chunk."
        else:
            raw, usage = call_trooper(
                filter_prompt(candidate["action"], candidate["owner"], candidate["deadline"], candidate["evidence"]),
                20,
                f"filter_candidate_{index}",
            )
            verdict = clean(raw).upper().rstrip(".")
            if verdict not in {"REAL ACTION", "PLANNED ACTIVITY", "NOT ACTION"}:
                raise ValueError(f"Invalid filter verdict for candidate {index}: {raw[:120]}")
            reason = ""
        filter_usage.append(usage)
        classified.append({**candidate, "classification": verdict, "validationReason": reason})

    seen = set()
    real_actions = []
    for candidate in classified:
        if candidate["classification"] != "REAL ACTION":
            continue
        key = normalized_key(candidate)
        if key in seen:
            continue
        seen.add(key)
        real_actions.append(candidate)

    planned = [candidate for candidate in classified if candidate["classification"] == "PLANNED ACTIVITY"]
    output = {
        "ok": True,
        "pipeline": "minilm_denoiser_v3_then_trooper_chunk_action_filter_v1",
        "discussion": discussion,
        "actions": real_actions,
        "plannedActivities": planned,
        "diagnostics": {
            "totalTurns": len(turns),
            "chunkCount": len(chunks),
            "chunks": [{"number": c.number, "start": c.start, "end": c.end} for c in chunks],
            "candidateCount": len(candidates),
            "realActionCount": len(real_actions),
            "plannedActivityCount": len(planned),
            "notActionCount": sum(c["classification"] == "NOT ACTION" for c in classified),
            "invalidEvidenceCount": sum(not c["evidenceValid"] for c in classified),
            "classifiedCandidates": classified,
            "usage": {
                "boundaries": boundary_usage,
                "discussion": discussion_usage,
                "actions": action_usage,
                "filters": filter_usage,
            },
            "timingMs": {"total": round((time.monotonic() - started) * 1000)},
        },
    }
    json.dump(output, sys.stdout, ensure_ascii=False, allow_nan=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
