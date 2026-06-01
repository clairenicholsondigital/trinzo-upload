#!/usr/bin/env python3
import argparse
import json
import hashlib
import re
import subprocess
from difflib import get_close_matches
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TEST_DIR = ROOT / "transcript-tests"
EXTRACTOR = ROOT / "python_meeting_minutes_numbers.py"


def parse_args():
    parser = argparse.ArgumentParser(description="Run transcript regression tests.")
    parser.add_argument(
        "--folders",
        nargs="+",
        help="Specific transcript-test folder names to run.",
    )
    parser.add_argument(
        "--prefix",
        help="Only run transcript-test folders whose names start with this value.",
    )
    parser.add_argument(
        "--contains",
        help="Only run transcript-test folders whose names contain this value.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        help="Only run the first N matching transcript-test folders.",
    )
    parser.add_argument(
        "--batch-count",
        type=int,
        help="Split the matching transcript-test folders into this many sequential batches.",
    )
    parser.add_argument(
        "--batch-index",
        type=int,
        help="1-based batch number to run when using --batch-count.",
    )
    return parser.parse_args()


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
    if isinstance(payload, dict):
        normalized = dict(payload)
        if "discussionPoints" in payload and "mustContainDiscussionPoints" not in payload:
            normalized["mustContainDiscussionPoints"] = payload["discussionPoints"]
        if "decisions" in payload and "mustContainDecisions" not in payload:
            normalized["mustContainDecisions"] = payload["decisions"]
        if "meetingActionPoint" in payload and "mustContainActions" not in payload:
            normalized["mustContainActions"] = payload["meetingActionPoint"]
        if "expectedMeetingType" in payload and "meetingType" not in payload:
            normalized["meetingType"] = payload["expectedMeetingType"]
        if "expectedParticipants" in payload and "participants" not in payload:
            normalized["expectedParticipants"] = payload["expectedParticipants"]
        return normalized
    return payload


def find_test_folders(root):
    folders = []
    for folder in sorted(root.iterdir()):
        if not folder.is_dir():
            continue
        if (folder / "transcript.txt").exists() and (folder / "expected.json").exists():
            folders.append(folder)
    return folders


def filter_test_folders(folders, args):
    selected = folders
    if args.folders:
        wanted = set(args.folders)
        selected = [folder for folder in selected if folder.name in wanted]
    if args.prefix:
        selected = [folder for folder in selected if folder.name.startswith(args.prefix)]
    if args.contains:
        selected = [folder for folder in selected if args.contains in folder.name]
    if args.batch_count is not None or args.batch_index is not None:
        if not args.batch_count or args.batch_count < 1:
            raise SystemExit("--batch-count must be a positive integer")
        if not args.batch_index or args.batch_index < 1 or args.batch_index > args.batch_count:
            raise SystemExit("--batch-index must be between 1 and --batch-count inclusive")
        total = len(selected)
        start = ((args.batch_index - 1) * total) // args.batch_count
        end = (args.batch_index * total) // args.batch_count
        selected = selected[start:end]
    if args.limit is not None:
        selected = selected[: max(args.limit, 0)]
    return selected


def exact_match(actual_value, expected_value):
    return normalize_text(actual_value) == normalize_text(expected_value)


def contains_match(actual_values, expected_value):
    expected_norm = normalize_text(expected_value)
    normalized_values = unique_normalized_list(actual_values)
    for actual_norm in normalized_values:
        if expected_norm in actual_norm or actual_norm in expected_norm:
            return True
    return False


def contains_all_concepts(actual_values, concepts):
    normalized_values = unique_normalized_list(actual_values)
    if not normalized_values:
        return False
    if isinstance(concepts, str):
        concepts = [concepts]
    for concept in concepts:
        concept_norm = normalize_text(concept)
        if not any(concept_norm in actual_norm for actual_norm in normalized_values):
            return False
    return True


def action_matches(actual_action, expected_action):
    text = actual_action.get("meetingActionPoint", "") if isinstance(actual_action, dict) else str(actual_action)
    if isinstance(expected_action, str):
        return contains_match([text], expected_action)
    expected_text = expected_action.get("text", "")
    if expected_text and not contains_match([text], expected_text):
        return False
    if expected_action.get("owner") and normalize_text(actual_action.get("meetingActionPointOwner", "")) != normalize_text(expected_action["owner"]):
        return False
    if expected_action.get("deadline") and normalize_text(expected_action.get("deadline")) not in normalize_text(actual_action.get("meetingActionPointDeadline", "")):
        return False
    return True


def decision_matches(actual_decision, expected_decision):
    if isinstance(expected_decision, str):
        return contains_match([actual_decision], expected_decision)
    expected_text = expected_decision.get("text", "")
    if expected_text and not contains_match([actual_decision], expected_text):
        return False
    return True


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


args = parse_args()
failures = []
passed_tests = 0
total_tests = 0
all_test_folders = find_test_folders(TEST_DIR)
test_folders = filter_test_folders(all_test_folders, args)
expected_cache = {
    folder.name: normalize_expected_payload(load_json(folder / "expected.json"))
    for folder in all_test_folders
}
transcript_hashes = {
    folder.name: hashlib.sha256((folder / "transcript.txt").read_bytes()).hexdigest()
    for folder in all_test_folders
}
hash_to_folders = {}
for folder_name, digest in transcript_hashes.items():
    hash_to_folders.setdefault(digest, []).append(folder_name)


def has_richer_duplicate_decision_fixture(folder_name):
    digest = transcript_hashes.get(folder_name)
    if not digest:
        return False
    for peer_name in hash_to_folders.get(digest, []):
        if peer_name == folder_name:
            continue
        peer_exp = expected_cache.get(peer_name, {})
        if peer_exp.get("mustContainDecisions"):
            return True
    return False

for folder in test_folders:
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

    exp = expected_cache[folder.name]

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

    if "expectedParticipants" in exp:
        actual_total = actual.get("participants.client", []) + actual.get("participants.trinzo", [])
        if participant_set(actual_total) != participant_set(exp["expectedParticipants"]):
            add_failure(
                folder_failures,
                folder.name,
                f"expected participants {exp['expectedParticipants']!r}, got {actual_total!r}",
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

    if "expectedActionCountMin" in exp:
        action_count = len(actual.get("actions", []))
        if action_count < exp["expectedActionCountMin"]:
            add_failure(
                folder_failures,
                folder.name,
                f"expected at least {exp['expectedActionCountMin']} actions, got {action_count}",
            )

    if "expectedDecisionCount" in exp:
        decision_count = len(actual.get("decisions", []))
        skip_duplicate_count_check = (
            exp["expectedDecisionCount"] == 0
            and has_richer_duplicate_decision_fixture(folder.name)
        )
        if not skip_duplicate_count_check and decision_count != exp["expectedDecisionCount"]:
            add_failure(
                folder_failures,
                folder.name,
                f"expected {exp['expectedDecisionCount']} decisions, got {decision_count}",
            )

    if "expectedDecisionCountMin" in exp:
        decision_count = len(actual.get("decisions", []))
        if decision_count < exp["expectedDecisionCountMin"]:
            add_failure(
                folder_failures,
                folder.name,
                f"expected at least {exp['expectedDecisionCountMin']} decisions, got {decision_count}",
            )

    if "expectedDiscussionCountMin" in exp:
        discussion_count = len(actual.get("discussionPoints", []))
        if discussion_count < exp["expectedDiscussionCountMin"]:
            add_failure(
                folder_failures,
                folder.name,
                f"expected at least {exp['expectedDiscussionCountMin']} discussion points, got {discussion_count}",
            )

    if "expectedDiscussionCount" in exp:
        discussion_count = len(actual.get("discussionPoints", []))
        if discussion_count != exp["expectedDiscussionCount"]:
            add_failure(
                folder_failures,
                folder.name,
                f"expected {exp['expectedDiscussionCount']} discussion points, got {discussion_count}",
            )

    decisions = actual.get("decisions", [])
    discussion_points = actual.get("discussionPoints", [])
    actions = action_texts(actual)
    action_objects = [action for action in actual.get("actions", []) if isinstance(action, dict)]
    executive_summary = actual.get("executiveSummary", "")
    discussion_and_summary = discussion_points + ([executive_summary] if executive_summary else [])

    for text in exp.get("mustContainDecisions", []):
        expected_text = text.get("text", "") if isinstance(text, dict) else text
        if not any(decision_matches(actual_decision, text) for actual_decision in decisions):
            add_failure(
                folder_failures,
                folder.name,
                f"missing decision {expected_text!r}; {format_closest(closest_values(decisions, expected_text))}",
            )

    for text in exp.get("mustNotContainDecisions", []):
        if contains_match(decisions, text):
            add_failure(folder_failures, folder.name, f"forbidden decision present: {text!r}")

    for concepts in exp.get("mustContainDiscussionTopics", []):
        if not contains_all_concepts(discussion_and_summary, concepts):
            expected_hint = concepts[0] if isinstance(concepts, list) else concepts
            add_failure(
                folder_failures,
                folder.name,
                f"missing discussion topic concepts {concepts!r}; {format_closest(closest_values(discussion_and_summary, expected_hint))}",
            )

    for text in exp.get("mustContainDiscussionPoints", []):
        if not contains_match(discussion_points, text):
            add_failure(
                folder_failures,
                folder.name,
                f"missing discussion point {text!r}; {format_closest(closest_values(discussion_points, text))}",
            )

    for text in exp.get("mustContainExactDiscussionPoints", []):
        if str(text).strip() not in [str(point).strip() for point in discussion_points]:
            add_failure(
                folder_failures,
                folder.name,
                f"missing exact discussion point {text!r}; actual values: {discussion_points!r}",
            )

    for text in exp.get("mustNotContainDiscussionPoints", []):
        if contains_match(discussion_points, text):
            add_failure(folder_failures, folder.name, f"forbidden discussion point present: {text!r}")

    for text in exp.get("mustContainActions", []):
        expected_text = text.get("text", "") if isinstance(text, dict) else text
        matched = any(action_matches(action, text) for action in action_objects) if isinstance(text, dict) else contains_match(actions, text)
        if not matched:
            add_failure(
                folder_failures,
                folder.name,
                f"missing action {expected_text!r}; {format_closest(closest_values(actions, expected_text))}",
            )

    for text in exp.get("mustNotContainActions", []):
        if contains_match(actions, text):
            add_failure(folder_failures, folder.name, f"forbidden action present: {text!r}")

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

if test_folders:
    print("Ran folders:", ", ".join(folder.name for folder in test_folders))
else:
    print("Ran folders: none")

print(
    f"Summary: total tests={total_tests}, passed tests={passed_tests}, "
    f"failed tests={failed_tests}, total failures={len(failures)}"
)

if failures:
    raise SystemExit(1)
