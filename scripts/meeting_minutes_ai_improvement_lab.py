#!/usr/bin/env python3
"""AI-assisted improvement lab for the meeting-minutes extractor.

This turns the original Colab experiment idea into a repo-safe workflow:

1. Run the existing meeting-minutes extractor against golden cases or transcript files.
2. Score outputs with the existing deterministic quality checks where possible.
3. Ask an AI reviewer for structured, implementation-oriented improvement proposals.
4. Write a JSON/Markdown report for human review.

The script deliberately does not auto-edit production extraction code. It is designed to
make AI useful as a reviewer and hypothesis generator while keeping the actual changes
reviewable and testable.

AI providers:
- In Google Colab, it can use `from google.colab import ai`.
- Without Colab AI, it still produces a deterministic failure report and engineering
  suggestions from the existing golden-case checks.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
REPO_DIR = ROOT.parent
GOLDEN_EVAL_DIR = ROOT / "meeting-minutes-final-golden"
REPORT_DIR = REPO_DIR / "reports" / "ai-improvement-lab"

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from run_meeting_minutes_final_golden_eval import (  # noqa: E402
    evaluate_case,
    find_cases,
    load_json,
    run_extractor,
    universal_quality_failures,
)


@dataclass
class AIReviewResult:
    provider: str
    raw: str
    parsed: dict[str, Any]


class AIReviewer:
    """Small adapter for optional Colab AI usage."""

    def __init__(self, enabled: bool):
        self.enabled = enabled
        self.provider = "none"
        self._colab_ai = None
        if not enabled:
            return
        try:
            from google.colab import ai as colab_ai  # type: ignore
        except Exception as exc:  # pragma: no cover - depends on Colab runtime
            self.provider = f"unavailable: {exc}"
            return
        self._colab_ai = colab_ai
        self.provider = "google.colab.ai"

    @property
    def available(self) -> bool:
        return bool(self.enabled and self._colab_ai)

    def review(self, prompt: str) -> AIReviewResult:
        if not self.available:
            return AIReviewResult(provider=self.provider, raw="", parsed={})
        raw = str(self._colab_ai.generate_text(prompt))
        return AIReviewResult(provider=self.provider, raw=raw, parsed=extract_json_object(raw))


def normalise_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())


def extract_json_object(text: str) -> dict[str, Any]:
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        return {}
    try:
        payload = json.loads(match.group(0))
    except json.JSONDecodeError:
        return {}
    return payload if isinstance(payload, dict) else {}


def compact_output(output: dict[str, Any]) -> dict[str, Any]:
    actions = output.get("actions") or []
    if not actions and output.get("meetingActionPoint"):
        actions = [
            {
                "meetingActionPoint": text,
                "meetingActionPointOwner": (output.get("meetingActionPointOwner") or [""])[index]
                if index < len(output.get("meetingActionPointOwner") or [])
                else "",
                "meetingActionPointDeadline": (output.get("meetingActionPointDeadline") or [""])[index]
                if index < len(output.get("meetingActionPointDeadline") or [])
                else "",
            }
            for index, text in enumerate(output.get("meetingActionPoint") or [])
        ]
    return {
        "meetingTitle": output.get("meetingTitle", ""),
        "meetingObjectives": output.get("meetingObjectives", [])[:5],
        "discussionPoints": output.get("discussionPoints", [])[:8],
        "decisions": output.get("decisions", [])[:8],
        "actions": actions[:8],
    }


def deterministic_suggestions(failures: list[str]) -> list[dict[str, str]]:
    """Map recurring deterministic failures to likely engineering levers."""
    suggestions: list[dict[str, str]] = []
    blob = "\n".join(failures).lower()

    if "missing" in blob and "actions:" in blob:
        suggestions.append(
            {
                "area": "action candidate selection",
                "target": "scripts/meeting_minutes_minilm_experiment.py",
                "reason": "Expected action items are missing from the extractor output.",
                "recommended_change": "Inspect collect_action_candidates and semantic_action_fallback thresholds for these cases; prefer broader candidate recall followed by evidence/owner/deadline filtering rather than hardcoded phrases.",
            }
        )
    if "expected at most" in blob or "abstention" in blob:
        suggestions.append(
            {
                "area": "abstention / evidence filtering",
                "target": "scripts/meeting_minutes_minilm_experiment.py",
                "reason": "The extractor is emitting content where the golden case expects sparse output.",
                "recommended_change": "Tighten semantic density, evidence support, and low-substance/noise rejection before rewrite; verify against low-substance and action-free fixtures.",
            }
        )
    if "conversational leakage" in blob or "first-person" in blob or "second-person" in blob:
        suggestions.append(
            {
                "area": "public wording sanitisation / rewrite constraints",
                "target": "scripts/meeting_minutes_text.py and rewrite prompt in scripts/meeting_minutes_minilm_experiment.py",
                "reason": "Transcript-like language is leaking into visible minutes.",
                "recommended_change": "Strengthen sanitisation and rewriter instructions to convert first/second-person transcript fragments into third-person business English, or drop weak evidence if it cannot be safely rewritten.",
            }
        )
    if "decisions: missing" in blob:
        suggestions.append(
            {
                "area": "decision detection",
                "target": "scripts/meeting_minutes_patterns.py and decision prototype scoring",
                "reason": "Expected decisions are not being selected.",
                "recommended_change": "Review decision cue/acceptance patterns and MiniLM decision prototype scoring; add general decision semantics rather than case-specific keyword rules.",
            }
        )
    if "too long" in blob or "transcript-like" in blob:
        suggestions.append(
            {
                "area": "rewrite brevity and output shape",
                "target": "scripts/meeting_minutes_minilm_experiment.py",
                "reason": "Visible fields are too long or still shaped like raw transcript.",
                "recommended_change": "Lower rewrite word budgets for actions/objectives and enforce concise verb-led actions with owner/deadline in separate fields.",
            }
        )

    if not suggestions:
        suggestions.append(
            {
                "area": "triage",
                "target": "golden evaluation report",
                "reason": "No common failure class was detected by the deterministic mapper.",
                "recommended_change": "Review case-level failures and output snippets manually; add a targeted golden fixture before changing extractor behaviour.",
            }
        )
    return suggestions


def build_ai_prompt(case_report: dict[str, Any], transcript_excerpt: str) -> str:
    return f"""
You are helping improve a production meeting-minutes extractor.

Important constraints:
- Do not suggest transcript-specific hardcoded phrase patches.
- Prefer changes to semantic candidate selection, evidence filtering, clustering,
  rewrite constraints, public text sanitisation, or golden tests.
- If evidence is weak, recommend abstaining/sparse output rather than inventing content.
- Return ONLY valid JSON.

Return this schema:
{{
  "root_cause": "short diagnosis",
  "improvement_hypotheses": [
    {{
      "area": "candidate selection | evidence filtering | rewrite | tests | config | other",
      "target_files": ["relative/path.py"],
      "change": "specific implementation-level proposal",
      "why_it_should_help": "reason",
      "risk": "what this could break",
      "verification": "which tests/cases to run"
    }}
  ],
  "not_recommended": ["changes that would be brittle or unsafe"]
}}

Case report:
{json.dumps(case_report, ensure_ascii=False, indent=2)[:9000]}

Transcript excerpt:
{transcript_excerpt[:5000]}
""".strip()


def case_payload(case: Path, timeout: int, reviewer: AIReviewer) -> dict[str, Any]:
    expected = load_json(case / "expected.json")
    transcript = (case / "transcript.txt").read_text(encoding="utf-8")
    output = run_extractor(case, timeout=timeout)
    evaluation = evaluate_case(case.name, output, expected)
    failures = evaluation.get("failures", []) or []
    report = {
        "case": case.name,
        "description": expected.get("description", ""),
        "coverage": expected.get("coverage", {}),
        "evaluation": evaluation,
        "output": compact_output(output),
        "deterministicSuggestions": deterministic_suggestions([str(item) for item in failures]),
    }
    if failures and reviewer.enabled:
        ai_result = reviewer.review(build_ai_prompt(report, transcript))
        report["aiReview"] = {
            "provider": ai_result.provider,
            "raw": ai_result.raw[:12000],
            "parsed": ai_result.parsed,
        }
    return report


def transcript_payload(path: Path, timeout: int, reviewer: AIReviewer) -> dict[str, Any]:
    # Re-use the extractor by creating a temporary golden-like folder in memory would be
    # awkward; instead run the extractor script directly for ad hoc transcripts.
    import subprocess

    result = subprocess.run(
        [sys.executable, str(ROOT / "meeting_minutes_minilm_only.py"), str(path), "--skip-diagnostics"],
        cwd=REPO_DIR,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or f"extractor exited {result.returncode}")
    payload = json.loads(result.stdout)
    output = payload.get("output") or {}
    failures = universal_quality_failures(output)
    report = {
        "case": path.name,
        "description": "ad hoc transcript",
        "evaluation": {
            "passed": not failures,
            "failures": failures,
            "counts": payload.get("counts", {}),
            "timingMs": payload.get("timingMs", {}),
        },
        "output": compact_output(output),
        "deterministicSuggestions": deterministic_suggestions([str(item) for item in failures]),
    }
    if reviewer.enabled:
        transcript = path.read_text(encoding="utf-8", errors="ignore")
        ai_result = reviewer.review(build_ai_prompt(report, transcript))
        report["aiReview"] = {
            "provider": ai_result.provider,
            "raw": ai_result.raw[:12000],
            "parsed": ai_result.parsed,
        }
    return report


def aggregate(case_reports: list[dict[str, Any]], ai_provider: str) -> dict[str, Any]:
    failed = [case for case in case_reports if not case.get("evaluation", {}).get("passed")]
    failure_counter: Counter[str] = Counter()
    area_counter: Counter[str] = Counter()
    targets: defaultdict[str, int] = defaultdict(int)

    for case in failed:
        for failure in case.get("evaluation", {}).get("failures", []) or []:
            failure_counter[str(failure).split(":", 1)[0]] += 1
        for suggestion in case.get("deterministicSuggestions", []) or []:
            area_counter[suggestion.get("area", "unknown")] += 1
            targets[suggestion.get("target", "unknown")] += 1
        parsed = ((case.get("aiReview") or {}).get("parsed") or {})
        for hypothesis in parsed.get("improvement_hypotheses", []) or []:
            area_counter[str(hypothesis.get("area", "ai:unknown"))] += 1
            for target in hypothesis.get("target_files", []) or []:
                targets[str(target)] += 1

    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "aiProvider": ai_provider,
        "totalCases": len(case_reports),
        "passedCases": len(case_reports) - len(failed),
        "failedCases": len(failed),
        "failureFamilies": dict(failure_counter.most_common()),
        "suggestionAreas": dict(area_counter.most_common()),
        "suggestedTargets": dict(sorted(targets.items(), key=lambda item: item[1], reverse=True)),
    }


def write_reports(report: dict[str, Any], output_dir: Path) -> tuple[Path, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    json_path = output_dir / f"meeting_minutes_ai_improvement_{stamp}.json"
    md_path = output_dir / f"meeting_minutes_ai_improvement_{stamp}.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    lines = [
        "# Meeting Minutes AI Improvement Lab",
        "",
        f"Generated: {report['summary']['generatedAt']}",
        f"AI provider: {report['summary']['aiProvider']}",
        "",
        "## Summary",
        "",
        f"- Cases: {report['summary']['totalCases']}",
        f"- Passed: {report['summary']['passedCases']}",
        f"- Failed: {report['summary']['failedCases']}",
        "",
        "## Suggested targets",
        "",
    ]
    for target, count in report["summary"].get("suggestedTargets", {}).items():
        lines.append(f"- `{target}` ({count})")
    lines.extend(["", "## Failed cases", ""])
    for case in report["cases"]:
        evaluation = case.get("evaluation", {})
        if evaluation.get("passed"):
            continue
        lines.append(f"### {case['case']}")
        if case.get("description"):
            lines.append(f"{case['description']}")
        lines.append("")
        lines.append("Failures:")
        for failure in evaluation.get("failures", []) or []:
            lines.append(f"- {failure}")
        lines.append("")
        lines.append("Suggested levers:")
        for suggestion in case.get("deterministicSuggestions", []) or []:
            lines.append(f"- **{suggestion.get('area')}** — {suggestion.get('recommended_change')}")
        parsed = ((case.get("aiReview") or {}).get("parsed") or {})
        if parsed:
            lines.append("")
            lines.append(f"AI root cause: {parsed.get('root_cause', '')}")
            for hypothesis in parsed.get("improvement_hypotheses", []) or []:
                targets = ", ".join(hypothesis.get("target_files", []) or [])
                lines.append(f"- AI: **{hypothesis.get('area')}** `{targets}` — {hypothesis.get('change')}")
        lines.append("")
    md_path.write_text("\n".join(lines).strip() + "\n", encoding="utf-8")
    return json_path, md_path


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run an AI-assisted improvement analysis for meeting-minutes extraction.")
    source = parser.add_mutually_exclusive_group(required=False)
    source.add_argument("--golden-cases", nargs="+", help="Golden case folder names to analyse. Defaults to failed/interesting recent cases.")
    source.add_argument("--transcripts", nargs="+", help="Ad hoc transcript files to analyse.")
    parser.add_argument("--all-golden", action="store_true", help="Analyse every golden case.")
    parser.add_argument("--with-ai", action="store_true", help="Use Google Colab AI when available.")
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--output-dir", default=str(REPORT_DIR))
    parser.add_argument("--json", action="store_true", help="Print the full report JSON to stdout.")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    reviewer = AIReviewer(enabled=args.with_ai)

    case_reports: list[dict[str, Any]] = []
    if args.transcripts:
        for value in args.transcripts:
            case_reports.append(transcript_payload(Path(value), timeout=args.timeout, reviewer=reviewer))
    else:
        cases = find_cases(GOLDEN_EVAL_DIR)
        if args.golden_cases:
            wanted = set(args.golden_cases)
            cases = [case for case in cases if case.name in wanted]
        elif not args.all_golden:
            # Default to a small, high-signal pack that exercises real transcripts,
            # noise abstention, actions, decisions and webinar behaviour.
            default_cases = {
                "002_incident_actions_decision",
                "003_low_substance_noise_abstention",
                "010_webinar_rehearsal_trim",
                "021_real_dita_importer_obligations_transcript",
                "022_real_eakin_sw_minutes_pdf",
            }
            cases = [case for case in cases if case.name in default_cases]
        if not cases:
            print("No cases selected.", file=sys.stderr)
            return 2
        for case in cases:
            try:
                case_reports.append(case_payload(case, timeout=args.timeout, reviewer=reviewer))
            except Exception as exc:
                case_reports.append(
                    {
                        "case": case.name,
                        "description": "analysis failed",
                        "evaluation": {"passed": False, "failures": [str(exc)]},
                        "deterministicSuggestions": deterministic_suggestions([str(exc)]),
                    }
                )

    summary = aggregate(case_reports, reviewer.provider)
    report = {"summary": summary, "cases": case_reports}
    json_path, md_path = write_reports(report, Path(args.output_dir))
    report["summary"]["reportJson"] = str(json_path)
    report["summary"]["reportMarkdown"] = str(md_path)

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(
            "AI improvement lab complete: "
            f"cases={summary['totalCases']}, passed={summary['passedCases']}, failed={summary['failedCases']}, "
            f"ai={reviewer.provider}"
        )
        print(f"JSON: {json_path}")
        print(f"Markdown: {md_path}")
        if summary.get("suggestedTargets"):
            print("Top suggested targets:")
            for target, count in list(summary["suggestedTargets"].items())[:8]:
                print(f"- {target} ({count})")
    return 1 if summary["failedCases"] else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
