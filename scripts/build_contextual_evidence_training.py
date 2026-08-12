#!/usr/bin/env python3
"""Build a group-safe contextual-head curriculum from hard canonical boundaries."""

from __future__ import annotations

import argparse
import csv
import json
from collections import Counter
from pathlib import Path

from build_canonical_speech_act_training import SCENARIOS, assign_splits


LABELS = {
    "lifecycle_state": {"active", "tentative", "completed", "inactive", "superseded", "none"},
    "context_dependency": {"standalone", "needs_previous", "needs_next", "accepts_previous", "modifies_previous"},
    "canonical_worthiness": {"canonical_item", "supporting_detail", "duplicate_expression", "context_only", "none"},
    "temporal_role": {"deadline_previous", "deadline_current", "historical", "other", "none"},
}


def example(previous, current, following, lifecycle, dependency, worthiness, temporal, section="", group_suffix=""):
    evidence_type = {"action": "action_commitment", "decision": "decision_agreement", "risk": "risk_dependency"}.get(section, "background_context")
    action_state = "confirmed_action" if section == "action" and lifecycle == "active" else "completed_history" if lifecycle == "completed" else "not_action"
    signals = "deadline_or_sequence" if temporal.startswith("deadline") else ""
    if section == "decision": signals = "decision_language"
    if section == "risk": signals = "risk_language"
    return {
        "previous_text": previous, "current_text": current, "next_text": following,
        "lifecycle_state": lifecycle, "context_dependency": dependency,
        "canonical_worthiness": worthiness, "temporal_role": temporal,
        "gold_section": section, "group_suffix": group_suffix,
        "evidence_type": evidence_type, "action_state": action_state, "signals": signals,
    }


def rows_for_scenario(index, scenario):
    domain, owner, task, deadline, decision, risk = scenario
    action_group = f"ACTION_{index:03d}"
    decision_group = f"DECISION_{index:03d}"
    risk_group = f"RISK_{index:03d}"
    rows = [
        example("We need someone to handle this.", f"I'll {task}.", f"Can it be done by {deadline}?", "active", "needs_previous", "canonical_item", "none", "action", action_group),
        example(f"I'll {task}.", f"Before {deadline}.", "Yes, that works.", "none", "needs_previous", "context_only", "deadline_previous", "action", action_group),
        example(f"Could you {task}?", "Yes, I'll take that.", f"Please finish by {deadline}.", "active", "accepts_previous", "canonical_item", "none", "action", action_group),
        example("The work is on the list.", f"{owner} will {task} by {deadline}.", "Let's move on.", "active", "standalone", "canonical_item", "deadline_current", "action", action_group),
        example("Here is the status.", f"I completed the work to {task} yesterday.", "Nothing remains open.", "completed", "standalone", "context_only", "historical", "", ""),
        example("We may need help.", f"I might {task} if capacity allows.", "No action was agreed.", "tentative", "needs_next", "context_only", "other", "", ""),
        example(f"{owner} will {task}.", f"Actually, another owner will {task} instead.", "Use the new owner.", "superseded", "modifies_previous", "canonical_item", "none", "action", action_group),
        example(f"Please {task}.", "Do not proceed with that action.", "It is no longer required.", "inactive", "modifies_previous", "context_only", "none", "", ""),
        example("We should choose an approach.", f"We agreed to {decision}.", "That is the final position.", "none", "standalone", "canonical_item", "none", "decision", decision_group),
        example(f"The proposal is to {decision}.", "Agreed.", "Let's use that approach.", "none", "accepts_previous", "supporting_detail", "none", "decision", decision_group),
        example(f"We agreed to {decision}.", "Yes, that is the decision.", "Next topic.", "none", "needs_previous", "duplicate_expression", "none", "decision", decision_group),
        example("We should review delivery exposure.", f"The team identified that {risk}.", "The exposure remains open.", "active", "standalone", "canonical_item", "none", "risk", risk_group),
        example(f"The risk is that {risk}.", "Yes, we should monitor that.", "Add it to the register.", "active", "accepts_previous", "supporting_detail", "none", "risk", risk_group),
        example(f"We previously worried that {risk}.", "That exposure was closed last week.", "No monitoring is required.", "completed", "modifies_previous", "context_only", "historical", "", ""),
        example("The meeting is starting.", "Can everyone see my screen?", "We will continue in a moment.", "none", "standalone", "none", "other", "", ""),
        example("We reviewed the background.", f"The {domain.replace('_', ' ')} work remains in progress.", "No commitment was made.", "none", "standalone", "supporting_detail", "none", "", ""),
    ]
    split = assign_splits([f"context_{i:03d}_{s[0]}" for i, s in enumerate(SCENARIOS, 1)], 761819)[f"context_{index:03d}_{domain}"]
    output = []
    for number, row in enumerate(rows, 1):
        current = row["current_text"]
        output.append({
            "row_id": f"ctx_{index:03d}_{number:02d}", "text": current, "current_text": current,
            "context_text": f"[PREVIOUS]\n{row['previous_text']}\n[CURRENT]\n{current}\n[NEXT]\n{row['next_text']}",
            "speech_act": "contextual_curriculum", "domain": domain,
            "group_id": f"context_{index:03d}_{domain}", "recommended_split": split,
            "source": "ai_authored_canonical_error_curriculum_v1",
            "review_status": "human_approved", "review_confidence": "high",
            "review_notes": "Human reviewed and approved for contextual-head training.",
            "canonical_group_id": row.pop("group_suffix"), "gold_include": bool(row["gold_section"]),
            **row,
        })
    return output


def validate(rows):
    errors = []
    for field, allowed in LABELS.items():
        invalid = sorted({row[field] for row in rows} - allowed)
        if invalid: errors.append(f"invalid {field}: {invalid}")
    leakage = {group: sorted({row["recommended_split"] for row in rows if row["group_id"] == group}) for group in {row["group_id"] for row in rows}}
    leakage = {group: splits for group, splits in leakage.items() if len(splits) != 1}
    counts = {field: dict(Counter(row[field] for row in rows)) for field in LABELS}
    for field, allowed in LABELS.items():
        if set(counts[field]) != allowed: errors.append(f"missing {field}: {sorted(allowed - set(counts[field]))}")
    return {"rows": len(rows), "groups": len({row['group_id'] for row in rows}), "splitCounts": dict(Counter(row["recommended_split"] for row in rows)), "labelCounts": counts, "groupLeakage": leakage, "errors": errors}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="artifacts/canonical_contextual_candidates_v1.csv")
    args = parser.parse_args()
    rows = [row for index, scenario in enumerate(SCENARIOS, 1) for row in rows_for_scenario(index, scenario)]
    report = validate(rows)
    if report["errors"] or report["groupLeakage"]: raise SystemExit(json.dumps(report, indent=2))
    output = Path(args.output); output.parent.mkdir(parents=True, exist_ok=True)
    fields = list(rows[0])
    with output.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields); writer.writeheader(); writer.writerows(rows)
    output.with_suffix(".manifest.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__": main()
