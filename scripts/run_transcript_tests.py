#!/usr/bin/env python3
import json
import re
import subprocess
from difflib import get_close_matches
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TEST_DIR = ROOT / "transcript-tests"
EXTRACTOR = ROOT / "python_meeting_minutes_numbers.py"


def load_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def normalize_text(value):
    text = str(value or "")
    text = re.sub(r"\s+", " ", text.strip())
    return text.lower()


def normalized_list(values):
    return [normalize_text(value) for value in values if normalize_text(value)]


def unique_normalized_list(values):
    seen = set()
    result = []
    for value in normalized_list(values):
        if value not in seen:
            seen.add(value)
            result.append(value)
    return result


def normalize_expected_payload(payload):
    if isinstance(payload, dict) and "assertions" in payload and isinstance(payload["assertions"], dict):
        return payload["assertions"]
    return payload


def find_test_folders(root):
    folders = []
    for folder in sorted(root.iterdir()):
        if not folder.is_dir():
            continue
        if (folder / "transcript.txt").exists() and (folder / "expected.json").exists():
            folders.append(folder)
    return folders


def exact_match(actual_value, expected_value):
    return normalize_text(actual_value) == normalize_text(expected_value)


def contains_match(actual_values, expected_value):
    expected_norm = normalize_text(expected_value)
    normalized_values = unique_normalized_list(actual_values)
    for actual_norm in normalized_values:
        if expected_norm in actual_norm or actual_norm in expected_norm:
            return True
    return False


def closest_values(actual_values, expected_value, limit=3):
    normalized_to_raw = {}
    for raw_value in actual_values:
        normalized = normalize_text(raw_value)
        if normalized and normalized not in normalized_to_raw:
            normalized_to_raw[normalized] = str(raw_value).strip()

    expected_norm = normalize_text(expected_value)
    matches = get_close_matches(expected_norm, list(normalized_to_raw.keys()), n=limit, cutoff=0.25)
    return [normalized_to_raw[match] for match in matches]


def format_closest(values):
    if not values:
        return "no close actual values"
    return "closest actual values: " + "; ".join(repr(value) for value in values)


def participant_set(values):
    return set(unique_normalized_list(values))


def add_failure(failures, folder_name, message):
    failures.append(f"{folder_name}: {message}")


def action_texts(actual):
    outputs = []
    for action in actual.get("actions", []):
        if isinstance(action, dict):
            text = action.get("meetingActionPoint", "")
            if text:
                outputs.append(text)
    outputs.extend(actual.get("meetingActionPoint", []))
    return outputs


failures = []
passed_tests = 0
total_tests = 0

for folder in find_test_folders(TEST_DIR):
    total_tests += 1
    folder_failures = []

    transcript = folder / "transcript.txt"
    expected = folder / "expected.json"

    result = subprocess.run(
        ["python3", str(EXTRACTOR), str(transcript)],
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        stderr = result.stderr.strip() or "(no stderr)"
        add_failure(folder_failures, folder.name, f"extractor failed with exit code {result.returncode}; stderr: {stderr}")
        failures.extend(folder_failures)
        continue

    try:
        actual = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        add_failure(folder_failures, folder.name, f"extractor returned invalid JSON: {exc}")
        failures.extend(folder_failures)
        continue

    exp = normalize_expected_payload(load_json(expected))

    if "meetingTitle" in exp and not exact_match(actual.get("meetingTitle", ""), exp["meetingTitle"]):
        add_failure(
            folder_failures,
            folder.name,
            f"expected meetingTitle {exp['meetingTitle']!r}, got {actual.get('meetingTitle', '')!r}",
        )

    if "meetingDate" in exp and not exact_match(actual.get("meetingDate", ""), exp["meetingDate"]):
        add_failure(
            folder_failures,
            folder.name,
            f"expected meetingDate {exp['meetingDate']!r}, got {actual.get('meetingDate', '')!r}",
        )

    if "participants" in exp:
        expected_participants = exp["participants"]
        if "client" in expected_participants:
            actual_client = actual.get("participants.client", [])
            if participant_set(actual_client) != participant_set(expected_participants["client"]):
                add_failure(
                    folder_failures,
                    folder.name,
                    f"expected participants.client {expected_participants['client']!r}, got {actual_client!r}",
                )
        if "trinzo" in expected_participants:
            actual_trinzo = actual.get("participants.trinzo", [])
            if participant_set(actual_trinzo) != participant_set(expected_participants["trinzo"]):
                add_failure(
                    folder_failures,
                    folder.name,
                    f"expected participants.trinzo {expected_participants['trinzo']!r}, got {actual_trinzo!r}",
                )

    if "participantCount" in exp:
        participant_total = len(actual.get("participants.client", [])) + len(actual.get("participants.trinzo", []))
        if participant_total != exp["participantCount"]:
            add_failure(
                folder_failures,
                folder.name,
                f"expected participantCount {exp['participantCount']}, got {participant_total}",
            )

    if "meetingType" in exp and not exact_match(actual.get("meetingType", ""), exp["meetingType"]):
        add_failure(
            folder_failures,
            folder.name,
            f"expected meetingType {exp['meetingType']!r}, got {actual.get('meetingType', '')!r}",
        )

    if "expectedActionCount" in exp:
        action_count = len(actual.get("actions", []))
        if action_count != exp["expectedActionCount"]:
            add_failure(
                folder_failures,
                folder.name,
                f"expected {exp['expectedActionCount']} actions, got {action_count}",
            )

    if "expectedDecisionCount" in exp:
        decision_count = len(actual.get("decisions", []))
        if decision_count != exp["expectedDecisionCount"]:
            add_failure(
                folder_failures,
                folder.name,
                f"expected {exp['expectedDecisionCount']} decisions, got {decision_count}",
            )

    decisions = actual.get("decisions", [])
    discussion_points = actual.get("discussionPoints", [])
    actions = action_texts(actual)
    executive_summary = actual.get("executiveSummary", "")

    for text in exp.get("mustContainDecisions", []):
        if not contains_match(decisions, text):
            add_failure(
                folder_failures,
                folder.name,
                f"missing decision {text!r}; {format_closest(closest_values(decisions, text))}",
            )

    for text in exp.get("mustNotContainDecisions", []):
        if contains_match(decisions, text):
            add_failure(folder_failures, folder.name, f"forbidden decision present: {text!r}")

    for text in exp.get("mustContainDiscussionPoints", []):
        if not contains_match(discussion_points, text):
            add_failure(
                folder_failures,
                folder.name,
                f"missing discussion point {text!r}; {format_closest(closest_values(discussion_points, text))}",
            )

    for text in exp.get("mustNotContainDiscussionPoints", []):
        if contains_match(discussion_points, text):
            add_failure(folder_failures, folder.name, f"forbidden discussion point present: {text!r}")

    for text in exp.get("mustContainActions", []):
        if not contains_match(actions, text):
            add_failure(
                folder_failures,
                folder.name,
                f"missing action {text!r}; {format_closest(closest_values(actions, text))}",
            )

    for text in exp.get("mustContainExecutiveSummary", []):
        if normalize_text(text) not in normalize_text(executive_summary):
            add_failure(
                folder_failures,
                folder.name,
                f"executive summary missing {text!r}; actual summary: {executive_summary!r}",
            )

    for text in exp.get("mustNotContain", []):
        combined_values = decisions + discussion_points + actions + [executive_summary]
        if contains_match(combined_values, text):
            add_failure(folder_failures, folder.name, f"forbidden content present: {text!r}")

    if folder_failures:
        failures.extend(folder_failures)
    else:
        passed_tests += 1

failed_tests = total_tests - passed_tests

if failures:
    print("❌ Transcript tests failed")
    for failure in failures:
        print("-", failure)
else:
    print("✅ All transcript tests passed")

print(
    f"Summary: total tests={total_tests}, passed tests={passed_tests}, "
    f"failed tests={failed_tests}, total failures={len(failures)}"
)

if failures:
    raise SystemExit(1)
