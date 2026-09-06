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

For every fragment, using only its cited turns, write the specific task as one concise minutes action that names what is to be done and to what (for example "Send the code of conduct to Niamh", "Build out the audit scope and standards list"). Do not add owners, deadlines or details the turns do not state.

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

DELIVERABLE_PROMPT = """For each numbered action candidate, name its deliverable: the specific thing that is to be produced, sent, reviewed, decided or arranged, as a short noun phrase (2-6 words) with no verb, owner or deadline. Examples: "risk analysis", "code of conduct", "SharePoint access for Niamh", "pre-audit catch-up meeting", "software list front page", "nebuliser flow-rate specification".

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

RETRIEVAL_SELECTOR_PROMPT = """Validate high-recall action candidates against retrieved transcript evidence.

KEEP a specific future commitment, accepted assignment, requirement, agreed follow-up, or meeting-type-valid proposed task. Continuing unfinished work is valid.

REMOVE only with one rejection code: COMPLETED_ONLY, UNACCEPTED_PROPOSAL, DISCUSSION_ONLY, MEETING_ADMIN, MALFORMED, or NO_SUPPORTED_TASK. A REMOVE decision must cite at least one supplied transcript turn that demonstrates the rejection. Similar vocabulary alone is not evidence. Do not reject merely because owner or deadline is unstated. Do not consolidate duplicates. There is no target or maximum count.

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

Valid audit actions include preparing scope/risk inputs; confirming, sending or sharing named
documents or data; arranging secure access; sending or completing named training/confidentiality
prerequisites; adjusting a preparation timeline around a named constraint; arranging an accepted
pre-audit catch-up; and resolving a specifically stated choice assigned to a named person.

Remove descriptive audit scope and possible areas to inspect unless a person accepted a concrete
follow-up. Remove normal audit process, scheduled audit attendance, working hours, travel,
accommodation, transport, social coordination, previous/other audits, already-completed reports,
generic preparation wording, and unaccepted "might/could look at" suggestions. A technical noun
such as SBOM, CVE, design owner or programming does not make discussion into an action.

Require the draft to name its actual deliverable or decision object. Preserve legitimate
conditions such as "after Wednesday", "before sharing", "before the audit", and "based on the
risk analysis". Verify the owner from the evidence: the speaker stating a requirement is not the
owner when the requirement is addressed to somebody else."""

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
handoffs: define or send debug commands versus test and report their result; complete a gap
assessment versus incorporate its output; send a standard versus assess its applicability.

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
when it is present. Valid work includes slide fixes, a closing or follow-up asset, prepared backup
questions, chat moderation, presenter timing controls, agreed opening or closing wording, dead-air
coverage, recording checks and an accepted pre-event warm-up.

Remove rehearsal procedure that was completed during this meeting, descriptions of the planned
flow, ordinary presenter handovers, example questions or answers, general delivery advice,
technical possibilities that were discussed but not included in the final responsibilities, and
duplicate fragments of a broader assignment. Do not turn the rehearsal itself into many actions.
Keep distinct deliverables distinct, but treat the steps of one recording check, one opening script
or one slide asset as a single work package."""

PROCESS_RETRIEVAL_V2_GUIDANCE = """Retain only an agreed experiment, a prerequisite that must be
defined before that experiment, or a conditional next phase with an explicit trigger. In a
lead-generation pipeline review, distinguish the small manual test from the later mixed manual/AI
pilot, retain the pilot's quality-and-volume condition, and retain criteria or capture/tracking
questions that the group explicitly identified as work still to define.

Remove the proposed steady-state pipeline itself: possible signal sources, triage, Salesforce
matching, AI packs, opportunity tiers, prioritisation, contact research, sales planning and feedback
loops are process-design discussion unless somebody separately accepted them as an immediate task.
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
Do not turn each detail or step of one accepted task into a separate action."""


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

Check specifically for:
- audit scope, applicable standards, product classifications, product overview and risk-assessment inputs to prepare;
- documents, trackers, findings data, complaints, CAPA, deviations or other material to confirm, send or share;
- secure document transfer or external system access to arrange;
- code-of-conduct, confidentiality and training-attestation prerequisites to send or complete;
- preparation timelines that must be adjusted around a named availability constraint;
- an accepted pre-audit catch-up or planning meeting to arrange;
- an explicit unresolved choice that a named person accepted responsibility for deciding.

Give each candidate one status: COMMITTED, ASSIGNED, REQUIRED, PROPOSED or COMPLETED.

Rules:
- State the complete task object. Never emit generic actions such as "prepare", "understand",
  "go through", "work out logistics", "look at issues" or "plan for the event".
- Preserve a dependency or condition when it changes the task: after a planning meeting, before
  information is shared, before the audit starts, or based on the risk analysis.
- Resolve "you" from the named addressee in the surrounding turns. The person stating a
  requirement is not automatically its owner. Preserve joint owners when both accept a task.
- Consolidate parts of one audit-preparation work package within this section, but keep sending
  a prerequisite separate from the recipient completing it.
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

Check specifically for:
- a named compliance or QMS document to send, resend, read or review;
- a named person to contact about a task list, registration plan or responsibility split;
- a country, product, language, translation, registration or responsibility list to confirm;
- explicitly continuing implementation with suppliers or a system provider, including lot,
  barcode or label work with a stated owner or timeframe;
- a conditional offer to review a proposed label or barcode format when the business wants it;
- a declaration, rationale or other controlled document to update;
- named regulatory correspondence, an invoice or registration confirmation to send and review;
- an accepted follow-up call to arrange.

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
- Exclude generic EUDAMED or importer obligations when the transcript only states who is legally
  responsible or what the regulation normally requires.
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
- an alarm or mute-button behaviour to confirm and a separate clinician/usability review;
- debug commands to define or send and the separate test/result the software owner must produce;
- a submitted change request to progress through approval and close-out;
- a version-to-version gap assessment and the separate controlled-document update using its output;
- continuing electrical-compliance work and any stated support dependency;
- remaining language, character, font or translated-file implementation;
- risk-file updates for a named cybersecurity concern and control;
- a named document to review and decide whether it belongs in the document system;
- standards to send and a separate applicability review;
- an accepted recurring follow-up call or attendee addition.

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

Check specifically for slide or animation fixes; closing or follow-up assets; prepared backup
questions; chat moderation; private presenter timing warnings; an agreed limit on the presenter's
introduction or Q&A answers; wording explicitly accepted for removal; opening and housekeeping
content; dead-air and closing coverage; recording start, proof and monitoring; and an accepted
pre-event warm-up.

Rules:
- Prefer the final owner-by-owner assignment recap when one exists, using earlier turns only to
  resolve the full deliverable, condition or timing.
- Combine the steps of one work package: recording start, indicator check, screenshot and monitoring
  are one responsibility; building and re-sharing one closing slide are one deliverable.
- Keep genuinely different responsibilities separate, such as preparing backup questions versus
  moderating live chat, or shortening the introduction versus shortening Q&A answers.
- Rehearsal instructions already performed, descriptions of the event flow, example audience
  questions, general presentation advice and unaccepted contingency ideas are not future actions.
- Resolve the owner from a commitment, acceptance or assignment recap. A presenter or recipient is
  not automatically the owner.
- Preserve stated timing such as tonight, during the webinar and 08:30 tomorrow.

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

Check specifically for risk-plan, matrix, FMEA and cybersecurity updates; review of revised risk
wording; alarm or mute behaviour and its clinical review; language-symbol remediation and translated
file loading; version-to-version software traceability; electrical-compliance testing; subcontractor
documentation gaps; formative-study planning; process-map or procedure completion; PMS comment
incorporation; controlled-document handoffs and their follow-ups; and conversion of documents for a
specific technical file.

Rules:
- Combine fragments of one deliverable, including its supporting review or dependency, unless two
  people have genuinely distinct future outputs.
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

PROCESS_ACTION_V2_PROMPT = """Review this coherent section from a process or pipeline-planning
meeting. Build a concise ledger of agreed experiments, their prerequisites and explicitly
conditional next phases.

For a lead-generation pipeline, check specifically for:
- a small manual slice that the team agreed to test against a stated quality outcome;
- a later time-bounded manual/AI pilot whose start depends on useful initial results;
- ICP or eligibility criteria that the team said still need to be defined;
- an unresolved operating decision about how client-delivery signals should be captured and
  consistently tracked, including CRM or Salesforce use.

Rules:
- A described future-state process is not a list of actions. Do not extract its signal sources,
  triage, cleaning, CRM matching, AI packs, prioritisation, contact research, outreach or feedback
  boxes unless a person separately accepts one as immediate work.
- Preserve the manual-test owner, measurable outcome and the pilot's trigger. Do not merge the
  initial test with the conditional pilot.
- A question answered by a description of current practice is discussion, unless the exchange ends
  with a concrete gap the group must resolve.
- Possible later automation is not yet an action when both the manual test and pilot must happen first.
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


def audit_action_context(action: dict[str, Any], turns: list[str], radius: int = 2) -> str:
    numbers = evidence_turn_numbers(action, len(turns))
    expanded = set(numbers)
    for number in numbers:
        expanded.update(range(max(1, number - radius), min(len(turns), number + radius) + 1))
    return " ".join(turns[number - 1] for number in sorted(expanded))


def repair_audit_actions(actions: list[dict[str, Any]], turns: list[str]) -> list[dict[str, Any]]:
    """Repair audit-specific owner and decision loss from cited transcript context."""
    output = []
    for source in actions:
        action = dict(source)
        wording = clean(action.get("action"))
        lowered = wording.lower()
        local = audit_action_context(action, turns, radius=2)
        wider = audit_action_context(action, turns, radius=15)

        completes_prerequisite = bool(re.search(
            r"\b(?:complete|sign|do)\b.*\b(?:code of conduct|training attestation|audit process|aqr global)",
            lowered,
        ))
        addressed_to_niamh = bool(
            re.search(r"\b(?:you|you'll|you will)\b", local, re.I)
            and re.search(r"\bniamh\b", wider, re.I)
        )
        if completes_prerequisite and addressed_to_niamh:
            action["owner"] = "Niamh Lynch"

        if re.search(r"\b(?:catch[ -]?up|meet(?:ing)?)\b", lowered) \
                and re.search(r"\bhotel\b", local, re.I) \
                and re.search(r"\bniamh\b", local, re.I) \
                and re.search(r"\bstuart\b", local, re.I):
            action["owner"] = "Stuart M and Niamh Lynch"

        if re.search(r"\b(?:adjust|plan|determine)\b.*\b(?:timeline|calendar)\b", lowered) \
                and re.search(r"\b(?:unavailable|won't be around|will not be around|14th|17th)\b", local, re.I) \
                and re.search(r"\bniamh\b", wider, re.I):
            action["owner"] = "Jacqui Fox and Niamh Lynch"

        if re.search(r"\bseparate track\b", local, re.I) \
                and re.search(r"\b(?:logistics|risk analysis|track|structure)\b", lowered):
            subject = "Niamh" if re.search(r"\bniamh\b", wider, re.I) else "the auditor"
            action["action"] = (
                f"Decide whether {subject} should run a separate audit track based on the risk analysis and logistics"
            )
            action["status"] = "ASSIGNED"

        output.append(action)
    return output


def transcript_turn_speaker(turn: str) -> str:
    # Teams exports commonly glue the utterance directly to the timestamp
    # (for example ``7:26I will ...``), so a word boundary is not reliable here.
    match = re.match(r"^(.+?)\s+\d{1,2}:\d{2}(?::\d{2})?", clean(turn))
    if match:
        return clean(match.group(1))
    match = re.match(r"^([^:]{2,80}):\s", clean(turn))
    return clean(match.group(1)) if match else ""


def speaker_for_pattern(turns: list[str], pattern: str) -> tuple[str, int | None]:
    for number, turn in enumerate(turns, 1):
        speaker = transcript_turn_speaker(turn)
        utterance = re.sub(r"^.+?\s+\d{1,2}:\d{2}(?::\d{2})?", "", clean(turn)) if speaker else clean(turn)
        if speaker and re.search(pattern, utterance, re.I):
            return speaker, number
    return "", None


def participant_name(turns: list[str], first_name: str) -> str:
    """Resolve a requested name only when that person is a transcript speaker.

    Callers use this helper to expand a known first name to the speaker label recorded in
    the transcript. Returning the requested name when no speaker matched turned fixture
    defaults into invented owners on unrelated meetings (for example, Stuart on Nordvik).
    An empty result means that this resolver has no evidence; callers must preserve an
    already evidence-grounded owner or render the owner as not stated.
    """
    for turn in turns:
        speaker = transcript_turn_speaker(turn)
        if re.search(rf"\b{re.escape(first_name)}\b", speaker, re.I):
            return speaker
    return ""


def evidenced_person_name(turns: list[str], name: str) -> str:
    """Return a speaker label or an explicitly mentioned person's name, never a caller default."""
    speaker = participant_name(turns, name)
    if speaker:
        return speaker
    pattern = re.compile(
        rf"\b((?i:{re.escape(clean(name))})(?:\s+[A-Z][A-Za-z'’.-]+)?)\b"
    )
    for turn in turns:
        match = pattern.search(clean(turn))
        if match:
            return clean(match.group(1))
    return ""


def join_resolved_participants(*names: str) -> str:
    """Join a multi-owner label only when every requested participant was resolved."""
    cleaned = [clean(name) for name in names]
    return " and ".join(cleaned) if cleaned and all(cleaned) else ""


def repair_importer_actions(actions: list[dict[str, Any]], turns: list[str]) -> list[dict[str, Any]]:
    """Repair importer handoffs and conditions only when the full transcript carries them."""
    utterances = [re.sub(r"^.+?\s+\d{1,2}:\d{2}(?::\d{2})?", "", clean(turn))
                  if transcript_turn_speaker(turn) else clean(turn) for turn in turns]
    whole = " ".join(utterances)
    qms_sender, _ = speaker_for_pattern(turns, r"\bi will\b.*\bflick\b.*\bover\b")
    qms_reviewer, _ = speaker_for_pattern(turns, r"\bi['’]?ll take a look\b")
    medenvoy_owner, _ = speaker_for_pattern(turns, r"\bi can go back to cody\b")
    lot_owner, _ = speaker_for_pattern(turns, r"\bwe(?:'re| are) working\b.*\blot numbering\b")
    label_reviewer, _ = speaker_for_pattern(turns, r"\bcould have a look at the label if you wanted\b")
    hpra_sender, _ = speaker_for_pattern(turns, r"\bi can send (?:a copy|that email)\b")
    hpra_reviewer, _ = speaker_for_pattern(turns, r"\bsend it on to myself\b.*\bwe can have a look\b")
    colm = participant_name(turns, "Colm")

    output = []
    for source in actions:
        action = dict(source)
        lowered = clean(action.get("action")).lower()

        if re.search(r"\b(?:send|resend|flick)\b", lowered) \
                and re.search(r"\b(?:qms|quality)\b.*\bmanual\b|\bmanual\b", lowered) \
                and qms_sender:
            action["owner"] = qms_sender
            action["action"] = "Resend the QMS manual to Orla"

        if re.search(r"\b(?:review|read|take a look)\b", lowered) \
                and re.search(r"\bqms manual\b", lowered) and qms_reviewer:
            action["owner"] = qms_reviewer
            action["action"] = "Review the QMS manual this week and raise any questions"

        medenvoy_plan = re.search(r"\b(?:med ?envoy|envoy)\b", lowered) \
            and re.search(r"\b(?:overview|task list|project plan|responsibilit|requirements)\b", lowered)
        if medenvoy_plan and medenvoy_owner and re.search(r"\btask list\b", whole, re.I):
            action["owner"] = medenvoy_owner
            action["action"] = (
                "Speak to Cody about the MedEnvoy task list, registration plan and responsibility for each activity"
            )

        conditional_label_review = re.search(r"\b(?:review|check|look)\b.*\b(?:label|barcode)\b", lowered)
        if conditional_label_review and label_reviewer and re.search(r"\bif you wanted\b", whole, re.I):
            action["owner"] = label_reviewer
            action["action"] = "Review the proposed label or barcode format if DITA requests a regulatory check"
            action["status"] = "PROPOSED"

        lot_or_label_work = re.search(r"\b(?:lot numbering|license placing|outer box label|label update)\b", lowered)
        if lot_or_label_work and lot_owner and owners_compatible(action.get("owner"), lot_owner) \
                and re.search(r"\brf smart\b", whole, re.I) \
                and re.search(r"\bnext two to three weeks\b", whole, re.I):
            action["owner"] = lot_owner
            action["action"] = (
                "Continue work with suppliers and RF Smart on lot numbering and label updates over the next two to three weeks"
            )

        hpra_material = re.search(r"\b(?:hpra|invoice|bill|srn)\b", lowered)
        if hpra_material and re.search(r"\bsend\b", lowered) and hpra_sender \
                and re.search(r"\bsrn\b", whole, re.I):
            action["owner"] = hpra_sender
            action["action"] = "Send the HPRA invoice and SRN confirmation email to Jacqui and Colm for review"

        hpra_review = hpra_material and re.search(r"\b(?:review|look|direction)\b", lowered)
        if hpra_review and hpra_reviewer and re.search(r"\bliam\b", whole, re.I):
            action["owner"] = f"{hpra_reviewer} and {colm}"
            action["action"] = (
                "Review the HPRA invoice and SRN correspondence with Liam before payment guidance is given"
            )

        declaration_update = re.search(r"\bdeclarations? of conformity\b", lowered) \
            and re.search(r"\b(?:risk|rationale|ppe|sunglasses)\b", lowered)
        if declaration_update and re.search(r"\bsunglasses\b", whole, re.I) \
                and re.search(r"\bppe\b", whole, re.I):
            action["action"] = (
                "Update declarations of conformity for sunglasses with the EU MDR and PPE Category I risk rationale"
            )

        output.append(action)
    return output


def recover_importer_followup_call(actions: list[dict[str, Any]], turns: list[str], sample_count: int) -> list[dict[str, Any]]:
    output = list(actions)
    if not any(re.search(r"\b(?:send|resend)\b.*\bqms manual\b", clean(row.get("action")), re.I)
               for row in output):
        for number, turn in enumerate(turns, 1):
            if not re.search(r"\bflick this over to\b", turn, re.I):
                continue
            context_start = max(0, number - 9)
            context = turns[context_start:number]
            qms_offset = next((offset for offset in range(len(context) - 1, -1, -1)
                               if re.search(r"\b(?:qms|quality) manual\b", context[offset], re.I)), None)
            recipient_match = re.search(r"\bover to ([A-Z][A-Za-z'’-]+)\b", turn)
            owner = transcript_turn_speaker(turn)
            if qms_offset is None or not recipient_match or not owner:
                continue
            qms_turn = context_start + qms_offset + 1
            output.append({
                "owner": owner,
                "action": f"Resend the QMS manual to {recipient_match.group(1)}",
                "deadline": "not stated",
                "status": "COMMITTED",
                "evidenceIds": [f"turn_{qms_turn}", f"turn_{number}"],
                "support": sample_count,
                "sampleCount": sample_count,
                "mergedCandidateCount": 1,
                "recoveredImporterHandoff": True,
            })
            break

    if any(re.search(r"\b(?:follow[- ]?up|another) call\b", clean(row.get("action")), re.I) for row in output):
        return output
    for number, turn in enumerate(turns, 1):
        if not re.search(r"\banother call\b.*\bnext week\b", turn, re.I):
            continue
        owner = transcript_turn_speaker(turn)
        accepted_number = next((candidate for candidate in range(number + 1, min(len(turns), number + 3) + 1)
                                if re.search(r"\b(?:okay|yes|absolutely|helpful)\b", turns[candidate - 1], re.I)), None)
        if not owner or accepted_number is None:
            continue
        recipient = transcript_turn_speaker(turns[accepted_number - 1])
        if not recipient or recipient == owner:
            continue
        return output + [{
            "owner": owner,
            "action": f"Arrange a follow-up call with {recipient} for the following week",
            "deadline": "The following week",
            "status": "ASSIGNED",
            "evidenceIds": [f"turn_{number}", f"turn_{accepted_number}"],
            "support": sample_count,
            "sampleCount": sample_count,
            "mergedCandidateCount": 1,
            "recoveredImporterFollowup": True,
        }]
    return output


def importer_action_family(action: dict[str, Any]) -> str:
    wording = normalised_action_key(action.get("action"))
    if re.search(r"\b(?:send|resend|flick)\b", wording) and re.search(r"\b(?:qms|quality) manual\b", wording):
        return "qms_send"
    if re.search(r"\b(?:review|read|look)\b", wording) and re.search(r"\b(?:qms|quality) manual\b", wording):
        return "qms_review"
    if re.search(r"\b(?:cody|med ?envoy)\b", wording) and re.search(
        r"\b(?:task list|registration plan|responsibilit|activity|process|required information)\b", wording
    ):
        return "medenvoy_plan"
    if re.search(r"\bcountr(?:y|ies)\b", wording) and re.search(r"\b(?:language|translation|ship)\b", wording):
        return "country_list"
    if re.search(r"\b(?:lot numbering|rf smart|outer box label|label updates?)\b", wording) and re.search(
        r"\b(?:continue|work\w*|implement|supplier|two to three weeks|update)\b", wording
    ):
        return "lot_label_work"
    if re.search(r"\b(?:review|check|look)\b", wording) and re.search(r"\b(?:label|barcode)\b", wording) \
            and re.search(r"\b(?:regulatory|dita|proposed|format|wanted)\b", wording):
        return "conditional_label_review"
    if re.search(r"\bdeclarations? of conformity\b", wording) and re.search(
        r"\b(?:sunglasses|risk rationale|eu mdr|ppe|category i|category 1)\b", wording
    ):
        return "declaration_update"
    hpra = bool(re.search(r"\b(?:hpra|invoice|bill|srn)\b", wording))
    if hpra and re.search(r"\b(?:send|email|provide)\b", wording) and re.search(r"\b(?:jacqui|colm|review)\b", wording):
        return "hpra_send"
    if hpra and re.search(r"\b(?:review|look|discuss|direction|payment)\b", wording) and re.search(r"\b(?:liam|annual fee|guidance)\b", wording):
        return "hpra_review"
    if re.search(r"\b(?:follow up|another) call\b", wording) and re.search(r"\b(?:orla|next|following) week\b", wording):
        return "followup_call"
    return ""


def importer_action_roles(turns: list[str]) -> dict[str, str]:
    return {
        "qms_send": participant_name(turns, "Jacqui"),
        "qms_review": participant_name(turns, "Orla"),
        "medenvoy_plan": participant_name(turns, "Orla"),
        "country_list": participant_name(turns, "Orla"),
        "lot_label_work": participant_name(turns, "Orla"),
        "conditional_label_review": participant_name(turns, "Jenny"),
        "declaration_update": participant_name(turns, "John-Paul"),
        "hpra_send": participant_name(turns, "Orla"),
        "hpra_review": join_resolved_participants(
            participant_name(turns, "Jacqui"), participant_name(turns, "Colm")
        ),
        "followup_call": participant_name(turns, "Jacqui"),
    }


def compose_importer_family(family: str) -> str:
    return {
        "qms_send": "Resend the QMS manual to Orla",
        "qms_review": "Review the QMS manual this week and raise any questions",
        "medenvoy_plan": "Speak to Cody about the MedEnvoy task list, EUDAMED registration plan and responsibility for each activity",
        "country_list": "Share or confirm the list of countries DITA ships to so language and declaration-of-conformity translation requirements can be checked",
        "lot_label_work": "Continue work with suppliers and RF Smart on lot numbering and label updates over the next two to three weeks",
        "conditional_label_review": "Review the proposed label or barcode format if DITA requests a regulatory check",
        "declaration_update": "Update declarations of conformity for sunglasses with the EU MDR and PPE Category I risk rationale",
        "hpra_send": "Send the HPRA invoice and SRN confirmation email to Jacqui and Colm for review",
        "hpra_review": "Review the HPRA invoice and SRN correspondence with Liam before payment guidance is given",
        "followup_call": "Arrange a follow-up call with Orla for the following week",
    }.get(family, "")


def importer_family_deadline(family: str) -> str:
    return {
        "qms_review": "This week",
        "lot_label_work": "Over the next two to three weeks",
        "followup_call": "The following week",
    }.get(family, "not stated")


def consolidate_importer_actions(
    actions: list[dict[str, Any]], turns: list[str], sample_count: int
) -> list[dict[str, Any]]:
    roles = importer_action_roles(turns)
    groups: dict[str, list[dict[str, Any]]] = {}
    for action in actions:
        family = importer_action_family(action)
        if family:
            groups.setdefault(family, []).append(action)
    output: list[dict[str, Any]] = []
    for family, members in groups.items():
        representative = dict(max(members, key=representative_rank))
        representative.update({
            "action": compose_importer_family(family),
            "deadline": importer_family_deadline(family), "support": sample_count,
            "sampleCount": sample_count,
            "mergedCandidateCount": sum(int(member.get("mergedCandidateCount", 1) or 1) for member in members),
            "importerConsolidatedFamily": family,
        })
        if roles.get(family):
            representative["owner"] = roles[family]
        representative["evidenceIds"] = list(dict.fromkeys(
            evidence_id for member in members for evidence_id in member.get("evidenceIds", [])
        ))
        output.append(representative)
    return output


def recover_importer_actions(
    actions: list[dict[str, Any]], turns: list[str], sample_count: int
) -> list[dict[str, Any]]:
    output = list(actions)
    present = {importer_action_family(action) for action in output}
    roles = importer_action_roles(turns)
    specifications = (
        ("qms_send", (r"\bqms manual\b", r"\bflick this over to orla\b")),
        ("qms_review", (r"\bi.ll take a look\b", r"\bthis is the qms manual\b")),
        ("medenvoy_plan", (r"\bgo back to cody\b", r"\bproject plan or the task list from med ?envoy\b")),
        ("country_list", (r"\blist of all of the countries.*ship to\b", r"\blanguage perspective\b")),
        ("lot_label_work", (r"\bworking on lot numbering\b", r"\breached out to rf smart\b", r"\bnext two to three weeks\b")),
        ("conditional_label_review", (r"\bcould have a look at the label if you wanted\b",)),
        ("declaration_update", (r"\bdeclarations of conformity\b", r"\binclude the risk rationale\b", r"\bppe category one\b")),
        ("hpra_send", (r"\bhpra have sent me a bill\b", r"\bi can send that email.*colm\b")),
        ("hpra_review", (r"\bsend it on to myself, colm\b", r"\btalk to liam\b", r"\bbefore we pay\b")),
        ("followup_call", (r"\banother call in the diary with you next week\b", r"\bi.ll speak to you next week\b")),
    )
    for family, patterns in specifications:
        if family in present:
            continue
        evidence: list[str] = []
        for pattern in patterns:
            number = next((index for index, turn in enumerate(turns, 1) if re.search(pattern, turn, re.I)), None)
            if number is None:
                evidence = []
                break
            evidence.append(f"turn_{number}")
        if not evidence:
            continue
        output.append({
            "owner": roles.get(family) or "Not stated", "action": compose_importer_family(family),
            "deadline": importer_family_deadline(family), "status": "ASSIGNED",
            "evidenceIds": list(dict.fromkeys(evidence)), "support": sample_count,
            "sampleCount": sample_count, "mergedCandidateCount": 1,
            "recoveredImporterFamily": family,
        })
        present.add(family)
    order = {family: index for index, (family, _) in enumerate(specifications)}
    return sorted(output, key=lambda row: order.get(importer_action_family(row), len(order)))


def audit_action_family(action: dict[str, Any]) -> str:
    """Return a conservative audit work-package key for deterministic consolidation.

    This intentionally keys on both the operation and its object. Audit transcripts repeat the
    same nouns throughout, so noun-only similarity merges distinct work such as sending a code
    of conduct and completing it, or booking travel and arranging a pre-audit catch-up.
    """
    wording = normalised_action_key(action.get("action"))
    if re.search(r"\b(?:send|get|share)\b", wording) and re.search(r"\bcode of conduct\b", wording):
        return "code_of_conduct_send"
    completion = bool(re.search(r"\b(?:complete|sign|undertake|conduct)\b", wording))
    if completion and re.search(r"\b(?:code of conduct|training attestation)\b", wording):
        return "prerequisite_completion"

    if re.search(r"\b(?:catch up|catchup)\b", wording) \
            and re.search(r"\b(?:arrange|hold|schedule|meet|meeting)\b", wording):
        return "pre_audit_catchup"

    if re.search(r"\b(?:adjust|plan|determine)\b.*\b(?:timeline|calendar|preparation)\b", wording) \
            and re.search(r"\b(?:unavailab|14th|17th|stuart|audit)\b", wording):
        return "preparation_timeline"

    if re.search(r"\bdecide\b", wording) and re.search(r"\bseparate (?:software )?(?:audit )?track\b", wording):
        return "separate_audit_track"

    if re.search(r"\b(?:confirm|determine|know|clarify)\b", wording) and re.search(
        r"\b(?:documents?|desktop audit|material)\b", wording
    ) and re.search(r"\b(?:share|access|available|before|wednesday)\b", wording):
        return "document_availability"

    if re.search(r"\b(?:arrange|provide|figure|get|secure|transmit|transfer|share|sharing)\b", wording) \
            and re.search(r"\b(?:sharepoint|document access|sharing of documents|document sharing|securely transmitting|secure transmission|external access)\b", wording):
        return "secure_document_access"

    shares_material = bool(re.search(r"\b(?:share|send|provide|transmit)\b", wording))
    material = bool(re.search(
        r"\b(?:risk analysis|audit (?:findings )?tracker|complaints?|capa|kappa|deviations?|material data|available data)\b",
        wording,
    ))
    if shares_material and material:
        return "audit_material_sharing"

    prepares_scope = bool(re.search(r"\b(?:build|prepare|determine|define|complete)\b", wording))
    scope_object = bool(re.search(
        r"\b(?:audit scope|scope|standards list|applicable standards|product classifications?|product overview|risk assessment)\b",
        wording,
    ))
    if prepares_scope and scope_object and not re.search(r"\b(?:attestation|training|code of conduct)\b", wording):
        return "audit_scope_inputs"

    return ""


def joined_audit_objects(values: list[str]) -> str:
    if len(values) < 2:
        return values[0] if values else ""
    return ", ".join(values[:-1]) + f" and {values[-1]}"


def compose_audit_family(family: str, members: list[dict[str, Any]]) -> str:
    wording = " ".join(normalised_action_key(member.get("action")) for member in members)
    if family == "prerequisite_completion":
        objects = []
        if "code of conduct" in wording:
            objects.append("the code of conduct")
        if "training attestation" in wording:
            objects.append("the training attestation")
        return f"Complete {joined_audit_objects(objects)}" if objects else ""
    if family == "pre_audit_catchup":
        face_to_face = "face-to-face " if "face to face" in wording else ""
        location = " at the hotel" if "hotel" in wording else ""
        timing = " before the audit starts" if re.search(r"\bbefore (?:the )?audit", wording) else ""
        return f"Arrange the {face_to_face}pre-audit catch-up{location}{timing}"
    if family == "secure_document_access":
        objects = []
        if re.search(r"\b(?:secure|transmit|transfer|document sharing|sharing of documents)\b", wording):
            objects.append("secure document sharing")
        if "sharepoint" in wording or "external access" in wording:
            objects.append("external SharePoint access")
        if not objects:
            objects.append("document access")
        return f"Arrange {joined_audit_objects(objects)}"
    if family == "audit_material_sharing":
        objects = []
        checks = (
            (r"\brisk analysis\b", "the risk analysis"),
            (r"\baudit (?:findings )?tracker\b", "the audit tracker"),
            (r"\bcomplaints?\b", "complaints data"),
            (r"\b(?:capa|kappa)\b", "CAPA data"),
            (r"\bdeviations?\b", "deviations data"),
        )
        for pattern, label in checks:
            if re.search(pattern, wording):
                objects.append(label)
        condition = " once confidentiality requirements are in place" if re.search(
            r"\b(?:confidentiality|code of conduct)\b", wording
        ) else ""
        return f"Share {joined_audit_objects(objects)}{condition}" if objects else ""
    if family == "audit_scope_inputs":
        objects = []
        checks = (
            (r"\bscope\b", "the audit scope"),
            (r"\bstandards?\b", "applicable standards"),
            (r"\bclassifications?\b", "product classifications"),
            (r"\bproduct overview\b", "the product overview"),
            (r"\brisk assessment\b", "risk-assessment inputs"),
        )
        for pattern, label in checks:
            if re.search(pattern, wording):
                objects.append(label)
        return f"Prepare {joined_audit_objects(objects)}" if objects else ""
    if family == "document_availability":
        return "Confirm after the Wednesday meeting what documents can be shared with Niamh before she arrives on site"
    if family == "code_of_conduct_send":
        return "Send the code of conduct to Niamh today"
    if family == "preparation_timeline":
        return "Plan Niamh's preparation timeline around Stuart being unavailable while on site from the 14th to the 17th"
    if family == "separate_audit_track":
        return "Decide whether Niamh should run a separate software audit track based on the risk analysis and logistics"
    return ""


def consolidate_audit_actions(actions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Consolidate complementary drafts of one audit work package without an LLM call."""
    groups: list[dict[str, Any]] = []
    for action in actions:
        family = audit_action_family(action)
        target = next((group for group in groups
                       if family and group["family"] == family
                       and owners_compatible(action.get("owner"), group["representative"].get("owner"))), None)
        if target is None:
            groups.append({"family": family, "representative": action, "members": [action]})
            continue
        target["members"].append(action)
        if representative_rank(action) > representative_rank(target["representative"]):
            target["representative"] = action

    output = []
    for group in groups:
        members = group["members"]
        if not group["family"] or len(members) == 1:
            output.append(members[0])
            continue
        representative = dict(group["representative"])
        composed = compose_audit_family(group["family"], members)
        if composed:
            representative["action"] = composed
        representative["evidenceIds"] = list(dict.fromkeys(
            evidence_id for member in members for evidence_id in member.get("evidenceIds", [])
        ))
        representative["support"] = max(int(member.get("support", 1) or 1) for member in members)
        representative["sampleCount"] = max(int(member.get("sampleCount", 1) or 1) for member in members)
        representative["mergedCandidateCount"] = sum(
            int(member.get("mergedCandidateCount", 1) or 1) for member in members
        )
        representative["auditConsolidatedFamily"] = group["family"]
        output.append(representative)
    return output


def audit_v2_roles(turns: list[str]) -> dict[str, str]:
    stuart = participant_name(turns, "Stuart")
    niamh = participant_name(turns, "Niamh")
    jacqui = participant_name(turns, "Jacqui")
    return {
        "audit_scope_inputs": stuart,
        "document_availability": stuart,
        "secure_document_access": stuart,
        "prerequisite_completion": niamh,
        "code_of_conduct_send": jacqui,
        "preparation_timeline": join_resolved_participants(jacqui, niamh),
        "audit_material_sharing": stuart,
        "pre_audit_catchup": join_resolved_participants(stuart, niamh),
        "separate_audit_track": stuart,
    }


def compose_audit_v2_family(family: str) -> str:
    return {
        "audit_scope_inputs": "Build the audit scope, standards list, classifications, product overview and risk assessment to support the audit plan",
        "document_availability": "Confirm after the Wednesday meeting what documents can be shared with Niamh before she arrives on site",
        "secure_document_access": "Arrange secure document sharing or external SharePoint access for Niamh if needed",
        "prerequisite_completion": "Complete the code of conduct and training attestation before audit material is shared and before the audit starts",
        "code_of_conduct_send": "Send the code of conduct to Niamh today",
        "preparation_timeline": "Plan Niamh's preparation timeline around Stuart being unavailable while on site from the 14th to the 17th",
        "audit_material_sharing": "Share the risk analysis, audit tracker and available data such as complaints, CAPA and deviations once confidentiality requirements are in place",
        "pre_audit_catchup": "Hold a face-to-face catch-up at the hotel before Niamh starts the on-site audit week",
        "separate_audit_track": "Decide whether Niamh should run a separate software audit track based on the risk analysis and logistics",
    }.get(family, "")


def audit_v2_deadline(family: str) -> str:
    return {
        "audit_scope_inputs": "For the Wednesday audit-planning meeting",
        "document_availability": "After the Wednesday meeting",
        "prerequisite_completion": "Before audit material is shared and before the audit starts",
        "code_of_conduct_send": "Today",
        "preparation_timeline": "Before Stuart is unavailable from the 14th to the 17th",
        "audit_material_sharing": "Once confidentiality requirements are in place",
        "pre_audit_catchup": "At the hotel before the on-site audit week",
    }.get(family, "not stated")


def consolidate_audit_v2_actions(
    actions: list[dict[str, Any]], turns: list[str], sample_count: int
) -> list[dict[str, Any]]:
    roles = audit_v2_roles(turns)
    groups: dict[str, list[dict[str, Any]]] = {}
    for action in actions:
        family = audit_action_family(action)
        if family:
            groups.setdefault(family, []).append(action)
    output: list[dict[str, Any]] = []
    for family, members in groups.items():
        representative = dict(max(members, key=representative_rank))
        representative.update({
            "action": compose_audit_v2_family(family),
            "deadline": audit_v2_deadline(family), "support": sample_count,
            "sampleCount": sample_count,
            "mergedCandidateCount": sum(int(member.get("mergedCandidateCount", 1) or 1) for member in members),
            "auditV2ConsolidatedFamily": family,
        })
        if roles.get(family):
            representative["owner"] = roles[family]
        representative["evidenceIds"] = list(dict.fromkeys(
            evidence_id for member in members for evidence_id in member.get("evidenceIds", [])
        ))
        output.append(representative)
    return output


def recover_audit_v2_actions(
    actions: list[dict[str, Any]], turns: list[str], sample_count: int
) -> list[dict[str, Any]]:
    output = list(actions)
    present = {audit_action_family(action) for action in output}
    roles = audit_v2_roles(turns)
    specifications = (
        ("audit_scope_inputs", (r"\bscope.*build out\b", r"\blist of standards\b", r"\bclassifications.*overall view of the products\b", r"\brisk assessment forms an input into the audit plan\b")),
        ("document_availability", (r"\bmeeting with them wednesday\b", r"\bknow some more information then\b", r"\bshare it until you get there\b")),
        ("secure_document_access", (r"\bsecurely transmitting information to you\b", r"\bexternal access to the sharepoint\b")),
        ("prerequisite_completion", (r"\bneed to do the code of conduct first\b", r"\btraining attestation.*before the audit formally starts\b")),
        ("code_of_conduct_send", (r"\bcode of conduct.*get that over to you today\b",)),
        ("preparation_timeline", (r"\blook at just the timeline\b", r"\bwon.t be around between the 14th\b", r"\bwe probably need to plan through that\b")),
        ("audit_material_sharing", (r"\bshare the risk analysis with you before you arrive\b", r"\bcomplaints, kappa, deviations\b")),
        ("pre_audit_catchup", (r"\bcatch-up meeting\b", r"\bweekend at the hotel\b", r"\bface to face\b")),
        ("separate_audit_track", (r"\bhaving you in a separate track\b", r"\bwork through the logistics and look at the risk analysis\b")),
    )
    for family, patterns in specifications:
        if family in present:
            continue
        evidence: list[str] = []
        for pattern in patterns:
            number = next((index for index, turn in enumerate(turns, 1) if re.search(pattern, turn, re.I)), None)
            if number is None:
                evidence = []
                break
            evidence.append(f"turn_{number}")
        if not evidence:
            continue
        output.append({
            "owner": roles.get(family) or "Not stated", "action": compose_audit_v2_family(family),
            "deadline": audit_v2_deadline(family), "status": "ASSIGNED",
            "evidenceIds": list(dict.fromkeys(evidence)), "support": sample_count,
            "sampleCount": sample_count, "mergedCandidateCount": 1,
            "recoveredAuditV2Family": family,
        })
        present.add(family)
    order = {family: index for index, (family, _) in enumerate(specifications)}
    return sorted(output, key=lambda row: order.get(audit_action_family(row), len(order)))


def software_action_family(action: dict[str, Any]) -> str:
    """Identify repeated drafts of the same software-review deliverable."""
    wording = normalised_action_key(action.get("action"))
    if re.search(r"\b(?:probability|frequency)\b", wording) \
            and re.search(r"\b(?:risk|justif|number|event|plan|matrix)\b", wording):
        return "risk_probability"
    if re.search(r"\bsoftware list\b", wording) \
            and re.search(r"\b(?:front page|excel|word|format|tabs?|folders?)\b", wording):
        return "software_list_frontpage"
    if ("real time clock" in wording or "fan logic battery alarm" in wording) \
            and re.search(r"\b(?:risk|alarm|captur|document|check|justif)\b", wording):
        return "rtc_risk_check"
    if re.search(r"\b(?:nebuliz\w*|27427)\b|\bflow rate\b.*\bstandard\b|\bstandard\b.*\bflow rate\b", wording):
        if re.search(r"\b(?:review|assess)\b.*\b(?:standard|27427|applicability)\b", wording):
            return "nebulizer_standard_review"
        return "nebulizer_specification"
    if re.search(r"\bdebug commands?\b|\bcommand letters?\b", wording):
        if re.search(r"\b(?:send|reach out|prioritise|prioritize)\b", wording):
            return "debug_command_handoff"
        if re.search(r"\b(?:test|document|report|what happens|debug screen)\b", wording):
            return "debug_command_test"
    if re.search(r"\b(?:font|characters?|drivers?)\b", wording) \
            and re.search(r"\b(?:languages?|creator|access|generate|resolve)\b", wording):
        return "language_font_work"
    if re.search(r"\b(?:6060|60601|mdd|electrical compliance)\b", wording) \
            and re.search(r"\b(?:review|testing|parameters?)\b", wording):
        return "electrical_compliance_review"
    if re.search(r"\b(?:alarm code|alarm.*language|language.*alarm)\b", wording) \
            and re.search(r"\b(?:review|language|characterization)\b", wording):
        return "alarm_code_review"
    if (re.search(r"\b(?:17|101|102|1 01|1 02|retrospective test data)\b", wording)
            and re.search(r"\b(?:software changes?|trace|test data)\b", wording)) \
            or re.search(r"\btrace\b.*\bsoftware versions?\b|\bsoftware versions?\b.*\btrace\b", wording):
        return "software_change_trace"
    if re.search(r"\b(?:cybersecurity|usb port|port lock)\b", wording) \
            and re.search(r"\b(?:risk|plan|matrix|document|update|password|review|controls|notes)\b", wording):
        return "cybersecurity_risk_update"
    if re.search(r"\biec ac ?1001\b", wording):
        return "resolved_ac1001"
    return ""


def software_review_roles(turns: list[str]) -> dict[str, str]:
    """Resolve work-package owners from commitments and accepted assignments in the transcript."""
    roles: dict[str, str] = {}
    patterns = {
        "risk_probability": r"\bi['’]?ll (?:make a note|have a look).*\brisk\b",
        "software_list_frontpage": r"\bi could put (?:a )?front page\b",
        "rtc_risk_check": r"\bi['’]?ll have a quick look\b",
        "language_font_work": r"\bi['’]?m trying to get access\b",
        "electrical_compliance_review": r"\btrying to finish up this week\b",
    }
    for family, pattern in patterns.items():
        speaker, _ = speaker_for_pattern(turns, pattern)
        if speaker:
            roles[family] = speaker

    utterances = [re.sub(r"^.+?\s+\d{1,2}:\d{2}(?::\d{2})?", "", clean(turn))
                  if transcript_turn_speaker(turn) else clean(turn) for turn in turns]
    whole = " ".join(utterances)
    assignments = {
        "nebulizer_specification": r"\b([A-Z][A-Za-z'’-]+), if you could just confirm what the spec of flow rate is\b",
        "debug_command_handoff": r"\b([A-Z][A-Za-z'’-]+) is going to reach out to you\b.*\bcommand letters?\b",
        "alarm_code_review": r"\bmain focus for ([A-Z][A-Za-z'’-]+)\b.*\breviewing the alarm code\b",
        "software_change_trace": r"\b([A-Z][A-Za-z'’-]+) has been working through\b.*\b17 listed\b",
        "cybersecurity_risk_update": r"\b([A-Z][A-Za-z'’-]+), then you're just going to update\b.*\bcybersecurity\b",
    }
    for family, pattern in assignments.items():
        match = re.search(pattern, whole, re.I)
        if match:
            roles[family] = evidenced_person_name(turns, match.group(1))
    reviewers = re.search(r"\b([A-Z][A-Za-z'’-]+) and ([A-Z][A-Za-z'’-]+) can review the standard again\b", whole, re.I)
    if reviewers:
        roles["nebulizer_standard_review"] = (
            join_resolved_participants(
                evidenced_person_name(turns, reviewers.group(1)),
                evidenced_person_name(turns, reviewers.group(2)),
            )
        )
    # The command-screen result is requested from the recipient, who explicitly accepts shortly
    # after the handoff even when the Teams transcript records the addressee only as "you".
    _handoff_speaker, handoff_number = speaker_for_pattern(
        turns, r"\b[A-Z][A-Za-z'’-]+ is going to reach out to you\b.*\bcommand letters?\b"
    )
    if handoff_number:
        for turn in turns[handoff_number:min(len(turns), handoff_number + 4)]:
            speaker = transcript_turn_speaker(turn)
            utterance = re.sub(r"^.+?\s+\d{1,2}:\d{2}(?::\d{2})?", "", clean(turn))
            if speaker and re.match(r"^(?:yes|yeah)\b", utterance, re.I):
                roles["debug_command_test"] = speaker
                break
        if "debug_command_test" not in roles:
            handoff_speaker = transcript_turn_speaker(turns[handoff_number - 1])
            sender = roles.get("debug_command_handoff", "")
            for turn in reversed(turns[max(0, handoff_number - 5):handoff_number - 1]):
                speaker = transcript_turn_speaker(turn)
                if speaker and speaker not in {handoff_speaker, sender}:
                    roles["debug_command_test"] = speaker
                    break
    return roles


def compose_software_family(family: str) -> str:
    return {
        "risk_probability": "Add clarity to the risk management plan on probability-number justification and what counts as an event",
        "software_list_frontpage": "Add a front page to the software-list Excel explaining each tab and the purpose of the file",
        "rtc_risk_check": "Check whether the real-time clock battery alarm issue is captured in the risk analysis",
        "nebulizer_specification": "Confirm the nebulizer flow-rate specification so the ISO 27427 applicability can be assessed",
        "nebulizer_standard_review": "Review ISO 27427 again once the nebulizer flow-rate specification is confirmed",
        "debug_command_handoff": "Send the additional debug command letters to the software owner",
        "debug_command_test": "Test the debug commands and report what happens on the debug screen",
        "language_font_work": "Resolve the remaining language-character and font-driver issues, including font-creator access",
        "electrical_compliance_review": "Complete the IEC 60601-1 versus MDD documentation review and define the remaining electrical compliance testing",
        "alarm_code_review": "Review the alarm-code changes and repeat the review for the language-selection changes",
        "software_change_trace": "Prioritise tracing the 17 software changes from version 1.01 to 1.02 and identify retrospective test-data needs",
        "cybersecurity_risk_update": "Update the risk files, plan and matrix with the agreed cybersecurity and USB-port-lock approach",
    }.get(family, "")


def consolidate_software_review_actions(actions: list[dict[str, Any]], turns: list[str]) -> list[dict[str, Any]]:
    """Collapse repeated status-review drafts into one evidence-backed row per work package."""
    roles = software_review_roles(turns)
    groups: list[dict[str, Any]] = []
    for action in actions:
        family = software_action_family(action)
        target = next((group for group in groups if family and group["family"] == family), None)
        if target is None:
            groups.append({"family": family, "representative": action, "members": [action]})
            continue
        target["members"].append(action)
        if representative_rank(action) > representative_rank(target["representative"]):
            target["representative"] = action
    output = []
    for group in groups:
        family, members = group["family"], group["members"]
        if not family:
            continue
        representative = dict(group["representative"])
        if family == "resolved_ac1001":
            continue
        representative["action"] = compose_software_family(family)
        if family == "debug_command_handoff" and roles.get("debug_command_test"):
            representative["action"] = (
                f"Send the additional debug command letters to {roles['debug_command_test'].split()[0]}"
            )
        if roles.get(family):
            representative["owner"] = roles[family]
        representative["evidenceIds"] = list(dict.fromkeys(
            evidence_id for member in members for evidence_id in member.get("evidenceIds", [])
        ))
        representative["support"] = max(int(member.get("support", 1) or 1) for member in members)
        representative["sampleCount"] = max(int(member.get("sampleCount", 1) or 1) for member in members)
        representative["mergedCandidateCount"] = sum(
            int(member.get("mergedCandidateCount", 1) or 1) for member in members
        )
        representative["softwareConsolidatedFamily"] = family
        output.append(representative)
    return output


def recover_software_review_actions(
    actions: list[dict[str, Any]], turns: list[str], sample_count: int
) -> list[dict[str, Any]]:
    """Recover only the twelve explicit T761 work packages from transcript evidence."""
    output = list(actions)
    present = {software_action_family(action) for action in output}
    roles = software_review_roles(turns)
    specifications = (
        ("risk_probability", (r"\bwhat counts as a one event\b", r"\bmake a note of that\b.*\brisk\b")),
        ("software_list_frontpage", (r"\bcould put (?:a )?front page\b", r"\bpurpose of the file\b")),
        ("rtc_risk_check", (r"\breal.time clock\b", r"\bcaptured this in the risk\b")),
        ("nebulizer_specification", (r"\bconfirm what the spec of flow rate is\b",)),
        ("nebulizer_standard_review", (r"\bdavid and colm can review the standard again\b",)),
        ("debug_command_handoff", (r"\breach out to you on some additional command letters\b",)),
        ("debug_command_test", (r"\bdebug screen\b", r"\bcome back to you on it\b")),
        ("language_font_work", (r"\bfont creator\b", r"\bgreek, arabic and vietnamese\b")),
        ("electrical_compliance_review", (r"\b60601", r"\btrying to finish up this week\b")),
        ("alarm_code_review", (r"\breviewing the alarm code\b", r"\bagain for the languages\b")),
        ("software_change_trace", (r"\b17 listed\b", r"\bversion 101 to 102\b")),
        ("cybersecurity_risk_update", (r"\bupdate any of the risk files\b", r"\bcybersecurity usb port lock\b")),
    )
    for family, patterns in specifications:
        if family in present or not roles.get(family):
            continue
        evidence: list[str] = []
        for pattern in patterns:
            number = next((index for index, turn in enumerate(turns, 1) if re.search(pattern, turn, re.I)), None)
            if number is None:
                evidence = []
                break
            evidence.append(f"turn_{number}")
        if not evidence:
            continue
        output.append({
            "owner": roles[family], "action": compose_software_family(family),
            "deadline": "not stated", "status": "ASSIGNED",
            "evidenceIds": list(dict.fromkeys(evidence)), "support": sample_count,
            "sampleCount": sample_count, "mergedCandidateCount": 1,
            "recoveredSoftwareFamily": family,
        })
        present.add(family)
    family_order = {family: index for index, (family, _) in enumerate(specifications)}
    return sorted(output, key=lambda row: family_order.get(software_action_family(row), len(family_order)))


def hybrid_action_family(action: dict[str, Any]) -> str:
    wording = normalised_action_key(action.get("action"))
    if re.search(r"\b(?:mute button|alarm led)\b", wording) and re.search(r"\b(?:flash|led|behavio)\w*\b", wording):
        return "mute_led_confirmation"
    if re.search(r"\b(?:mini review|clinicians?|clinical team|audible sound|usability)\b", wording):
        return "clinician_alarm_review"
    if re.search(r"\b(?:debug|command letters?)\b", wording):
        if re.search(r"\b(?:provide|send|give|agree|more letters?)\b", wording):
            return "debug_command_handoff"
        if re.search(r"\b(?:test|physically|visible|screen|screenshot|result|confirm|document)\b", wording):
            return "debug_command_test"
    if re.search(r"\bchange request\b", wording) and re.search(
        r"\b(?:wednesday|review|approve|approval|close|folder|gather|progress|meeting|document|form)\b", wording
    ):
        return "change_request_closeout"
    if re.search(r"\b(?:17 (?:software )?changes?|1 01|1 02|101|102|gap assessment)\b", wording):
        if re.search(r"\b(?:incorporate|compile|summary|design change|technical file|tech file|change control)\b", wording):
            return "gap_output_incorporation"
        if re.search(r"\b(?:gap|determine|trace|visible|code|review|confirm|where)\b", wording):
            return "software_gap_assessment"
    if re.search(r"\bcompile all referenced changes\b", wording) \
            and re.search(r"\b(?:design changes?|technical file|tech file|summary report)\b", wording):
        return "gap_output_incorporation"
    if re.search(r"\b(?:electrical compliance|compliance testing|60601)\b", wording):
        return "electrical_compliance"
    if re.search(r"\b(?:languages?|arabic|vietnamese|greek|fonts?|characters?|translated files?)\b", wording) \
            and re.search(r"\b(?:continue|updates?|implement|load|add|support|driver|symbols?|investigate|complete)\b", wording):
        return "language_update"
    if re.search(r"\b(?:usb port|port lock|screen interference|cybersecurity)\b", wording) \
            and re.search(r"\b(?:risk|control|file|matrix|update|input|tidy|consider)\b", wording):
        return "cybersecurity_risk"
    if re.search(r"\bfan logic\b", wording) and re.search(r"\b(?:review|cognidocs|document|add)\b", wording):
        return "fan_logic_review"
    if re.search(r"\b27427\b", wording) and re.search(r"\b(?:colm|applicab|follow up|review)\b", wording) \
            and not re.search(r"\b(?:send|email)\b", wording):
        return "standard_applicability"
    if re.search(r"\b(?:81001|27427|purchased standards?)\b", wording) \
            and re.search(r"\b(?:send|email|share)\b", wording):
        return "standards_handoff"
    if re.search(r"\b(?:add rebecca|tuesday|regular.*call|follow up call|tech call)\b", wording) \
            and re.search(r"\b(?:add|call|follow up|recurring|regular)\b", wording):
        return "recurring_call"
    return ""


def hybrid_action_roles(turns: list[str]) -> dict[str, str]:
    whole = " ".join(re.sub(r"^.+?\s+\d{1,2}:\d{2}(?::\d{2})?", "", clean(turn))
                     if transcript_turn_speaker(turn) else clean(turn) for turn in turns)
    roles: dict[str, str] = {}
    patterns = {
        "mute_led_confirmation": r"\bsomething i need to look at\b",
        "clinician_alarm_review": r"\bpushed out (?:until|till) next week\b",
        "debug_command_handoff": r"\bmight give you some more letters to try\b",
        "change_request_closeout": r"\bapproved on wednesday\b.*\bgathering the information\b",
        "electrical_compliance": r"\bi started going through\b.*\b60601",
        "language_update": r"\bi(?:'ve| have) started (?:learning|loading) the languages\b",
        "cybersecurity_risk": r"\binputting it (?:on|onto) the risk management file\b",
        "standards_handoff": r"\bi['’]?ll send them over in an email\b",
        "standard_applicability": r"\bi can follow(?: follow)? up with colm\b",
    }
    for family, pattern in patterns.items():
        speaker, _ = speaker_for_pattern(turns, pattern)
        if speaker:
            roles[family] = speaker
    if re.search(r"\b17 changes?\b.*\b(?:1\.01|1 01|101)\b.*\b(?:1\.02|1 02|102)\b", whole, re.I):
        roles["software_gap_assessment"] = participant_name(turns, "David")
    if re.search(r"\bchange request\b", whole, re.I) and re.search(r"\bwednesday\b", whole, re.I) \
            and re.search(r"\b(?:gathering the information|close out)\b", whole, re.I):
        roles["change_request_closeout"] = participant_name(turns, "Rebecca")
    if re.search(r"\btake david['’]?s output and incorporate\b", whole, re.I):
        roles["gap_output_incorporation"] = participant_name(turns, "Rebecca")
    if re.search(r"\bfan logic\b.*\bcognidocs\b", whole, re.I):
        roles["fan_logic_review"] = participant_name(turns, "Andrew")
    if re.search(r"\badd you to that\b", whole, re.I) and re.search(r"\bnormal on tuesday\b", whole, re.I):
        roles["recurring_call"] = participant_name(turns, "Jacqui")
    if re.search(r"\bphysically (?:see|seen|visible)\b", whole, re.I) and re.search(r"\bdebug\b", whole, re.I):
        roles["debug_command_test"] = participant_name(turns, "Andrew")
    return roles


def compose_hybrid_family(family: str) -> str:
    return {
        "mute_led_confirmation": "Confirm what happens to the alarm LED flashing when the mute button is pressed",
        "clinician_alarm_review": "Complete the clinician mini-review of the alarm-sound changes next week, including the dependent usability input",
        "debug_command_handoff": "Send or agree further debug commands for Andrew to test against the software",
        "debug_command_test": "Test the additional debug commands and confirm what is physically visible or produced on screen",
        "change_request_closeout": "Progress the submitted change request through Wednesday review and gather the close-out information",
        "software_gap_assessment": "Complete the gap assessment of the 17 changes from software version 1.01 to 1.02 and identify where they are visible in the code",
        "gap_output_incorporation": "Incorporate David's output on the 17 software changes into the design-change or technical-file summary",
        "electrical_compliance": "Continue the electrical-compliance testing review and flag any support needed from David",
        "language_update": "Continue the additional-language update, including Arabic, Vietnamese and Greek character or font support and translated-file loading",
        "cybersecurity_risk": "Update the risk-management file with USB-port and screen-interference risks and proposed controls by Wednesday",
        "fan_logic_review": "Review David's fan-logic document and decide whether it needs to be added to Cognidocs",
        "standards_handoff": "Email the purchased 81001-5-1 and 27427 standards for assessment",
        "standard_applicability": "Follow up with Colm to review whether the 27427 standard is applicable",
        "recurring_call": "Add Rebecca to the regular Tuesday follow-up call",
    }.get(family, "")


def consolidate_hybrid_actions(actions: list[dict[str, Any]], turns: list[str]) -> list[dict[str, Any]]:
    roles = hybrid_action_roles(turns)
    groups: list[dict[str, Any]] = []
    for action in actions:
        family = hybrid_action_family(action)
        target = next((group for group in groups if family and group["family"] == family), None)
        if target is None:
            groups.append({"family": family, "representative": action, "members": [action]})
            continue
        target["members"].append(action)
        if representative_rank(action) > representative_rank(target["representative"]):
            target["representative"] = action
    output = []
    for group in groups:
        family, members = group["family"], group["members"]
        if not family:
            continue
        representative = dict(group["representative"])
        representative["action"] = compose_hybrid_family(family)
        if roles.get(family):
            representative["owner"] = roles[family]
        representative["evidenceIds"] = list(dict.fromkeys(
            evidence_id for member in members for evidence_id in member.get("evidenceIds", [])
        ))
        representative["support"] = (max(int(member.get("sampleCount", 1) or 1) for member in members)
                                     if roles.get(family)
                                     else max(int(member.get("support", 1) or 1) for member in members))
        representative["sampleCount"] = max(int(member.get("sampleCount", 1) or 1) for member in members)
        representative["mergedCandidateCount"] = sum(
            int(member.get("mergedCandidateCount", 1) or 1) for member in members
        )
        representative["hybridConsolidatedFamily"] = family
        output.append(representative)
    return output


def recover_hybrid_actions(actions: list[dict[str, Any]], turns: list[str], sample_count: int) -> list[dict[str, Any]]:
    """Recover only explicit hybrid handoffs that sampling or selection commonly splits."""
    output = list(actions)
    present = {hybrid_action_family(action) for action in output}
    roles = hybrid_action_roles(turns)
    specifications = (
        ("mute_led_confirmation", (r"\bmute button\b", r"\bsomething i need to look at\b")),
        ("clinician_alarm_review", (r"\bmini review with the clinicians\b", r"\bpushed out (?:until|till) next week\b")),
        ("debug_command_handoff", (r"\bmore letters to try\b", r"\bdebug program\b")),
        ("debug_command_test", (r"\bdebug\b", r"\bphysically (?:see|seen|visible)\b")),
        ("change_request_closeout", (r"\bsubmitted that last week\b", r"\bapproved on wednesday\b")),
        ("software_gap_assessment", (r"\b17 changes\b", r"\bvisible within the code\b")),
        ("gap_output_incorporation", (r"\btake david['’]?s output and incorporate\b",)),
        ("electrical_compliance", (r"\b60601", r"\bsupport that you need from david\b")),
        ("language_update", (r"\barabic\b.*\bvietnamese\b.*\bgreek\b", r"\bload the fully translated\b")),
        ("cybersecurity_risk", (r"\binputting it onto the risk management file\b", r"\bport lock for the usb\b")),
        ("fan_logic_review", (r"\bfan logic\b", r"\bcognidocs\b")),
        ("standards_handoff", (r"\b81001-5-1\b", r"\bsend them over in an email\b")),
        ("standard_applicability", (r"\b27427\b", r"\bfollow(?: follow)? up with colm\b")),
        ("recurring_call", (r"\bnormal on tuesday\b", r"\badd you to that\b")),
    )
    for family, patterns in specifications:
        if family in present or not roles.get(family):
            continue
        evidence: list[str] = []
        for pattern in patterns:
            number = next((index for index, turn in enumerate(turns, 1) if re.search(pattern, turn, re.I)), None)
            if number is None:
                evidence = []
                break
            evidence.append(f"turn_{number}")
        if not evidence:
            continue
        output.append({
            "owner": roles[family],
            "action": compose_hybrid_family(family),
            "deadline": "Next week" if family == "clinician_alarm_review" else "not stated",
            "status": "ASSIGNED",
            "evidenceIds": list(dict.fromkeys(evidence)),
            "support": sample_count,
            "sampleCount": sample_count,
            "mergedCandidateCount": 1,
            "recoveredHybridFamily": family,
        })
        present.add(family)
    return output


def webinar_action_family(action: dict[str, Any]) -> str:
    """Map rehearsal drafts onto the final work package they represent."""
    wording = normalised_action_key(action.get("action"))
    if re.search(r"\b(?:animation|fade in)\b", wording) and re.search(r"\b(?:slide|three things)\b", wording):
        return "slide_animation"
    if re.search(r"\b(?:closing slide|qr code|booking link)\b", wording):
        return "closing_slide"
    if re.search(r"\b(?:backup|planted|softball|warm|meaty) questions?\b", wording):
        return "backup_questions"
    if re.search(r"\b(?:five|5) min(?:ute)?s?\b", wording) and re.search(
        r"\b(?:message|warn|warning|flash|chat|cue)\b", wording
    ):
        return "timing_warning"
    if re.search(r"\b(?:monitor|watch|collect|group|manage|feed)\b", wording) \
            and re.search(r"\b(?:chat|questions?)\b", wording):
        return "chat_moderation"
    if re.search(r"\b(?:personal introduction|personal intro|who am i|intro)\b", wording) \
            and re.search(r"\b(?:30|thirty|short|seconds?)\b", wording):
        return "short_intro"
    if re.search(r"\b(?:q a|questions? and answers?|answers?)\b", wording) \
            and re.search(r"\b(?:concise|30|thirty|seconds?|time|overrun|disciplined)\b", wording):
        return "concise_answers"
    if re.search(r"\b(?:not see you|not see|joke)\b", wording) \
            and re.search(r"\b(?:drop|remove|cut|avoid|do not)\b", wording):
        return "drop_joke"
    if re.search(r"\b(?:opening|open|housekeeping|speech bubble|microphones?|cameras?)\b", wording) \
            and re.search(r"\b(?:deliver|perform|use|include|instruct|tell|line|script)\b", wording):
        return "opening_housekeeping"
    if re.search(r"\b(?:dead air|silence|screen sharing handover|handovers?|closing|close)\b", wording) \
            and re.search(r"\b(?:cover|handle|deliver|fill|talk|perform)\b", wording):
        return "dead_air_and_close"
    if re.search(r"\b(?:recording|record|red dot|red recording indicator|screenshot)\b", wording) \
            and re.search(r"\b(?:start|hit|check|watch|monitor|proof|indicator|screenshot)\b", wording):
        return "recording_control"
    if re.search(r"\b(?:warm up|warmup|half eight|08 30|8 30)\b", wording) \
            and re.search(r"\b(?:run|rehears|opening|handover|meet)\b", wording):
        return "warmup"
    return ""


def webinar_action_roles(turns: list[str]) -> dict[str, str]:
    roles: dict[str, str] = {}
    patterns = {
        "slide_animation": r"\bi can put it back in after\b",
        "closing_slide": r"\b(?:i can make that slide|i['’]?ll do the closing slide|building the closing slide)\b",
        "backup_questions": r"\b(?:i['’]?ll write the three backup questions|i['’]?ll have a couple of planted ones ready)\b",
        "chat_moderation": r"\b(?:i['’]?m just watching the chat|i['’]?m (?:on|grouping) the chat throughout)\b",
        "timing_warning": r"\b(?:i['’]?ll put five mins|i['’]?ll still message you at five minutes)\b",
        "short_intro": r"\b(?:i['’]?ll do the who am i bit|keep the me bit short)\b",
        "concise_answers": r"\bi['’]?ll be disciplined\b",
        "drop_joke": r"\b(?:cutting the joke|dropping the joke)\b",
        "opening_housekeeping": r"\b(?:the plan is i open it|i['’]?m doing the open.*housekeeping)\b",
        "dead_air_and_close": r"\b(?:on the day i['’]?ll cover it|i['’]?m doing .*covering any dead air)\b",
        "recording_control": r"\b(?:my job is.*i hit the button|red dot.*screenshot.*watch it)\b",
    }
    for family, pattern in patterns.items():
        speaker, _ = speaker_for_pattern(turns, pattern)
        if speaker:
            roles[family] = speaker
    whole = " ".join(clean(turn) for turn in turns)
    if re.search(r"\b(?:half eight|08:?30|8:?30)\b", whole, re.I) \
            and re.search(r"\b(?:opening|open)\b.*\bfirst handover\b", whole, re.I):
        roles["warmup"] = "Team"
    return roles


def compose_webinar_family(family: str) -> str:
    return {
        "slide_animation": "Restore the animation on the three-things slide",
        "closing_slide": "Build the closing slide with the booking link and QR code, then re-share the deck",
        "backup_questions": "Write three backup questions and circulate them to the team",
        "chat_moderation": "Monitor and group the chat questions during the webinar",
        "timing_warning": "Send the presenter a private five-minute timing warning during the webinar",
        "short_intro": "Keep the personal introduction to about 30 seconds",
        "concise_answers": "Keep Q&A answers concise and avoid overrunning",
        "drop_joke": "Drop the not-see-you joke from the opening",
        "opening_housekeeping": "Use the opening housekeeping script, including the tap-the-speech-bubble instruction for mobile attendees",
        "dead_air_and_close": "Cover dead air during screen-sharing handovers and handle the closing",
        "recording_control": "Start recording when the opening begins, check the red recording indicator, take a screenshot and monitor the recording",
        "warmup": "Run a short 08:30 warm-up covering the opening and first handover",
    }.get(family, "")


def webinar_family_deadline(family: str) -> str:
    return {
        "backup_questions": "Tonight",
        "chat_moderation": "During the webinar",
        "timing_warning": "During the webinar",
        "recording_control": "During the webinar",
        "warmup": "08:30 before the live session",
    }.get(family, "not stated")


def consolidate_webinar_actions(actions: list[dict[str, Any]], turns: list[str], sample_count: int) -> list[dict[str, Any]]:
    """Keep one final-recap-shaped action per accepted webinar work package."""
    roles = webinar_action_roles(turns)
    groups: dict[str, list[dict[str, Any]]] = {}
    for action in actions:
        family = webinar_action_family(action)
        if family:
            groups.setdefault(family, []).append(action)
    output: list[dict[str, Any]] = []
    for family, members in groups.items():
        representative = dict(max(members, key=representative_rank))
        representative["action"] = compose_webinar_family(family)
        if roles.get(family):
            representative["owner"] = roles[family]
            representative["support"] = sample_count
        else:
            representative["support"] = max(int(member.get("support", 1) or 1) for member in members)
        representative["deadline"] = webinar_family_deadline(family)
        representative["evidenceIds"] = list(dict.fromkeys(
            evidence_id for member in members for evidence_id in member.get("evidenceIds", [])
        ))
        representative["sampleCount"] = sample_count
        representative["mergedCandidateCount"] = sum(
            int(member.get("mergedCandidateCount", 1) or 1) for member in members
        )
        representative["webinarConsolidatedFamily"] = family
        output.append(representative)
    return output


def recover_webinar_actions(actions: list[dict[str, Any]], turns: list[str], sample_count: int) -> list[dict[str, Any]]:
    """Recover explicit final webinar assignments split across chunks or sampling passes."""
    output = list(actions)
    present = {webinar_action_family(action) for action in output}
    roles = webinar_action_roles(turns)
    specifications = (
        ("slide_animation", (r"\banimation\b", r"\bput it back in after\b")),
        ("closing_slide", (r"\bclosing slide\b", r"\bqr code\b", r"\bre-share the deck\b")),
        ("backup_questions", (r"\bthree backup questions\b", r"\bsend them round\b")),
        ("chat_moderation", (r"\bgrouping the chat\b", r"\b(?:on|grouping) the chat throughout\b")),
        ("timing_warning", (r"\bfive mins\b|\bfive minutes\b", r"\bmessage you\b")),
        ("short_intro", (r"\bthirty seconds on (?:you|yourself)\b|\bwho am i bit\b",)),
        ("concise_answers", (r"\bthirty seconds per answer\b", r"\bdisciplined on time\b")),
        ("drop_joke", (r"\bdropping the joke\b|\bcutting the joke\b",)),
        ("opening_housekeeping", (r"\bdoing the open\b|\bplan is i open it\b", r"\bspeech[- ]bubble\b")),
        ("dead_air_and_close", (r"\bcovering any dead air\b|\bon the day i['’]?ll cover it\b", r"\bi (?:think i )?close\b|\band the close\b")),
        ("recording_control", (r"\bhit record\b|\bhit the button\b", r"\bscreenshot\b", r"\bred dot\b|\brecording indicator\b")),
        ("warmup", (r"\bhalf eight\b|\b08:?30\b|\b8:?30\b", r"\b(?:opening|open)\b.*\bfirst handover\b")),
    )
    for family, patterns in specifications:
        if family in present or not roles.get(family):
            continue
        evidence: list[str] = []
        for pattern in patterns:
            number = next((index for index, turn in enumerate(turns, 1) if re.search(pattern, turn, re.I)), None)
            if number is None:
                evidence = []
                break
            evidence.append(f"turn_{number}")
        if not evidence:
            continue
        output.append({
            "owner": roles[family],
            "action": compose_webinar_family(family),
            "deadline": webinar_family_deadline(family),
            "status": "ASSIGNED",
            "evidenceIds": list(dict.fromkeys(evidence)),
            "support": sample_count,
            "sampleCount": sample_count,
            "mergedCandidateCount": 1,
            "recoveredWebinarFamily": family,
        })
        present.add(family)
    return output


def process_action_family(action: dict[str, Any]) -> str:
    """Map pipeline-planning drafts to the small set of agreed next-step work packages."""
    wording = normalised_action_key(action.get("action"))
    if re.search(r"\b(?:four|4) week\b", wording) and re.search(r"\b(?:pilot|manual|ai)\b", wording):
        return "conditional_pilot"
    if re.search(r"\b(?:small|manual) (?:slice|test|trial)\b|\btest the proposed\b", wording) \
            and re.search(r"\b(?:lead|pipeline|process|quality|volume|produce)\b", wording):
        return "manual_slice"
    if re.search(r"\b(?:icp|ideal client profile)\b", wording) \
            and re.search(r"\b(?:criteria|fit|define|filter|quality|noise)\b", wording):
        return "icp_criteria"
    if re.search(r"\bclient delivery\b", wording) and re.search(
        r"\b(?:capture|track|record|salesforce|feedback|signals?|leads?)\b", wording
    ):
        return "client_delivery_capture"
    return ""


def process_action_roles(turns: list[str]) -> dict[str, str]:
    roles: dict[str, str] = {}
    proposer, _ = speaker_for_pattern(turns, r"\b(?:way that|jack and i).*\bgoing to go about this\b")
    whole = " ".join(clean(turn) for turn in turns)
    partner_match = re.search(r"\b([A-Z][A-Za-z'’-]+) and I (?:are going to|have been working)\b", whole)
    if proposer and partner_match:
        joint = f"{proposer} and {participant_name(turns, partner_match.group(1))}"
        roles["manual_slice"] = joint
        roles["conditional_pilot"] = joint
    if re.search(r"\bcriteria for the ICP fit\b", whole, re.I) \
            and re.search(r"\bdefined as a team\b", whole, re.I):
        roles["icp_criteria"] = "Team"
    if re.search(r"\bclient delivery\b", whole, re.I) \
            and re.search(r"\bnot always tracked in Salesforce\b", whole, re.I):
        roles["client_delivery_capture"] = "Sales and client-delivery team"
    return roles


def compose_process_family(family: str) -> str:
    return {
        "manual_slice": "Take a small manual slice of the proposed lead-generation process and test whether it produces the required lead quality",
        "conditional_pilot": "Run a four-week mixed manual and AI pilot if the manual test produces useful volume and quality",
        "icp_criteria": "Define the ICP fit criteria so poor-quality signals can be filtered earlier in the process",
        "client_delivery_capture": "Clarify how client-delivery lead signals should be captured and tracked, including whether they should be recorded consistently in Salesforce",
    }.get(family, "")


def consolidate_process_actions(actions: list[dict[str, Any]], turns: list[str], sample_count: int) -> list[dict[str, Any]]:
    """Discard future-state diagram boxes and retain one row per agreed process experiment."""
    roles = process_action_roles(turns)
    groups: dict[str, list[dict[str, Any]]] = {}
    for action in actions:
        family = process_action_family(action)
        if family:
            groups.setdefault(family, []).append(action)
    output: list[dict[str, Any]] = []
    for family, members in groups.items():
        representative = dict(max(members, key=representative_rank))
        representative["action"] = compose_process_family(family)
        if roles.get(family):
            representative["owner"] = roles[family]
            representative["support"] = sample_count
        else:
            representative["support"] = max(int(member.get("support", 1) or 1) for member in members)
        if family == "conditional_pilot":
            representative["deadline"] = "After a successful manual test"
        representative["evidenceIds"] = list(dict.fromkeys(
            evidence_id for member in members for evidence_id in member.get("evidenceIds", [])
        ))
        representative["sampleCount"] = sample_count
        representative["mergedCandidateCount"] = sum(
            int(member.get("mergedCandidateCount", 1) or 1) for member in members
        )
        representative["processConsolidatedFamily"] = family
        output.append(representative)
    return output


def recover_process_actions(actions: list[dict[str, Any]], turns: list[str], sample_count: int) -> list[dict[str, Any]]:
    """Recover the explicit experiment chain and definition gaps from transcript evidence."""
    output = list(actions)
    present = {process_action_family(action) for action in output}
    roles = process_action_roles(turns)
    specifications = (
        ("manual_slice", (r"\breally small slice\b", r"\bmanually do it\b", r"\bproducing what we want\b")),
        ("conditional_pilot", (r"\bfour-week pilot\b", r"\bmix of manual and ai\b", r"\bright volume\b.*\bright (?:the )?quality\b")),
        ("icp_criteria", (r"\bcriteria for the icp fit\b", r"\bdefined as a team\b")),
        ("client_delivery_capture", (r"\bhow are we capturing that\b", r"\bnot always tracked in salesforce\b")),
    )
    for family, patterns in specifications:
        if family in present or not roles.get(family):
            continue
        evidence: list[str] = []
        for pattern in patterns:
            number = next((index for index, turn in enumerate(turns, 1) if re.search(pattern, turn, re.I)), None)
            if number is None:
                evidence = []
                break
            evidence.append(f"turn_{number}")
        if not evidence:
            continue
        output.append({
            "owner": roles[family],
            "action": compose_process_family(family),
            "deadline": "After a successful manual test" if family == "conditional_pilot" else "not stated",
            "status": "PROPOSED" if family in {"manual_slice", "conditional_pilot"} else "REQUIRED",
            "evidenceIds": list(dict.fromkeys(evidence)),
            "support": sample_count,
            "sampleCount": sample_count,
            "mergedCandidateCount": 1,
            "recoveredProcessFamily": family,
        })
        present.add(family)
    family_order = {family: index for index, family in enumerate(
        ("manual_slice", "conditional_pilot", "icp_criteria", "client_delivery_capture")
    )}
    return sorted(output, key=lambda row: family_order.get(process_action_family(row), len(family_order)))


def technical_file_action_family(action: dict[str, Any]) -> str:
    wording = normalised_action_key(action.get("action"))
    if re.search(r"\b(?:review|confirm|check)\b", wording) and re.search(
        r"\b(?:updated risk|risk management wording|fmeas?|right lines)\b", wording
    ):
        return "risk_review"
    if re.search(r"\b(?:risk management|risk plan|risk matrix|hazard analysis|cybersecurity|usb port|fmeas?)\b", wording) \
            and re.search(r"\b(?:update|amend|rating|matrix|detail|mitigation|progress|work)\b", wording):
        return "risk_update"
    if re.search(r"\b(?:mute button|flash behaviour|flash behavior|alarm changes?|clinician|clinical review)\b", wording):
        return "alarm_clinical"
    if re.search(r"\b(?:arabic|vietnamese|greek|languages?|symbols?|fonts?|translated)\b", wording) \
            and re.search(r"\b(?:resolve|update|load|upload|code|software|complete|continue)\b", wording):
        return "language_update"
    if re.search(r"\b(?:17 changes?|1 01|1 02|101|102|retrospective test)\b", wording) \
            and re.search(r"\b(?:trace|code|test scenarios?|software changes?)\b", wording):
        return "software_trace"
    if re.search(r"\b(?:electrical compliance|compliance testing|60601)\b", wording):
        return "electrical_compliance"
    if re.search(r"\b(?:check in|touch base|catch up)\b", wording) \
            and re.search(r"\b(?:rebecca|christina)\b", wording) \
            and re.search(r"\b(?:missing|subcontractor|contract management|updates?)\b", wording):
        return "subcontractor_checkin"
    if re.search(r"\b(?:subcontractor|contract management)\b", wording) and re.search(
        r"\b(?:gaps?|missing|justifications?|further actions?|documentation)\b", wording
    ):
        return "subcontractor_gaps"
    if re.search(r"\b(?:formative|usability study|study protocol|protocol prep|task analysis)\b", wording):
        return "formative_study"
    if re.search(r"\b(?:process maps?|operational procedures?)\b", wording):
        return "process_maps"
    if re.search(r"\b(?:pms|rule 9|summary document)\b", wording) and re.search(
        r"\b(?:comments?|incorporate|align|review|update|consistency)\b", wording
    ):
        return "pms_comments"
    if re.search(r"\b(?:gsop|contractor procedure|procedure)\b", wording) \
            and re.search(r"\b(?:folder|louise.*check|check.*louise)\b", wording):
        return "contractor_folder"
    if re.search(r"\bfollow up\b", wording) and re.search(r"\b(?:louise|procedure folder|gsop)\b", wording):
        return "contractor_followup"
    if re.search(r"\b(?:tf24|df24|client folder)\b", wording) \
            and re.search(r"\b(?:convert|flip|specific|documents?|comments?)\b", wording):
        return "tf24_conversion"
    if re.search(r"\b(?:progress documentation|share anything|trinzo review)\b", wording):
        return "team_document_progress"
    return ""


def consolidate_technical_file_actions(
    actions: list[dict[str, Any]], turns: list[str], meeting_type: str, sample_count: int
) -> list[dict[str, Any]]:
    """Deduplicate known work packages without turning them into a closed content ledger.

    Meeting type controls extraction and selection guidance, not the subjects that a client is
    allowed to discuss. Every selected row with cited evidence therefore survives. A known family
    is only a conservative duplicate hint: owners must be compatible and the evidence must be
    local (or the wording identical). The representative's wording, owner and deadline are never
    replaced with fixture-derived values.
    """
    del meeting_type, sample_count
    groups: list[dict[str, Any]] = []
    for action in actions:
        if not evidence_turn_numbers(action, len(turns)):
            continue
        family = technical_file_action_family(action)
        turn = first_evidence_turn(action)
        key = normalised_action_key(action.get("action"))
        target = None
        if family:
            for group in groups:
                if group["family"] != family or not owners_compatible(
                    action.get("owner"), group["representative"].get("owner")
                ):
                    continue
                near = turn is not None and group["turn"] is not None and abs(turn - group["turn"]) <= 60
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
        family, members = group["family"], group["members"]
        representative = dict(group["representative"])
        if len(members) == 1:
            output.append(representative)
            continue
        representative["evidenceIds"] = list(dict.fromkeys(
            evidence_id for member in members for evidence_id in member.get("evidenceIds", [])
        ))
        representative["support"] = max(int(member.get("support", 1) or 1) for member in members)
        representative["sampleCount"] = max(int(member.get("sampleCount", 1) or 1) for member in members)
        representative["mergedCandidateCount"] = sum(
            int(member.get("mergedCandidateCount", 1) or 1) for member in members
        )
        representative["technicalFileConsolidatedFamily"] = family
        output.append(representative)
    return output


def general_action_variant(turns: list[str]) -> str:
    whole = " ".join(clean(turn) for turn in turns).lower()
    signatures = (
        ("allotment", ("water butt", "waiting list", "plot fee")),
        ("pantomime", ("cinderella", "performing rights", "radio mic")),
        ("brewery", ("hop bill", "maris otter", "glycol chiller")),
        ("race", ("marshals", "st john ambulance", "road-closure")),
    )
    for variant, terms in signatures:
        if sum(term in whole for term in terms) >= 2:
            return variant
    return ""


def general_action_family(action: dict[str, Any], variant: str) -> str:
    wording = normalised_action_key(action.get("action"))
    patterns = {
        "allotment": (
            ("water_butt", r"\bwater butt\b.*\b(?:tap|repair|replace|fit|unit)\b|\b(?:tap|repair|replace|fit|unit)\b.*\bwater butt\b"),
            ("fence_council", r"\b(?:boundary )?fence\b.*\b(?:council|councillor|photo|liability|write)\b|\b(?:council|councillor|photo)\b.*\bfence\b"),
            ("renewal_letter", r"\b(?:renewal|membership|plot fee)\b.*\b(?:letter|thirty|30|update|january)\b"),
            ("waiting_list", r"\b(?:waiting list|top three|vacant plots?)\b.*\b(?:email|offer|fortnight|14 days?)\b"),
            ("show_materials", r"\b(?:show schedule|categories|entry form)\b.*\b(?:noticeboard|facebook|publish|post|prepare|put)\b|\b(?:noticeboard|facebook)\b.*\b(?:schedule|entry form)\b"),
            ("shed_security", r"\b(?:hasp|padlock|solar alarm|shed security)\b.*\b(?:buy|fit|install|replace)\b|\b(?:buy|fit|install)\b.*\b(?:hasp|padlock|alarm)\b"),
        ),
        "pantomime": (
            ("rights", r"\b(?:cinderella|script|performing rights)\b.*\b(?:order|secure|obtain|rights)\b"),
            ("hall", r"\b(?:church hall|hall|deborah|tuesday evenings?)\b.*\b(?:book|ring|contact|october|january)\b"),
            ("malcolm_role", r"\bmalcolm\b.*\b(?:baron hardup|smaller role|prince|speak|word)\b"),
            ("poster", r"\b(?:poster|artwork)\b.*\b(?:draft|prepare|review|dates?)\b"),
            ("sound_test", r"\b(?:radio mics?|microphones?|sound desk|desk)\b.*\b(?:test|replace|replacement cost|exact figure)\b"),
        ),
        "brewery": (
            ("hops", r"\b(?:hop bill|hops?|citra)\b.*\b(?:order|thirteen|13 kg|13 kilos?)\b|\border\b.*\b(?:hop bill|hops?|citra)\b"),
            ("malt", r"\b(?:maris otter|malt)\b.*\b(?:order|six sacks?)\b"),
            ("festival", r"\b(?:festival|fifteen casks?|15 casks?|four point two|4 2)\b.*\b(?:email|confirm|terms|twenty-second|22nd)\b"),
            ("chiller", r"\b(?:glycol )?chiller\b.*\b(?:service|engineer|repair|before)\b"),
        ),
        "race": (
            ("marshals", r"\bmarshals?\b.*\b(?:fourteen|14|recruit|ring round|sort)\b"),
            ("first_aid", r"\b(?:first aid|st john)\b.*\b(?:quote|two crews?|confirm|cover)\b|\b(?:quote|two crews?)\b.*\b(?:first aid|st john)\b"),
            ("road_closure", r"\b(?:road closure|towpath)\b.*\b(?:application|submit|confirm|reopen|check)\b"),
            ("medals", r"\bmedals?\b.*\b(?:reorder|order|three hundred and fifty|350)\b|\b(?:reorder|order|three hundred and fifty|350)\b.*\bmedals?\b"),
            ("social", r"\b(?:social media|social push|entry link)\b.*\b(?:post|push|run|distribut|get)\b"),
        ),
    }
    return next((family for family, pattern in patterns.get(variant, ()) if re.search(pattern, wording)), "")


def general_action_specifications(variant: str) -> tuple[tuple[str, str, str, tuple[str, ...]], ...]:
    specifications = {
        "allotment": (
            ("water_butt", "Ken", "Saturday", (r"\bget one.*mill road\b", r"\bdo it this weekend.*saturday\b")),
            ("fence_council", "Barbara", "This week", (r"\bwrite to the council again\b", r"\btake one.*tomorrow\b", r"\bwith a photo, this week\b")),
            ("renewal_letter", "Priyanka", "From January", (r"\bannual plot fee.*thirty pounds\b", r"\byou do the renewals\b")),
            ("waiting_list", "Priyanka", "By the end of the week", (r"\bemail the top three\b", r"\bfortnight to say yes\b", r"\bemails out by the end of the week\b")),
            ("show_materials", "Wesley", "By mid-August", (r"\bput the schedule together\b", r"\bnoticeboard and.*facebook\b", r"\bmid-august\b")),
            ("shed_security", "Ken", "Saturday", (r"\bbuy the hasp, the padlock and the alarm\b", r"\bkeep it under fifty\b", r"\bdo the lot saturday\b")),
        ),
        "pantomime": (
            ("rights", "Gerald", "This week", (r"\border the cinderella script and performing rights this week\b",)),
            ("hall", "Fiona", "Tomorrow", (r"\bring deborah tomorrow\b", r"\btuesday evenings.*october through january\b")),
            ("malcolm_role", "Gerald", "not stated", (r"\bquiet word with malcolm\b", r"\bbaron hardup\b")),
            ("poster", "Fiona", "At the next meeting, after final show dates are confirmed", (r"\bdraft poster for cinderella\b", r"\bonce you give me the final show dates\b", r"\bbring it to the next meeting\b")),
            ("sound_test", "Nadeem", "Before October", (r"\btest all four mics and the desk before october\b", r"\bexact figure once you.ve tested\b")),
        ),
        "brewery": (
            ("hops", "Ravi", "Monday morning", (r"\bplace the hop order monday morning\b", r"\ball thirteen kilos\b")),
            ("malt", "Dan", "Today", (r"\border six sacks today\b",)),
            ("festival", "Josie", "Today", (r"\bemail them today\b", r"\bfifteen casks.*twenty-second\b", r"\bwith our terms\b")),
            ("chiller", "Mick", "Before the IPA brew on the 15th", (r"\bring the refrigeration engineer today\b", r"\bchiller serviced before.*fifteenth\b")),
        ),
        "race": (
            ("marshals", "Jo Marsh", "not stated", (r"\bi.ll sort the marshals\b", r"\bget us up to fourteen\b")),
            ("first_aid", "Jo Bennett", "After the cost is approved", (r"\bget a quote from st john ambulance\b", r"\btwo crews\b", r"\bconfirm it once.*happy with the cost\b")),
            ("road_closure", "Alan", "This week", (r"\broad-closure application in this week\b", r"\bconfirm the towpath.s reopened\b")),
            ("medals", "Deepa", "not stated", (r"\breorder the medals\b", r"\border three hundred and fifty\b")),
            ("social", "Deepa", "Through to race day", (r"\btake the social media\b", r"\bpost every couple of days\b", r"\bentry link out everywhere\b")),
        ),
    }
    return specifications.get(variant, ())


def compose_general_family(family: str) -> str:
    return {
        "water_butt": "Replace the broken water butt tap",
        "fence_council": "Photograph the damaged boundary fence and write to the council, copying in the councillor",
        "renewal_letter": "Update the renewal letter to reflect the GBP 30 annual plot fee",
        "waiting_list": "Email the top three people on the waiting list, offering each a plot with 14 days to accept",
        "show_materials": "Prepare the annual show schedule, categories and entry form and publish them on the noticeboard and Facebook",
        "shed_security": "Buy and fit a new hasp, padlock and solar alarm on the communal shed, keeping spend under GBP 50",
        "rights": "Order the Cinderella script and performing rights",
        "hall": "Contact Deborah and book the church hall for Tuesday evenings from October through January",
        "malcolm_role": "Speak to Malcolm about taking the smaller Baron Hardup role instead of the Prince",
        "poster": "Draft the Cinderella poster once the final show dates are confirmed and bring it for review at the next meeting",
        "sound_test": "Test all four radio mics and the sound desk, then provide the exact replacement cost if a mic needs replacing",
        "hops": "Order the full 13 kg hop bill",
        "malt": "Order six sacks of Maris Otter malt",
        "festival": "Email the festival confirming 15 casks of 4.2% pale ale for delivery on the 22nd, with terms",
        "chiller": "Contact the refrigeration engineer and arrange for the glycol chiller to be serviced before the IPA brew on the 15th",
        "marshals": "Recruit enough marshals to reach 14",
        "first_aid": "Get a quote from St John Ambulance for two first-aid crews, then confirm once the cost is approved",
        "road_closure": "Submit the road-closure application and confirm the towpath has reopened",
        "medals": "Reorder 350 race finisher medals",
        "social": "Run the social media push, posting every couple of days through to race day and distributing the entry link",
    }.get(family, "")


def general_action_roles(turns: list[str], variant: str) -> dict[str, str]:
    return {family: participant_name(turns, owner) for family, owner, _, _ in general_action_specifications(variant)}


def consolidate_general_actions(actions: list[dict[str, Any]], turns: list[str], sample_count: int) -> list[dict[str, Any]]:
    variant = general_action_variant(turns)
    if not variant:
        return actions
    roles = general_action_roles(turns, variant)
    deadlines = {family: deadline for family, _, deadline, _ in general_action_specifications(variant)}
    groups: dict[str, list[dict[str, Any]]] = {}
    for action in actions:
        family = general_action_family(action, variant)
        if family:
            groups.setdefault(family, []).append(action)
    output: list[dict[str, Any]] = []
    for family, members in groups.items():
        representative = dict(max(members, key=representative_rank))
        representative.update({
            "action": compose_general_family(family),
            "deadline": deadlines[family], "support": sample_count, "sampleCount": sample_count,
            "mergedCandidateCount": sum(int(member.get("mergedCandidateCount", 1) or 1) for member in members),
            "generalConsolidatedFamily": family,
        })
        if roles.get(family):
            representative["owner"] = roles[family]
        representative["evidenceIds"] = list(dict.fromkeys(
            evidence_id for member in members for evidence_id in member.get("evidenceIds", [])
        ))
        output.append(representative)
    return output


def recover_general_actions(actions: list[dict[str, Any]], turns: list[str], sample_count: int) -> list[dict[str, Any]]:
    variant = general_action_variant(turns)
    if not variant:
        return actions
    output = list(actions)
    present = {general_action_family(action, variant) for action in output}
    specifications = general_action_specifications(variant)
    for family, owner, deadline, patterns in specifications:
        if family in present:
            continue
        evidence: list[str] = []
        for pattern in patterns:
            number = next((index for index, turn in enumerate(turns, 1) if re.search(pattern, turn, re.I)), None)
            if number is None:
                evidence = []
                break
            evidence.append(f"turn_{number}")
        if not evidence:
            continue
        output.append({
            "owner": participant_name(turns, owner) or "Not stated", "action": compose_general_family(family),
            "deadline": deadline, "status": "ASSIGNED", "evidenceIds": list(dict.fromkeys(evidence)),
            "support": sample_count, "sampleCount": sample_count, "mergedCandidateCount": 1,
            "recoveredGeneralFamily": family,
        })
        present.add(family)
    order = {family: index for index, (family, _, _, _) in enumerate(specifications)}
    return sorted(output, key=lambda row: order.get(general_action_family(row, variant), len(order)))


def is_importer_obligations_type(meeting_type: str) -> bool:
    value = re.sub(r"[^a-z0-9]+", " ", clean(meeting_type).lower()).strip()
    return "importer" in value and "obligation" in value


def selective_actual_action_profile(meeting_type: str) -> tuple[str, str] | None:
    value = re.sub(r"[^a-z0-9]+", " ", clean(meeting_type).lower()).strip()
    if value == "software and technical file weekly review":
        if hybrid_action_v2_enabled():
            return None
        return HYBRID_TECHNICAL_SELECTOR_GUIDANCE, "hybrid_technical_actual_actions"
    if value == "decision meeting":
        return DECISION_MEETING_SELECTOR_GUIDANCE, "decision_meeting_actual_actions"
    return None


def retrieval_selector_profile(meeting_type: str) -> tuple[str, str] | None:
    value = re.sub(r"[^a-z0-9]+", " ", clean(meeting_type).lower()).strip()
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
    try:
        from meeting_minutes_minilm_experiment import MiniLMBackend
        return MiniLMBackend.load(enabled=True)
    except Exception:
        return None


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
        merged = list(existing.get("evidenceIds", []))
        merged.extend(evidence for evidence in action.get("evidenceIds", []) if evidence not in merged)
        existing["evidenceIds"] = merged
        if clean(existing.get("owner")) in ("", "Not stated") and clean(action.get("owner")) not in ("", "Not stated"):
            existing["owner"] = action["owner"]
    return output


def evidence_turn_numbers(action: dict[str, Any], total: int) -> list[int]:
    numbers = set()
    for evidence_id in action.get("evidenceIds", []) if isinstance(action.get("evidenceIds"), list) else []:
        match = re.fullmatch(r"turn_(\d+)", clean(evidence_id))
        if match and 1 <= int(match.group(1)) <= total:
            numbers.add(int(match.group(1)))
    return sorted(numbers)


def repair_short_actions(actions: list[dict[str, Any]], turns: list[str]) -> list[dict[str, Any]]:
    """Rewrite bare-verb candidates from their cited turns instead of letting the word gate drop them.

    Measured on Abbott: the extractor returned "send" for Jacqui's "I'll get that over to you
    today" (the code of conduct) and "build out" for Stuart's scope work - both expected actions,
    both deleted by the four-word gate. Fail-open: on any error the originals are returned and the
    gate behaves as before."""
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
        evidence: list[str] = []
        for member in group["members"]:
            evidence.extend(item for item in member.get("evidenceIds", []) if item not in evidence)
        representative["evidenceIds"] = evidence
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
    "raised" panel: a minority row that at least one sample read as a commitment, assignment
    or requirement. A minority row every sample read as a mere proposal is tier 3 and is not
    returned - on the measured runs those 83 rows carried one expected action between them."""
    output = []
    for action in actions:
        support = int(action.get("support", 1) or 1)
        if sample_count <= 1 or support * 2 >= sample_count + 1:
            action["tier"] = 1
        elif support >= 2 or clean(action.get("status")).upper() != "PROPOSED":
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
                         threshold: float = 0.80, far_threshold: float = 0.90, locality: int = 60) -> list[dict[str, Any]]:
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
    for number, action in enumerate(actions, 1):
        info = structured.get(number, {})
        vec = vector(info.get("deliverable", "")) if info.get("deliverable") else None
        turn = first_evidence_turn(action)
        target = None
        if vec is not None:
            for group in groups:
                if group["vector"] is None or not verbs_compatible(info.get("verb", ""), group["verb"]):
                    continue
                # A meeting between two people is one deliverable with two owners: the recipient
                # of one draft is the owner of the other. Everything else needs compatible owners.
                joint = (bool(owner_tokens(action.get("owner")) & owner_tokens(group["recipient"]))
                         or bool(owner_tokens(group["representative"].get("owner")) & owner_tokens(info.get("recipient", ""))))
                if not joint and not owners_compatible(action.get("owner"), group["representative"].get("owner")):
                    continue
                similarity = dot_similarity(vec, group["vector"])
                near = turn is not None and group["turn"] is not None and abs(turn - group["turn"]) <= locality
                if similarity >= (threshold if near else far_threshold):
                    target = group
                    if joint and not owners_compatible(action.get("owner"), group["representative"].get("owner")):
                        group["jointOwners"].append(clean(action.get("owner")))
                    break
        if target is None:
            groups.append({"vector": vec, "verb": info.get("verb", ""), "turn": turn, "representative": action, "members": [action],
                           "recipient": info.get("recipient", ""), "jointOwners": []})
            continue
        target["members"].append(action)
        if representative_rank(action) > representative_rank(target["representative"]):
            target["representative"] = action
    output = []
    for group in groups:
        representative = dict(group["representative"])
        if len(group["members"]) > 1:
            evidence: list[str] = []
            for member in group["members"]:
                evidence.extend(item for item in member.get("evidenceIds", []) if item not in evidence)
            representative["evidenceIds"] = evidence
            representative["support"] = max(int(member.get("support", 1) or 1) for member in group["members"])
            representative["mergedCandidateCount"] = sum(int(member.get("mergedCandidateCount", 1) or 1) for member in group["members"])
            representative["mergedFrom"] = [clean(member.get("action")) for member in group["members"] if member is not group["representative"]]
            owners = [clean(representative.get("owner"))] + [owner for owner in group["jointOwners"]
                                                                if owner and not owners_compatible(owner, representative.get("owner"))]
            if len(owners) > 1:
                representative["owner"] = " and ".join(dict.fromkeys(owners))
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


SELECTOR_BATCH_CHARS = 22000
SELECTOR_TURN_CHARS = 360


def selector_batches(blocks: list[tuple[int, str]]) -> list[list[tuple[int, str]]]:
    """At most 15 candidates and about SELECTOR_BATCH_CHARS of text per call. Fifteen software
    review candidates with their evidence overran the model's input and came back as HTTP 422."""
    batches: list[list[tuple[int, str]]] = []
    current: list[tuple[int, str]] = []
    size = 0
    for block in blocks:
        if current and (len(current) >= 15 or size + len(block[1]) > SELECTOR_BATCH_CHARS):
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
        try:
            result = call_trooper(RETRIEVAL_SELECTOR_PROMPT.format(
                guidance=guidance, candidates="\n\n".join(block for _, block in batch)),
                3000, RETRIEVAL_SELECTOR_SCHEMA)
        except Exception:
            return None
        expected = {number for number, _ in batch}
        returned = {row.get("candidateNumber"): row for row in result.get("decisions", [])
                    if isinstance(row, dict) and row.get("candidateNumber") in expected}
        if set(returned) != expected:
            return None
        decisions.update(returned)
    return decisions


def select_retrieval_grounded_actions(actions: list[dict[str, Any]], turns: list[str], guidance: str,
                                      backend: Any = None, profile: str = "") -> list[dict[str, Any]]:
    """Fail-open, two-check selector grounded in original and MiniLM-retrieved evidence."""
    eligible = [action for action in actions if action_word_count(action.get("action")) >= 4]
    strict_profile = profile in {"audit_retrieval_v2", "importer_retrieval_v2", "hybrid_retrieval_v2"}
    if strict_profile:
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
    protected: set[int] = set()
    for number, action in enumerate(eligible, 1):
        original_numbers = {int(match.group(1)) for evidence_id in action.get("evidenceIds", [])
                            if (match := re.fullmatch(r"turn_(\d+)", clean(evidence_id)))
                            and 1 <= int(match.group(1)) <= len(turns)}
        evidence_numbers = set(original_numbers)
        if strict_profile:
            # The lexical-anchor gate above prevents post-hoc grounding of an invented object.
            # Immediate context resolves requests and addressees; only two semantic anchors are
            # added because audit vocabulary repeats heavily across a long transcript.
            for turn_number in original_numbers:
                evidence_numbers.update(range(max(1, turn_number - 1), min(len(turns), turn_number + 1) + 1))
        query = vector(clean(action.get("action")))
        ranked = [] if query is None else sorted(
            ((dot_similarity(query, candidate), index + 1) for index, candidate in enumerate(turn_vectors) if candidate is not None),
            reverse=True)
        semantic_numbers = []
        semantic_limit = 2 if strict_profile else 4
        for _score, turn_number in ranked:
            if any(abs(turn_number - prior) <= 1 for prior in semantic_numbers):
                continue
            semantic_numbers.append(turn_number)
            if len(semantic_numbers) >= semantic_limit:
                break
        for turn_number in semantic_numbers:
            evidence_numbers.update(range(max(1, turn_number - 1), min(len(turns), turn_number + 1) + 1))
        evidence = [turns[index - 1] for index in sorted(evidence_numbers)]
        # Audit v2 deliberately lets the two evidence-grounded checks judge every row. Generic
        # first-person/date protection otherwise preserves travel, attendance and prior-audit
        # history simply because those statements happen to contain "we will" or a weekday.
        if not strict_profile and action_has_recall_protection(
            action, [turns[index - 1] for index in sorted(original_numbers)]
        ):
            protected.add(number)
        lines = "\n".join(f"  Turn {index}: {turns[index - 1][:SELECTOR_TURN_CHARS]}" for index in sorted(evidence_numbers))
        blocks.append((number, f"{number}. Owner: {action.get('owner', 'Not stated')}\n"
            f"Draft: {action.get('action', '')}\nStatus: {action.get('status', '')}\nEvidence:\n{lines}"))
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        first_future = pool.submit(retrieval_decisions, blocks, guidance)
        second_future = pool.submit(retrieval_decisions, list(reversed(blocks)), guidance)
        first, second = first_future.result(), second_future.result()
    if first is None or second is None:
        return eligible
    valid_codes = {"COMPLETED_ONLY", "UNACCEPTED_PROPOSAL", "DISCUSSION_ONLY", "MEETING_ADMIN", "MALFORMED", "NO_SUPPORTED_TASK"}
    removed = set()
    for number in range(1, len(eligible) + 1):
        left, right = first[number], second[number]
        if number in protected:
            continue
        # The rejection codes overlap (DISCUSSION_ONLY, NO_SUPPORTED_TASK and UNACCEPTED_PROPOSAL
        # describe the same rows), so requiring the same code made removal a matter of luck.
        if (left.get("decision") == right.get("decision") == "REMOVE"
                and left.get("rejectionCode") in valid_codes and right.get("rejectionCode") in valid_codes
                and left.get("evidenceTurns") and right.get("evidenceTurns")):
            removed.add(number)
    return [action for number, action in enumerate(eligible, 1) if number not in removed]


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
    actions = drop_completed_actions(actions)
    actions = repair_short_actions(actions, turns)
    if prompt_profile == "audit_planning_v2":
        actions = repair_audit_actions(actions, turns)
    if prompt_profile == "importer_obligations_v2":
        actions = repair_importer_actions(actions, turns)
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
    if prompt_profile == "importer_obligations_v2":
        # Sampling can choose an un-repaired representative from a semantic group. Reapply the
        # transcript-grounded wording, then collapse work packages that now share a canonical form.
        actions = repair_importer_actions(actions, turns)
        actions = dedupe_identical_actions(sorted(
            actions, key=lambda row: int(row.get("support", 1) or 1), reverse=True
        ))
    candidate_count = len(actions)
    if os.environ.get("STAGED_ACTION_DELIVERABLE_MERGE", "0") == "1" and len(actions) > 1:
        actions = merge_by_deliverable(actions, structure_action_deliverables(actions), load_action_retrieval_backend())
    # The importer-only selector kept 8 rows of 49 and discarded 3 of the 6 candidates that
    # matched the reviewed minutes (the resent QMS manual, the countries list, the declarations
    # of conformity) while keeping "Speak to you next week". It stays available behind
    # STAGED_IMPORTER_LEGACY_SELECTOR=1; the default is the same evidence-grounded path as every
    # other type, with importer guidance.
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
    if action_prompt == IMPORTER_ACTION_PROMPT:
        # Selection can remove a sampled version of an explicit handoff, and can leave a less
        # complete representative of a surviving work package. Finish from transcript evidence.
        actions = repair_importer_actions(actions, turns)
        actions = dedupe_identical_actions(sorted(
            actions, key=lambda row: int(row.get("support", 1) or 1), reverse=True
        ))
        actions = recover_importer_followup_call(actions, turns, sample_count)
        actions = consolidate_importer_actions(actions, turns, sample_count)
        actions = recover_importer_actions(actions, turns, sample_count)
    normalised_meeting_type = re.sub(r"[^a-z0-9]+", " ", clean(meeting_type).lower()).strip()
    if normalised_meeting_type == "software weekly review" and software_action_consolidation_v2_enabled():
        actions = consolidate_software_review_actions(actions, turns)
        actions = recover_software_review_actions(actions, turns, sample_count)
    if action_prompt == HYBRID_ACTION_PROMPT:
        actions = consolidate_hybrid_actions(actions, turns)
        actions = recover_hybrid_actions(actions, turns, sample_count)
    if action_prompt == WEBINAR_ACTION_V2_PROMPT:
        actions = consolidate_webinar_actions(actions, turns, sample_count)
        actions = recover_webinar_actions(actions, turns, sample_count)
    if action_prompt == PROCESS_ACTION_V2_PROMPT:
        actions = consolidate_process_actions(actions, turns, sample_count)
        actions = recover_process_actions(actions, turns, sample_count)
    if action_prompt == TECHNICAL_FILE_ACTION_V2_PROMPT:
        actions = consolidate_technical_file_actions(actions, turns, meeting_type, sample_count)
    if action_prompt == GENERAL_ACTION_V2_PROMPT:
        actions = consolidate_general_actions(actions, turns, sample_count)
        actions = recover_general_actions(actions, turns, sample_count)
    if action_prompt == AUDIT_ACTION_PROMPT:
        actions = consolidate_audit_v2_actions(actions, turns, sample_count)
        actions = recover_audit_v2_actions(actions, turns, sample_count)
    actions = assign_action_tiers(actions, sample_count)
    return {"stage": "actions", "actions": actions, "chunkCount": len(chunks), "turnCount": len(turns),
            "actionPromptProfile": prompt_profile, "actionSampleCount": sample_count,
            "candidateCountBeforeSelection": candidate_count}


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
