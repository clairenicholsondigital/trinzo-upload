#!/usr/bin/env python3
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TEST_DIR = ROOT / "transcript-tests"
EXTRACTOR = ROOT / "python_meeting_minutes_numbers.py" 

def load_json(path):
    return json.loads(path.read_text(encoding="utf-8"))

def contains_any(items, expected):
    joined = "\n".join(items).lower()
    return expected.lower() in joined

failures = []

for folder in sorted(TEST_DIR.iterdir()):
    if not folder.is_dir():
        continue

    transcript = folder / "transcript.txt"
    expected = folder / "expected.json"

    if not transcript.exists() or not expected.exists():
        failures.append(f"{folder.name}: missing transcript.txt or expected.json")
        continue

    result = subprocess.run(
        ["python3", str(EXTRACTOR), str(transcript)],
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        failures.append(f"{folder.name}: extractor failed\n{result.stderr}")
        continue

    actual = json.loads(result.stdout)
    exp = load_json(expected)

    if "expectedActionCount" in exp and len(actual.get("actions", [])) != exp["expectedActionCount"]:
        failures.append(f"{folder.name}: expected {exp['expectedActionCount']} actions, got {len(actual.get('actions', []))}")

    if "expectedDecisionCount" in exp and len(actual.get("decisions", [])) != exp["expectedDecisionCount"]:
        failures.append(f"{folder.name}: expected {exp['expectedDecisionCount']} decisions, got {len(actual.get('decisions', []))}")

    for text in exp.get("mustContainDecisions", []):
        if not contains_any(actual.get("decisions", []), text):
            failures.append(f"{folder.name}: missing decision: {text}")

    for text in exp.get("mustNotContainDecisions", []):
        if contains_any(actual.get("decisions", []), text):
            failures.append(f"{folder.name}: forbidden decision present: {text}")

    for text in exp.get("mustContainDiscussionPoints", []):
        if not contains_any(actual.get("discussionPoints", []), text):
            failures.append(f"{folder.name}: missing discussion point: {text}")

if failures:
    print("❌ Transcript tests failed")
    for failure in failures:
        print("-", failure)
    raise SystemExit(1)

print("✅ All transcript tests passed")
