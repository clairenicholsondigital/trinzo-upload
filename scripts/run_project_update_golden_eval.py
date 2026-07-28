#!/usr/bin/env python3
"""Run behavioural golden checks for /project-update-test.

Current packaged cases are AI-generated synthetic scenarios. Passing them is useful
regression evidence, not proof of real-world performance.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

REPO_DIR = Path(__file__).resolve().parents[1]
if str(REPO_DIR) not in sys.path:
    sys.path.insert(0, str(REPO_DIR))

from scripts.project_update_minilm import build_project_update_output  # noqa: E402
from scripts.project_status_evidence_pack import (  # noqa: E402
    DEFAULT_MODEL_PATH as STATUS_CLASSIFIER_MODEL_PATH,
    DEFAULT_PROJECT_STATUS_DIR,
)

CASE_ROOT = REPO_DIR / "scripts" / "project-update-golden"


def clean(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())


def canonical_status(value: Any) -> str:
    raw = clean(value).lower()
    return {
        "green": "on_track",
        "amber": "at_risk",
        "red": "off_track",
        "declining": "deteriorating",
        "new": "new_risk",
        "complete": "completed",
    }.get(raw, raw)


def norm(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()


def tokens(value: Any) -> set[str]:
    return {token for token in norm(value).split() if len(token) >= 3}


def load_cases(mode: str) -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    if mode in {"synthetic", "all"}:
        path = CASE_ROOT / "synthetic" / "cases.json"
        if path.exists():
            cases.extend(json.loads(path.read_text(encoding="utf-8")).get("synthetic_cases", []))
    if mode in {"real", "all"}:
        for path in sorted((CASE_ROOT / "real").glob("*.json")):
            payload = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(payload, dict) and "cases" in payload:
                cases.extend(payload["cases"])
            elif isinstance(payload, list):
                cases.extend(payload)
    return cases


def find_by_label(items: list[dict[str, Any]], label: str, fields: tuple[str, ...]) -> dict[str, Any] | None:
    wanted = tokens(label)
    if not wanted:
        return None
    best: tuple[float, dict[str, Any]] | None = None
    for item in items:
        text = " ".join(clean(item.get(field)) for field in fields)
        item_tokens = tokens(text)
        if not item_tokens:
            continue
        if norm(label) in norm(text) or norm(text) in norm(label):
            score = 1.0
        else:
            score = len(wanted & item_tokens) / max(1, len(wanted))
        if score >= 0.45 and (best is None or score > best[0]):
            best = (score, item)
    return best[1] if best else None


def trend_of(item: dict[str, Any]) -> str:
    return clean(item.get("trend") or item.get("delivery_status") or item.get("status")).lower()


def matched_by(item: dict[str, Any]) -> str:
    prov = item.get("risk_match_provenance") if isinstance(item.get("risk_match_provenance"), dict) else {}
    if prov.get("matchedBy"):
        return clean(prov.get("matchedBy")).lower()
    return clean(item.get("matchedBy") or item.get("matched_by") or item.get("match_provenance")).lower()


def case_context_with_retrieval(case: dict[str, Any]) -> dict[str, Any]:
    context = dict(case.get("context") or {})
    retrieved = context.get("retrievedKnowledge") if isinstance(context.get("retrievedKnowledge"), dict) else {}
    context["retrievedKnowledge"] = retrieved or {"retrievalMode": "none", "chunks": []}
    return context


def top_label(items: list[dict[str, Any]], key: str) -> str:
    counts: dict[str, float] = {}
    for item in items:
        ranked = item.get(key) if isinstance(item, dict) else None
        if not isinstance(ranked, list) or not ranked:
            continue
        best = ranked[0] if isinstance(ranked[0], dict) else {}
        label = canonical_status(best.get("label"))
        if not label:
            continue
        counts[label] = counts.get(label, 0.0) + float(best.get("score") or 0.0)
    if not counts:
        return ""
    return max(counts.items(), key=lambda item: item[1])[0]


def top_signals(items: list[dict[str, Any]], limit: int = 6) -> list[str]:
    scores: dict[str, float] = {}
    for item in items:
        for signal in item.get("signals") or []:
            if not isinstance(signal, dict):
                continue
            label = clean(signal.get("label")).lower()
            if not label:
                continue
            scores[label] = max(scores.get(label, 0.0), float(signal.get("score") or 0.0))
    return [label for label, _ in sorted(scores.items(), key=lambda item: item[1], reverse=True)[:limit]]


def status_classifier_summary(pack: dict[str, Any], report: dict[str, Any]) -> dict[str, Any]:
    items = [item for item in pack.get("items", []) if isinstance(item, dict)]
    report_health = canonical_status(report.get("overallHealth") or report.get("overallHealthRag"))
    classifier_status = top_label(items, "status")
    action_state = top_label(items, "actionState")
    comparison = "unavailable"
    if pack.get("available"):
        if not classifier_status:
            comparison = "no_strong_status_signal"
        elif classifier_status == report_health:
            comparison = "agrees"
        else:
            comparison = "differs"
    return {
        "decisionUse": "diagnostics_only",
        "available": bool(pack.get("available")),
        "reason": clean(pack.get("reason")),
        "chunksAnalysed": int(pack.get("chunksAnalysed") or 0),
        "itemCount": len(items),
        "reportOverallHealth": report_health,
        "classifierTopStatus": classifier_status,
        "classifierTopActionState": action_state,
        "classifierTopSignals": top_signals(items),
        "comparison": comparison,
    }


def run_status_classifier(case: dict[str, Any], max_chunks: int, timeout_seconds: int) -> tuple[dict[str, Any], list[str]]:
    warnings: list[str] = []
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".txt", delete=True) as transcript_file:
            transcript_file.write(case.get("transcript", ""))
            transcript_file.flush()
            completed = subprocess.run(
                [
                    sys.executable,
                    str(REPO_DIR / "scripts" / "project_status_evidence_pack.py"),
                    transcript_file.name,
                    "--model",
                    str(STATUS_CLASSIFIER_MODEL_PATH),
                    "--project-dir",
                    str(DEFAULT_PROJECT_STATUS_DIR),
                    "--max-chunks",
                    str(max_chunks),
                ],
                check=False,
                capture_output=True,
                text=True,
                timeout=max(1, timeout_seconds),
            )
    except subprocess.TimeoutExpired:
        pack = {"available": False, "items": [], "reason": "Status classifier timed out."}
    except OSError as exc:
        pack = {"available": False, "items": [], "reason": f"Status classifier could not run: {clean(exc)}"}
    else:
        if completed.returncode != 0:
            pack = {"available": False, "items": [], "reason": clean(completed.stderr or completed.stdout or f"Status classifier exited {completed.returncode}.")}
        else:
            try:
                pack = json.loads(completed.stdout)
            except json.JSONDecodeError:
                pack = {"available": False, "items": [], "reason": "Classifier returned unparseable JSON."}
    if not isinstance(pack, dict):
        return {"decisionUse": "diagnostics_only", "available": False, "reason": "Classifier returned a malformed result.", "items": []}, warnings
    if not pack.get("available"):
        warnings.append(clean(pack.get("reason")) or "Status classifier unavailable.")
    return {**pack, "decisionUse": "diagnostics_only"}, warnings


def check_case(
    case: dict[str, Any],
    *,
    use_minilm: bool,
    use_rewrite: bool,
    with_status_classifier: bool,
    status_classifier_max_chunks: int,
    status_classifier_timeout_seconds: int,
) -> tuple[bool, list[str], list[str], dict[str, Any]]:
    result = build_project_update_output(
        case.get("transcript", ""),
        use_minilm=use_minilm,
        use_rewrite=use_rewrite,
        project_context=case_context_with_retrieval(case),
    )
    report = result.get("projectReport") or {}
    diagnostics = result.get("modelDiagnostics") or {}
    expected = case.get("expected") or {}
    failures: list[str] = []
    warnings: list[str] = []

    if result.get("mode") != "project_update_minilm":
        failures.append("mode was not project_update_minilm")
    if not isinstance(report, dict):
        failures.append("projectReport missing")
        return False, failures, warnings, result

    if with_status_classifier:
        classifier_pack, classifier_warnings = run_status_classifier(case, status_classifier_max_chunks, status_classifier_timeout_seconds)
        warnings.extend(classifier_warnings)
        result["statusClassifierDiagnostics"] = classifier_pack
        result["statusClassifierComparison"] = status_classifier_summary(classifier_pack, report)
        if result["statusClassifierComparison"].get("decisionUse") != "diagnostics_only":
            failures.append("status classifier decisionUse was not diagnostics_only")
        if "comparison" not in result["statusClassifierComparison"]:
            failures.append("status classifier comparison was malformed")

    allowed_health = {canonical_status(v) for v in expected.get("overallHealthIn", [])}
    actual_health = canonical_status(report.get("overallHealth") or report.get("overallHealthRag"))
    if allowed_health and actual_health not in allowed_health:
        failures.append(f"overall health {actual_health!r} not in {sorted(allowed_health)}")

    milestones = [m for m in report.get("milestones", []) if isinstance(m, dict)]
    for check in expected.get("milestoneChecks", []) or []:
        label = check.get("labelContains", "")
        milestone = find_by_label(milestones, label, ("milestone", "milestoneName", "normalised_evidence_summary", "previous_summary"))
        if not milestone:
            failures.append(f"milestone containing {label!r} not found")
            continue
        expected_trend = clean(check.get("expectedTrend")).lower()
        expected_trends = {clean(v).lower() for v in check.get("expectedTrendIn", [])}
        if expected_trend:
            expected_trends.add(expected_trend)
        actual_trend = canonical_status(trend_of(milestone))
        expected_trends = {canonical_status(v) for v in expected_trends}
        if expected_trends and actual_trend not in expected_trends:
            failures.append(f"milestone {label!r} trend {actual_trend!r} not in {sorted(expected_trends)}")
        if check.get("shouldBeCarriedForward") and milestone.get("transcript_update_status") not in {"carried_forward", "unchanged_from_context"}:
            failures.append(f"milestone {label!r} was expected to be carried forward")

    risks = [r for r in report.get("risks", []) if isinstance(r, dict)]
    if "expectedRiskCountMax" in expected and len(risks) > int(expected["expectedRiskCountMax"]):
        failures.append(f"risk count {len(risks)} exceeded maximum {expected['expectedRiskCountMax']}")
    for check in expected.get("riskChecks", []) or []:
        label = check.get("labelContains", "")
        risk = find_by_label(risks, label, ("riskTitle", "description", "suggestedMitigation"))
        if not risk:
            failures.append(f"risk containing {label!r} not found")
            continue
        expected_trend = canonical_status(check.get("expectedTrend"))
        if expected_trend and canonical_status(risk.get("trend")) != expected_trend:
            failures.append(f"risk {label!r} trend {canonical_status(risk.get('trend'))!r} != {expected_trend!r}")
        allowed_match = {clean(v).lower() for v in check.get("expectedMatchedByIn", [])}
        if not use_minilm and "semantic" in allowed_match:
            allowed_match.add("token_overlap")
        actual_match = matched_by(risk)
        if allowed_match and actual_match and actual_match not in allowed_match:
            failures.append(f"risk {label!r} matchedBy {actual_match!r} not in {sorted(allowed_match)}")

    expected_retrieval = {clean(v).lower() for v in expected.get("expectedRetrievalModeIn", [])}
    actual_retrieval = clean((report.get("retrievedKnowledge") or diagnostics.get("projectKnowledge") or {}).get("retrievalMode")).lower()
    if expected_retrieval and actual_retrieval not in expected_retrieval:
        failures.append(f"retrieval mode {actual_retrieval!r} not in {sorted(expected_retrieval)}")

    if expected.get("mustNotUseRetrievedKnowledgeAsTranscriptEvidence"):
        knowledge = diagnostics.get("projectKnowledge") or report.get("retrievedKnowledge") or {}
        if knowledge.get("usedAsTranscriptEvidence") is True:
            failures.append("retrieved knowledge was marked as transcript evidence")

    if expected.get("shouldGenerateSparseOutput"):
        updated = [m for m in milestones if m.get("transcript_update_status") == "updated_from_transcript"]
        if len(updated) > 1 or len(risks) > 1:
            failures.append("sparse-output case produced too many transcript updates/risks")

    return not failures, failures, warnings, result


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Run project-update golden behavioural checks.")
    parser.add_argument("--mode", choices=["synthetic", "real", "all"], default="synthetic")
    parser.add_argument("--skip-minilm", action="store_true", help="Disable MiniLM for faster/deterministic smoke runs.")
    parser.add_argument("--use-rewrite", action="store_true", help="Enable optional rewrite layer; off by default for eval stability.")
    parser.add_argument("--with-status-classifier", action="store_true", help="Run the separate status classifier as diagnostics and compare it with report output.")
    parser.add_argument("--status-classifier-max-chunks", type=int, default=24, help="Maximum transcript chunks to send through classifier diagnostics.")
    parser.add_argument("--status-classifier-timeout-seconds", type=int, default=20, help="Per-case timeout for optional classifier diagnostics.")
    parser.add_argument("--json", action="store_true", help="Emit JSON summary.")
    args = parser.parse_args(argv)

    cases = load_cases(args.mode)
    results = []
    for case in cases:
        ok, failures, warnings, result = check_case(
            case,
            use_minilm=not args.skip_minilm,
            use_rewrite=args.use_rewrite,
            with_status_classifier=args.with_status_classifier,
            status_classifier_max_chunks=max(1, args.status_classifier_max_chunks),
            status_classifier_timeout_seconds=max(1, args.status_classifier_timeout_seconds),
        )
        item = {"case_id": case.get("case_id"), "case_name": case.get("case_name"), "source": case.get("source", "unknown"), "ok": ok, "failures": failures, "warnings": warnings}
        if args.with_status_classifier:
            item["statusClassifierComparison"] = result.get("statusClassifierComparison", {})
        results.append(item)

    passed = sum(1 for item in results if item["ok"])
    summary = {
        "ok": passed == len(results),
        "mode": args.mode,
        "caseCount": len(results),
        "passed": passed,
        "failed": len(results) - passed,
        "warningCount": sum(len(item.get("warnings", [])) for item in results),
        "syntheticCaveat": "Synthetic cases are AI-generated behavioural checks, not proof of real-world performance.",
        "statusClassifierMode": "diagnostics_only" if args.with_status_classifier else "not_run",
        "results": results,
    }
    if args.json:
        print(json.dumps(summary, indent=2, ensure_ascii=False))
    else:
        print("Project update golden eval")
        print(summary["syntheticCaveat"])
        print(f"Mode: {args.mode} | Passed: {passed}/{len(results)}")
        for item in results:
            mark = "✓" if item["ok"] else "✗"
            print(f"{mark} {item['case_id']} — {item['case_name']}")
            for failure in item["failures"]:
                print(f"    - FAIL: {failure}")
            for warning in item.get("warnings", []):
                print(f"    - WARN: {warning}")
            if args.with_status_classifier:
                comparison = item.get("statusClassifierComparison") or {}
                print(
                    "    - STATUS CLASSIFIER: "
                    f"{comparison.get('comparison', 'unknown')} "
                    f"(report={comparison.get('reportOverallHealth') or '-'}, "
                    f"classifier={comparison.get('classifierTopStatus') or '-'}, "
                    f"action={comparison.get('classifierTopActionState') or '-'})"
                )
    return 0 if summary["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
