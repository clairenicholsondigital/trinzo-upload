#!/usr/bin/env python3
"""Build a coarse discourse-role curriculum from reusable reviewed datasets.

The role head answers whether an evidence event should be published, attached to
another event, or suppressed. It deliberately uses broad behavioural labels and
contains no golden case identifiers or transcript-specific phrases.
"""

from __future__ import annotations

import argparse
import csv
import json
from collections import Counter
from pathlib import Path

import pandas as pd

from build_canonical_speech_act_training import SCENARIOS, assign_splits


SPEECH_ACT_ROLE = {
    "commitment": "canonical_commitment",
    "volunteer_commitment": "canonical_commitment",
    "request_acceptance_thread": "canonical_commitment",
    "distributed_request_acceptance": "canonical_commitment",
    "minutes_assignment": "canonical_commitment",
    "recap_assignment": "single_item_recap",
    "contextual_volunteer": "canonical_commitment",
    "ownerless_need": "unassigned_proposal",
    "unassigned_suggestion": "unassigned_proposal",
    "hypothetical": "hypothetical",
    "explicitly_uncommitted": "hypothetical",
    "completed_history": "completed_history",
    "completed_correction": "completed_history",
    "rejection": "state_modifier",
    "superseded_action": "state_modifier",
    "decision": "canonical_assertion",
    "decision_after_alternative": "canonical_assertion",
    "proposal_acceptance_decision": "canonical_assertion",
    "unconfirmed_option": "unassigned_proposal",
    "risk": "canonical_assertion",
    "conditional_risk": "canonical_assertion",
    "closed_risk_negative": "completed_history",
    "informational": "supporting_detail",
    "administrative": "administrative",
    "social_false_commitment": "administrative",
}


def contextual_role(row: pd.Series) -> str:
    dependency = str(row.get("context_dependency", ""))
    worthiness = str(row.get("canonical_worthiness", ""))
    lifecycle = str(row.get("lifecycle_state", ""))
    temporal = str(row.get("temporal_role", ""))
    section = str(row.get("gold_section", ""))
    if temporal == "deadline_previous":
        return "temporal_attachment"
    if dependency == "accepts_previous":
        return "acceptance"
    if dependency == "modifies_previous" or lifecycle in {"inactive", "superseded"}:
        return "state_modifier"
    if lifecycle == "completed":
        return "completed_history"
    if lifecycle == "tentative":
        return "hypothetical"
    if worthiness == "duplicate_expression":
        return "single_item_recap"
    if worthiness in {"supporting_detail", "context_only", "none"}:
        return "supporting_detail" if worthiness == "supporting_detail" else "administrative" if worthiness == "none" else "context_only"
    if worthiness == "canonical_item":
        return "canonical_commitment" if section == "action" else "canonical_assertion"
    return "context_only"


def generated_rows() -> list[dict[str, str]]:
    """Event-level hard contrasts absent from the older multi-sentence set."""
    groups = [f"discourse_hard_{index:03d}_{scenario[0]}" for index, scenario in enumerate(SCENARIOS, 1)]
    splits = assign_splits(groups, 190817)
    rows = []
    for index, (domain, owner, task, deadline, decision, risk) in enumerate(SCENARIOS, 1):
        group = groups[index - 1]
        topic = domain.replace("_", " ")
        examples = [
            ("We need an owner.", f"{owner}: I'll {task}.", f"Can you finish by {deadline}?", "canonical_commitment"),
            (f"Could you {task}?", "Yes, I'll take it.", f"By {deadline}, please.", "canonical_commitment"),
            (f"{owner} accepted the work.", f"Action: {owner} will {task} by {deadline}.", "Next item.", "single_item_recap"),
            (f"The proposal is to {decision}.", "Agreed.", "That settles the approach.", "acceptance"),
            ("We need a final position.", f"Decision: we will {decision}.", "The matter is closed.", "canonical_assertion"),
            ("Should we commission another review cycle?", f"Decision: no additional {topic} testing is required.", "The existing evidence is sufficient.", "canonical_assertion"),
            ("A further verification round was proposed.", "We will not carry out another round of testing.", "The group agreed that it would add no value.", "canonical_assertion"),
            ("The team asked whether more checking was needed.", "No further testing is required.", "That is the settled decision.", "canonical_assertion"),
            (f"We discussed whether to {decision}.", f"The group formally approved the decision to {decision}.", "Record that in the minutes.", "canonical_assertion"),
            ("Several items were resolved.", f"To recap, we agreed to {decision}, noted that {risk}, and assigned {owner} to {task}.", "There is nothing else to add.", "multi_item_recap"),
            ("Let's summarise everything.", f"We approved the {topic} approach, accepted the delivery exposure, and confirmed the supplier choice.", "No new decision is being made in this recap.", "multi_item_recap"),
            (f"The decision was to {decision}.", "Yes, that's the decision.", "Next topic.", "single_item_recap"),
            ("This was resolved before today's meeting.", f"We approved the choice to {decision} last month.", "The paperwork is already complete.", "completed_history"),
            ("Here is the latest status.", f"The work to {task} was completed yesterday.", "No outstanding task remains.", "completed_history"),
            (f"{owner} was going to {task}.", "That assignment has been withdrawn.", "Do not keep it as an open action.", "state_modifier"),
            (f"{owner} owns the task.", f"Actually, Lee will {task} instead.", "Use Lee as the new owner.", "state_modifier"),
            ("We are exploring options.", f"Should we {decision}?", "No decision was made.", "unassigned_proposal"),
            ("A concern was raised.", f"Could {risk}?", "The team did not confirm that exposure.", "unassigned_proposal"),
            ("Capacity is uncertain.", f"I might {task} if I have time.", "Treat that as an idea, not an action.", "hypothetical"),
            ("The screen is shared.", "Can everyone see the small control in the corner?", "There it is.", "administrative"),
            ("The meeting is starting.", "Good.", "Let's continue.", "administrative"),
            ("The speaker finished.", "Mm-hmm.", "Next point.", "acceptance"),
            (f"{owner} accepted the task.", f"Before {deadline}.", "That timing works.", "temporal_attachment"),
            (f"{owner} is already responsible for {task} and for cueing the lead.", "And I'll still send you a reminder at five minutes.", "That reminder is part of the same responsibility.", "supporting_detail"),
            (f"The main action is for {owner} to {task}.", "I'll also give you a private timing cue.", "Keep it within the existing action rather than creating another item.", "supporting_detail"),
            (f"The risk is that {risk}.", "Keep an eye on that exposure.", "Add it to the risk register.", "supporting_detail"),
            ("We reviewed current exposure.", f"Risk: {risk}.", "It remains open and should be recorded.", "canonical_assertion"),
            ("This is not a task.", f"The {topic} variation is a watch item, with nothing to do today.", "Continue normal monitoring.", "canonical_assertion"),
            ("The exposure remains within tolerance.", "It is worth noting, but there is no separate action.", "Monitoring continues.", "supporting_detail"),
            ("The evidence is complete.", "It's documented and justified.", "Move to the next topic.", "supporting_detail"),
            ("The group already agreed.", "That's confirmed; the paperwork is signed.", "Nothing remains open.", "single_item_recap"),
            (f"Someone suggested that {owner} might {task}.", "No, that was not assigned.", "Do not record an action.", "state_modifier"),
            ("The current topic is background only.", f"The {topic} work remains in progress.", "No commitment was made.", "context_only"),
        ]
        for number, (previous, current, following, role) in enumerate(examples, 1):
            rows.append({
                "row_id": f"disc_h_{index:03d}_{number:02d}", "group_id": group,
                "recommended_split": splits[group], "current_text": current,
                "context_text": f"[PREVIOUS]\n{previous}\n[CURRENT]\n{current}\n[NEXT]\n{following}",
                "discourse_role": role, "source": "ai_generated_event_level_hard_contrasts_v1",
                "review_status": "assistant_reviewed_candidate",
            })
    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--speech-data", default="artifacts/canonical_speech_act_candidates_v2.csv")
    parser.add_argument("--context-data", default="artifacts/canonical_contextual_candidates_v1.csv")
    parser.add_argument("--output", default="artifacts/canonical_discourse_candidates_v1.csv")
    args = parser.parse_args()
    rows = []
    speech = pd.read_csv(args.speech_data).fillna("")
    for _, source in speech.iterrows():
        role = SPEECH_ACT_ROLE.get(str(source["speech_act"]))
        if not role:
            continue
        text = str(source["text"])
        rows.append({
            "row_id": f"disc_s_{source['row_id']}", "group_id": source["group_id"],
            "recommended_split": source["recommended_split"], "current_text": text,
            "context_text": f"[CURRENT]\n{text}", "discourse_role": role,
            "source": "derived_reusable_speech_act_curriculum_v1",
            "review_status": source["review_status"],
        })
    contextual = pd.read_csv(args.context_data).fillna("")
    for _, source in contextual.iterrows():
        rows.append({
            "row_id": f"disc_c_{source['row_id']}", "group_id": source["group_id"],
            "recommended_split": source["recommended_split"], "current_text": source["current_text"],
            "context_text": source["context_text"], "discourse_role": contextual_role(source),
            "source": "derived_reviewed_contextual_curriculum_v1",
            "review_status": source["review_status"],
        })
    rows.extend(generated_rows())
    group_splits = {}
    for row in rows:
        group_splits.setdefault(row["group_id"], set()).add(row["recommended_split"])
    leakage = {group: sorted(splits) for group, splits in group_splits.items() if len(splits) > 1}
    report = {
        "rows": len(rows), "groups": len(group_splits), "groupLeakage": leakage,
        "splitCounts": dict(Counter(row["recommended_split"] for row in rows)),
        "labelCounts": dict(Counter(row["discourse_role"] for row in rows)),
        "frozenGoldenTextUsed": False,
    }
    if leakage:
        raise SystemExit(json.dumps(report, indent=2))
    output = Path(args.output); output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0])); writer.writeheader(); writer.writerows(rows)
    output.with_suffix(".manifest.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
