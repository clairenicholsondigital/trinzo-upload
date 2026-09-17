#!/usr/bin/env python3
"""Score Meeting Minutes Agent harness output against the golden pack criteria.

Reuses evaluate_case from run_meeting_minutes_final_golden_eval so the agent is
held to the same mustContain / mustNotContain / count / topic rules (with the
same MiniLM matching) as the older /meeting-minutes-final tool. The harness's
reviewerOutput is adapted to that evaluator's field names; nothing else changes.

Usage: score_meeting_minutes_agent_golden.py <harness.json> [<golden-dir>] [--json out.json]
"""
from __future__ import annotations

import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import run_meeting_minutes_final_golden_eval as ev  # noqa: E402

DEFAULT_GOLDEN = "/root/.openclaw/workspace/trinzo-upload/scripts/meeting-minutes-final-golden"


def timing_text(timing: dict | None) -> str:
    if not isinstance(timing, dict):
        return ""
    kind = str(timing.get("kind") or "not_stated")
    wording = str(timing.get("wording") or timing.get("text") or "")
    exact = str(timing.get("exactDate") or "")
    if kind == "not_stated":
        return ""
    return " ".join(part for part in (wording, exact) if part).strip()


def adapt(reviewer_output: dict) -> dict:
    """Map the agent's reviewer-facing draft to the evaluator's output shape.

    Only what a reviewer sees as minutes counts: primary Discussion rows,
    published Actions, objectives and summary. Supporting context, proposals
    and flags are the tray, not the minutes.
    """
    details = reviewer_output.get("details") or {}
    discussion_points: list[str] = []
    decisions: list[str] = []
    for topic in reviewer_output.get("discussion") or []:
        for row in topic.get("points") or []:
            if row.get("text"):
                discussion_points.append(str(row["text"]))
        for row in topic.get("openQuestions") or []:
            if row.get("text"):
                discussion_points.append(str(row["text"]))
        for row in topic.get("decisions") or []:
            if row.get("text"):
                decisions.append(str(row["text"]))
    actions = []
    for action in reviewer_output.get("actions") or []:
        actions.append({
            "meetingActionPoint": str(action.get("action") or ""),
            "meetingActionPointOwner": ", ".join(str(owner) for owner in (action.get("owners") or [])),
            "meetingActionPointDeadline": timing_text(action.get("timing")),
        })
    objectives = [str(item.get("text") if isinstance(item, dict) else item) for item in reviewer_output.get("meetingObjectives") or []]
    return {
        "meetingTitle": str(details.get("meetingTitle") or ""),
        "participants": {
            "client": list(details.get("clientAttendees") or []),
            "trinzo": list(details.get("internalAttendees") or []),
        },
        "executiveSummary": str(reviewer_output.get("executiveSummary") or ""),
        "meetingObjectives": objectives,
        "discussionPoints": discussion_points,
        "decisions": decisions,
        "actions": actions,
    }


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    harness = json.loads(Path(argv[1]).read_text())
    golden = Path(argv[2]) if len(argv) > 2 and not argv[2].startswith("--") else Path(DEFAULT_GOLDEN)
    json_out = argv[argv.index("--json") + 1] if "--json" in argv else ""
    results = []
    unprepared: dict[str, str] = {}
    for journey in harness.get("journeys") or []:
        case = str(journey.get("case") or "")
        if journey.get("error"):
            unprepared[case] = str(journey["error"])
            continue
        expected_path = golden / case / "expected.json"
        if not expected_path.exists():
            continue
        expected = json.loads(expected_path.read_text())
        output = adapt(journey.get("reviewerOutput") or {})
        result = ev.evaluate_case(case, output, expected)
        result["run"] = journey.get("run")
        result["draftId"] = journey.get("draftId")
        result["waitingMs"] = journey.get("waitingMs")
        result["totalElapsedMs"] = journey.get("totalElapsedMs")
        results.append(result)
    if not results:
        print("no scoreable journeys")
        return 1
    by_case: dict[str, list[dict]] = {}
    for result in results:
        by_case.setdefault(result["case"], []).append(result)
    print(f"{'case':44} {'runs':>4} {'mean':>6} {'min':>6} {'thr':>5} {'pass':>5}  failures (first run)")
    for case in sorted(by_case):
        runs = by_case[case]
        scores = [r["score"] for r in runs]
        passed = sum(1 for r in runs if r["passed"])
        first = runs[0]["failures"][:2]
        print(f"{case:44} {len(runs):>4} {statistics.mean(scores):>6.3f} {min(scores):>6.3f} {runs[0]['passThreshold']:>5.2f} {passed:>2}/{len(runs)}  {'; '.join(first)[:110]}")
    scores = [r["score"] for r in results]
    hallucination = [r["categoryScores"]["hallucinations"] for r in results]
    print(f"\njourneys {len(results)} | mean score {statistics.mean(scores):.3f} | pass rate {sum(1 for r in results if r['passed'])}/{len(results)}"
          f" | hallucination-free journeys {sum(1 for h in hallucination if h == 1.0)}/{len(results)}"
          f" | mean waiting {statistics.mean([r['waitingMs'] or 0 for r in results]) / 1000:.1f}s")
    if unprepared:
        print(f"not prepared by the tool ({len(unprepared)}): " + ", ".join(f"{case} [{reason}]" for case, reason in sorted(unprepared.items())))
    if json_out:
        Path(json_out).write_text(json.dumps({"results": results, "unprepared": unprepared}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
