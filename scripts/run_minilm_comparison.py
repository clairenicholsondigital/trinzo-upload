#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path

from meeting_minutes_minilm_experiment import run_comparison

ROOT = Path(__file__).resolve().parent
TEST_DIR = ROOT / "transcript-tests"
DEFAULT_OUTPUT = ROOT.parent / "reports" / "minilm_comparison.json"
DEFAULT_SUMMARY = ROOT.parent / "reports" / "minilm_comparison_summary.md"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run an isolated MiniLM comparison against transcript fixtures.")
    parser.add_argument("--limit", type=int, help="Only run the first N matching fixtures.")
    parser.add_argument("--folders", nargs="+", help="Specific transcript-test folder names to run.")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT), help="Path to write the JSON report.")
    parser.add_argument("--summary-output", default=str(DEFAULT_SUMMARY), help="Path to write the markdown summary.")
    parser.add_argument("--dry-run", action="store_true", help="Skip model loading and produce a baseline/no-model report.")
    parser.add_argument("--no-model", action="store_true", help="Alias for dry-run model disabling while still running baseline comparisons.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = run_comparison(
        TEST_DIR,
        Path(args.output),
        Path(args.summary_output),
        limit=args.limit,
        folders_filter=args.folders,
        enable_model=not args.no_model,
        dry_run=args.dry_run,
    )
    print(f"Wrote JSON report to {args.output}")
    print(f"Wrote markdown summary to {args.summary_output}")
    print(
        "Summary: "
        f"fixtures={report['summary']['totalFixtures']}, "
        f"baseline_passed={report['summary']['baselinePassed']}, "
        f"minilm_passed={report['summary']['minilmPassed'] if report['summary']['minilmPassed'] is not None else 'not-executed'}, "
        f"improved={report['summary']['improved']}, "
        f"worsened={report['summary']['worsened']}, "
        f"unchanged={report['summary']['unchanged']}, "
        f"skipped={report['summary']['skipped']}"
    )
    if not report["summary"]["modelAvailable"]:
        print(f"MiniLM unavailable: {report['summary']['modelReason']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
