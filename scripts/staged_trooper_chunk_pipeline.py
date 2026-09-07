#!/usr/bin/env python3
"""Turn a MiniLM-v3 denoised transcript into discussion or action records."""
from __future__ import annotations

import argparse
import concurrent.futures
import random
import threading
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
# Trooper allows 10 in-flight requests per API key and answers the eleventh with 429. Chunk
# extraction and the two selector passes fan out in threads, so the process caps its own
# concurrency below that and treats 429 as "wait", not "fail".
TROOPER_MAX_INFLIGHT = max(1, int(os.environ.get("TROOPER_MAX_INFLIGHT", "8")))
TROOPER_INFLIGHT = threading.BoundedSemaphore(TROOPER_MAX_INFLIGHT)
ACTION_RETRIEVAL_BACKEND: Any = None
ACTION_RETRIEVAL_BACKEND_LOCK = threading.Lock()
MAX_CHUNK_TURNS = 45
# The boundary model was observed returning a 3-turn section despite the prompt's 8-turn
# floor; sections that small produced bare-verb candidates ("share", "do"). Merge them.
MIN_CHUNK_TURNS = 8
MINIMUM_ACTION_WORDS = 4
# Rows that recur across independent extraction samples are real far more often than rows that
# appear once (measured on three deployed runs: 55% vs 17% hit expected actions). Two candidates
# are the same deliverable when their embeddings agree at this level and their owners do not
# disagree.
SUPPORT_MERGE_THRESHOLD = 0.70
STATUS_RANK = {"ASSIGNED": 4, "COMMITTED": 3, "REQUIRED": 2, "PROPOSED": 1, "COMPLETED": 0}

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

DISCUSSION_CANDIDATE_SCHEMA = {"type": "json_schema", "json_schema": {
    "name": "meeting_discussion_candidates", "strict": True, "schema": {
        "type": "object", "properties": {"candidates": {"type": "array", "items": {
            "type": "object", "properties": {
                "workstream": {"type": "string"},
                "state": {"type": "string"},
                "evidenceTurns": {"type": "array", "items": {"type": "integer"}},
            },
            "required": ["workstream", "state", "evidenceTurns"],
            "additionalProperties": False,
        }}},
        "required": ["candidates"], "additionalProperties": False,
    },
}}

DISCUSSION_FILTER_SCHEMA = {"type": "json_schema", "json_schema": {
    "name": "meeting_discussion_candidate_filter", "strict": True, "schema": {
        "type": "object", "properties": {"decisions": {"type": "array", "items": {
            "type": "object", "properties": {
                "candidate": {"type": "integer"},
                "decision": {"type": "string", "enum": ["DISCUSSION_POINT", "IGNORE"]},
            },
            "required": ["candidate", "decision"],
            "additionalProperties": False,
        }}},
        "required": ["decisions"], "additionalProperties": False,
    },
}}

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

ACTUAL_ACTIONS_SCHEMA = {"type": "json_schema", "json_schema": {"name": "actual_actions", "strict": True, "schema": {
    "type": "object", "properties": {"candidateNumbers": {"type": "array", "items": {"type": "integer"}}},
    "required": ["candidateNumbers"], "additionalProperties": False}}}

RETRIEVAL_SELECTOR_SCHEMA = {"type": "json_schema", "json_schema": {"name": "retrieval_action_decisions", "strict": True, "schema": {
    "type": "object", "properties": {"decisions": {"type": "array", "items": {"type": "object", "properties": {
        "candidateNumber": {"type": "integer"}, "decision": {"type": "string", "enum": ["KEEP", "REMOVE"]},
        "rejectionCode": {"type": "string", "enum": ["NONE", "COMPLETED_ONLY", "UNACCEPTED_PROPOSAL", "DISCUSSION_ONLY", "MEETING_ADMIN", "MALFORMED", "NO_SUPPORTED_TASK"]},
        "evidenceTurns": {"type": "array", "items": {"type": "integer"}}},
        "required": ["candidateNumber", "decision", "rejectionCode", "evidenceTurns"], "additionalProperties": False}}},
    "required": ["decisions"], "additionalProperties": False}}}

SHORT_ACTION_REPAIR_SCHEMA = {"type": "json_schema", "json_schema": {"name": "short_action_repairs", "strict": True, "schema": {
    "type": "object", "properties": {"repairs": {"type": "array", "items": {"type": "object", "properties": {
        "candidateNumber": {"type": "integer"}, "action": {"type": "string"}},
        "required": ["candidateNumber", "action"], "additionalProperties": False}}},
    "required": ["repairs"], "additionalProperties": False}}}

SHORT_ACTION_REPAIR_PROMPT = """Each numbered fragment below is an action candidate that the extractor wrote as a bare verb or phrase, with the transcript turns it cited.

For every fragment, using only its cited turns, write the specific task as one concise minutes action that names what is to be done and to what (for example "Send the code of conduct to the auditor", "Build out the audit scope and standards list"). Do not add owners, deadlines or details the turns do not state.

Return an empty string for a fragment when its cited turns contain no specific future task: screen sharing, meeting procedure, banter, a description of how things normally work, or a restatement of the schedule. Also return an empty string for travel, accommodation, car hire, attendance, being on site, and personal arrangements - these are never minutes actions. Only a deliverable somebody will send, share, review, confirm, arrange, update, decide, investigate or prepare qualifies.

Return exactly one repair for every fragment, keeping its candidate number.

{fragments}"""

DELIVERABLE_VERBS = ["SEND", "SHARE", "REVIEW", "CONFIRM", "ARRANGE", "UPDATE", "DECIDE", "INVESTIGATE", "PREPARE", "ATTEND", "OTHER"]
DELIVERABLE_SCHEMA = {"type": "json_schema", "json_schema": {"name": "action_deliverables", "strict": True, "schema": {
    "type": "object", "properties": {"deliverables": {"type": "array", "items": {"type": "object", "properties": {
        "candidateNumber": {"type": "integer"}, "deliverable": {"type": "string"},
        "verb": {"type": "string", "enum": DELIVERABLE_VERBS}, "recipient": {"type": "string"}},
        "required": ["candidateNumber", "deliverable", "verb", "recipient"], "additionalProperties": False}}},
    "required": ["deliverables"], "additionalProperties": False}}}

DELIVERABLE_PROMPT = """For each numbered action candidate, name its deliverable: the specific thing that is to be produced, sent, reviewed, decided or arranged, as a short noun phrase (2-6 words) with no verb, owner or deadline. Examples: "risk analysis", "code of conduct", "secure document access", "pre-audit catch-up meeting", "software list front page", "nebuliser flow-rate specification".

Give the verb class: SEND (send/email/provide), SHARE (share/give access), REVIEW (review/read/check/look at), CONFIRM (confirm/check whether/clarify), ARRANGE (arrange/schedule/organise/meet), UPDATE (update/add/change/write/document), DECIDE (decide/agree/choose), INVESTIGATE (investigate/look up/find out/test), PREPARE (prepare/build/plan/draft), ATTEND (attend/be present/travel), OTHER.

Give the recipient if the candidate names who receives the deliverable, otherwise an empty string.

Return exactly one entry per candidate, keeping its number.

{candidates}"""

IMPORTER_ACTUAL_ACTIONS_PROMPT = """Provide only the actual actions from these candidates.

An actual action is a concrete future task that a person explicitly agreed or was assigned to do in this meeting.

Exclude discussion, existing processes, general obligations, questions, suggestions, completed work and vague possibilities.

Judge each row from its evidence. There is no minimum or target number of actions. Return none if no candidates qualify.

{candidates}

Return candidate numbers only, never action text."""

SELECTIVE_ACTUAL_ACTIONS_PROMPT = """Perform a conservative final cleanup of these high-recall action candidates for formal meeting minutes.

The earlier extraction deliberately found both newly assigned and continuing required work. Do not re-litigate every commitment from scratch. Retain a COMMITTED, ASSIGNED or REQUIRED candidate when it names a specific meaningful future task and its evidence does not contradict it. Retain a concrete PROPOSED candidate when the meeting-specific rules allow it.

Remove only completed work, pure discussion or status, an unresolved issue with no next step, vague wording without a meaningful deliverable, malformed transcript fragments, and clearly unaccepted hypotheticals.

Candidate status is an advisory extraction signal: use it, but let contradictory transcript evidence override it. This is a precision cleanup, not a request to minimise the list. There is no target or maximum number of actions.

MEETING-SPECIFIC RULES:
{guidance}

{candidates}

Return selected candidate numbers only, in transcript order. Never return action text."""

HYBRID_TECHNICAL_SELECTOR_GUIDANCE = """This is a combined software and technical-file weekly review. Retain concrete compliance checks, investigations, tests, document changes, reviews, submissions and dependency-driven follow-ups, including continuing work. REQUIRED is valid here even without a fresh first-person promise. Concrete PROPOSED investigations or reviews are also reviewer-useful and should remain. Exclude only completed items, broad status restatements, vague encouragement, meeting administration, and technical issues with no next step."""

DECISION_MEETING_SELECTOR_GUIDANCE = """This is a decision meeting. Discussion of options is not an action. Retain only an explicit commitment, accepted assignment or agreed follow-up. Exclude every proposal, possibility, question, option and unresolved decision that nobody accepted, even if it is worded like a task."""

RETRIEVAL_SELECTOR_PROMPT = """Validate high-recall action candidates against the supplied local transcript evidence.

KEEP only when the evidence positively establishes both a concrete standalone task or deliverable
and that it is outstanding work: an explicit commitment, accepted assignment, agreed follow-up,
continuing unfinished task, stated prerequisite, or meeting-type-valid accepted/deferred proposal.

For KEEP, use rejectionCode NONE and cite the supplied turns that prove the task and outstanding
status. Candidate wording, status labels, repetition across extraction samples and similar vocabulary
are not proof. If either element is ambiguous, REMOVE with COMPLETED_ONLY, UNACCEPTED_PROPOSAL,
DISCUSSION_ONLY, MEETING_ADMIN, MALFORMED or NO_SUPPORTED_TASK and cite the supporting turns. Do not
reject merely because owner or deadline is unstated. Do not consolidate duplicates. There is no target.

MEETING RULES:
{guidance}

Return exactly one decision for every candidate, retaining its candidate number.

{candidates}"""

RETRIEVAL_PROFILE_GUIDANCE = {
    "audit_retrieval": "Retain concrete audit preparation, scope/risk planning, training prerequisites, document/data sharing, access arrangements and pre-audit coordination.",
    "technical_retrieval": "Retain concrete compliance checks, investigations, tests, controlled-document changes, reviews, submissions and continuing dependency-driven work.",
    "webinar_retrieval": "Retain agreed live-event responsibilities, accepted slide/script/delivery changes, technical checks, question handling, cues, rehearsal and distribution tasks.",
    "software_retrieval": "Retain concrete software investigation, testing, debugging, documentation, change-control and continuing technical work.",
    "process_retrieval": "Retain concrete manual tests, pilots, criteria, information-capture tasks and conditional next phases with a stated trigger or method.",
    "importer_retrieval": "Retain explicit future assignments created in this meeting: documents to send, resend or review, lists or confirmations to provide, registrations, declarations or labels to update, calls to arrange, and named follow-ups with a person. Remove descriptions of the importer's standing regulatory obligations, existing processes, how the business works, questions with no agreed follow-up, and requests to explain something during the meeting itself.",
}

AUDIT_RETRIEVAL_V2_GUIDANCE = """Retain only a concrete outstanding audit-preparation deliverable,
prerequisite, accepted coordination task, or explicit decision that still has to be made.

Valid audit actions include preparing scope or readiness inputs; confirming, sending or sharing a
named document, record or dataset; arranging required evidence access; completing a specifically
named prerequisite; adjusting a preparation plan around a stated constraint; arranging an accepted
working session; and resolving a concrete choice assigned to a person.

Remove descriptive audit scope and possible areas to inspect unless a person accepted a concrete
follow-up. Remove normal audit process, scheduled audit attendance, working hours, travel,
accommodation, transport, social coordination, previous/other audits, already-completed reports,
generic preparation wording, and unaccepted "might/could look at" suggestions. A technical noun
such as SBOM, CVE, design owner or programming does not make discussion into an action.

Require the draft to name its actual deliverable or decision object. Preserve legitimate
conditions only when the transcript states them. Verify the owner from the evidence: the speaker
stating or recapping a requirement is not the owner when somebody else must perform it."""

IMPORTER_RETRIEVAL_V2_GUIDANCE = """Retain only a specific outstanding follow-up created or
explicitly continued in this importer-obligations meeting. Valid actions include sending or
reviewing a named QMS/compliance document; contacting a named person about a task list,
registration plan or responsibility split; confirming a country/language/product list; continuing
supplier/system implementation with a concrete outcome; a genuinely conditional offer to review
a proposed label or barcode; updating a named declaration or rationale; sending and separately
reviewing named regulatory correspondence; and arranging an accepted follow-up call.

Remove regulatory or importer obligations stated as background, legal-responsibility explanations,
ordinary warehouse/order/ERP/picking/packing/invoicing/dispatch process, questions answered in the
meeting, generic checks, vague clarity or handling tasks, and future possibilities nobody accepted.
An EUDAMED, UDI, barcode, label, invoice or QMS noun does not make discussion into an action.

Require a complete task object and outcome in the candidate's own cited turns. Preserve ongoing
work only when a named owner states it is still being progressed toward a future outcome. Verify
the owner from the commitment or acceptance; do not assign work to the explainer, requester,
recipient, legal manufacturer or service provider merely because they are mentioned."""

HYBRID_RETRIEVAL_V2_GUIDANCE = """Retain only a concrete outstanding software or technical-file
follow-up created, accepted or explicitly continued in this weekly review. Keep distinct dependent
handoffs when one person produces or sends an input and another tests, reviews or incorporates its
result. Keep a technical assessment separate from the controlled-document change it enables.

Remove status already completed, explanations of current software behaviour, questions answered in
the meeting, speculative version numbers, generic review or update wording, and a meeting or
document mentioned without a specific future output. Do not turn the facilitator recapping another
person's task into an action owned by the facilitator. Require the task object, owner, condition and
future outcome to be supported by the candidate's cited turns."""

TECHNICAL_FILE_RETRIEVAL_V2_GUIDANCE = """Retain only a concrete outstanding regulated
technical-file work package: a risk-file update or review, software or language remediation,
traceability work, compliance testing, a documentation-gap resolution, study planning, controlled
process-map completion, PMS incorporation, or an explicit document handoff or follow-up.

Collapse status fragments and dependencies into the responsible deliverable. Remove tracker or
minutes administration, completed reviews and tests, broad progress updates, repeated descriptions
of the same document work, schedules with no new task, and vague requests to progress or focus.
Preserve dependent owner handoffs only where each person has a distinct future output. A facilitator
summarising another person's work is not its owner."""

WEBINAR_RETRIEVAL_V2_GUIDANCE = """Retain only a final, outstanding webinar deliverable or a
live-session responsibility that the team explicitly accepted. Prefer the final assignment recap
when it is present. A valid row must name the exact material, content change, equipment or venue
check, prepared resource, or operational responsibility supported by this transcript.

A live-session behaviour (opening, handover, timing, chat, questions, recording, closing or backup
coverage) is an action only when the evidence explicitly assigns or accepts it for the real event,
ideally in the final owner-by-owner recap. Merely performing, practising, demonstrating or advising
it during this rehearsal is not outstanding work. Concrete pre-event changes to slides, charts,
speaker notes, wording, equipment, venue checks or materials do not require a final recap when their
own evidence clearly assigns or accepts the future deliverable.

Remove rehearsal procedure that was completed during this meeting, descriptions of the planned
flow, ordinary presenter handovers, example questions or answers, general delivery advice,
technical possibilities that were discussed but not included in the final responsibilities, and
duplicate fragments of a broader assignment. Do not turn the rehearsal itself into many actions or
invent a familiar webinar task merely because it appears in these instructions. Keep distinct
deliverables distinct and merge only steps producing one supported output for a compatible owner."""

PROCESS_RETRIEVAL_V2_GUIDANCE = """Retain only an agreed experiment, a prerequisite that must be
defined before that experiment, or a conditional next phase with an explicit trigger. In a process
or pipeline review, distinguish an immediate bounded test from a later pilot, preserve the pilot's
stated success condition, and retain criteria, ownership or information-capture work that the group
explicitly accepted.

Remove the proposed steady-state pipeline itself: possible sources, stages, system matching,
prioritisation, enrichment, routing and feedback loops are process-design discussion unless somebody
separately accepted one as an immediate task.
Remove requests answered during the meeting, descriptions of current practice, possible automation
after an uncompleted pilot, generic sense-checking and options nobody accepted. Do not convert each
box in a future-state process diagram into an action."""

GENERAL_RETRIEVAL_V2_GUIDANCE = """This is a general committee or operational planning meeting.
Retain only a concrete future task that a named person accepted, volunteered for, or was explicitly
assigned. Combine repeated fragments of the same deliverable, including its request, acceptance,
details and recap. Keep distinct deliverables separate even when they share an owner.

Remove decisions that need no follow-up, risk-register observations without an accepted response,
possible contingency plans, routine meeting administration, requests answered in the meeting,
descriptions of the agreed operating plan, and conversational promises with no useful deliverable.
Do not turn each detail or step of one accepted task into a separate action. Agreement to revisit a
topic, make progress, wait for somebody, or return with the best idea is not a deliverable. Exclude
personal side tasks, travel and training unrelated to the meeting's substantive work."""

PROJECT_CHECKIN_RETRIEVAL_GUIDANCE = """This is a project or consultancy check-in. Retain only a
specific outstanding project follow-up that somebody accepted: arranging a replacement working
session, asking a named person to resolve or explain a concrete blocker, correcting access to a
named project resource, or producing, sending, reviewing or updating a specific project output.

When a participant accepts a follow-up to ask, contact or chase another person, keep that
participant as owner and state the action as "Ask/contact [person] to [specific outcome]". Do not
turn it into an assignment of the underlying work to the other person unless the evidence records
that person's own acceptance.

Remove waiting for an attendee, attendance and travel discussion, personal training or exams,
meeting procedure, instructions not to produce minutes, status narration, vague progress updates,
and unresolved references such as 'try him', 'get it' or 'deal with that'. A rescheduled meeting is
an action only when somebody is explicitly responsible for placing or confirming it."""


def audit_action_v2_enabled() -> bool:
    return os.environ.get("STAGED_AUDIT_ACTION_V2", "0") == "1"


def importer_action_v2_enabled() -> bool:
    return os.environ.get("STAGED_IMPORTER_ACTION_V2", "0") == "1"


def software_action_consolidation_v2_enabled() -> bool:
    return os.environ.get("STAGED_SOFTWARE_ACTION_CONSOLIDATION_V2", "0") == "1"


def hybrid_action_v2_enabled() -> bool:
    return os.environ.get("STAGED_HYBRID_ACTION_V2", "0") == "1"


def technical_file_action_v2_enabled() -> bool:
    return os.environ.get("STAGED_TECHNICAL_FILE_ACTION_V2", "0") == "1"


def webinar_action_v2_enabled() -> bool:
    return os.environ.get("STAGED_WEBINAR_ACTION_V2", "0") == "1"


def process_action_v2_enabled() -> bool:
    return os.environ.get("STAGED_PROCESS_ACTION_V2", "0") == "1"


def general_action_v2_enabled() -> bool:
    return os.environ.get("STAGED_GENERAL_ACTION_V2", "0") == "1"

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

AUDIT_ACTION_PROMPT = """Review this coherent section from an audit kick-off or audit-planning transcript.

Build a concise audit-preparation action ledger. Identify every supported future task with a
specific deliverable, prerequisite, coordination outcome or unresolved decision that somebody
must progress after this meeting.

Check generically for scope, readiness or risk inputs to prepare; a named document, record, dataset
or evidence pack to confirm, send, share or review; required evidence access; a specifically named
prerequisite; a preparation-plan change caused by a stated constraint; an accepted working session;
and a concrete unresolved choice that somebody accepted responsibility for deciding.

Give each candidate one status: COMMITTED, ASSIGNED, REQUIRED, PROPOSED or COMPLETED.

Rules:
- State the complete task object. Never emit generic actions such as "prepare", "understand",
  "go through", "work out logistics", "look at issues" or "plan for the event".
- Preserve a dependency or condition only when the transcript states it and it changes the task.
- Resolve "you" from the named addressee in the surrounding turns. The person stating a
  requirement is not automatically its owner. Preserve joint owners when both accept a task.
- Consolidate parts of one audit-preparation work package within this section, but keep separately
  owned production, sending, review and completion stages distinct.
- A possible audit topic (a system, standard, SBOM, CVE, device area, process or document that
  the auditor may inspect) is not an action unless somebody accepts a concrete follow-up.
- Exclude descriptions of normal audit practice, audit scope, and already scheduled audit work
  when no additional deliverable or decision remains.
- Exclude previous or other audits, already-completed reports, travel, accommodation, car
  arrangements, mere attendance, site hours and social coordination.
- A suggestion such as "might be worth looking at" is PROPOSED only when somebody accepts it;
  otherwise exclude it.
- An unresolved choice can be an action only when the cited section states both the specific
  choice and that somebody is actively deciding it; name that choice rather than its background.
- Evidence for task, commitment, owner, recipient, prerequisite and deadline may be in different
  turns. Cite all supporting turns within this section.
- Before returning, rescan owner by owner for missed PREPARE, CONFIRM, SHARE, ARRANGE, COMPLETE,
  ADJUST and DECIDE tasks.

Return at most two discussion points and six action candidates. Prioritise explicit deliverables,
prerequisites and decisions over descriptive audit content. Use only turn numbers in this section.
Return only the required JSON.

TRANSCRIPT SECTION:
{numbered_chunk}"""

IMPORTER_ACTION_PROMPT = """Review this coherent section from an importer-obligations review.

Build a concise ledger of concrete outstanding follow-ups created or explicitly continued in
this meeting. A regulatory obligation, business-process description or question is not itself an
action. Include it only when the section supports a named person's specific next-step output.

Check generically for concrete information, questions, contracts, controlled documents or evidence
to draft, obtain, send, chase, review or update; a named external party to contact; implementation
work with a supplier or service provider that has a stated owner and future outcome; and an accepted
follow-up session that somebody must schedule.

Give each candidate one status: COMMITTED, ASSIGNED, REQUIRED, PROPOSED or COMPLETED.

Rules:
- State the complete deliverable. Exclude vague wording such as "go through questions", "provide
  clarity", "handle the invoice", "do checks", "follow up" or "look at the process" unless the
  concrete object and outcome are stated.
- Distinguish work newly assigned or explicitly continued from the organisation's standing legal
  duty, normal warehouse/order process, existing manufacturer responsibility or background status.
- A question asked and answered during this meeting is not a future action.
- Preserve legitimate continuation work when the owner states it is underway and still has a
  future outcome or timeframe.
- Preserve conditions: an offered regulatory review remains conditional until accepted; do not
  turn an offer into a committed task.
- Resolve the owner from the commitment or acceptance. The person explaining an obligation,
  asking a question, receiving a document or being consulted is not automatically the owner.
- Keep each handoff distinct: sending correspondence and reviewing it are separate actions;
  updating a label and optionally reviewing its proposed format may also be separate.
- Exclude ordinary product flow, warehousing, ERP, picking, packing, invoicing and dispatch
  descriptions unless a concrete follow-up was accepted.
- Exclude standing importer or regulatory obligations when the transcript only states who is
  legally responsible or what normally happens.
- Evidence for task, commitment, owner, recipient, condition and timeframe may be in different
  turns. Cite all supporting turns within this section.
- Before returning, rescan owner by owner for missed SEND, REVIEW, SPEAK, CONFIRM, CONTINUE,
  UPDATE and ARRANGE tasks.

Return at most two discussion points and seven action candidates. Prioritise explicit handoffs,
continuing implementation and controlled-document changes over regulatory explanation. Use only
turn numbers in this section. Return only the required JSON.

TRANSCRIPT SECTION:
{numbered_chunk}"""

HYBRID_ACTION_PROMPT = """Review this coherent section from a combined software and technical-file
weekly review. Build a concise ledger of concrete outstanding follow-ups created, accepted or
explicitly continued in the meeting.

Keep dependent work packages distinct. Check specifically for:
- software behaviour, risk or control questions with a concrete investigation or document output;
- technical inputs to define or send and the separate test or review result another owner must produce;
- a change, assessment or gap analysis and the controlled-document update its output enables;
- continuing compliance, localisation, traceability or testing work with a stated outcome;
- a named document or standard to send, review, file, update or assess for applicability;
- an accepted follow-up session or participant addition needed to progress the work.

Rules:
- A status report, completed test, current behaviour explanation or question answered in the meeting
  is not a future action.
- State the complete deliverable; exclude vague wording such as "review the output", "look at the
  languages", "continue the work", "set up meetings" or "get an update" without its object/outcome.
- Resolve ownership from the commitment, accepted assignment or explicit recap. The facilitator,
  requester, recipient or person mentioned in a document is not automatically the owner.
- Preserve conditions, dependencies and dates such as next week, Wednesday, after confirmation and
  only if the document needs to be added.
- Evidence for task, owner, condition and timeframe may span several turns. Cite them all.
- Before returning, rescan for missed CONFIRM, REVIEW, SEND, TEST, PROGRESS, COMPLETE, INCORPORATE,
  CONTINUE, UPDATE, EMAIL, FOLLOW UP and ADD tasks.

Return at most two discussion points and eight action candidates. Prioritise explicit commitments,
handoffs and recap items over explanatory discussion. Use only turn numbers in this section and
return only the required JSON.

TRANSCRIPT SECTION:
{numbered_chunk}"""

WEBINAR_ACTION_V2_PROMPT = """Review this coherent section from a webinar rehearsal and build a
concise ledger of final outstanding deliverables and accepted live-session responsibilities.

Check generically for changes to slides, charts, scripts, speaker notes or other content; venue,
display, connectivity or presentation-equipment checks; printed or digital materials to prepare;
accepted wording or timing edits; reserve audience questions; and explicitly assigned live-session
or pre-event responsibilities.

Rules:
- Prefer the final owner-by-owner assignment recap when one exists, using earlier turns only to
  resolve the full deliverable, condition or timing.
- For a live-session behaviour, emit a candidate only when the section explicitly assigns or
  accepts that behaviour for the real event. Do not emit something merely because a person
  practises, demonstrates or receives advice about it in the rehearsal.
- A concrete pre-event slide, chart, notes, wording, venue, equipment or materials change may be
  emitted without a final recap when it is clearly accepted as outstanding work.
- Combine steps only when they produce one deliverable for one compatible owner. Keep genuinely
  different deliverables or owners separate.
- Rehearsal instructions already performed, descriptions of the event flow, example audience
  questions, general presentation advice and unaccepted contingency ideas are not future actions.
- Resolve the owner from a commitment, acceptance or assignment recap. A presenter or recipient is
  not automatically the owner.
- Preserve stated timing, but do not infer a task merely because an event time is discussed.

Return at most two discussion points and eight action candidates for this section. Use only turn
numbers in this section and return only the required JSON.

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

TECHNICAL_FILE_ACTION_V2_PROMPT = """Review this coherent section from a regulated technical-file
review. Build a concise ledger of concrete outstanding deliverables, continuing work packages and
accepted dependent handoffs.

Check generically for risk-management comments, definitions, matrices and approvals; classification
or regulatory rationale; identifier or controlled-record corrections; technical investigation and
testing; evidence, reviewer or specialist-resource gaps; supplier and quality agreements; localisation
or market requirements; tracker ownership corrections; controlled-document drafting, handoff, review
and incorporation; and a focused session explicitly assigned to resolve a technical definition.

Rules:
- Combine fragments of one deliverable, including its supporting review or dependency, unless two
  people have genuinely distinct future outputs.
- Preserve distinct stages where one person must produce or send an output and another must review or
  approve it. Preserve a request for comments separately from implementing those comments.
- Continuing work is valid when the transcript identifies its concrete outcome and owner.
- Remove completed work, tracker narration, broad status, generic focus statements and vague
  progress wording without a named document, study, test or decision outcome.
- Resolve the owner from the person doing the work, not the facilitator who recaps it.
- Preserve stated timing and conditions, including end of week, second-last week of July, once a
  colleague returns and after a document is placed in a review folder.

Return at most two discussion points and eight action candidates for this section. Use only turn
numbers in this section and return only the required JSON.

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

First identify concise, substantive discussion points. Then build a concise ledger of concrete
outstanding software deliverables, accepted assignments and explicitly deferred work.

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

Include a proposal only when somebody accepts or explicitly defers it as work to perform. Give each
candidate one status: COMMITTED, ASSIGNED, REQUIRED, PROPOSED or COMPLETED.

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

PROCESS_ACTION_V2_PROMPT = """Review this coherent section from a process or pipeline-planning
meeting. Build a concise ledger of agreed experiments, their prerequisites and explicitly
conditional next phases.

Check generically for a bounded test or pilot with a concrete method or success condition; a
prerequisite, definition, measurement or ownership decision the group accepted as immediate work;
information-capture or tracking work with a specific output; and a conditional later phase with an
explicit trigger.

Rules:
- A described future-state process is not a list of actions. Do not extract its sources, stages,
  system matching, prioritisation, enrichment, routing or feedback loops unless a person separately
  accepts one as immediate work.
- Preserve each experiment's owner, measurable outcome and trigger. Do not merge an initial test
  with a conditional later pilot.
- A question answered by a description of current practice is discussion, unless the exchange ends
  with a concrete gap the group must resolve.
- Possible later automation is not yet an action while prerequisite experiments remain incomplete.
- Resolve named joint owners from the proposal and use a team owner only where the transcript
  explicitly describes the definition as team work.

Return at most two discussion points and six action candidates for this section. Use only turn
numbers in this section and return only the required JSON.

TRANSCRIPT SECTION:
{numbered_chunk}"""

GENERAL_ACTION_V2_PROMPT = """Review this coherent section from a general committee or operational
planning meeting. Build a concise ledger of accepted future deliverables.

Rules:
- Keep a concrete task only when a named person accepts it, volunteers for it, or is explicitly
  assigned it. A later owner-by-owner recap is strong evidence.
- Combine the request, acceptance, task details, deadline and recap for one deliverable into one
  complete action. Do not emit a short fragment and a fuller duplicate.
- Keep genuinely separate deliverables separate, including two different tasks for one owner.
- An agreed decision or operating plan is not itself an action unless someone must produce, send,
  order, book, repair, test, submit or otherwise complete a follow-up.
- Exclude unaccepted suggestions, completed work, risk observations without an accepted response,
  possible contingency plans, meeting administration and social conversation.
- Resolve the owner from the commitment or assignment, not the requester, recipient or facilitator.
- Preserve useful quantities, dates, conditions and recipients stated in the evidence.

Return at most two discussion points and eight action candidates for this section. Use only turn
numbers in this section and return only the required JSON.

TRANSCRIPT SECTION:
{numbered_chunk}"""

PROJECT_CHECKIN_ACTION_PROMPT = """Review this coherent section from a project or consultancy
check-in. Build a concise ledger of specific outstanding project follow-ups.

Keep an explicitly owned replacement meeting, a request to resolve or explain a concrete blocker,
an access correction, or a specific project document or output to produce, send, review or update.
Exclude waiting for attendees, personal training or exams, travel, meeting procedure, status-only
discussion, instructions about whether to write minutes, and vague or unresolved actions.

If somebody accepts responsibility to ask, contact or chase another person about an outcome, the
candidate must preserve that delegation: owner = the person accepting the follow-up; action =
"Ask/contact [other person] to [specific outcome]". Do not assign the underlying work directly to
the other person unless that person explicitly accepts it in the cited section.

Give each candidate one status: COMMITTED, ASSIGNED, REQUIRED, PROPOSED or COMPLETED. Cite separate
task, commitment, owner and deadline evidence. Preserve the exact supported deliverable and owner;
do not fill gaps from common project-management practice. Return only the required JSON.

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
    if audit_action_v2_enabled() and "audit" in normalised and any(
        term in normalised for term in ("kick off", "kickoff", "planning")
    ):
        return AUDIT_ACTION_PROMPT, "audit_planning_v2"
    if importer_action_v2_enabled() and "importer" in normalised and "obligation" in normalised:
        return IMPORTER_ACTION_PROMPT, "importer_obligations_v2"
    if hybrid_action_v2_enabled() and normalised == "software and technical file weekly review":
        return HYBRID_ACTION_PROMPT, "hybrid_technical_v2"
    if "webinar" in normalised and any(term in normalised for term in ("rehearsal", "practice", "run through")):
        if webinar_action_v2_enabled():
            return WEBINAR_ACTION_V2_PROMPT, "webinar_rehearsal_v2"
        return WEBINAR_REHEARSAL_ACTION_PROMPT, "webinar_rehearsal"
    if ("software" in normalised and "technical file" in normalised) or any(
        term in normalised for term in ("software weekly", "software check in", "software review")
    ):
        return SOFTWARE_WEEKLY_ACTION_PROMPT, "software_weekly_review"
    if technical_file_action_v2_enabled() and normalised in {
        "technical file review", "technical file consultancy review"
    }:
        return TECHNICAL_FILE_ACTION_V2_PROMPT, "technical_file_v2"
    if "technical file" in normalised:
        return TECHNICAL_REVIEW_ACTION_PROMPT, "technical_file_review"
    if any(term in normalised for term in ("pipeline", "process planning", "process review", "lead generation")):
        if process_action_v2_enabled():
            return PROCESS_ACTION_V2_PROMPT, "process_pipeline_v2"
        return PROCESS_PIPELINE_ACTION_PROMPT, "process_or_pipeline_planning"
    if normalised == "general" and general_action_v2_enabled():
        return GENERAL_ACTION_V2_PROMPT, "general_v2"
    if normalised == "project consultancy check in" and general_action_v2_enabled():
        return PROJECT_CHECKIN_ACTION_PROMPT, "project_checkin_v2"
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

AUDIT_DISCUSSION_PROMPT = """Write concise Key discussion points for formal minutes of this audit planning meeting using only this transcript section.

Create a compact audit state ledger. Preserve concrete states affecting audit scope, readiness, responsibilities, evidence access, execution, working arrangements or reporting.

Prioritise according to the section supplied:
- FIRST THIRD: audit classification and findings; preparation/on-site/report dates; audit lead, auditors and specialist role; products and no-AI position; initial transmission, rollout, version and cybersecurity risks; software-management focus; document-access position.
- MIDDLE THIRD: site and travel logistics; design-owner or device context; code of conduct, training and confidentiality prerequisites; access and sharing; risk-assessment-to-audit-plan sequence; planning meetings and availability constraints.
- FINAL THIRD: tracker, sampling and checklist method; SBOM availability and suppliers; CVE and corporate threat monitoring; separate software track; AI-assisted report writing; end-of-day coordination after site work.

Rules:
- Return at most 4 headings and at most 12 points TOTAL for this section. Count all points and remove lower-priority ones until there are no more than 12.
- Combine repetitions but keep materially different states separate. Omit banter, generic wellbeing commentary, meeting procedure and speculative examples without an audit consequence.
- Preserve exact names, dates, standards, device types, dependencies, proposals and uncertainty. Describe states, not actions.
- A speaker saying “you are the lead” assigns the addressee, not the speaker. Name that lead only if the addressee is explicit or securely resolved from a nearby named address; otherwise say “the audit lead”.
- Preserve classification evidence literally: routine versus for-cause, surveillance context, full findings and ratings, and not an assessment audit.
- Preserve positive and negative technology claims literally, including no-AI statements.
- Distinguish core auditors from specialist support and a proposed separate software track.
- Distinguish evidence expected before arrival from evidence only available on site.
- Before returning, rescan for the priority states assigned to the supplied third.

Use clear British English. Return only the required JSON.

DENOISED TRANSCRIPT SECTION:
{transcript}"""

IMPORTER_DISCUSSION_PROMPT = """Write concise Key discussion points for formal minutes of this importer-obligations review using only this transcript section.

Create a compact importer-compliance state ledger. Preserve distinct supported states concerning:
- how the QMS manual, procedures and other compliance documents are being built, and how regulatory requirements must reflect the organisation's actual operations;
- the end-to-end product flow: supplier country, fiscal import or customs clearance, temporary holds, final warehousing and distribution;
- warehouse systems and manual steps, order channels, ERP processing, picking, packing, labelling, invoicing and dispatch;
- current identifiers and traceability, including UPC, lot numbers, UDI and 2D data-matrix changes;
- EUDAMED deadlines, new versus existing products, importer checks, manufacturer data, authorised-representative or third-party registration responsibilities, oversight and timelines;
- other market databases such as FDA GUDID where products are distributed outside the EU;
- manufacturer information, warranty material, IFUs, Class I exemptions and the evidence or rationale required when no IFU is supplied;
- declarations of conformity, product scope, sunglasses, MDR/PPE classifications and risk rationale;
- document translation and the countries and languages that must be covered based on actual distribution;
- authorised-representative appointments, SRN correspondence, regulator invoices and checks needed before payment;
- missing, unreceived or outstanding documents and information, preserving their current state without turning them into an action list.

Rules:
- Return at most 6 concise headings and at most 16 points TOTAL for this transcript section. Count all points before returning.
- Keep each materially distinct regulatory obligation, operating-process fact, document state, deadline or dependency as its own point. Combine repetition only.
- Preserve exact organisations, countries, locations, systems, product classes, identifiers, dates and uncertainty.
- Distinguish manufacturer, importer, authorised representative, distributor and service-provider responsibilities; do not transfer an obligation merely because another party was discussed.
- Distinguish customs or airport clearance from warehousing and temporary holding from final storage.
- Distinguish a proposed interpretation or unresolved question from a confirmed requirement.
- Include concrete current states even when they imply follow-up, but write discussion points rather than actions.
- Omit banter, meeting procedure and unsupported inference.
- Before returning, rescan for QMS/PROCESS, PRODUCT FLOW, CUSTOMS, WAREHOUSE, ORDER FLOW, UPC/UDI/LOT, EUDAMED, GUDID, IFU, DOC, MDR/PPE, COUNTRY/LANGUAGE, SRN and INVOICE states.
- Use clear British English. Return only the required JSON.

DENOISED TRANSCRIPT SECTION:
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

SOFTWARE_TECHNICAL_FILE_CANDIDATE_PROMPT = """Review this coherent numbered section from a software and technical-file meeting.

Return only standalone, minutes-worthy discussion-state candidates. A candidate must help a reader understand a workstream's material current position, implemented outcome, unresolved issue, decision, dependency, review/approval status, test or evidence position, risk/control rationale, regulatory status, version consequence, standard applicability or document state.

Capture distinct lifecycle states separately, but combine conversational fragments and demonstration micro-steps that establish the same state. Preserve materially different modes such as audible versus visual implementation, and preserve method, timing and evidence gaps separately when each changes the meaning.

Do not create candidates for greetings, meeting frequency, screen sharing, playback procedure, navigation, vague activity, conversational corrections or isolated technical details without a workstream consequence.

Before returning, check each named participant for a substantive contribution and each named standard, plan, matrix, report, logic description or technical-file document for a material review/update state. Include supported brief states rather than allowing a dominant topic to hide them.

Use a short reusable workstream label, one concise factual state, and the smallest sufficient set of supporting turn numbers. Return at most 10 candidates for this section. Include all qualifying states up to that limit. Preserve names, dates, versions, standards, conditions and uncertainty. Describe states rather than action-list instructions.

NUMBERED TRANSCRIPT SECTION:
{numbered_chunk}"""

DISCUSSION_CANDIDATE_FILTER_PROMPT = """Classify every numbered candidate independently as DISCUSSION_POINT or IGNORE.

DISCUSSION_POINT means the candidate is a standalone, minutes-worthy statement that helps a reader understand a substantive workstream's current position, implemented outcome, unresolved issue, decision, dependency, review or approval status, test/evidence position, risk/control rationale, regulatory status, version consequence, standard applicability or document state.

The candidate must remain useful when read outside the transcript. Brief technical details qualify when they distinguish an agreed behaviour, measurable requirement, material test result, risk, unresolved defect or evidence consequence.

IGNORE means the candidate is any of the following:
- greeting, banter, social observation or personal activity;
- meeting frequency or attendance without a substantive project consequence;
- screen sharing, playback, navigation or other demonstration procedure rather than its technical result;
- vague activity such as being busy, working on something, turning something up or asking generally for progress;
- conversational correction, fragment or instruction that does not state a durable workstream position;
- a micro-step whose only purpose is to conduct the meeting or demonstration;
- wording too ambiguous to be useful in formal minutes.

A substantive point may imply future work and still qualify. Judge only whether the candidate itself is a durable discussion state. Do not rewrite, merge, rank or omit candidates. Return one decision for every candidate number.

NUMBERED CANDIDATES:
{candidates}"""


def discussion_prompt_for_meeting_type(meeting_type: str) -> tuple[str, str]:
    normalised = re.sub(r"[^a-z0-9]+", " ", clean(meeting_type).lower()).strip()
    if "audit" in normalised:
        return AUDIT_DISCUSSION_PROMPT, "audit_planning"
    if "importer" in normalised:
        return IMPORTER_DISCUSSION_PROMPT, "importer_obligations"
    if "webinar" in normalised and any(term in normalised for term in ("rehearsal", "practice", "run through")):
        return WEBINAR_REHEARSAL_DISCUSSION_PROMPT, "webinar_rehearsal"
    if ("software" in normalised and "technical file" in normalised) or any(
        term in normalised for term in ("software weekly", "software check in", "software review")
    ):
        return SOFTWARE_WEEKLY_DISCUSSION_PROMPT, "software_weekly_review"
    if "technical file" in normalised:
        return TECHNICAL_REVIEW_DISCUSSION_PROMPT, "technical_file_review"
    return DISCUSSION_PROMPT, "general"


def discussion_uses_chunk_candidate_filter(meeting_type: str) -> bool:
    normalised = re.sub(r"[^a-z0-9]+", " ", clean(meeting_type).lower()).strip()
    return normalised == "software and technical file weekly review"


def discussion_uses_two_halves(meeting_type: str) -> bool:
    normalised = re.sub(r"[^a-z0-9]+", " ", clean(meeting_type).lower()).strip()
    return (
        normalised == "workshop"
        or normalised == "technical file review"
    )


def discussion_uses_three_thirds(meeting_type: str) -> bool:
    normalised = re.sub(r"[^a-z0-9]+", " ", clean(meeting_type).lower()).strip()
    return (
        "audit" in normalised
        or "importer" in normalised
        or normalised in ("software weekly review", "general", "project review", "technical file consultancy review")
        or any(term in normalised for term in ("pipeline", "lead generation"))
    )


def clean(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def numbered_turns(transcript: str) -> tuple[list[str], str]:
    turns = [line.strip() for line in transcript.splitlines() if line.strip()]
    return turns, "\n".join(f"[{index}] {line}" for index, line in enumerate(turns, 1))


def validate_trooper_response_format(response_format: dict[str, Any]) -> None:
    """Fail closed if a Trooper call could fall back to prompt-only JSON instructions."""
    format_type = clean(response_format.get("type")) if isinstance(response_format, dict) else ""
    if format_type == "json_object":
        return
    if format_type == "json_schema":
        json_schema = response_format.get("json_schema")
        if (
            isinstance(json_schema, dict)
            and clean(json_schema.get("name"))
            and isinstance(json_schema.get("schema"), dict)
        ):
            return
    raise ValueError("Trooper requests require response_format json_object or a named json_schema")


def call_trooper(prompt: str, max_tokens: int, schema: dict[str, Any]) -> dict[str, Any]:
    key = clean(os.environ.get("TROOPER_API_KEY"))
    if not key:
        raise RuntimeError("TROOPER_API_KEY is not configured")
    validate_trooper_response_format(schema)
    body = json.dumps({
        "model": clean(os.environ.get("TROOPER_MODEL")) or MODEL,
        "messages": [{"role": "system", "content": "Use only transcript evidence. Return valid JSON only."}, {"role": "user", "content": prompt}],
        "temperature": 0.1, "max_tokens": max_tokens, "response_format": schema,
    }).encode()
    last: Exception | None = None
    attempts = 6
    for attempt in range(attempts):
        request = urllib.request.Request(clean(os.environ.get("TROOPER_CHAT_COMPLETIONS_URL")) or URL, data=body,
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"}, method="POST")
        try:
            with TROOPER_INFLIGHT:
                with urllib.request.urlopen(request, timeout=180) as response:
                    payload = json.loads(response.read().decode())
            content = payload.get("choices", [{}])[0].get("message", {}).get("content", "")
            start = content.find("{")
            if start < 0:
                raise RuntimeError("Trooper returned no JSON object")
            return json.JSONDecoder().raw_decode(content[start:])[0]
        except urllib.error.HTTPError as error:
            try:
                error.detail = error.read().decode("utf-8", "replace")[:300]
            except Exception:
                error.detail = ""
            last = error
            json_generation_failed = (
                error.code == 422
                and bool(re.search(r"json_generation_failed|could not produce valid JSON", error.detail, re.I))
                and attempt == 0
            )
            if error.code not in (408, 409, 425, 429, 500, 502, 503, 504) and not json_generation_failed:
                break
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, RuntimeError) as error:
            last = error
        if attempt < attempts - 1:
            time.sleep(min(30.0, 2 ** attempt) + random.uniform(0, 0.5))
    detail = (f"HTTP {last.code} {getattr(last, 'detail', '')}".strip()
              if isinstance(last, urllib.error.HTTPError) else type(last).__name__)
    raise RuntimeError(f"Trooper request failed: {detail}")


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
            output.append({"start": start, "end": end})
            start = end + 1
    output = merge_undersized_chunks(output)
    for number, chunk in enumerate(output, 1):
        chunk["number"] = number
    if not output or output[-1]["end"] != total:
        raise RuntimeError("Could not build contiguous chunk boundaries")
    return output


def alternative_chunkings(chunks: list[dict[str, int]], total: int, sample_count: int) -> list[list[dict[str, int]]]:
    """One chunking per extraction sample, so the samples disagree for structural reasons.

    Three passes over the same sections at temperature 0.1 mostly agree with each other,
    including on the noise. Sample 0 keeps the model's boundaries; sample 1 shifts every
    boundary to the middle of the model's sections, so a request and its acceptance split by
    a boundary sit together; later samples use fixed windows of decreasing size."""
    output = [chunks]
    if sample_count <= 1 or total < 2 * MIN_CHUNK_TURNS:
        return output * sample_count
    if sample_count >= 2:
        midpoints = [(chunk["start"] + chunk["end"]) // 2 for chunk in chunks[:-1]]
        ends = sorted({point for point in midpoints if 1 <= point < total} | {total})
        rows, start = [], 1
        for end in ends:
            rows.append({"start": start, "end": end})
            start = end + 1
        output.append(safe_boundaries(rows, total))
    window = 30
    while len(output) < sample_count:
        rows = [{"start": start, "end": min(total, start + window - 1)} for start in range(1, total + 1, window)]
        output.append(safe_boundaries(rows, total))
        window = max(MIN_CHUNK_TURNS * 2, window - 8)
    return output[:sample_count]


def merge_undersized_chunks(chunks: list[dict[str, int]]) -> list[dict[str, int]]:
    """Fold any section under MIN_CHUNK_TURNS into its smaller neighbour when the result stays
    within MAX_CHUNK_TURNS. A section too small to carry a request and its acceptance yields
    fragments, not actions."""
    chunks = [dict(chunk) for chunk in chunks]
    changed = True
    while changed and len(chunks) > 1:
        changed = False
        for index, chunk in enumerate(chunks):
            if chunk["end"] - chunk["start"] + 1 >= MIN_CHUNK_TURNS:
                continue
            neighbours = [i for i in (index - 1, index + 1) if 0 <= i < len(chunks)]
            neighbours.sort(key=lambda i: chunks[i]["end"] - chunks[i]["start"])
            for other in neighbours:
                merged_size = max(chunk["end"], chunks[other]["end"]) - min(chunk["start"], chunks[other]["start"]) + 1
                if merged_size <= MAX_CHUNK_TURNS:
                    low, high = sorted((index, other))
                    chunks[low] = {"start": chunks[low]["start"], "end": chunks[high]["end"]}
                    del chunks[high]
                    changed = True
                    break
            if changed:
                break
    return chunks


def normalise_actions(result: dict[str, Any], chunk: dict[str, int]) -> list[dict[str, Any]]:
    output = []
    for row in result.get("actionCandidates", []) if isinstance(result.get("actionCandidates"), list) else []:
        if not isinstance(row, dict) or not clean(row.get("action")):
            continue
        evidence_by_role: dict[str, list[str]] = {}
        evidence = []
        for field in ("taskEvidenceTurns", "commitmentEvidenceTurns", "ownerEvidenceTurns", "deadlineEvidenceTurns"):
            values = row.get(field) if isinstance(row.get(field), list) else []
            valid = sorted(set(
                value for value in values
                if isinstance(value, int) and not isinstance(value, bool)
                and chunk["start"] <= value <= chunk["end"]
            ))
            evidence_by_role[field.replace("Turns", "Ids")] = [f"turn_{value}" for value in valid]
            evidence.extend(valid)
        status = clean(row.get("status"))
        action = {
            "owner": clean(row.get("owner")) or "Not stated",
            "action": clean(row.get("action")),
            "deadline": clean(row.get("deadline")) or "Not stated",
            "status": status or "PROPOSED", "evidenceIds": [f"turn_{n}" for n in sorted(set(evidence))],
        }
        action.update(evidence_by_role)
        output.append(action)
    return output


def action_word_count(value: Any) -> int:
    return len(re.findall(r"[\w]+(?:['’.-][\w]+)*", clean(value), flags=re.UNICODE))


AUDIT_GROUNDING_STOP = {
    "the", "and", "for", "with", "from", "into", "that", "this", "those", "these", "before", "after",
    "audit", "auditor", "meeting", "action", "task", "explicit", "decision", "decide", "complete", "prepare",
    "provide", "share", "send", "confirm", "arrange", "review", "look", "work", "make", "ensure", "plan",
}


def audit_candidate_has_lexical_anchor(action: dict[str, Any], turns: list[str]) -> bool:
    """Reject prompt-shaped audit candidates whose cited turns do not mention their object.

    The selector may retrieve a same-topic turn elsewhere in a long audit and accidentally
    validate an invented candidate. Requiring one non-generic object token in the extractor's
    own citations prevents that post-hoc grounding while still allowing later context retrieval.
    """
    action_tokens = {token for token in re.findall(r"[a-z0-9]+", clean(action.get("action")).lower())
                     if len(token) > 2 and token not in AUDIT_GROUNDING_STOP}
    evidence = " ".join(
        turns[number - 1]
        for number in evidence_turn_numbers(action, len(turns))
    ).lower()
    evidence_tokens = {token for token in re.findall(r"[a-z0-9]+", evidence)
                       if len(token) > 2 and token not in AUDIT_GROUNDING_STOP}
    return bool(action_tokens & evidence_tokens)


def transcript_turn_speaker(turn: str) -> str:
    # Teams exports commonly glue the utterance directly to the timestamp
    # (for example ``7:26I will ...``), so a word boundary is not reliable here.
    match = re.match(r"^(.+?)\s+\d{1,2}:\d{2}(?::\d{2})?", clean(turn))
    if match:
        return clean(match.group(1))
    match = re.match(r"^([^:]{2,80}):\s", clean(turn))
    return clean(match.group(1)) if match else ""


def is_importer_obligations_type(meeting_type: str) -> bool:
    value = re.sub(r"[^a-z0-9]+", " ", clean(meeting_type).lower()).strip()
    return "importer" in value and "obligation" in value


def selective_actual_action_profile(meeting_type: str) -> tuple[str, str] | None:
    value = re.sub(r"[^a-z0-9]+", " ", clean(meeting_type).lower()).strip()
    if value == "software and technical file weekly review":
        if hybrid_action_v2_enabled():
            return None
        return HYBRID_TECHNICAL_SELECTOR_GUIDANCE, "hybrid_technical_actual_actions"
    return None


def retrieval_selector_profile(meeting_type: str) -> tuple[str, str] | None:
    value = re.sub(r"[^a-z0-9]+", " ", clean(meeting_type).lower()).strip()
    if value == "decision meeting":
        return DECISION_MEETING_SELECTOR_GUIDANCE, "decision_retrieval_v2"
    profiles = {
        "audit kick off planning": "audit_retrieval",
        "technical file review": "technical_retrieval",
        "webinar rehearsal": "webinar_retrieval",
        "software weekly review": "software_retrieval",
        "process pipeline planning": "process_retrieval",
        "lead generation pipeline review": "process_retrieval",
        "importer obligations review": "importer_retrieval",
    }
    if value == "software and technical file weekly review" and hybrid_action_v2_enabled():
        return HYBRID_RETRIEVAL_V2_GUIDANCE, "hybrid_retrieval_v2"
    if value == "general" and general_action_v2_enabled():
        return GENERAL_RETRIEVAL_V2_GUIDANCE, "general_retrieval_v2"
    if value == "project consultancy check in" and general_action_v2_enabled():
        return PROJECT_CHECKIN_RETRIEVAL_GUIDANCE, "project_checkin_retrieval_v2"
    if technical_file_action_v2_enabled() and value in {
        "technical file review", "technical file consultancy review"
    }:
        return TECHNICAL_FILE_RETRIEVAL_V2_GUIDANCE, "technical_file_retrieval_v2"
    profile = profiles.get(value)
    if profile == "audit_retrieval" and audit_action_v2_enabled():
        return AUDIT_RETRIEVAL_V2_GUIDANCE, "audit_retrieval_v2"
    if profile == "importer_retrieval" and importer_action_v2_enabled():
        return IMPORTER_RETRIEVAL_V2_GUIDANCE, "importer_retrieval_v2"
    if profile == "webinar_retrieval" and webinar_action_v2_enabled():
        return WEBINAR_RETRIEVAL_V2_GUIDANCE, "webinar_retrieval_v2"
    if profile == "process_retrieval" and process_action_v2_enabled():
        return PROCESS_RETRIEVAL_V2_GUIDANCE, "process_retrieval_v2"
    return (RETRIEVAL_PROFILE_GUIDANCE[profile], profile) if profile else None


def load_action_retrieval_backend() -> Any:
    global ACTION_RETRIEVAL_BACKEND
    if ACTION_RETRIEVAL_BACKEND is not None:
        return ACTION_RETRIEVAL_BACKEND
    with ACTION_RETRIEVAL_BACKEND_LOCK:
        if ACTION_RETRIEVAL_BACKEND is not None:
            return ACTION_RETRIEVAL_BACKEND
        try:
            from meeting_minutes_minilm_experiment import MiniLMBackend
            ACTION_RETRIEVAL_BACKEND = MiniLMBackend.load(enabled=True)
        except Exception:
            return None
    return ACTION_RETRIEVAL_BACKEND


def dot_similarity(left: list[float], right: list[float]) -> float:
    return sum(a * b for a, b in zip(left, right))


def drop_completed_actions(actions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The extractor labels finished work COMPLETED so it can be excluded; 9 such rows reached
    reviewers across three measured runs and matched 2 expected actions between them."""
    return [action for action in actions if clean(action.get("status")).upper() != "COMPLETED"]


def normalised_action_key(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", clean(value).lower()).strip()


def dedupe_identical_actions(actions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Adjacent chunks re-extract the same wording; keep the first row and pool the evidence."""
    output: list[dict[str, Any]] = []
    by_key: dict[str, dict[str, Any]] = {}
    for action in actions:
        key = normalised_action_key(action.get("action"))
        existing = by_key.get(key)
        if existing is None:
            by_key[key] = action
            output.append(action)
            continue
        merge_action_evidence(existing, [existing, action])
        if clean(existing.get("owner")) in ("", "Not stated") and clean(action.get("owner")) not in ("", "Not stated"):
            existing["owner"] = action["owner"]
    return output


ACTION_EVIDENCE_FIELDS = (
    "evidenceIds", "taskEvidenceIds", "commitmentEvidenceIds", "ownerEvidenceIds", "deadlineEvidenceIds",
    "selectorEvidenceIds",
)


def merge_action_evidence(target: dict[str, Any], sources: list[dict[str, Any]]) -> None:
    """Pool evidence without losing what each cited turn supports."""
    for field in ACTION_EVIDENCE_FIELDS:
        merged: list[str] = []
        for source in sources:
            values = source.get(field) if isinstance(source.get(field), list) else []
            merged.extend(value for value in values if value not in merged)
        values = target.get(field) if isinstance(target.get(field), list) else []
        merged.extend(value for value in values if value not in merged)
        if merged or field in target or any(field in source for source in sources):
            target[field] = merged
    trace_ids: list[str] = []
    for source in sources:
        for trace_id in source.get("_traceIds", []) if isinstance(source.get("_traceIds"), list) else []:
            if trace_id not in trace_ids:
                trace_ids.append(trace_id)
    for trace_id in target.get("_traceIds", []) if isinstance(target.get("_traceIds"), list) else []:
        if trace_id not in trace_ids:
            trace_ids.append(trace_id)
    if trace_ids:
        target["_traceIds"] = trace_ids


def consolidate_open_world_actions(
    actions: list[dict[str, Any]], turns: list[str], family_fn: Any = None,
    marker: str = "", locality: int = 60,
) -> list[dict[str, Any]]:
    """Deduplicate evidence-grounded actions without defining what a meeting may contain.

    A meeting-type family is only a similarity hint. Unfamiliar deliverables pass through, and
    the representative keeps its extracted wording, owner, deadline and real sample support.
    """
    groups: list[dict[str, Any]] = []
    for action in actions:
        if not evidence_turn_numbers(action, len(turns)):
            continue
        family = clean(family_fn(action)) if family_fn else ""
        turn = first_evidence_turn(action)
        key = normalised_action_key(action.get("action"))
        target = None
        if family:
            for group in groups:
                if group["family"] != family or not owners_compatible(
                    action.get("owner"), group["representative"].get("owner")
                ):
                    continue
                near = turn is not None and group["turn"] is not None and abs(turn - group["turn"]) <= locality
                if near or key == group["key"]:
                    target = group
                    break
        if target is None:
            groups.append({
                "family": family, "key": key, "turn": turn,
                "representative": action, "members": [action],
            })
            continue
        target["members"].append(action)
        if representative_rank(action) > representative_rank(target["representative"]):
            target["representative"] = action

    output: list[dict[str, Any]] = []
    for group in groups:
        members = group["members"]
        representative = dict(group["representative"])
        if len(members) > 1:
            merge_action_evidence(representative, members)
            representative["support"] = max(int(member.get("support", 1) or 1) for member in members)
            representative["sampleCount"] = max(int(member.get("sampleCount", 1) or 1) for member in members)
            representative["mergedCandidateCount"] = sum(
                int(member.get("mergedCandidateCount", 1) or 1) for member in members
            )
            if marker and group["family"]:
                representative[marker] = group["family"]
        output.append(representative)
    return output


def evidence_turn_numbers(action: dict[str, Any], total: int) -> list[int]:
    numbers = set()
    for evidence_id in action.get("evidenceIds", []) if isinstance(action.get("evidenceIds"), list) else []:
        match = re.fullmatch(r"turn_(\d+)", clean(evidence_id))
        if match and 1 <= int(match.group(1)) <= total:
            numbers.add(int(match.group(1)))
    return sorted(numbers)


def action_evidence_context(action: dict[str, Any], turns: list[str], radius: int = 2) -> str:
    numbers: set[int] = set()
    for number in evidence_turn_numbers(action, len(turns)):
        numbers.update(range(max(1, number - radius), min(len(turns), number + radius) + 1))
    return " ".join(turns[number - 1] for number in sorted(numbers))


def owner_supported_by_evidence(action: dict[str, Any], turns: list[str]) -> bool:
    owner = clean(action.get("owner"))
    if not owner or owner.lower() in {"unknown", "not stated", "n/a"}:
        return True
    owner_tokens_value = {
        token for token in re.findall(r"[a-z][a-z'’-]+", owner.lower())
        if len(token) > 2 and token not in {"and", "the"}
    }
    evidence_ids = action.get("ownerEvidenceIds") or action.get("taskEvidenceIds") or action.get("evidenceIds") or []
    for evidence_id in evidence_ids:
        match = re.fullmatch(r"turn_(\d+)", clean(evidence_id))
        if not match or not 1 <= int(match.group(1)) <= len(turns):
            continue
        turn = turns[int(match.group(1)) - 1]
        speaker = transcript_turn_speaker(turn)
        speaker_tokens = set(re.findall(r"[a-z][a-z'’-]+", speaker.lower()))
        utterance = re.sub(
            r"^(?:.+?\s+\d{1,2}:\d{2}(?::\d{2})?|[^:]{2,80}:)\s*", "", clean(turn)
        ) if speaker else clean(turn)
        if owner_tokens_value and owner_tokens_value <= speaker_tokens:
            first_person_commitment = re.search(
                r"\b(?:i['’]?ll|i will|i can|i['’]?m going to|we['’]?ll|we will)\b", utterance, re.I
            )
            # A speaker issuing a second-person or bare-imperative instruction is the assigner,
            # not evidence that the speaker owns the task.
            directive = re.match(
                r"^(?:when you(?:'re| are)\b|(?:please\s+)?(?:send|share|review|check|write|"
                r"prepare|print|fix|update|add|book|schedule|arrange|confirm|find|investigate|"
                r"trace|run|re-?run|test|decide|provide|forward|complete|finalise)\b)",
                utterance, re.I,
            )
            if directive and not first_person_commitment:
                continue
            if re.match(r"^(?:so\b|one (?:action )?is\b|the action is\b|can i\b|am i\b|and the last\b|we said\b)", utterance, re.I) \
                    and not first_person_commitment:
                continue
            return True
        utterance_tokens = set(re.findall(r"[a-z][a-z'’-]+", utterance.lower()))
        if owner_tokens_value and owner_tokens_value <= utterance_tokens and re.search(
            r"\b(?:will|is going to|needs? to|has to|to (?:do|write|send|review|fix|prepare|check)|can you|could you)\b",
            utterance, re.I,
        ):
            return True
    return False


def ground_action_attributions(actions: list[dict[str, Any]], turns: list[str]) -> list[dict[str, Any]]:
    """Blank unsupported owners/deadlines and remove non-standalone action fragments."""
    output: list[dict[str, Any]] = []
    unresolved = re.compile(
        # Do not reject a complete diagnostic choice such as "whether the protocols are blocked
        # by something substantive or by available time" merely because it contains "something".
        # Reject only wording whose task object or addressee is still an unresolved reference.
        r"\b(?:presumably|implied|someone)\b|\[[^]]+\]|"
        r"\b(?:ask|contact|email|send|share|give|tell|follow up with) (?:him|her)\b|"
        r"\b(?:get|obtain|send|review|fix|update|share|provide) it\b",
        re.I,
    )
    vague = re.compile(
        r"^(?:make progress\b|wait for\b|come back\b.*\bbest idea\b|deal with\b|"
        r"provide any other updates?\b|know the outcome\b|confirm happiness\b|acknowledge fault\b|"
        r"do not (?:send|write|produce) (?:the )?minutes\b|prepare for (?:the )?.*\bmeeting\b)",
        re.I,
    )
    for source in actions:
        action = dict(source)
        wording = clean(action.get("action"))
        if unresolved.search(wording) or vague.search(wording):
            continue
        context = action_evidence_context(action, turns)
        owner = clean(action.get("owner"))
        if owner.lower() in {"all", "everyone", "team", "the team"}:
            action["owner"] = "Not stated"
        elif not owner_supported_by_evidence(action, turns):
            action["owner"] = "Not stated"
        deadline = clean(action.get("deadline"))
        if deadline.lower() not in {"", "unknown", "not stated", "n/a", "none"} \
                and not action.get("deadlineEvidenceIds"):
            deadline_tokens = {
                token for token in re.findall(r"[a-z0-9]+", deadline.lower())
                if len(token) > 2 or token.isdigit()
            }
            context_tokens = set(re.findall(r"[a-z0-9]+", context.lower()))
            if deadline_tokens and not deadline_tokens & context_tokens:
                action["deadline"] = "Not stated"
        output.append(action)
    return output


def repair_short_actions(actions: list[dict[str, Any]], turns: list[str]) -> list[dict[str, Any]]:
    """Rewrite bare-verb candidates from their cited turns instead of letting the word gate drop them.

    Long audit transcripts can yield fragments such as "send" or "build out" for otherwise valid
    document and scope commitments. Both would be deleted by the four-word gate. Fail-open: on any
    error the originals are returned and the gate behaves as before."""
    short = [(index, action) for index, action in enumerate(actions)
             if action_word_count(action.get("action")) < MINIMUM_ACTION_WORDS and evidence_turn_numbers(action, len(turns))]
    if not short:
        return actions
    fragments = []
    for number, (_index, action) in enumerate(short, 1):
        cited = "\n".join(f"  Turn {turn}: {turns[turn - 1]}" for turn in evidence_turn_numbers(action, len(turns))[:6])
        fragments.append(f"{number}. Owner: {action.get('owner', 'Not stated')}\nFragment: {action.get('action', '')}\nCited turns:\n{cited}")
    repaired: dict[int, str] = {}
    try:
        for start in range(0, len(fragments), 12):
            batch = fragments[start:start + 12]
            result = call_trooper(SHORT_ACTION_REPAIR_PROMPT.format(fragments="\n\n".join(batch)), 1500, SHORT_ACTION_REPAIR_SCHEMA)
            for row in result.get("repairs", []) if isinstance(result.get("repairs"), list) else []:
                number = row.get("candidateNumber") if isinstance(row, dict) else None
                if isinstance(number, int) and start + 1 <= number <= start + len(batch):
                    repaired[number] = clean(row.get("action"))
    except Exception:
        return actions
    output = list(actions)
    for number, (index, action) in enumerate(short, 1):
        wording = repaired.get(number, "")
        if action_word_count(wording) >= MINIMUM_ACTION_WORDS:
            output[index] = {**action, "action": wording, "repairedFrom": action.get("action")}
        else:
            output[index] = {**action, "action": ""}  # nothing supported: leave for the gate
    return [action for action in output if clean(action.get("action"))]


def action_sample_count() -> int:
    """Independent extraction samples per meeting. Three, each over a different chunking, is
    the measured configuration (see docs/staged-actions-live-path-2026-09-06.md);
    STAGED_ACTION_SAMPLES=1 restores single-pass extraction with every row in tier 1."""
    try:
        return max(1, int(os.environ.get("STAGED_ACTION_SAMPLES", "3")))
    except ValueError:
        return 3


def owner_tokens(value: Any) -> set[str]:
    tokens = {token for token in re.findall(r"[a-z]+", clean(value).lower()) if len(token) > 1}
    return tokens - {"not", "stated", "and", "team", "the", "mr", "mrs", "ms", "dr"}


def owners_compatible(left: Any, right: Any) -> bool:
    """Unstated owners are compatible with anyone; stated owners must share a name token."""
    left_tokens, right_tokens = owner_tokens(left), owner_tokens(right)
    if not left_tokens or not right_tokens:
        return True
    return bool(left_tokens & right_tokens)


def action_vectors(actions: list[dict[str, Any]], backend: Any) -> list[list[float] | None]:
    if not backend or not getattr(backend, "available", False):
        return [None] * len(actions)
    texts = [clean(action.get("action")) for action in actions]
    try:
        embeddings = backend.encode_many(texts)
    except Exception:
        return [None] * len(actions)
    output = []
    for text in texts:
        key = re.sub(r"\s+", " ", text).strip()
        output.append(embeddings.get(key) or embeddings.get(text) or embeddings.get(key.lower()))
    return output


def merge_sampled_actions(actions: list[dict[str, Any]], sample_count: int, backend: Any = None,
                          threshold: float = SUPPORT_MERGE_THRESHOLD) -> list[dict[str, Any]]:
    """Fold repeated extraction samples into one row per deliverable with a support count.

    Each row carries the sample it came from. Rows join an existing group when their wording is
    identical after normalisation, or when the embeddings agree at SUPPORT_MERGE_THRESHOLD and the
    owners do not disagree. Without MiniLM only identical wording merges, so support is
    understated rather than invented."""
    vectors = action_vectors(actions, backend)
    groups: list[dict[str, Any]] = []
    for action, vector in zip(actions, vectors):
        key = normalised_action_key(action.get("action"))
        target = None
        for group in groups:
            if group["key"] == key:
                target = group
                break
            if vector is not None and group["vector"] is not None and dot_similarity(vector, group["vector"]) >= threshold \
                    and owners_compatible(action.get("owner"), group["representative"].get("owner")):
                target = group
                break
        if target is None:
            groups.append({"key": key, "vector": vector, "representative": action, "members": [action]})
            continue
        target["members"].append(action)
        if representative_rank(action) > representative_rank(target["representative"]):
            target["representative"] = action
    output = []
    for group in groups:
        representative = dict(group["representative"])
        merge_action_evidence(representative, group["members"])
        representative["support"] = len({member.get("sample", 0) for member in group["members"]})
        representative["sampleCount"] = sample_count
        representative["mergedCandidateCount"] = len(group["members"])
        representative.pop("sample", None)
        output.append(representative)
    return output


def representative_rank(action: dict[str, Any]) -> tuple[int, int, int, int]:
    owner_stated = int(clean(action.get("owner")) not in ("", "Not stated"))
    return (owner_stated, STATUS_RANK.get(clean(action.get("status")).upper(), 0),
            len(action.get("evidenceIds", []) or []), action_word_count(action.get("action")))


def assign_action_tiers(actions: list[dict[str, Any]], sample_count: int) -> list[dict[str, Any]]:
    """Tier 1 is the actions table: a row most samples agreed on. Tier 2 is the collapsed
    "raised" panel: a minority row whose extraction includes direct commitment or assignment
    evidence. A one-sample task fragment without that evidence is tier 3 and is not returned,
    regardless of the model's status label; labels alone previously promoted discussion and
    ordinary requirements into reviewer-facing actions."""
    output = []
    for action in actions:
        support = int(action.get("support", 1) or 1)
        if sample_count <= 1 or support * 2 >= sample_count + 1:
            action["tier"] = 1
        elif action.get("commitmentEvidenceIds"):
            action["tier"] = 2
        else:
            action["tier"] = 3
        if action["tier"] < 3 or os.environ.get("STAGED_ACTION_KEEP_TIER3") == "1":
            output.append(action)
    return output


VERB_FAMILIES = [{"SEND", "SHARE"}, {"REVIEW", "INVESTIGATE", "CONFIRM"}, {"ARRANGE", "ATTEND"}, {"UPDATE", "PREPARE"}]


def verbs_compatible(left: str, right: str) -> bool:
    left, right = clean(left).upper(), clean(right).upper()
    if not left or not right or left == right:
        return True
    return any(left in family and right in family for family in VERB_FAMILIES)


def structure_action_deliverables(actions: list[dict[str, Any]]) -> dict[int, dict[str, str]]:
    """Ask for the deliverable noun phrase, verb class and recipient of every candidate.

    Free-text action sentences embed poorly for identity ("Have a catch-up before Monday" and
    "Schedule a meeting at the hotel" sit at 0.66); the deliverable phrase is what two drafts of
    the same commitment share. Fail-open: returns {} when the call fails, and callers then skip
    the merge."""
    output: dict[int, dict[str, str]] = {}
    for start in range(0, len(actions), 20):
        batch = actions[start:start + 20]
        blocks = "\n".join(f"{start + index}. Owner: {row.get('owner', 'Not stated')} | {clean(row.get('action'))}"
                            for index, row in enumerate(batch, 1))
        try:
            result = call_trooper(DELIVERABLE_PROMPT.format(candidates=blocks), 2500, DELIVERABLE_SCHEMA)
        except Exception:
            return {}
        for row in result.get("deliverables", []) if isinstance(result.get("deliverables"), list) else []:
            number = row.get("candidateNumber") if isinstance(row, dict) else None
            if isinstance(number, int) and start + 1 <= number <= start + len(batch) and clean(row.get("deliverable")):
                output[number] = {"deliverable": clean(row.get("deliverable")), "verb": clean(row.get("verb")).upper(),
                                  "recipient": clean(row.get("recipient"))}
    return output


def first_evidence_turn(action: dict[str, Any]) -> int | None:
    numbers = [int(match.group(1)) for evidence_id in action.get("evidenceIds", []) or []
               if (match := re.fullmatch(r"turn_(\d+)", clean(evidence_id)))]
    return min(numbers) if numbers else None


def merge_by_deliverable(actions: list[dict[str, Any]], structured: dict[int, dict[str, str]], backend: Any,
                         threshold: float = 0.80, far_threshold: float = 0.90, locality: int = 60,
                         preserve_structure: bool = False) -> list[dict[str, Any]]:
    """Fold candidates that name the same deliverable for compatible owners with compatible verbs.

    Nearby candidates (within `locality` turns) merge at `threshold`; candidates from different
    parts of the meeting need the stronger `far_threshold`, because the same phrase can be a
    different deliverable an hour later. Without structure or MiniLM nothing merges."""
    if not structured or not backend or not getattr(backend, "available", False):
        return actions
    phrases = [structured.get(number, {}).get("deliverable", "") for number in range(1, len(actions) + 1)]
    try:
        embeddings = backend.encode_many([phrase for phrase in phrases if phrase])
    except Exception:
        return actions
    def vector(phrase: str) -> list[float] | None:
        key = re.sub(r"\s+", " ", phrase).strip()
        return embeddings.get(key) or embeddings.get(phrase) or embeddings.get(key.lower())
    groups: list[dict[str, Any]] = []
    for number, source in enumerate(actions, 1):
        info = structured.get(number, {})
        action = dict(source)
        if preserve_structure and info.get("deliverable"):
            action["_deliverable"] = info["deliverable"]
            action["_deliverableVerb"] = info.get("verb", "")
            action["_deliverableRecipient"] = info.get("recipient", "")
        vec = vector(info.get("deliverable", "")) if info.get("deliverable") else None
        turn = first_evidence_turn(action)
        target = None
        if vec is not None:
            for group in groups:
                if group["vector"] is None or not verbs_compatible(info.get("verb", ""), group["verb"]):
                    continue
                if not owners_compatible(action.get("owner"), group["representative"].get("owner")):
                    continue
                similarity = dot_similarity(vec, group["vector"])
                near = turn is not None and group["turn"] is not None and abs(turn - group["turn"]) <= locality
                if similarity >= (threshold if near else far_threshold):
                    target = group
                    break
        if target is None:
            groups.append({"vector": vec, "verb": info.get("verb", ""), "turn": turn,
                           "representative": action, "members": [action]})
            continue
        target["members"].append(action)
        if representative_rank(action) > representative_rank(target["representative"]):
            target["representative"] = action
    output = []
    for group in groups:
        representative = dict(group["representative"])
        if len(group["members"]) > 1:
            merge_action_evidence(representative, group["members"])
            representative["support"] = max(int(member.get("support", 1) or 1) for member in group["members"])
            representative["mergedCandidateCount"] = sum(int(member.get("mergedCandidateCount", 1) or 1) for member in group["members"])
            representative["mergedFrom"] = [clean(member.get("action")) for member in group["members"] if member is not group["representative"]]
        output.append(representative)
    return output


def action_has_recall_protection(action: dict[str, Any], evidence: list[str]) -> bool:
    if clean(action.get("status")).upper() not in {"COMMITTED", "ASSIGNED", "REQUIRED"}:
        return False
    joined = " ".join(evidence)
    # First-person commitments, explicit assignments and dated promises only. "need to",
    # "must", "please" and "required" describe how things are done at least as often as they
    # create a task, and protecting them kept process description on the screen.
    return bool(re.search(
        r"\b(?:i['’]?ll|i will|i can|we['’]?ll|we will|you(?:['’]ll| will)|"
        r"can you|could you|will you|agreed|assigned|action(?:ed)?|"
        r"by (?:monday|tuesday|wednesday|thursday|friday|tomorrow|next week))\b", joined, re.I))


SELECTOR_BATCH_CHARS = 9500
SELECTOR_BATCH_ITEMS = 8
SELECTOR_TURN_CHARS = 360
VALIDATED_RETRIEVAL_PROFILES = {
    "audit_retrieval_v2", "importer_retrieval_v2", "hybrid_retrieval_v2",
    "webinar_retrieval_v2", "process_retrieval_v2", "technical_file_retrieval_v2",
    "general_retrieval_v2", "project_checkin_retrieval_v2", "software_retrieval",
    "decision_retrieval_v2",
}
SELECTOR_REJECTION_CODES = {
    "COMPLETED_ONLY", "UNACCEPTED_PROPOSAL", "DISCUSSION_ONLY", "MEETING_ADMIN", "MALFORMED",
    "NO_SUPPORTED_TASK",
}


def normalise_retrieval_decision(row: Any, local_numbers: set[int]) -> dict[str, Any] | None:
    """Trooper can return JSON that violates its requested schema; enforce it locally."""
    if not isinstance(row, dict) or row.get("candidateNumber") not in local_numbers:
        return None
    decision = row.get("decision")
    code = row.get("rejectionCode")
    evidence = row.get("evidenceTurns")
    if not isinstance(evidence, list) or not all(
        isinstance(value, int) and not isinstance(value, bool) for value in evidence
    ) or not evidence:
        return None
    if decision == "KEEP" and code != "NONE":
        return None
    if decision == "REMOVE" and code not in SELECTOR_REJECTION_CODES:
        return None
    if decision not in {"KEEP", "REMOVE"}:
        return None
    return {
        "candidateNumber": row["candidateNumber"], "decision": decision,
        "rejectionCode": code, "evidenceTurns": evidence,
    }


def selector_batches(blocks: list[tuple[int, str]]) -> list[list[tuple[int, str]]]:
    """Bound both candidates and evidence so schema output fits in the model context window."""
    batches: list[list[tuple[int, str]]] = []
    current: list[tuple[int, str]] = []
    size = 0
    for block in blocks:
        if current and (len(current) >= SELECTOR_BATCH_ITEMS
                        or size + len(block[1]) > SELECTOR_BATCH_CHARS):
            batches.append(current)
            current, size = [], 0
        current.append(block)
        size += len(block[1])
    if current:
        batches.append(current)
    return batches


def retrieval_decisions(blocks: list[tuple[int, str]], guidance: str) -> dict[int, dict[str, Any]] | None:
    decisions: dict[int, dict[str, Any]] = {}
    for batch in selector_batches(blocks):
        expected = {number for number, _ in batch}
        by_number = dict(batch)
        returned: dict[int, dict[str, Any]] = {}
        last_error = ""
        for attempt in range(4):
            remaining = expected - set(returned)
            global_numbers = sorted(remaining)
            local_to_global = {local: number for local, number in enumerate(global_numbers, 1)}
            request_blocks = [
                re.sub(r"^\d+\.", f"{local}.", by_number[number], count=1)
                for local, number in local_to_global.items()
            ]
            try:
                result = call_trooper(RETRIEVAL_SELECTOR_PROMPT.format(
                    guidance=guidance, candidates="\n\n".join(request_blocks)),
                    1600, RETRIEVAL_SELECTOR_SCHEMA)
                last_error = ""
            except Exception as error:
                result = {}
                last_error = clean(error)
            candidate_rows = {}
            for row in result.get("decisions", []):
                normalised = normalise_retrieval_decision(row, set(local_to_global))
                if normalised is None:
                    continue
                global_number = local_to_global[normalised["candidateNumber"]]
                candidate_rows[global_number] = {**normalised, "candidateNumber": global_number}
            returned.update(candidate_rows)
            if set(returned) == expected:
                break
            if attempt < 3:
                time.sleep(0.25 + random.uniform(0, 0.25))
        if set(returned) != expected:
            missing = ",".join(str(number) for number in sorted(expected - set(returned)))
            detail = f" ({last_error})" if last_error else ""
            raise RuntimeError(f"Selector batch omitted candidate numbers: {missing}{detail}")
        decisions.update(returned)
    return decisions


def select_retrieval_grounded_actions(actions: list[dict[str, Any]], turns: list[str], guidance: str,
                                      backend: Any = None, profile: str = "") -> list[dict[str, Any]]:
    """Fail-open selector; validated profiles require two positive, locally grounded checks."""
    eligible = [action for action in actions if action_word_count(action.get("action")) >= 4]
    lexical_anchor_profiles = VALIDATED_RETRIEVAL_PROFILES
    strict_consensus = profile in VALIDATED_RETRIEVAL_PROFILES
    if profile == "decision_retrieval_v2":
        eligible = [action for action in eligible if action.get("commitmentEvidenceIds")]
    if profile in lexical_anchor_profiles:
        eligible = [action for action in eligible if audit_candidate_has_lexical_anchor(action, turns)]
    if not eligible:
        return []
    backend = backend or load_action_retrieval_backend()
    if not backend or not getattr(backend, "available", False):
        return eligible
    texts = [*turns, *[clean(action.get("action")) for action in eligible]]
    embeddings = backend.encode_many(texts)
    def vector(text: str) -> list[float] | None:
        value = re.sub(r"\s+", " ", clean(text)).strip()
        return embeddings.get(value)
    turn_vectors = [vector(turn) for turn in turns]
    blocks: list[tuple[int, str]] = []
    allowed_evidence: dict[int, set[int]] = {}
    protected: set[int] = set()
    for number, action in enumerate(eligible, 1):
        original_numbers = {int(match.group(1)) for evidence_id in action.get("evidenceIds", [])
                            if (match := re.fullmatch(r"turn_(\d+)", clean(evidence_id)))
                            and 1 <= int(match.group(1)) <= len(turns)}
        evidence_numbers = set(original_numbers)
        if strict_consensus:
            # The lexical-anchor gate above prevents post-hoc grounding of an invented object.
            # Immediate context resolves requests and addressees.
            context_radius = 2
            for turn_number in original_numbers:
                evidence_numbers.update(range(
                    max(1, turn_number - context_radius),
                    min(len(turns), turn_number + context_radius) + 1,
                ))
        query = vector(clean(action.get("action")))
        ranked = [] if query is None or strict_consensus else sorted(
            ((dot_similarity(query, candidate), index + 1) for index, candidate in enumerate(turn_vectors) if candidate is not None),
            reverse=True)
        semantic_numbers = []
        # Domain nouns recur throughout structured reviews. A remotely retrieved same-topic turn
        # can make completed status, ordinary logistics or an unsupported owner look like a current
        # commitment. Specialised profiles therefore use citations and immediate dialogue only;
        # the fallback profile retains bounded retrieval for genuinely scattered hand-offs.
        semantic_limit = 0 if strict_consensus else 4
        for _score, turn_number in ranked:
            if any(abs(turn_number - prior) <= 1 for prior in semantic_numbers):
                continue
            semantic_numbers.append(turn_number)
            if len(semantic_numbers) >= semantic_limit:
                break
        for turn_number in semantic_numbers:
            evidence_numbers.update(range(max(1, turn_number - 1), min(len(turns), turn_number + 1) + 1))
        evidence = [turns[index - 1] for index in sorted(evidence_numbers)]
        allowed_evidence[number] = evidence_numbers
        # Audit v2 deliberately lets the two evidence-grounded checks judge every row. Generic
        # first-person/date protection otherwise preserves travel, attendance and prior-audit
        # history simply because those statements happen to contain "we will" or a weekday.
        if not strict_consensus and action_has_recall_protection(
            action, [turns[index - 1] for index in sorted(original_numbers)]
        ):
            protected.add(number)
        lines = "\n".join(f"  Turn {index}: {turns[index - 1][:SELECTOR_TURN_CHARS]}" for index in sorted(evidence_numbers))
        blocks.append((number, f"{number}. Owner: {action.get('owner', 'Not stated')}\n"
            f"Draft: {action.get('action', '')}\nStatus: {action.get('status', '')}\nEvidence:\n{lines}"))
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            first_future = pool.submit(retrieval_decisions, blocks, guidance)
            second_future = pool.submit(retrieval_decisions, list(reversed(blocks)), guidance)
            first, second = first_future.result(), second_future.result()
    except Exception:
        if strict_consensus:
            raise
        return eligible
    valid_codes = {"COMPLETED_ONLY", "UNACCEPTED_PROPOSAL", "DISCUSSION_ONLY", "MEETING_ADMIN", "MALFORMED", "NO_SUPPORTED_TASK"}
    selected: list[dict[str, Any]] = []
    for number in range(1, len(eligible) + 1):
        left, right = first[number], second[number]
        eligible[number - 1]["_selectorChecks"] = [
            {key: decision.get(key) for key in ("decision", "rejectionCode", "evidenceTurns")}
            for decision in (left, right)
        ]
        if number in protected:
            selected.append(eligible[number - 1])
            continue
        left_evidence = {
            value for value in left.get("evidenceTurns", [])
            if isinstance(value, int) and not isinstance(value, bool)
            and value in allowed_evidence[number]
        }
        right_evidence = {
            value for value in right.get("evidenceTurns", [])
            if isinstance(value, int) and not isinstance(value, bool)
            and value in allowed_evidence[number]
        }
        if strict_consensus:
            # Publication is a positive decision, not the absence of a unanimous veto. Each
            # independently ordered pass must affirm the action from evidence supplied for it.
            if (
                left.get("decision") == right.get("decision") == "KEEP"
                and left.get("rejectionCode") == right.get("rejectionCode") == "NONE"
                and left_evidence and right_evidence
            ):
                action = dict(eligible[number - 1])
                action["selectorEvidenceIds"] = [
                    f"turn_{turn_number}" for turn_number in sorted(left_evidence | right_evidence)
                ]
                selected.append(action)
            continue
        # The rejection codes overlap (DISCUSSION_ONLY, NO_SUPPORTED_TASK and UNACCEPTED_PROPOSAL
        # describe the same rows), so requiring the same code made removal a matter of luck.
        if (left.get("decision") == right.get("decision") == "REMOVE"
                and left.get("rejectionCode") in valid_codes and right.get("rejectionCode") in valid_codes
                and left_evidence and right_evidence):
            continue
        selected.append(eligible[number - 1])
    return selected


def select_actual_actions(actions: list[dict[str, Any]], turns: list[str], guidance: str) -> list[dict[str, Any]]:
    """Apply the four-word gate and the narrowly routed conservative selector."""
    eligible = [action for action in actions if action_word_count(action.get("action")) >= 4]
    blocks = []
    for number, action in enumerate(eligible, 1):
        evidence = []
        for evidence_id in action.get("evidenceIds", []):
            match = re.fullmatch(r"turn_(\d+)", clean(evidence_id))
            if match and 1 <= int(match.group(1)) <= len(turns):
                evidence.append(turns[int(match.group(1)) - 1])
        blocks.append(
            f"{number}. Owner: {action.get('owner', 'Not stated')}\n"
            f"Draft: {action.get('action', '')}\n"
            f"Status: {action.get('status', '')}\n"
            f"Evidence: {' '.join(evidence)}"
        )
    if not eligible:
        return []
    result = call_trooper(SELECTIVE_ACTUAL_ACTIONS_PROMPT.format(
        guidance=guidance, candidates="\n\n".join(blocks)), 2200, ACTUAL_ACTIONS_SCHEMA)
    selected = {number for number in result.get("candidateNumbers", [])
                if isinstance(number, int) and not isinstance(number, bool) and 1 <= number <= len(eligible)}
    return [action for number, action in enumerate(eligible, 1) if number in selected]


def importer_action_content_tokens(value: Any) -> set[str]:
    ignored = {
        "a", "an", "and", "all", "additional", "better", "for", "from", "full", "general", "in", "information", "of", "on", "the", "to", "with",
        "arrange", "ask", "check", "clarify", "confirm", "elaborate", "email", "follow", "provide", "review", "send", "update",
    }
    return {token for token in re.findall(r"[a-z0-9]+(?:-[a-z0-9]+)*", clean(value).lower()) if token not in ignored}


def filter_importer_selected_actions(actions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Remove generic-object rows and retain the more specific of contained duplicates."""
    generic_objects = {"clarity", "detail", "details", "issue", "issues", "point", "points", "question", "questions", "thing", "things"}
    useful = []
    for action in actions:
        tokens = importer_action_content_tokens(action.get("action"))
        if not tokens or tokens <= generic_objects:
            continue
        useful.append(action)

    removed: set[int] = set()
    for left_index, left in enumerate(useful):
        if left_index in removed:
            continue
        left_tokens = importer_action_content_tokens(left.get("action"))
        left_verb = clean(left.get("action")).split(" ", 1)[0].lower()
        for right_index in range(left_index + 1, len(useful)):
            if right_index in removed:
                continue
            right = useful[right_index]
            right_tokens = importer_action_content_tokens(right.get("action"))
            right_verb = clean(right.get("action")).split(" ", 1)[0].lower()
            if left_verb != right_verb or not left_tokens or not right_tokens:
                continue
            smaller, larger = (left_tokens, right_tokens) if len(left_tokens) <= len(right_tokens) else (right_tokens, left_tokens)
            if len(smaller & larger) / len(smaller) < 0.8:
                continue
            left_score = (len(left_tokens), action_word_count(left.get("action")))
            right_score = (len(right_tokens), action_word_count(right.get("action")))
            removed.add(left_index if left_score < right_score else right_index)
            if left_index in removed:
                break
    return [action for index, action in enumerate(useful) if index not in removed]


def select_importer_actual_actions(actions: list[dict[str, Any]], turns: list[str]) -> list[dict[str, Any]]:
    """Apply the four-word gate, then one simple evidence-backed publication selection."""
    eligible = [action for action in actions if action_word_count(action.get("action")) >= 4]
    blocks = []
    for number, action in enumerate(eligible, 1):
        evidence = []
        for evidence_id in action.get("evidenceIds", []):
            match = re.fullmatch(r"turn_(\d+)", clean(evidence_id))
            if match and 1 <= int(match.group(1)) <= len(turns):
                turn = int(match.group(1))
                evidence.append(turns[turn - 1])
        blocks.append(f"{number}. {action.get('owner', 'Not stated')} — {action.get('action', '')}\n"
                      f"Evidence: {' '.join(evidence)}")
    if not eligible:
        return []
    result = call_trooper(IMPORTER_ACTUAL_ACTIONS_PROMPT.format(candidates="\n\n".join(blocks)),
                          1200, ACTUAL_ACTIONS_SCHEMA)
    selected = {number for number in result.get("candidateNumbers", [])[:15]
                if isinstance(number, int) and not isinstance(number, bool) and 1 <= number <= len(eligible)}
    chosen = [action for number, action in enumerate(eligible, 1) if number in selected]
    return filter_importer_selected_actions(chosen)


def normalise_discussion_candidates(result: dict[str, Any], chunk: dict[str, int]) -> list[dict[str, Any]]:
    output = []
    rows = result.get("candidates") if isinstance(result.get("candidates"), list) else []
    for row in rows:
        if not isinstance(row, dict):
            continue
        workstream, state = clean(row.get("workstream")), clean(row.get("state"))
        if not workstream or not state:
            continue
        evidence = row.get("evidenceTurns") if isinstance(row.get("evidenceTurns"), list) else []
        evidence = sorted({turn for turn in evidence
                           if isinstance(turn, int) and not isinstance(turn, bool)
                           and chunk["start"] <= turn <= chunk["end"]})
        if not evidence:
            continue
        output.append({"workstream": workstream, "state": state, "evidenceTurns": evidence,
                       "chunk": chunk["number"]})
    return output


def discussion_from_candidates(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    discussion: list[dict[str, Any]] = []
    topics: dict[str, dict[str, Any]] = {}
    seen_states: set[str] = set()
    for candidate in candidates:
        state_key = clean(candidate.get("state")).casefold()
        if not state_key or state_key in seen_states:
            continue
        seen_states.add(state_key)
        topic = clean(candidate.get("workstream"))
        topic_key = topic.casefold()
        if topic_key not in topics:
            row = {"topic": topic, "points": []}
            topics[topic_key] = row
            discussion.append(row)
        topics[topic_key]["points"].append(clean(candidate.get("state")))
    return discussion


def run_actions_stage(turns: list[str], numbered: str, meeting_type: str) -> dict[str, Any]:
    """The live actions stage: boundary chunking, high-recall extraction, type-routed selection.

    Shared by the CLI (main) and the offline live-path harness so both measure the same code."""
    diagnostics_enabled = os.environ.get("STAGED_ACTION_DIAGNOSTICS", "0") == "1"
    diagnostic_sources: dict[str, dict[str, Any]] = {}
    diagnostic_stages: dict[str, list[str]] = {}
    diagnostic_counts: dict[str, int] = {}

    def record_stage(stage: str, rows: list[dict[str, Any]]) -> None:
        if not diagnostics_enabled:
            return
        diagnostic_counts[stage] = len(rows)
        for row in rows:
            for trace_id in row.get("_traceIds", []):
                diagnostic_stages.setdefault(trace_id, []).append(stage)
                source = diagnostic_sources.setdefault(trace_id, {})
                if clean(row.get("_deliverable")):
                    source["deliverable"] = clean(row.get("_deliverable"))
                    source["deliverableVerb"] = clean(row.get("_deliverableVerb"))
                    source["deliverableRecipient"] = clean(row.get("_deliverableRecipient"))

    minimum = max(1, math.ceil(len(turns) / MAX_CHUNK_TURNS))
    maximum = max(minimum, math.ceil(len(turns) / 15))
    boundary_result = call_trooper(BOUNDARY_PROMPT.format(total=len(turns), minimum=minimum, maximum=maximum, numbered=numbered), 1400, BOUNDARY_SCHEMA)
    chunks = safe_boundaries(boundary_result.get("chunks"), len(turns))
    lines = numbered.splitlines()
    action_prompt, prompt_profile = action_prompt_for_meeting_type(meeting_type)
    sample_count = action_sample_count()
    def analyse(job: tuple[dict[str, int], int]) -> list[dict[str, Any]]:
        chunk, sample = job
        prompt = action_prompt.format(numbered_chunk="\n".join(lines[chunk["start"] - 1:chunk["end"]]))
        rows = normalise_actions(call_trooper(prompt, 1800, ACTION_SCHEMA), chunk)
        for row in rows:
            row["sample"] = sample
        return rows
    chunkings = alternative_chunkings(chunks, len(turns), sample_count)
    jobs = [(chunk, sample) for sample, sample_chunks in enumerate(chunkings) for chunk in sample_chunks]
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(4 if sample_count == 1 else 6, len(jobs))) as pool:
        results = list(pool.map(analyse, jobs))
    actions = [action for group in results for action in group]
    if diagnostics_enabled:
        for index, action in enumerate(actions, 1):
            trace_id = f"candidate_{index}"
            action["_traceIds"] = [trace_id]
            diagnostic_sources[trace_id] = {
                key: action.get(key) for key in (
                    "action", "owner", "deadline", "status", "evidenceIds", "taskEvidenceIds",
                    "commitmentEvidenceIds", "ownerEvidenceIds", "deadlineEvidenceIds", "sample",
                )
            }
    record_stage("extracted", actions)
    actions = drop_completed_actions(actions)
    record_stage("not_completed", actions)
    actions = repair_short_actions(actions, turns)
    record_stage("standalone", actions)
    if sample_count > 1:
        support_threshold = (0.64 if prompt_profile in {"audit_planning_v2", "importer_obligations_v2", "hybrid_technical_v2", "webinar_rehearsal_v2", "process_pipeline_v2", "technical_file_v2", "general_v2"}
                             else SUPPORT_MERGE_THRESHOLD)
        actions = merge_sampled_actions(
            actions, sample_count, load_action_retrieval_backend(), threshold=support_threshold
        )
    else:
        for action in actions:
            action.pop("sample", None)
        actions = dedupe_identical_actions(actions)
    record_stage("sample_consolidated", actions)
    candidate_count = len(actions)
    open_world_merge_profiles = {
        "audit_planning_v2", "importer_obligations_v2", "hybrid_technical_v2",
        "webinar_rehearsal_v2", "process_pipeline_v2", "technical_file_v2",
        "general_v2", "project_checkin_v2", "software_weekly_review",
    }
    if len(actions) > 1 and (
        prompt_profile in open_world_merge_profiles
        or os.environ.get("STAGED_ACTION_DELIVERABLE_MERGE", "0") == "1"
    ):
        actions = merge_by_deliverable(
            actions, structure_action_deliverables(actions), load_action_retrieval_backend(),
            threshold=0.84, far_threshold=0.92, preserve_structure=True,
        )
    record_stage("deliverable_consolidated", actions)
    # The importer-only selector kept 8 rows of 49 and discarded 3 of the 6 candidates that
    # matched the reviewed minutes (the resent QMS manual, the countries list, the declarations
    # of conformity) while keeping "Speak to you next week". It stays available behind
    # STAGED_IMPORTER_LEGACY_SELECTOR=1; the default is the same evidence-grounded path as every
    # other type, with importer guidance.
    selector_input = list(actions)
    if is_importer_obligations_type(meeting_type) and os.environ.get("STAGED_IMPORTER_LEGACY_SELECTOR") == "1":
        actions = select_importer_actual_actions(actions, turns)
        prompt_profile = "importer_obligations_actual_actions"
    else:
        selector = selective_actual_action_profile(meeting_type)
        if selector:
            guidance, prompt_profile = selector
            actions = select_actual_actions(actions, turns, guidance)
        else:
            retrieval_selector = retrieval_selector_profile(meeting_type)
            if retrieval_selector:
                guidance, prompt_profile = retrieval_selector
                actions = select_retrieval_grounded_actions(actions, turns, guidance, profile=prompt_profile)
    if diagnostics_enabled:
        for action in selector_input:
            checks = action.get("_selectorChecks")
            if checks is None:
                continue
            for trace_id in action.get("_traceIds", []):
                diagnostic_sources.setdefault(trace_id, {})["selectorChecks"] = checks
    record_stage("evidence_selected", actions)
    if action_prompt == IMPORTER_ACTION_PROMPT:
        actions = consolidate_open_world_actions(actions, turns)
    normalised_meeting_type = re.sub(r"[^a-z0-9]+", " ", clean(meeting_type).lower()).strip()
    if normalised_meeting_type == "software weekly review" and software_action_consolidation_v2_enabled():
        actions = consolidate_open_world_actions(actions, turns)
    if action_prompt == HYBRID_ACTION_PROMPT:
        actions = consolidate_open_world_actions(actions, turns)
    if action_prompt == WEBINAR_ACTION_V2_PROMPT:
        actions = consolidate_open_world_actions(actions, turns)
    if action_prompt == PROCESS_ACTION_V2_PROMPT:
        actions = consolidate_open_world_actions(actions, turns)
    if action_prompt == TECHNICAL_FILE_ACTION_V2_PROMPT:
        actions = consolidate_open_world_actions(actions, turns)
    if action_prompt == GENERAL_ACTION_V2_PROMPT:
        actions = consolidate_open_world_actions(actions, turns)
    if action_prompt == AUDIT_ACTION_PROMPT:
        actions = consolidate_open_world_actions(actions, turns)
    if prompt_profile == "decision_retrieval_v2":
        actions = [action for action in actions if clean(action.get("status")).upper() != "PROPOSED"]
    record_stage("type_consolidated", actions)
    actions = [action for action in actions if evidence_turn_numbers(action, len(turns))]
    record_stage("evidence_valid", actions)
    actions = ground_action_attributions(actions, turns)
    record_stage("attribution_grounded", actions)
    # Wrongly inferred owners can prevent the first deliverable merge. Once attribution has been
    # grounded (and unsupported owners blanked), reuse the already extracted deliverable labels;
    # do not make another model call and do not invent a joint owner.
    grounded_structure = {
        number: {
            "deliverable": clean(action.get("_deliverable")),
            "verb": clean(action.get("_deliverableVerb")),
            "recipient": clean(action.get("_deliverableRecipient")),
        }
        for number, action in enumerate(actions, 1) if clean(action.get("_deliverable"))
    }
    if len(actions) > 1 and grounded_structure:
        actions = merge_by_deliverable(
            actions, grounded_structure, load_action_retrieval_backend(),
            # Attribution is grounded now, but keep the same conservative identity threshold as
            # the pre-selector pass. A broader threshold reduced duplicates at the cost of novel
            # technical-file work packages in the complete corpus benchmark.
            threshold=0.84, far_threshold=0.92,
        )
    record_stage("work_package_consolidated", actions)
    for action in actions:
        action.pop("_deliverable", None)
        action.pop("_deliverableVerb", None)
        action.pop("_deliverableRecipient", None)
    actions = assign_action_tiers(actions, sample_count)
    record_stage("published", actions)
    diagnostics = []
    if diagnostics_enabled:
        published_by_trace = {
            trace_id: clean(action.get("action")) for action in actions
            for trace_id in action.get("_traceIds", [])
        }
        rejection_by_last_stage = {
            "extracted": "completed_filter",
            "not_completed": "short_action_repair",
            "standalone": "sample_consolidation",
            "sample_consolidated": "evidence_selector",
            "deliverable_consolidated": "evidence_selector",
            "evidence_selected": "type_consolidation",
            "type_consolidated": "invalid_evidence",
            "evidence_valid": "attribution_or_fragment_grounding",
            "attribution_grounded": "work_package_consolidation",
            "work_package_consolidated": "tier_gate",
        }
        for trace_id, source in diagnostic_sources.items():
            stages = diagnostic_stages.get(trace_id, [])
            published = "published" in stages
            diagnostics.append({
                "candidateId": trace_id,
                **source,
                "stages": stages,
                "published": published,
                "publishedAction": published_by_trace.get(trace_id, ""),
                "disposition": "published" if published else rejection_by_last_stage.get(
                    stages[-1] if stages else "", "unknown"
                ),
            })
    for action in actions:
        action.pop("_traceIds", None)
        action.pop("_selectorChecks", None)
    result = {"stage": "actions", "actions": actions, "chunkCount": len(chunks), "turnCount": len(turns),
            "actionPromptProfile": prompt_profile, "actionSampleCount": sample_count,
            "candidateCountBeforeSelection": candidate_count}
    if diagnostics_enabled:
        result["candidateLifecycle"] = diagnostics
        result["actionStageCounts"] = diagnostic_counts
    return result


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
        if discussion_uses_chunk_candidate_filter(args.meeting_type):
            minimum = max(1, math.ceil(len(turns) / MAX_CHUNK_TURNS))
            maximum = max(minimum, math.ceil(len(turns) / 15))
            boundary_result = call_trooper(BOUNDARY_PROMPT.format(
                total=len(turns), minimum=minimum, maximum=maximum, numbered=numbered),
                1400, BOUNDARY_SCHEMA)
            chunks = safe_boundaries(boundary_result.get("chunks"), len(turns))
            lines = numbered.splitlines()

            def extract_candidates(chunk: dict[str, int]) -> list[dict[str, Any]]:
                prompt = SOFTWARE_TECHNICAL_FILE_CANDIDATE_PROMPT.format(
                    numbered_chunk="\n".join(lines[chunk["start"] - 1:chunk["end"]]))
                result = call_trooper(prompt, 1800, DISCUSSION_CANDIDATE_SCHEMA)
                return normalise_discussion_candidates(result, chunk)

            with concurrent.futures.ThreadPoolExecutor(max_workers=min(4, len(chunks))) as pool:
                candidate_groups = list(pool.map(extract_candidates, chunks))
            candidates = [candidate for group in candidate_groups for candidate in group]
            for number, candidate in enumerate(candidates, 1):
                candidate["candidate"] = number

            batches = [candidates[start:start + 25] for start in range(0, len(candidates), 25)]

            def classify_candidates(batch: list[dict[str, Any]]) -> dict[int, str]:
                numbered_candidates = "\n".join(
                    f"{row['candidate']}. {row['workstream']}: {row['state']}"
                    for row in batch)
                result = call_trooper(DISCUSSION_CANDIDATE_FILTER_PROMPT.format(
                    candidates=numbered_candidates), 2600, DISCUSSION_FILTER_SCHEMA)
                valid_numbers = {row["candidate"] for row in batch}
                decisions: dict[int, str] = {}
                rows = result.get("decisions") if isinstance(result.get("decisions"), list) else []
                for row in rows:
                    if not isinstance(row, dict) or row.get("candidate") not in valid_numbers:
                        continue
                    if row.get("decision") in ("DISCUSSION_POINT", "IGNORE"):
                        decisions[row["candidate"]] = row["decision"]
                return decisions

            with concurrent.futures.ThreadPoolExecutor(max_workers=min(4, max(1, len(batches)))) as pool:
                decision_groups = list(pool.map(classify_candidates, batches)) if batches else []
            decisions = {number: decision for group in decision_groups for number, decision in group.items()}
            accepted = [row for row in candidates if decisions.get(row["candidate"]) == "DISCUSSION_POINT"]
            discussion = discussion_from_candidates(accepted)
            total_calls = 1 + len(chunks) + len(batches)
            print(json.dumps({
                "stage": "discussion", "discussion": discussion,
                "discussionPromptProfile": "software_technical_file_chunk_filter",
                "discussionCallCount": total_calls, "splitAfterTurn": None,
                "splitAfterTurns": None, "chunkCount": len(chunks), "turnCount": len(turns),
                "discussionCandidateCount": len(candidates),
                "discussionAcceptedCandidateCount": len(accepted),
            }, ensure_ascii=False))
            return 0

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
                if prompt_profile == "audit_planning":
                    context = f"This is the {position} third of the meeting transcript. Follow the {position.upper()} THIRD priorities.\n\n"
                    max_tokens = 1800
                elif prompt_profile == "importer_obligations":
                    context = f"This is the {position} third of the meeting transcript. Capture only the substantive importer-obligations discussion contained in this third.\n\n"
                    max_tokens = 2200
                else:
                    context = f"This is the {position} third of the meeting transcript. Capture the substantive discussion contained in this third.\n\n"
                    max_tokens = 2400
                return call_trooper(discussion_prompt.format(transcript=context + "\n".join(third_turns)), max_tokens, DISCUSSION_SCHEMA)
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

    print(json.dumps(run_actions_stage(turns, numbered, args.meeting_type), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
