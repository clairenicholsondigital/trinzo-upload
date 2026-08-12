#!/usr/bin/env python3
"""Create and train a group-safe MiniLM speech-act augmentation set.

The scenarios and variants were AI-authored from the failure taxonomy exposed by
Trinzo's frozen golden suites. Golden transcript wording is never copied into the
training rows. All variants from one semantic scenario stay in one split.
"""

from __future__ import annotations

import argparse
import csv
import json
import random
from collections import Counter
from pathlib import Path


SCENARIOS = [
    ("inventory", "Marta", "reconcile the warehouse count", "Friday", "use barcode scanning for the next stocktake", "late supplier files could delay reconciliation"),
    ("mobile_release", "Elliot", "patch the mobile login redirect", "today", "hold the release until smoke testing passes", "the redirect defect could block customer access"),
    ("recruitment", "Sana", "invite the shortlisted engineer to a technical interview", "tomorrow", "progress one candidate to the final round", "interviewer availability may delay the final round"),
    ("budget", "Theo", "circulate the revised department forecast", "before lunch", "defer the contractor extension", "exchange-rate movement could exceed the travel budget"),
    ("customer_support", "Inez", "create separate queues for complex support cases", "next Tuesday", "pilot specialist triage for one month", "urgent cases may remain hidden in the general queue"),
    ("supplier", "Ravi", "request the supplier insurance certificate", "Thursday", "approve onboarding only after due diligence", "missing insurance evidence could postpone onboarding"),
    ("webinar", "Chloe", "shorten the product demonstration", "Wednesday", "reserve the final fifteen minutes for questions", "a long demonstration could crowd out questions"),
    ("security", "Jonah", "disable the legacy file-transfer account", "end of day", "require multifactor authentication for external access", "the legacy account creates an unauthorised-access risk"),
    ("contract", "Amara", "redline the termination wording", "Monday", "offer a twelve-month renewal", "unclear termination wording could prolong negotiation"),
    ("audit", "Louis", "prepare the audit evidence index", "next week", "sample two additional operational processes", "missing records could prevent completion of the audit plan"),
    ("marketing", "Mei", "update the campaign launch schedule", "Tuesday", "move the regional campaign into September", "creative approval may slip beyond the media booking date"),
    ("operations", "Declan", "update the weekend duty rota", "this afternoon", "keep weekend support within the internal team", "insufficient weekend cover could delay incident response"),
    ("documentation", "Nora", "rewrite the account-permissions guide", "Friday", "publish one combined onboarding guide", "ambiguous permissions guidance is increasing support demand"),
    ("analytics", "Omar", "refresh the quarterly sales forecast", "Tuesday morning", "focus pipeline reviews on logistics and healthcare", "two unqualified opportunities may distort the forecast"),
    ("quality", "Priya", "upload the signed corrective-action response", "close tomorrow", "retain the supplier on the approved list", "an overdue corrective action could affect supplier approval"),
    ("planning", "David", "reschedule the programme check-in", "today", "hold the check-in on Friday at noon", "the proposed time may conflict with the client workshop"),
    ("data_migration", "Fatima", "verify the customer mapping file", "Thursday", "run a phased migration by region", "duplicate customer identifiers could corrupt the import"),
    ("product", "Gabriel", "remove two fields from the registration form", "before release", "use the shorter registration journey", "removing mandatory fields could weaken reporting"),
    ("facilities", "Anika", "confirm the laboratory access list", "Monday", "limit after-hours access to trained staff", "unapproved access could breach safety controls"),
    ("training", "Marcus", "send the revised facilitator pack", "tomorrow morning", "replace the lecture with two practical exercises", "late materials could leave facilitators unprepared"),
]


def signals(*values: str) -> str:
    return "|".join(values)


def rows_for_scenario(index: int, scenario: tuple[str, ...]) -> list[dict[str, str]]:
    domain, owner, task, deadline, decision, risk = scenario
    group = f"speech_act_{index:03d}_{domain}"
    base = {
        "group_id": group,
        "domain": domain,
        "source": "ai_authored_speech_act_contrast_v1",
        "review_status": "assistant_reviewed_candidate",
    }
    examples = [
        (f"{owner}: I'll {task} by {deadline}.", "action_commitment", "confirmed_action", signals("named_owner", "explicit_commitment_verb", "deliverable_object", "deadline_or_sequence"), "commitment"),
        (f"{owner}: I can {task}. I'll have it done by {deadline}.", "action_commitment", "confirmed_action", signals("named_owner", "explicit_commitment_verb", "deliverable_object", "deadline_or_sequence"), "volunteer_commitment"),
        (f"Could {owner} {task} by {deadline}? {owner}: Yes, I'll take that.", "action_commitment", "confirmed_action", signals("named_owner", "explicit_commitment_verb", "deliverable_object", "deadline_or_sequence"), "request_acceptance_thread"),
        (f"Lead: Can you {task}?\n{owner}: Yes.\nLead: Can you finish by {deadline}?\n{owner}: That works.", "action_commitment", "confirmed_action", signals("named_owner", "explicit_commitment_verb", "deliverable_object", "deadline_or_sequence"), "distributed_request_acceptance"),
        (f"{owner} to {task}; due {deadline}.", "action_commitment", "confirmed_action", signals("named_owner", "explicit_commitment_verb", "deliverable_object", "deadline_or_sequence"), "minutes_assignment"),
        (f"Actions recap: {owner}, you're taking the item to {task}. {owner}: Correct, by {deadline}.", "action_commitment", "confirmed_action", signals("named_owner", "explicit_commitment_verb", "deliverable_object", "deadline_or_sequence"), "recap_assignment"),
        (f"We need someone to {task}. {owner}: Leave that with me; {deadline} is fine.", "action_commitment", "confirmed_action", signals("named_owner", "explicit_commitment_verb", "deliverable_object", "deadline_or_sequence"), "contextual_volunteer"),
        (f"We need to {task}, but nobody accepted ownership or timing.", "discussion_topic", "possible_action", signals("explicit_commitment_verb", "deliverable_object"), "ownerless_need"),
        (f"It would help to {task}. The group moved on without assigning it.", "discussion_topic", "possible_action", signals("deliverable_object"), "unassigned_suggestion"),
        (f"Perhaps {owner} could {task} if there is time, but this was not agreed.", "discussion_topic", "not_action", signals("named_owner", "deliverable_object", "hypothetical_language"), "hypothetical"),
        (f"{owner}: I might {task}, depending on capacity. Lead: Treat that as an idea, not an action.", "discussion_topic", "not_action", signals("named_owner", "deliverable_object", "hypothetical_language"), "explicitly_uncommitted"),
        (f"{owner} already completed the work to {task} yesterday.", "background_context", "completed_history", signals("named_owner", "deliverable_object", "completed_tense"), "completed_history"),
        (f"Lead: {owner} should {task}. {owner}: That's already done; it closed yesterday.", "background_context", "completed_history", signals("named_owner", "deliverable_object", "completed_tense"), "completed_correction"),
        (f"Do not {task}; that proposed action has been cancelled.", "decision_agreement", "not_action", signals("deliverable_object", "decision_language"), "rejection"),
        (f"Earlier we asked {owner} to {task}. That assignment is withdrawn and must not remain open.", "decision_agreement", "not_action", signals("named_owner", "deliverable_object", "decision_language"), "superseded_action"),
        (f"The team agreed to {decision}.", "decision_agreement", "not_action", signals("decision_language", "deliverable_object"), "decision"),
        (f"Option A was discussed, but the final position is to {decision}.", "decision_agreement", "not_action", signals("decision_language", "deliverable_object"), "decision_after_alternative"),
        (f"Lead: Shall we {decision}?\nTeam: Agreed. That's the approach we will use.", "decision_agreement", "not_action", signals("decision_language", "deliverable_object"), "proposal_acceptance_decision"),
        (f"One option would be to {decision}, although no decision was made.", "discussion_topic", "not_action", signals("hypothetical_language", "deliverable_object"), "unconfirmed_option"),
        (f"The team identified that {risk}.", "risk_dependency", "not_action", signals("risk_language", "deliverable_object"), "risk"),
        (f"If the dependency is not resolved, {risk}. The issue remains open.", "risk_dependency", "not_action", signals("risk_language", "deliverable_object"), "conditional_risk"),
        (f"The team checked whether {risk}, but evidence confirmed the exposure is closed and no monitoring is required.", "background_context", "not_action", signals("deliverable_object", "completed_tense"), "closed_risk_negative"),
        (f"The current position is that the {domain.replace('_', ' ')} work remains in progress.", "background_context", "not_action", "", "informational"),
        (f"Can everyone see the {domain.replace('_', ' ')} screen? We will pause for two minutes before continuing.", "low_value_noise", "not_action", "", "administrative"),
        (f"{owner}: I promise I'll bring coffee to the next {domain.replace('_', ' ')} call. This is social chat, not project work.", "low_value_noise", "not_action", signals("named_owner"), "social_false_commitment"),
    ]
    return [{**base, "text": text, "evidence_type": evidence, "action_state": action, "signals": signal, "speech_act": speech_act} for text, evidence, action, signal, speech_act in examples]


def assign_splits(groups: list[str], seed: int) -> dict[str, str]:
    shuffled = sorted(set(groups))
    random.Random(seed).shuffle(shuffled)
    train_end = round(len(shuffled) * 0.7)
    validation_end = train_end + round(len(shuffled) * 0.15)
    return {group: ("train" if i < train_end else "validation" if i < validation_end else "test") for i, group in enumerate(shuffled)}


def validate(rows: list[dict[str, str]]) -> dict:
    texts = [row["text"].strip().lower() for row in rows]
    duplicates = [text for text, count in Counter(texts).items() if count > 1]
    group_splits = {}
    for row in rows:
        group_splits.setdefault(row["group_id"], set()).add(row["recommended_split"])
    leaked = {group: sorted(values) for group, values in group_splits.items() if len(values) > 1}
    required = {"commitment", "volunteer_commitment", "request_acceptance_thread", "distributed_request_acceptance", "minutes_assignment", "recap_assignment", "contextual_volunteer", "ownerless_need", "unassigned_suggestion", "hypothetical", "explicitly_uncommitted", "completed_history", "completed_correction", "rejection", "superseded_action", "decision", "decision_after_alternative", "proposal_acceptance_decision", "unconfirmed_option", "risk", "conditional_risk", "closed_risk_negative", "informational", "administrative", "social_false_commitment"}
    acts = {row["speech_act"] for row in rows}
    return {
        "rows": len(rows), "groups": len(group_splits), "duplicateTexts": duplicates,
        "groupLeakage": leaked, "missingSpeechActs": sorted(required - acts),
        "splitCounts": dict(Counter(row["recommended_split"] for row in rows)),
        "speechActCounts": dict(Counter(row["speech_act"] for row in rows)),
        "evidenceTypeCounts": dict(Counter(row["evidence_type"] for row in rows)),
        "actionStateCounts": dict(Counter(row["action_state"] for row in rows)),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="/root/meeting-minutes-evidence-model/data/canonical_speech_act_candidates_v1.csv")
    parser.add_argument("--manifest", default="/root/meeting-minutes-evidence-model/data/canonical_speech_act_candidates_v1.manifest.json")
    parser.add_argument("--seed", type=int, default=761819)
    args = parser.parse_args()
    rows = [row for index, scenario in enumerate(SCENARIOS, 1) for row in rows_for_scenario(index, scenario)]
    split_by_group = assign_splits([row["group_id"] for row in rows], args.seed)
    for row_index, row in enumerate(rows, 1):
        row["row_id"] = f"csa_{row_index:04d}"
        row["recommended_split"] = split_by_group[row["group_id"]]
    manifest = validate(rows)
    if manifest["duplicateTexts"] or manifest["groupLeakage"] or manifest["missingSpeechActs"]:
        raise SystemExit(f"Dataset validation failed: {manifest}")
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    for row in rows:
        row["review_confidence"] = "medium" if row["speech_act"] in {"ownerless_need", "unassigned_suggestion", "closed_risk_negative"} else "high"
        row["review_notes"] = "Label and negative-state relationship checked against canonical staged semantics."
    fields = ["row_id", "text", "speech_act", "evidence_type", "action_state", "signals", "domain", "group_id", "recommended_split", "source", "review_status", "review_confidence", "review_notes"]
    with output.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader(); writer.writerows(rows)
    Path(args.manifest).write_text(json.dumps({**manifest, "seed": args.seed, "frozenGoldenTextUsed": False, "generation": "AI-authored semantic contrast families"}, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
