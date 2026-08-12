#!/usr/bin/env python3
"""Compare two canonical golden output directories with precision-aware metrics."""

from __future__ import annotations

import argparse
import difflib
import json
import re
from pathlib import Path


def norm(value):
    text = str(value or "").lower()
    for word, number in (("fifteenth", "15"), ("twentieth", "20"), ("thursday", "thursday")):
        text = re.sub(rf"\b{word}\b", number, text)
    return re.sub(r"[^a-z0-9]+", " ", text).strip()
def similarity(left, right): return difflib.SequenceMatcher(None, norm(left), norm(right)).ratio()


def match_text(expected, actual, threshold=0.60):
    remaining = set(range(len(actual))); matches = []
    for expected_index, expected_value in enumerate(expected):
        ranked = sorted(((similarity(expected_value, actual[index]), index) for index in remaining), reverse=True)
        if ranked and ranked[0][0] >= threshold:
            score, actual_index = ranked[0]; remaining.remove(actual_index); matches.append((expected_index, actual_index, score))
    return matches, remaining


def analyse_case(case_dir, output):
    gold = json.loads((case_dir / "manifest.json").read_text())
    expected_actions = gold.get("expected_actions", []); actual_actions = output.get("actions", [])
    remaining = set(range(len(actual_actions))); action_matches = []
    for expected_index, expected in enumerate(expected_actions):
        ranked = []
        for actual_index in remaining:
            actual = actual_actions[actual_index]
            owner = similarity(expected.get("owner"), actual.get("owner"))
            action = similarity(expected.get("action"), actual.get("action"))
            deadline = similarity(expected.get("due_evidence"), actual.get("deadline"))
            ranked.append(((owner * .30) + (action * .50) + (deadline * .20), actual_index, owner, action, deadline))
        ranked.sort(reverse=True)
        if ranked and ranked[0][2] >= .75 and ranked[0][3] >= .55:
            score, actual_index, owner, action, deadline = ranked[0]
            remaining.remove(actual_index); action_matches.append((expected_index, actual_index, score, owner, action, deadline))
    decision_matches, extra_decisions = match_text(gold.get("expected_decisions", []), output.get("decisions", []))
    risk_matches, extra_risks = match_text(gold.get("expected_risks", []), output.get("risks", []))
    return {
        "expected": {"actions": len(expected_actions), "decisions": len(gold.get("expected_decisions", [])), "risks": len(gold.get("expected_risks", []))},
        "actual": {"actions": len(actual_actions), "decisions": len(output.get("decisions", [])), "risks": len(output.get("risks", []))},
        "matched": {"actions": len(action_matches), "decisions": len(decision_matches), "risks": len(risk_matches)},
        "extras": {"actions": len(remaining), "decisions": len(extra_decisions), "risks": len(extra_risks)},
        "missing": {"actions": len(expected_actions) - len(action_matches), "decisions": len(gold.get("expected_decisions", [])) - len(decision_matches), "risks": len(gold.get("expected_risks", [])) - len(risk_matches)},
        "deadlineMatches": sum(match[5] >= .55 for match in action_matches),
        "extraActionRows": [actual_actions[index] for index in sorted(remaining)],
        "extraDecisionRows": [output.get("decisions", [])[index] for index in sorted(extra_decisions)],
    }


def analyse(root, output_dir):
    cases = {}
    for case_dir in sorted((root / "cases").glob("[0-9][0-9]_*/")):
        output = json.loads((output_dir / f"{case_dir.name}.json").read_text())
        cases[case_dir.name] = analyse_case(case_dir, output)
    totals = {group: {kind: sum(case[group][kind] for case in cases.values()) for kind in ("actions", "decisions", "risks")} for group in ("expected", "actual", "matched", "extras", "missing")}
    totals["deadlineMatches"] = sum(case["deadlineMatches"] for case in cases.values())
    expected_total = sum(totals["expected"].values()); matched_total = sum(totals["matched"].values()); actual_total = sum(totals["actual"].values())
    totals["canonicalRecall"] = round(matched_total / expected_total, 4) if expected_total else 1
    totals["canonicalPrecision"] = round(matched_total / actual_total, 4) if actual_total else (1 if not expected_total else 0)
    return {"totals": totals, "cases": cases}


def main():
    parser = argparse.ArgumentParser(); parser.add_argument("baseline"); parser.add_argument("enriched")
    args = parser.parse_args(); root = Path(__file__).parent / "meeting-minutes-core-golden"
    report = {"baseline": analyse(root, Path(args.baseline)), "enriched": analyse(root, Path(args.enriched))}
    print(json.dumps(report, indent=2))


if __name__ == "__main__": main()
