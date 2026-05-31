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

def equals_text(value, expected):
    return str(value).strip().lower() == str(expected).strip().lower()

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

    if "meetingTitle" in exp and not equals_text(actual.get("meetingTitle", ""), exp["meetingTitle"]):
        failures.append(f"{folder.name}: expected meetingTitle '{exp['meetingTitle']}', got '{actual.get('meetingTitle', '')}'")

    if "meetingDate" in exp and not equals_text(actual.get("meetingDate", ""), exp["meetingDate"]):
        failures.append(f"{folder.name}: expected meetingDate '{exp['meetingDate']}', got '{actual.get('meetingDate', '')}'")

    if "participants" in exp:
        expected_participants = exp["participants"]
        if "client" in expected_participants:
            actual_client = actual.get("participants.client", [])
            if actual_client != expected_participants["client"]:
                failures.append(f"{folder.name}: expected participants.client {expected_participants['client']}, got {actual_client}")
        if "trinzo" in expected_participants:
            actual_trinzo = actual.get("participants.trinzo", [])
            if actual_trinzo != expected_participants["trinzo"]:
                failures.append(f"{folder.name}: expected participants.trinzo {expected_participants['trinzo']}, got {actual_trinzo}")

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

    for text in exp.get("mustNotContainDiscussionPoints", []):
        if contains_any(actual.get("discussionPoints", []), text):
            failures.append(f"{folder.name}: forbidden discussion point present: {text}")

    for text in exp.get("mustContainActions", []):
        if not contains_any(actual.get("meetingActionPoint", []), text):
            failures.append(f"{folder.name}: missing action: {text}")

    for text in exp.get("mustContainExecutiveSummary", []):
        if text.lower() not in actual.get("executiveSummary", "").lower():
            failures.append(f"{folder.name}: executive summary missing: {text}")

if failures:
    print("❌ Transcript tests failed")
    for failure in failures:
        print("-", failure)
    raise SystemExit(1)

print("✅ All transcript tests passed")
