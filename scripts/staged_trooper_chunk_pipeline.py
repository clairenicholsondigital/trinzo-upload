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

WEBINAR_REHEARSAL_ACTION_PROMPT = """Review this coherent section from a webinar-rehearsal transcript.

First identify concise, substantive discussion points about the webinar content,
delivery or operation. Then perform a separate action sweep and identify every
possible task with a distinct deliverable or operational responsibility.

In addition to the general action signals, check specifically for:
- documents, scripts, slides, links or information to send, share or review;
- changes to the opening, closing, script, slides, demonstrations or Q&A;
- technical checks, rehearsal changes and timing adjustments;
- monitoring or grouping chat questions;
- managing Q&A, including keeping answers concise or within time;
- handling screen-sharing handovers, pauses or dead air;
- introducing speakers, covering transitions or delivering the closing;
- distributing registration, attendance or follow-up links;
- promotional activity that someone has agreed to carry out.

Treat an agreed responsibility during the live webinar as an action. Give each
candidate one status: COMMITTED, ASSIGNED, REQUIRED, PROPOSED or COMPLETED.

Rules:
- State only the exact deliverable or operational responsibility supported.
- Split separate deliverables and preserve every supported owner.
- Do not mistake a recipient, presenter or attendee for an owner.
- An offer is PROPOSED unless another turn accepts it.
- Evidence for the task, commitment, owner and deadline may be in different turns.
- An accepted change to webinar wording or delivery is a distinct action.
- Prioritise explicit assignment recaps and accepted changes before incidental
  rehearsal instructions.
- Monitoring chat, managing Q&A and covering transitions are separate responsibilities.
- Exclude banter, personal travel, mere attendance and trivial meeting procedure.
- Before returning, rescan for missed MONITOR, GROUP, TIME, COVER, REMOVE,
  REHEARSE, RECORD, DISTRIBUTE, OPENING, CLOSING and Q&A tasks.

Use only turn numbers in this section. Keep wording concise. Return at most two
discussion points and eight action candidates. Return only the required JSON.

TRANSCRIPT SECTION:
{numbered_chunk}"""

TECHNICAL_REVIEW_ACTION_PROMPT = """Review this coherent section from a technical-file or software-review meeting.

First identify concise, substantive discussion points. Then perform a separate
action sweep for every concrete deliverable, continuing workstream, technical
investigation, compliance activity or documentation change.

In addition to the general action signals, check specifically for:
- work someone must continue, progress, finish or close out;
- software issues, language or font problems and technical gaps to resolve;
- changes to trace and retrospective test evidence to identify;
- tests, studies, assessments and compliance reviews to plan, run or complete;
- risks, standards, specifications and applicability questions to check or confirm;
- comments, findings or test outputs to incorporate into controlled documents;
- documents to update, convert, file, place in a folder, send or submit for review;
- dependencies where one person's output enables another person's review;
- support to request or flag and people to add to recurring meetings.

Treat continuation of an existing technical or documentation workstream as an
action when an owner is expected to progress it, even if no new task is created.
Give each candidate one status: COMMITTED, ASSIGNED, REQUIRED, PROPOSED or COMPLETED.

Rules:
- State only the exact deliverable or next-step output supported.
- Split testing, sending, reviewing and incorporating results when separately owned.
- Preserve every supported owner; do not mistake a reviewer or recipient for an owner.
- Preserve conditions and dependencies without merging the dependent tasks.
- An unresolved issue is not itself an action unless the section supports a next step.
- Evidence for the task, commitment, owner and deadline may be in different turns.
- Prioritise explicit assignment recaps and owner confirmations.
- Exclude status-only observations with no supported next step.
- Before returning, rescan for missed CONTINUE, PROGRESS, RESOLVE, TRACE, TEST,
  ASSESS, INCORPORATE, CONVERT, FILE, FLAG, CLOSE-OUT, CONFIRM and ADD tasks.

Use only turn numbers in this section. Keep wording concise. Return at most two
discussion points and eight action candidates. Return only the required JSON.

TRANSCRIPT SECTION:
{numbered_chunk}"""

SOFTWARE_WEEKLY_ACTION_PROMPT = """Review this coherent software weekly-review transcript section.

First identify concise, substantive discussion points. Then perform a separate,
exhaustive action sweep and identify every possible task with a distinct deliverable.

Apply the full general sweep first:
- I’ll, I can, we’ll, we need to, you need to;
- Review, Resolve, Arrange, Plan and Email;
- requests followed by agreement and named assignments;
- information or documents to send, share, review or update;
- checks, confirmations, decisions, follow-ups and deadlines.

Then apply a software-workstream sweep for:
- checking whether an issue, alarm or control is captured in a risk analysis;
- sending debug commands, technical instructions, files or other test inputs;
- running those commands or tests and reporting observable results;
- resolving language-character, symbol, font-driver, tool-access or loading issues;
- tracing changes between software versions and locating them in code;
- identifying gaps, retrospective test scenarios, test data or close-out evidence;
- incorporating another person's findings into design-change, risk or technical-file records;
- continuing compliance or technical reviews and flagging support required;
- following up on whether a standard or requirement applies;
- adding someone to a recurring review or follow-up call.

Treat clearly assigned continuation of existing work as an action. At the end of
the section, build an owner-by-owner action ledger from any recap: every concrete
responsibility in that recap must be considered before lower-value candidates.

Include proposed tasks. Give each candidate one status: COMMITTED, ASSIGNED,
REQUIRED, PROPOSED or COMPLETED.

Rules:
- State only the exact deliverable or next step supported.
- Sending an input, testing it, reviewing the result and incorporating the result
  are separate deliverables when separately supported.
- Split separate owners and deliverables; preserve every supported owner.
- Do not mistake a recipient, reviewer, dependency or person offering support for the owner.
- Evidence for the task, commitment, owner and deadline may be in different turns.
- Preserve conditions and dependencies without merging the dependent actions.
- An issue or status update alone is not an action without a supported next step.
- Do not spend candidate capacity on broad status restatements or meeting procedure.
- Before returning, rescan owner by owner for missed CHECK, SEND, TEST, REPORT,
  RESOLVE, TRACE, IDENTIFY, INCORPORATE, CONTINUE, FLAG, FOLLOW-UP and ADD tasks.

Use only turn numbers in this section. Keep wording concise. Return at most two
discussion points and ten action candidates. Return only the required JSON.

TRANSCRIPT SECTION:
{numbered_chunk}"""

PROCESS_PIPELINE_ACTION_PROMPT = """Review this coherent section from a process or pipeline-planning meeting.

First identify concise, substantive discussion points. Then perform a separate
action sweep for every concrete experiment, process decision, definition,
measurement activity and staged next step.

In addition to the general action signals, check specifically for:
- manual tests, sample slices, trials, pilots and proof-of-concept work;
- success, quality, volume, eligibility or ICP criteria to define or assess;
- process stages, ownership, handoffs and operating rules to clarify;
- signals or data to capture, classify, record, route, track or monitor;
- CRM, Salesforce or other system changes needed to support the process;
- conditional next phases that depend on the result of an earlier test;
- reviews, decisions, follow-ups and updates required after an experiment.

A proposed experiment with a concrete method or outcome is PROPOSED. A subsequent
phase dependent on that experiment is a separate conditional candidate; do not
omit it because execution depends on the first result. Give each candidate one
status: COMMITTED, ASSIGNED, REQUIRED, PROPOSED or COMPLETED.

Rules:
- State only the exact deliverable, decision or measurable next step supported.
- Split the initial test, evaluation and subsequent pilot into separate candidates.
- Preserve each condition and supported owner.
- Do not mistake a beneficiary, system or consulted team for an owner.
- Evidence for the task, commitment, owner and condition may be in different turns.
- Do not promote speculative ideas without a concrete method, output or agreed next step.
- Prioritise explicit assignment recaps and accepted proposals.
- Before returning, rescan for missed TEST, PILOT, DEFINE, MEASURE, ASSESS,
  CLARIFY, CAPTURE, RECORD, TRACK, ROUTE, MONITOR and FOLLOW-UP tasks.

Use only turn numbers in this section. Keep wording concise. Return at most two
discussion points and eight action candidates. Return only the required JSON.

TRANSCRIPT SECTION:
{numbered_chunk}"""


def action_prompt_for_meeting_type(meeting_type: str) -> tuple[str, str]:
    normalised = re.sub(r"[^a-z0-9]+", " ", clean(meeting_type).lower()).strip()
    if "webinar" in normalised and any(term in normalised for term in ("rehearsal", "practice", "run through")):
        return WEBINAR_REHEARSAL_ACTION_PROMPT, "webinar_rehearsal"
    if ("software" in normalised and "technical file" in normalised) or any(
        term in normalised for term in ("software weekly", "software check in", "software review")
    ):
        return SOFTWARE_WEEKLY_ACTION_PROMPT, "software_weekly_review"
    if "technical file" in normalised:
        return TECHNICAL_REVIEW_ACTION_PROMPT, "technical_file_review"
    if any(term in normalised for term in ("pipeline", "process planning", "process review", "lead generation")):
        return PROCESS_PIPELINE_ACTION_PROMPT, "process_or_pipeline_planning"
    return ACTION_PROMPT, "general"

DISCUSSION_PROMPT = """Write the Key discussion points for formal meeting minutes using only the denoised transcript below.

- Group related material under concise, useful topic headings.
- Under each heading, provide concise substantive points recording the current position, decisions, open questions, risks and dependencies.
- Keep distinct technical or regulatory workstreams separate and combine repeated discussion of the same workstream.
- Do not create actions, owners or deadlines here and do not invent facts.
- Preserve proposals and uncertainty as proposals and uncertainty.
- Use clear British English. Return only the required JSON.

DENOISED TRANSCRIPT:
{transcript}"""

WEBINAR_REHEARSAL_DISCUSSION_PROMPT = """Write concise Key discussion points for formal minutes of this webinar rehearsal using only the denoised transcript below.

Capture the substantive run-of-show at concrete, atomic detail. Internally sweep the transcript for:
- slide or deck defects, missing animations, content changes and presentation readiness;
- the exact opening and audience instructions, including device-specific guidance;
- presenter order, spoken cues, handovers, case-study insertions and who hands back to whom;
- timing signals or private warnings given while someone is presenting;
- Q&A sequencing, proposed opening or backup questions, moderation and closing arrangements;
- screen-sharing transitions, pauses or dead-air risks and how those gaps will be covered;
- failure contingencies: who fills verbally, contacts a missing presenter, or takes over a backup deck;
- explicit rehearsal decisions about what will be rerun, practised or only spot-checked.

Output rules:
- Return 4-6 concise topic headings and at most 24 points in total.
- Keep each materially distinct fact as its own standalone point, but omit duplicate explanations and action-list restatements.
- Preserve concrete names, sequence, cues, examples, timings, defects, risks, contingencies and rehearsal decisions.
- Do not collapse several handovers or contingency roles into a generic statement such as "roles were agreed".
- Include operational arrangements as discussion points even when they also imply an action; describe the agreed position without creating an action list.
- Record proposals and uncertainty accurately. Do not infer or invent facts.
- Prioritise agreed run-of-show details, identified defects, handover risks, audience instructions, Q&A examples, failure contingencies and decisions about rehearsal scope.
- Use clear British English.
- Return only the required JSON.

DENOISED TRANSCRIPT:
{transcript}"""

TECHNICAL_REVIEW_DISCUSSION_PROMPT = """Write concise Key discussion points for formal minutes of this technical or consultancy review using only the denoised transcript below.

Capture the current position of each distinct workstream at concrete, atomic detail. Internally sweep the transcript for:
- tracker movement since the previous review, including what completion band changed and whether that is positive;
- software or product changes, their exact behaviour, progress, resulting version and change-request review route;
- technical issues involving alarms, language characters, symbols, fonts, tools, interfaces or loading;
- risk-management, software, usability, clinical, PMS and technical-file workstreams;
- protocols, task-analysis completion, study execution plans and timing relative to submissions or external review;
- clinical or specialist review needed to judge whether a change is acceptable in the field;
- comments, findings or evidence that must feed into a named document or workstream;
- traceability gaps and circumstances requiring retrospective scenarios or test evidence;
- process maps, procedures, contract or subcontractor document availability, gaps, justifications and finalisation dependencies;
- dependencies, constraints, open questions and decisions about what happens next;
- governance and evidence consequences: change-request review, clinical acceptability review, resulting software versions, retrospective testing where traceability is absent, and comments to incorporate into PMS or summary documents.

Output rules:
- Return 5-8 concise topic headings and at most 24 points in total.
- Keep each materially distinct finding or workstream state as its own standalone point; do not merge several statuses into a generic progress summary.
- Preserve concrete names, document types, version or change details, languages, percentages, dependencies and uncertainty.
- Distinguish completed work, work in progress, work awaiting review and conditional work.
- Include a concrete workstream status even where it also implies an action, but do not create an action list.
- Omit duplicate explanations, meeting procedure and unsupported inference.
- Before returning, check that any supported tracker delta, multi-part software change, change-control route, clinical acceptability review, task-analysis state, study timing, retrospective-testing condition, subcontractor-document state and process/procedure dependency is stated explicitly rather than hidden inside a broad summary.
- Use clear British English and return only the required JSON.

DENOISED TRANSCRIPT:
{transcript}"""

SOFTWARE_WEEKLY_DISCUSSION_PROMPT = """Write concise Key discussion points for formal minutes of this software weekly review using only the denoised transcript below.

Capture each concrete software-workstream state separately. Internally sweep the transcript for:
- implemented or demonstrated behaviour, including alarm sound, colour, flash, mute and fan logic;
- change requests and their exact state: proposed, submitted, approved, awaiting review or incorporated into a software version;
- changes between software versions, whether they are visible in code, and any gap assessment or traceability consequence;
- debug commands or test inputs one person must provide, what another person must run, and what should be visible on screen;
- prospective or retrospective tests, test scenarios, test data and evidence needed where code or traceability is incomplete;
- risk-plan and risk-matrix updates, including probability rationale, what constitutes an event, severity, occurrence and benefit-risk reasoning;
- cybersecurity controls involving ports, locks, passwords, GUI access or third-party interference, plus where those controls must be documented;
- standards and compliance reviews, applicability questions, current review progress, existing test coverage and remaining testing scope;
- device-function distinctions that affect applicability, such as supplying flow to connected equipment rather than performing that equipment's function;
- language, character, symbol, font-driver, font-tool, firewall or IT-access issues and their current resolution state;
- clinical or usability feedback and whether it accepted a change or left further review necessary;
- purchased standards, PMS updates and other technical-file follow-up relevant to the software work.

Output rules:
- Return 5-8 concise headings and no more than 26 points in total.
- Use one standalone point for each materially distinct implementation, change-control, testing, traceability, risk, standards or documentation state.
- Do not combine "implemented", "submitted", "approved", "tested" and "documented" into one broad progress sentence when the transcript supports them separately.
- Preserve concrete names, versions, dates, standard numbers, device functions, technical examples, dependencies and uncertainty.
- Distinguish completed work, current work, required evidence and conditional consequences.
- Include concrete current states even where they imply an action, but do not create an action list.
- Omit repetition, meeting procedure and unsupported inference.
- Before returning, rescan for missed IMPLEMENTED, DEMONSTRATED, SUBMITTED, APPROVED, DEBUG INPUT, TEST RESULT, TRACEABILITY, RETROSPECTIVE TEST, RISK RATIONALE, STANDARD APPLICABILITY, COMPLIANCE STATUS, CYBERSECURITY CONTROL, FONT ACCESS, CLINICAL ACCEPTANCE and PMS details.
- Give equal priority to documentation and hand-off states: the agreed software-list format; who must supply debug commands and who will use them; whether a compliance-document review is only part-way complete; existing test coverage versus remaining scope; purchased standards; and where risk or cybersecurity rationale must be recorded.
- State timing and status literally. Never convert "submitted for review on Wednesday" into "approved for Wednesday", or a request for another person to supply information into work already completed.
- Keep these distinct when supported: the numerical risk rationale and definition of one event; the physical device function relevant to a standard; the chosen cybersecurity controls and their usability risk; and the document that must capture those controls.
- Use clear British English. Return only the required JSON.

DENOISED TRANSCRIPT:
{transcript}"""


def discussion_prompt_for_meeting_type(meeting_type: str) -> tuple[str, str]:
    normalised = re.sub(r"[^a-z0-9]+", " ", clean(meeting_type).lower()).strip()
    if "webinar" in normalised and any(term in normalised for term in ("rehearsal", "practice", "run through")):
        return WEBINAR_REHEARSAL_DISCUSSION_PROMPT, "webinar_rehearsal"
    if ("software" in normalised and "technical file" in normalised) or any(
        term in normalised for term in ("software weekly", "software check in", "software review")
    ):
        return SOFTWARE_WEEKLY_DISCUSSION_PROMPT, "software_weekly_review"
    if "technical file" in normalised:
        return TECHNICAL_REVIEW_DISCUSSION_PROMPT, "technical_file_review"
    return DISCUSSION_PROMPT, "general"


def discussion_uses_two_halves(meeting_type: str) -> bool:
    normalised = re.sub(r"[^a-z0-9]+", " ", clean(meeting_type).lower()).strip()
    return (
        "audit" in normalised
        or "importer" in normalised
        or normalised == "workshop"
        or any(term in normalised for term in ("pipeline", "lead generation"))
    )


def discussion_uses_three_thirds(meeting_type: str) -> bool:
    normalised = re.sub(r"[^a-z0-9]+", " ", clean(meeting_type).lower()).strip()
    return normalised == "software weekly review"


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
    parser.add_argument("--meeting-type", default="")
    args = parser.parse_args()
    transcript = Path(args.transcript).read_text(encoding="utf-8")
    turns, numbered = numbered_turns(transcript)
    if not turns:
        raise SystemExit("Denoised transcript has no turns")
    if args.stage == "discussion":
        discussion_prompt, prompt_profile = discussion_prompt_for_meeting_type(args.meeting_type)
        split_after_turn = None
        split_after_turns = None
        if discussion_uses_three_thirds(args.meeting_type):
            first_end = (len(turns) + 2) // 3
            second_end = (2 * len(turns) + 2) // 3
            split_after_turns = [first_end, second_end]
            thirds = (turns[:first_end], turns[first_end:second_end], turns[second_end:])
            def analyse_third(index_and_turns: tuple[int, list[str]]) -> dict[str, Any]:
                index, third_turns = index_and_turns
                position = ("first", "middle", "final")[index - 1]
                context = f"This is the {position} third of the meeting transcript. Capture the substantive discussion contained in this third.\n\n"
                return call_trooper(discussion_prompt.format(transcript=context + "\n".join(third_turns)), 2400, DISCUSSION_SCHEMA)
            with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
                results = list(pool.map(analyse_third, enumerate(thirds, 1)))
        elif discussion_uses_two_halves(args.meeting_type):
            split_after_turn = (len(turns) + 1) // 2
            halves = (turns[:split_after_turn], turns[split_after_turn:])
            def analyse_half(index_and_turns: tuple[int, list[str]]) -> dict[str, Any]:
                index, half_turns = index_and_turns
                position = "first" if index == 1 else "second"
                context = f"This is the {position} half of the meeting transcript. Capture the substantive discussion contained in this half.\n\n"
                return call_trooper(discussion_prompt.format(transcript=context + "\n".join(half_turns)), 2200, DISCUSSION_SCHEMA)
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(analyse_half, enumerate(halves, 1)))
        else:
            results = [call_trooper(discussion_prompt.format(transcript=transcript), 2200, DISCUSSION_SCHEMA)]
        discussion = []
        for result in results:
            for row in result.get("discussion", []):
                topic, points = clean(row.get("topic")), [clean(p) for p in row.get("points", []) if clean(p)]
                if topic and points:
                    discussion.append({"topic": topic, "points": points[:6]})
        print(json.dumps({"stage": "discussion", "discussion": discussion,
            "discussionPromptProfile": prompt_profile,
            "discussionCallCount": len(results), "splitAfterTurn": split_after_turn,
            "splitAfterTurns": split_after_turns}, ensure_ascii=False))
        return 0

    minimum = max(1, math.ceil(len(turns) / MAX_CHUNK_TURNS))
    maximum = max(minimum, math.ceil(len(turns) / 15))
    boundary_result = call_trooper(BOUNDARY_PROMPT.format(total=len(turns), minimum=minimum, maximum=maximum, numbered=numbered), 1400, BOUNDARY_SCHEMA)
    chunks = safe_boundaries(boundary_result.get("chunks"), len(turns))
    lines = numbered.splitlines()
    action_prompt, prompt_profile = action_prompt_for_meeting_type(args.meeting_type)
    def analyse(chunk: dict[str, int]) -> list[dict[str, Any]]:
        prompt = action_prompt.format(numbered_chunk="\n".join(lines[chunk["start"] - 1:chunk["end"]]))
        return normalise_actions(call_trooper(prompt, 1800, ACTION_SCHEMA), chunk)
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(4, len(chunks))) as pool:
        results = list(pool.map(analyse, chunks))
    actions = [action for group in results for action in group]
    print(json.dumps({"stage": "actions", "actions": actions, "chunkCount": len(chunks), "turnCount": len(turns),
        "actionPromptProfile": prompt_profile}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
