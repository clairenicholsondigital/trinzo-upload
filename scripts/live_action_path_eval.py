#!/usr/bin/env python3
"""Run the LIVE staged actions path over the scorecard fixtures, several times, and save run files.

The scorecard (staged_minutes_scorecard.js) measures canonicalStagedResponse, which the Actions
screen no longer uses. This harness measures what /api/staged-meeting-minutes/jobs?stage=actions
actually runs: MiniLM-v3 denoising -> staged_trooper_chunk_pipeline.run_actions_stage -> the
four-word presentation gate. Score the saved runs with score_live_action_runs.py.

Usage:
  python3 scripts/live_action_path_eval.py --label baseline --runs 3
  python3 scripts/live_action_path_eval.py --label fixes --runs 3 --only 01 06 07
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
FIXTURES = ROOT / "scripts" / "staged-scorecard-fixtures"
MODEL = ROOT / "artifacts" / "meeting-minutes-usefulness-v3" / "classifier.joblib"
OUT_ROOT = ROOT / "artifacts" / "live-action-path-eval"


def load_env() -> None:
    for path in (Path("/srv/m365-agent-test/.env"), ROOT / ".env"):
        if not path.exists():
            continue
        for line in path.read_text().splitlines():
            if line and not line.lstrip().startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
        if os.environ.get("TROOPER_API_KEY"):
            return


def generation_meeting_type(meeting_type: str, meeting_title: str, file_name: str = "") -> str:
    """Mirror of the routing in routes/api.js for the queued actions stage."""
    identity = f"{meeting_title} {file_name}"
    if meeting_type == "General" and re.search(r"\bimporter[\s_-]*obligations?\b", identity, re.I):
        return "Importer obligations review"
    if meeting_type == "General" and re.search(r"(?:lead[\s_-]*generation|generation[\s_-]*pipeline|pipeline[\s_-]*(?:planning|review))", identity, re.I):
        return "Process / pipeline planning"
    return meeting_type


def denoise(transcript_path: Path) -> dict[str, Any]:
    result = subprocess.run([sys.executable, str(ROOT / "scripts" / "staged_simplified_minilm.py"), str(transcript_path),
                             "--model", str(MODEL), "--remove-threshold", "0.85"],
                            cwd=ROOT, text=True, capture_output=True, check=True)
    prepared = json.loads(result.stdout)
    total = int(prepared.get("totalUnitCount") or 0)
    removed_ratio = (int(prepared.get("removedUnitCount") or 0) / total) if total else 1
    if not prepared.get("ok") or int(prepared.get("keptUnitCount") or 0) < 3 or len(prepared.get("preparedTranscript", "")) < 100 or removed_ratio > 0.55:
        raise RuntimeError(prepared.get("reason") or "MiniLM-v3 denoising failed its fail-open safety checks.")
    return prepared


def run_fixture(folder: Path, pipeline: Any) -> dict[str, Any]:
    payload = json.loads((folder / "expected.json").read_text())
    expected = payload.get("expected", payload)
    meeting_type = expected.get("meetingType", "")
    generation_type = generation_meeting_type(meeting_type, expected.get("meetingTitle", ""))
    started = time.time()
    prepared = denoise(folder / "transcript.txt")
    turns, numbered = pipeline.numbered_turns(prepared["preparedTranscript"])
    result = pipeline.run_actions_stage(turns, numbered, generation_type)
    shown = [row for row in result.get("actions", []) if pipeline.action_word_count(row.get("action")) >= 4]
    return {
        "name": folder.name, "meetingType": meeting_type, "generationMeetingType": generation_type,
        "expected": expected, "actions": shown, "rawActionCount": len(result.get("actions", [])),
        "actionPromptProfile": result.get("actionPromptProfile"), "chunkCount": result.get("chunkCount"),
        "candidateCountBeforeSelection": result.get("candidateCountBeforeSelection"), "actionSampleCount": result.get("actionSampleCount"),
        "turnCount": result.get("turnCount"), "durationMs": int((time.time() - started) * 1000),
        "denoise": {key: prepared.get(key) for key in ("removedUnitCount", "keptUnitCount", "totalUnitCount")},
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--label", required=True)
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--only", nargs="*", default=[], help="fixture number prefixes, e.g. 01 06")
    parser.add_argument("--workers", type=int, default=2, help="fixtures in parallel (Trooper allows 10 in-flight per key)")
    args = parser.parse_args()
    load_env()
    os.environ.setdefault("CANONICAL_MINILM_DISK_CACHE", str(ROOT / ".minilm-cache"))
    import staged_trooper_chunk_pipeline as pipeline
    folders = sorted(path for path in FIXTURES.iterdir() if path.is_dir()
                     and (not args.only or any(path.name.startswith(prefix) for prefix in args.only)))
    out_dir = OUT_ROOT / args.label
    out_dir.mkdir(parents=True, exist_ok=True)
    for run in range(1, args.runs + 1):
        out_path = out_dir / f"run-{run}.json"
        if out_path.exists():
            print(f"run {run}: exists, skipping", flush=True)
            continue
        started = time.time()
        def attempt(folder: Path) -> dict[str, Any]:
            # One failed fixture must not cost the whole run: retry once, then record the error
            # so the scorer can report the run as partial rather than the file never existing.
            for retry in range(2):
                try:
                    return run_fixture(folder, pipeline)
                except Exception as error:  # noqa: BLE001
                    print(f"  {folder.name}: {type(error).__name__}: {error}" + (" - retrying" if retry == 0 else ""), flush=True)
                    if retry == 0:
                        time.sleep(10)
            payload = json.loads((folder / "expected.json").read_text())
            expected = payload.get("expected", payload)
            return {"name": folder.name, "meetingType": expected.get("meetingType", ""), "expected": expected,
                    "actions": [], "error": "fixture failed twice"}
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
            results = list(pool.map(attempt, folders))
        out_path.write_text(json.dumps({"label": args.label, "run": run, "results": results}, ensure_ascii=False, indent=1))
        shown = sum(len(item["actions"]) for item in results)
        print(f"run {run}: {len(results)} fixtures, {shown} rows shown, {int(time.time() - started)}s -> {out_path}", flush=True)


if __name__ == "__main__":
    main()
