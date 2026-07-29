#!/usr/bin/env python3
from __future__ import annotations

import argparse
import ast
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any
from uuid import uuid4

ROOT = Path(__file__).resolve().parent
PACK_DIR = ROOT / "meeting-minutes-final-golden"
# The production /api/meeting-minutes-final route runs meeting_minutes_trooper.py
# (see routes/api.js). This must stay the default extractor so the golden pack tests
# what is actually deployed. Older Colab/MiniLM-only scripts are retained only for
# regression comparison and must be selected explicitly with --extractor.
DEFAULT_EXTRACTOR_NAME = "meeting_minutes_trooper.py"
EXTRACTOR = ROOT / DEFAULT_EXTRACTOR_NAME
REQUIRED_CATEGORIES = ("decisions", "actions", "hallucinations", "abstention")
CONVERSATIONAL_LEAKAGE = (
    "basically",
    "good point",
    "i guess",
    "i suppose",
    "i don't mind",
    "i do not mind",
    "i'm mostly here",
    "i am mostly here",
    "what you did at the weekend",
    "you know",
)
BAD_PARTICIPANT_NAMES = {"participant", "participants", "speaker", "unknown", "transcript"}
US_SPELLINGS = {
    "summarize": "summarise",
    "summarized": "summarised",
    "organize": "organise",
    "organized": "organised",
    "prioritize": "prioritise",
    "prioritized": "prioritised",
    "finalize": "finalise",
    "finalized": "finalised",
}
FIRST_PERSON_RE = re.compile(r"\b(?:i['’]?ll|i\s+will|i['’]?m|i\s+am|i\s+can|i\s+need|my|mine)\b", re.I)
SECOND_PERSON_TRANSCRIPT_RE = re.compile(r"\b(?:you['’]?ve\s+got|you\s+have\s+got|your\s+business|you\s+know)\b", re.I)
TIMECODE_RE = re.compile(r"\b(?:\d{1,2}:\d{2}(?::\d{2})?|\d{1,2}\.\d{2}\.\d{2})\b")
EMOJI_RE = re.compile(r"[\U0001F300-\U0001FAFF]")
DATE_IN_ACTION_RE = re.compile(
    r"\b(?:by|before|due|on)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|"
    r"next\s+week|next\s+month|\d{1,2}(?:st|nd|rd|th)?|january|february|march|april|may|june|july|"
    r"august|september|october|november|december)\b",
    re.I,
)
STOPWORDS = {
    "a",
    "an",
    "and",
    "as",
    "be",
    "by",
    "for",
    "from",
    "in",
    "is",
    "it",
    "of",
    "on",
    "or",
    "the",
    "to",
    "until",
    "will",
    "with",
}


def normalize_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip()).lower()


MINILM_SIMILARITY_THRESHOLD = 0.6
SEMANTIC_MATCHING_ENABLED = True
_MINILM_BACKEND_STATE: dict[str, Any] = {"loaded": False, "backend": None}


def _minilm_backend() -> Any:
    """Lazily load a single shared MiniLM backend for the whole eval run.

    Reuses scripts/meeting_minutes_minilm_experiment.MiniLMBackend -- the same
    class /project-update-test's golden eval already depends on for semantic
    milestone/risk matching -- so mustContain/requiredDiscussionTopics checks
    below aren't purely brittle to exact wording. Follows the same
    .available/.reason degrade-gracefully contract: if sentence-transformers
    isn't installed (or loading fails for any reason), callers see
    available=False and fall back to today's literal-substring-only behaviour,
    they never raise.
    """
    if not _MINILM_BACKEND_STATE["loaded"]:
        _MINILM_BACKEND_STATE["loaded"] = True
        try:
            sys.path.insert(0, str(ROOT))
            from meeting_minutes_minilm_experiment import MiniLMBackend

            _MINILM_BACKEND_STATE["backend"] = MiniLMBackend.load(enabled=True, prefer_remote=False)
        except Exception:
            _MINILM_BACKEND_STATE["backend"] = None
    return _MINILM_BACKEND_STATE["backend"]


def _semantic_match(expected_value: Any, actual_values: list[Any]) -> bool:
    if not SEMANTIC_MATCHING_ENABLED:
        return False
    backend = _minilm_backend()
    if not backend or not getattr(backend, "available", False):
        return False
    expected_text = str(expected_value or "").strip()
    if not expected_text:
        return False
    for value in actual_values:
        text = str(value or "").strip()
        if not text:
            continue
        try:
            if backend.similarity(expected_text, text) >= MINILM_SIMILARITY_THRESHOLD:
                return True
        except Exception:
            return False
    return False


def contains_match(actual_values: list[Any], expected_value: Any) -> bool:
    expected = normalize_text(expected_value)
    if any(expected in normalize_text(value) or normalize_text(value) in expected for value in actual_values if normalize_text(value)):
        return True
    if any(content_token_match(value, expected_value) for value in actual_values):
        return True
    return _semantic_match(expected_value, actual_values)


def contains_forbidden(actual_values: list[Any], forbidden_value: Any) -> bool:
    forbidden = normalize_text(forbidden_value)
    return any(forbidden in normalize_text(value) for value in actual_values if normalize_text(value))


def contains_all_concepts(actual_values: list[Any], concepts: list[str]) -> bool:
    normalized = [normalize_text(value) for value in actual_values if normalize_text(value)]
    for concept in concepts:
        concept_norm = normalize_text(concept)
        if any(concept_norm in value for value in normalized):
            continue
        if not _semantic_match(concept, actual_values):
            return False
    return True


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def string_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value if str(item).strip()]
    if isinstance(value, str) and value.strip():
        return [value]
    return []


def case_coverage(expected: dict[str, Any]) -> dict[str, Any]:
    coverage = expected.get("coverage") or {}
    return {
        "sourceFixture": str(coverage.get("sourceFixture") or ""),
        "meetingTypes": string_list(coverage.get("meetingTypes")),
        "behaviours": string_list(coverage.get("behaviours")),
    }


def coverage_summary(case_reports: list[dict[str, Any]]) -> dict[str, Any]:
    meeting_types: dict[str, int] = {}
    behaviours: dict[str, int] = {}
    source_fixtures: list[str] = []
    for report in case_reports:
        coverage = report.get("coverage") or {}
        source_fixture = coverage.get("sourceFixture")
        if source_fixture:
            source_fixtures.append(str(source_fixture))
        for tag in coverage.get("meetingTypes", []) or []:
            meeting_types[str(tag)] = meeting_types.get(str(tag), 0) + 1
        for tag in coverage.get("behaviours", []) or []:
            behaviours[str(tag)] = behaviours.get(str(tag), 0) + 1
    return {
        "meetingTypes": dict(sorted(meeting_types.items())),
        "behaviours": dict(sorted(behaviours.items())),
        "sourceFixtures": sorted(source_fixtures),
    }


def validate_manifest(pack_dir: Path, summary: dict[str, Any]) -> list[str]:
    manifest_path = pack_dir / "manifest.json"
    if not manifest_path.exists():
        return ["missing manifest.json"]
    manifest = load_json(manifest_path)
    failures: list[str] = []
    if manifest.get("caseCount") != summary["totalCases"]:
        failures.append(f"manifest caseCount={manifest.get('caseCount')} does not match cases={summary['totalCases']}")
    required = manifest.get("coverageDimensions") or {}
    coverage = summary["coverage"]
    for key, label in (("meetingTypes", "meeting type"), ("behaviours", "behaviour")):
        expected_tags = set(string_list(required.get(key)))
        actual_tags = set(coverage.get(key, {}).keys())
        missing = sorted(expected_tags - actual_tags)
        if missing:
            failures.append(f"manifest missing {label} coverage: {', '.join(missing)}")
        undocumented = sorted(actual_tags - expected_tags)
        if undocumented:
            failures.append(f"expected.json uses undocumented {label} coverage: {', '.join(undocumented)}")
    return failures


def find_cases(pack_dir: Path) -> list[Path]:
    return [
        folder
        for folder in sorted(pack_dir.iterdir())
        if folder.is_dir() and (folder / "transcript.txt").exists() and (folder / "expected.json").exists()
    ]


def action_objects(output: dict[str, Any]) -> list[dict[str, Any]]:
    actions = [item for item in output.get("actions", []) if isinstance(item, dict)]
    if not actions:
        texts = output.get("meetingActionPoint", []) or []
        owners = output.get("meetingActionPointOwner", []) or []
        deadlines = output.get("meetingActionPointDeadline", []) or []
        actions = [
            {
                "meetingActionPoint": text,
                "meetingActionPointOwner": owners[index] if index < len(owners) else "",
                "meetingActionPointDeadline": deadlines[index] if index < len(deadlines) else "",
            }
            for index, text in enumerate(texts)
        ]
    return [action for action in actions if not is_null_action(action)]


def is_null_action(action: dict[str, Any]) -> bool:
    text = normalize_text(action.get("meetingActionPoint", ""))
    text_without_period = text.rstrip(".")
    owner = normalize_text(action.get("meetingActionPointOwner", ""))
    deadline = normalize_text(action.get("meetingActionPointDeadline", ""))
    null_texts = {
        "none",
        "none.",
        "none identified",
        "none explicitly assigned",
        "none explicitly identified",
        "none stated",
        "not stated",
        "n/a",
    }
    null_owners = {"", "not stated", "n/a", "none"}
    null_deadlines = {"", "not stated", "n/a", "none"}
    return (text in null_texts or text_without_period in null_texts) and owner in null_owners and deadline in null_deadlines


def decision_texts(output: dict[str, Any]) -> list[str]:
    return [decision_text(item) for item in output.get("decisions", []) or [] if not is_null_decision(item)]


def decision_text(value: Any) -> str:
    if isinstance(value, dict):
        return str(value.get("decision") or value.get("text") or "")
    if isinstance(value, str) and value.strip().startswith("{"):
        try:
            parsed = ast.literal_eval(value)
            if isinstance(parsed, dict):
                return str(parsed.get("decision") or parsed.get("text") or value)
        except Exception:
            pass
    return str(value)


def is_null_decision(value: Any) -> bool:
    text = normalize_text(value)
    null_phrases = (
        "none explicitly recorded",
        "none explicitly identified",
        "no formal decisions were explicitly recorded",
        "no decisions were explicitly recorded",
        "not stated",
    )
    return any(phrase in text for phrase in null_phrases)


def action_texts(output: dict[str, Any]) -> list[str]:
    return [str(action.get("meetingActionPoint", "")) for action in action_objects(output) if action.get("meetingActionPoint")]


def visible_values(output: dict[str, Any]) -> list[Any]:
    values: list[Any] = []
    values.extend(decision_texts(output))
    for key in (
        "meetingTitle",
        "executiveSummary",
        "meetingObjectives",
        "discussionPoints",
        "meetingActionPoint",
        "meetingActionPointOwner",
        "meetingActionPointDeadline",
    ):
        value = output.get(key)
        if isinstance(value, list):
            values.extend(value)
        elif value:
            values.append(value)
    for action in action_objects(output):
        # Evidence/dependency metadata may contain raw transcript snippets, speaker labels,
        # timestamps, or first-person wording. Those are useful for auditability but are not
        # part of the visible client-facing minutes fields this quality gate is checking.
        for key in ("meetingActionPoint", "meetingActionPointOwner", "meetingActionPointDeadline"):
            if action.get(key):
                values.append(action[key])
    return values


def words(value: Any) -> list[str]:
    return re.findall(r"[A-Za-z0-9']+", str(value or ""))


def content_tokens(value: Any) -> list[str]:
    tokens: list[str] = []
    for word in words(value):
        token = word.lower().strip("'")
        if token in STOPWORDS or len(token) <= 2:
            continue
        if token.endswith("ing") and len(token) > 5:
            token = token[:-3]
        elif token.endswith("ed") and len(token) > 4:
            token = token[:-2]
        elif token.endswith("s") and len(token) > 4:
            token = token[:-1]
        tokens.append(token)
    return tokens


def content_token_match(actual_value: Any, expected_value: Any) -> bool:
    expected_tokens = content_tokens(expected_value)
    if len(expected_tokens) < 2:
        return False
    actual_tokens = set(content_tokens(actual_value))
    if not actual_tokens:
        return False
    matched = sum(1 for token in expected_tokens if token in actual_tokens)
    return matched >= max(2, int(len(expected_tokens) * 0.7 + 0.999))


def universal_quality_failures(output: dict[str, Any]) -> list[str]:
    """Checklist checks derived from the Notion meeting-minutes quality database."""
    failures: list[str] = []
    visible = [str(value) for value in visible_values(output)]
    flat = "\n".join(visible)
    normalized_flat = normalize_text(flat)

    title = str(output.get("meetingTitle") or "")
    if "transcript" in normalize_text(title):
        failures.append("quality: meeting title contains 'Transcript'")

    participants = output.get("participants") or {}
    all_participants = list(participants.get("client") or []) + list(participants.get("trinzo") or [])
    for participant in all_participants:
        normalized = normalize_text(participant)
        if normalized in BAD_PARTICIPANT_NAMES:
            failures.append(f"quality: invalid participant name {participant!r}")

    if EMOJI_RE.search(flat):
        failures.append("quality: visible output contains emoji")
    if TIMECODE_RE.search(flat):
        failures.append("quality: visible output contains timestamp/timecode")
    if FIRST_PERSON_RE.search(flat):
        failures.append("quality: visible output contains first-person wording")
    if SECOND_PERSON_TRANSCRIPT_RE.search(flat):
        failures.append("quality: visible output contains second-person transcript wording")

    for phrase in CONVERSATIONAL_LEAKAGE:
        if phrase in normalized_flat:
            failures.append(f"quality: conversational leakage present {phrase!r}")

    for us_spelling, british_spelling in US_SPELLINGS.items():
        if re.search(rf"\b{re.escape(us_spelling)}\b", flat, re.I):
            failures.append(f"quality: use British English spelling {british_spelling!r} instead of {us_spelling!r}")

    for action in action_objects(output):
        action_text = str(action.get("meetingActionPoint") or "")
        deadline = str(action.get("meetingActionPointDeadline") or "").strip()
        if len(words(action_text)) > 18:
            failures.append(f"quality: action item is too long/unclear {action_text!r}")
        if deadline and normalize_text(deadline) in normalize_text(action_text):
            failures.append(f"quality: action text repeats deadline column {action_text!r}")
        if deadline and DATE_IN_ACTION_RE.search(action_text):
            failures.append(f"quality: action text appears to include deadline wording {action_text!r}")

    for objective in output.get("meetingObjectives", []) or []:
        if len(words(objective)) > 28:
            failures.append(f"quality: objective is too long/transcript-like {objective!r}")

    return failures


def count_for_category(output: dict[str, Any], category: str) -> int:
    if category == "decisions":
        return len(decision_texts(output))
    if category == "actions":
        return len(action_objects(output))
    if category == "discussion":
        return len(output.get("discussionPoints", []) or [])
    raise ValueError(f"Unsupported count category: {category}")


def action_matches(actual: dict[str, Any], expected: dict[str, Any] | str) -> bool:
    text = actual.get("meetingActionPoint", "")
    if isinstance(expected, str):
        return contains_match([text], expected)
    if expected.get("text") and not contains_match([text], expected["text"]):
        return False
    if expected.get("owner") and normalize_text(actual.get("meetingActionPointOwner", "")) != normalize_text(expected["owner"]):
        return False
    if expected.get("deadline") and normalize_text(expected["deadline"]) not in normalize_text(actual.get("meetingActionPointDeadline", "")):
        return False
    return True


def score_count_rules(category_name: str, criteria: dict[str, Any], actual_count: int) -> tuple[int, list[str]]:
    checks = 0
    failures: list[str] = []
    if "minCount" in criteria:
        checks += 1
        if actual_count < int(criteria["minCount"]):
            failures.append(f"{category_name}: expected at least {criteria['minCount']} items, got {actual_count}")
    if "maxCount" in criteria:
        checks += 1
        if actual_count > int(criteria["maxCount"]):
            failures.append(f"{category_name}: expected at most {criteria['maxCount']} items, got {actual_count}")
    return checks, failures


def evaluate_case(case_name: str, output: dict[str, Any], expected: dict[str, Any]) -> dict[str, Any]:
    criteria = expected["criteria"]
    category_scores: dict[str, float] = {}
    category_failures: dict[str, list[str]] = {}

    decisions = decision_texts(output)
    actions = action_objects(output)
    discussions = [str(item) for item in output.get("discussionPoints", []) or []]
    visible = visible_values(output)

    decision_checks, decision_failures = score_count_rules("decisions", criteria["decisions"], len(decisions))
    for expected_decision in criteria["decisions"].get("mustContain", []):
        decision_checks += 1
        if not contains_match(decisions, expected_decision):
            decision_failures.append(f"decisions: missing {expected_decision!r}")
    category_failures["decisions"] = decision_failures
    category_scores["decisions"] = 1.0 if decision_checks == 0 else (decision_checks - len(decision_failures)) / decision_checks

    action_checks, action_failures = score_count_rules("actions", criteria["actions"], len(actions))
    for expected_action in criteria["actions"].get("mustContain", []):
        action_checks += 1
        if not any(action_matches(action, expected_action) for action in actions):
            action_failures.append(f"actions: missing {expected_action!r}")
    category_failures["actions"] = action_failures
    category_scores["actions"] = 1.0 if action_checks == 0 else (action_checks - len(action_failures)) / action_checks

    hallucination_checks = 0
    hallucination_failures: list[str] = []
    for forbidden in criteria["hallucinations"].get("mustNotContain", []):
        hallucination_checks += 1
        if contains_forbidden(visible, forbidden):
            hallucination_failures.append(f"hallucinations: forbidden content present {forbidden!r}")
    category_failures["hallucinations"] = hallucination_failures
    category_scores["hallucinations"] = 1.0 if hallucination_checks == 0 else (
        hallucination_checks - len(hallucination_failures)
    ) / hallucination_checks

    abstention = criteria["abstention"]
    abstention_checks = 0
    abstention_failures: list[str] = []
    for key, category in (("decisionMaxCount", "decisions"), ("actionMaxCount", "actions"), ("discussionMaxCount", "discussion")):
        if key in abstention:
            abstention_checks += 1
            actual_count = count_for_category(output, category)
            if actual_count > int(abstention[key]):
                abstention_failures.append(f"abstention: expected {category} <= {abstention[key]}, got {actual_count}")
    if "discussionMinCount" in abstention:
        abstention_checks += 1
        if len(discussions) < int(abstention["discussionMinCount"]):
            abstention_failures.append(f"abstention: expected discussion >= {abstention['discussionMinCount']}, got {len(discussions)}")
    for concepts in abstention.get("requiredDiscussionTopics", []):
        abstention_checks += 1
        if not contains_all_concepts(discussions, concepts):
            abstention_failures.append(f"abstention: missing discussion topic concepts {concepts!r}")
    category_failures["abstention"] = abstention_failures
    category_scores["abstention"] = 1.0 if abstention_checks == 0 else (abstention_checks - len(abstention_failures)) / abstention_checks

    weighted_score = 0.0
    total_weight = 0.0
    for category in REQUIRED_CATEGORIES:
        weight = float(criteria[category].get("weight", 0.0))
        weighted_score += category_scores[category] * weight
        total_weight += weight
    score = 0.0 if total_weight == 0 else round(weighted_score / total_weight, 4)
    failures = [failure for category in REQUIRED_CATEGORIES for failure in category_failures[category]]
    failures.extend(universal_quality_failures(output))
    threshold = float(expected.get("passThreshold", 1.0))
    return {
        "case": case_name,
        "score": score,
        "passThreshold": threshold,
        "passed": score >= threshold and not failures,
        "categoryScores": category_scores,
        "failures": failures,
        "counts": {
            "decisions": len(decisions),
            "actions": len(actions),
            "discussionPoints": len(discussions),
        },
    }


def validate_expected(case: Path, expected: dict[str, Any]) -> list[str]:
    failures: list[str] = []
    criteria = expected.get("criteria")
    if not isinstance(criteria, dict):
        return ["missing criteria object"]
    for category in REQUIRED_CATEGORIES:
        if category not in criteria:
            failures.append(f"missing criteria.{category}")
        elif "weight" not in criteria[category]:
            failures.append(f"missing criteria.{category}.weight")
    if not isinstance(expected.get("passThreshold"), (int, float)):
        failures.append("missing numeric passThreshold")
    coverage = case_coverage(expected)
    if not coverage["sourceFixture"]:
        failures.append("missing coverage.sourceFixture")
    if not coverage["meetingTypes"]:
        failures.append("missing coverage.meetingTypes")
    if not coverage["behaviours"]:
        failures.append("missing coverage.behaviours")
    transcript = (case / "transcript.txt").read_text(encoding="utf-8").strip()
    if len(transcript) < 80:
        failures.append("transcript fixture is too short to be useful")
    return failures


def _rewriter_meta(source: dict[str, Any]) -> dict[str, Any]:
    return {
        "rewriterAvailable": source.get("rewriterAvailable"),
        "rewriterReason": source.get("rewriterReason"),
        "rewriterTokenUsage": source.get("rewriterTokenUsage"),
    }


def run_extractor(
    case: Path,
    timeout: int,
    extractor: Path = EXTRACTOR,
    skip_rewrite: bool = False,
    evidence_json: Path | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    cmd = [sys.executable, str(extractor), str(case / "transcript.txt")]
    if evidence_json is not None:
        cmd.extend(["--project-status-evidence-json", str(evidence_json)])
    if skip_rewrite:
        cmd.append("--skip-rewrite")
    cmd.append("--skip-diagnostics")
    result = subprocess.run(
        cmd,
        cwd=ROOT.parent,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or f"extractor exited {result.returncode}")
    payload = json.loads(result.stdout)
    if not payload.get("executed"):
        reason = payload.get("modelReason") or "MiniLM backend unavailable"
        raise RuntimeError(f"extractor did not execute: {reason}")
    return payload.get("output") or {}, _rewriter_meta(payload)


def multipart_form(files: dict[str, tuple[str, bytes, str]]) -> tuple[bytes, str]:
    boundary = f"openclaw-{uuid4().hex}"
    parts: list[bytes] = []
    for name, (filename, content, content_type) in files.items():
        parts.append(f"--{boundary}\r\n".encode())
        parts.append(f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'.encode())
        parts.append(f"Content-Type: {content_type}\r\n\r\n".encode())
        parts.append(content)
        parts.append(b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), boundary


def run_live_endpoint(base_url: str, case: Path, timeout: int) -> tuple[dict[str, Any], dict[str, Any]]:
    body, boundary = multipart_form(
        {"file": ("transcript.txt", (case / "transcript.txt").read_bytes(), "text/plain")}
    )
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}/api/meeting-minutes-final?includeDiagnostics=true",
        data=body,
        method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))
    result = payload.get("result") or {}
    if not result.get("executed"):
        reason = result.get("modelReason") or payload.get("error") or "live endpoint did not execute"
        raise RuntimeError(str(reason))
    return result.get("output") or {}, _rewriter_meta(result)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the /meeting-minutes-final golden transcript evaluation pack.")
    parser.add_argument("--pack-dir", default=str(PACK_DIR))
    parser.add_argument("--cases", nargs="+", help="Specific case folder names to run.")
    parser.add_argument("--dry-run", action="store_true", help="Validate fixture/schema/scoring criteria without loading MiniLM.")
    parser.add_argument("--base-url", help="Score the deployed web-app /api/meeting-minutes-final endpoint instead of the local extractor.")
    parser.add_argument(
        "--extractor",
        default=DEFAULT_EXTRACTOR_NAME,
        help="Extractor script under scripts/ to run locally (defaults to the production meeting_minutes_trooper.py).",
    )
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument(
        "--skip-rewrite",
        action="store_true",
        help=(
            "Run the fast, rewrite-free fallback path instead of the live production path. "
            "Default (flag omitted) lets the Trooper production script use its configured rewrite path -- "
            "pass this flag for a faster deterministic dev-loop."
        ),
    )
    parser.add_argument(
        "--pace-seconds",
        type=float,
        default=3.5,
        help="Delay between external rewrite/API calls to respect rate limits. Ignored in --skip-rewrite/--dry-run mode.",
    )
    parser.add_argument(
        "--literal-only",
        action="store_true",
        help="Disable optional MiniLM semantic matching during scoring; useful for deterministic/offline dev-loop runs.",
    )
    parser.add_argument(
        "--precompute-project-status-evidence",
        action="store_true",
        help="Precompute project-status evidence once in this runner and pass JSON to the default extractor, avoiding repeated MiniLM/classifier loads.",
    )
    parser.add_argument("--json", action="store_true", help="Print the full report as JSON.")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    global SEMANTIC_MATCHING_ENABLED
    args = parse_args(argv)
    SEMANTIC_MATCHING_ENABLED = not args.literal_only
    pack_dir = Path(args.pack_dir)
    extractor = Path(args.extractor)
    if not extractor.is_absolute():
        extractor = ROOT / extractor
    cases = find_cases(pack_dir)
    if args.cases:
        wanted = set(args.cases)
        cases = [case for case in cases if case.name in wanted]
    if not cases:
        print("No golden cases found.", file=sys.stderr)
        return 2

    precomputed_evidence_paths: dict[str, Path] = {}
    if args.precompute_project_status_evidence and not args.dry_run and not args.base_url:
        if extractor.name != DEFAULT_EXTRACTOR_NAME:
            print("--precompute-project-status-evidence is only supported with the default meeting_minutes_trooper.py extractor.", file=sys.stderr)
            return 2
        evidence_module_path = ROOT / "project_status_evidence_pack.py"
        import importlib.util
        spec = importlib.util.spec_from_file_location("project_status_evidence_pack", evidence_module_path)
        evidence_module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(evidence_module)
        model_path = Path(os.environ.get("PROJECT_STATUS_MODEL_BUNDLE", str(evidence_module.DEFAULT_MODEL_PATH)))
        project_dir = Path(os.environ.get("PROJECT_STATUS_MODEL_DIR", str(evidence_module.DEFAULT_PROJECT_STATUS_DIR)))
        max_chunks = int(os.environ.get("PROJECT_STATUS_EVIDENCE_MAX_CHUNKS", "220"))
        max_items = int(os.environ.get("PROJECT_STATUS_EVIDENCE_MAX_ITEMS", "80"))
        evidence_dir = ROOT / ".golden-evidence-cache"
        evidence_dir.mkdir(exist_ok=True)
        components = evidence_module.load_classifier_components(model_path, project_dir)
        for case in cases:
            transcript_text = (case / "transcript.txt").read_text(encoding="utf-8")
            pack = evidence_module.build_pack(
                transcript_text,
                model_path=model_path,
                project_dir=project_dir,
                max_chunks=max(1, max_chunks),
                max_items=max(1, max_items),
                components=components,
            )
            evidence_path = evidence_dir / f"{case.name}.project-status-evidence.json"
            evidence_path.write_text(json.dumps(pack, ensure_ascii=False), encoding="utf-8")
            precomputed_evidence_paths[case.name] = evidence_path

    case_reports = []
    validation_failures: list[str] = []
    is_live = not args.dry_run and not args.skip_rewrite
    for index, case in enumerate(cases):
        expected = load_json(case / "expected.json")
        schema_failures = validate_expected(case, expected)
        if schema_failures:
            validation_failures.extend(f"{case.name}: {failure}" for failure in schema_failures)
        report: dict[str, Any] = {
            "case": case.name,
            "description": expected.get("description", ""),
            "coverage": case_coverage(expected),
            "dryRunValidated": not schema_failures,
        }
        if not args.dry_run and not schema_failures:
            try:
                if args.base_url:
                    output, rewriter_meta = run_live_endpoint(args.base_url, case, args.timeout)
                else:
                    output, rewriter_meta = run_extractor(
                        case,
                        args.timeout,
                        extractor,
                        args.skip_rewrite,
                        precomputed_evidence_paths.get(case.name),
                    )
                report["rewriter"] = rewriter_meta
                report["evaluation"] = evaluate_case(case.name, output, expected)
            except Exception as exc:
                report["evaluation"] = {
                    "case": case.name,
                    "score": 0.0,
                    "passThreshold": expected.get("passThreshold"),
                    "passed": False,
                    "failures": [str(exc)],
                }
        case_reports.append(report)
        if is_live and index < len(cases) - 1:
            time.sleep(args.pace_seconds)

    executed_reports = [report["evaluation"] for report in case_reports if "evaluation" in report]
    failed_evals = [report for report in executed_reports if not report.get("passed")]
    rewriter_used_count = sum(
        1 for report in case_reports if (report.get("rewriter") or {}).get("rewriterReason") == "Google AI Studio used."
    )
    summary = {
        "packDir": str(pack_dir),
        "mode": "dry-run" if args.dry_run else ("live-api" if args.base_url else "extractor"),
        "rewriteMode": "skip-rewrite" if args.skip_rewrite else ("live" if is_live else "n/a"),
        "extractor": None if (args.dry_run or args.base_url) else extractor.name,
        "baseUrl": args.base_url,
        "totalCases": len(cases),
        "schemaFailures": validation_failures,
        "executedCases": len(executed_reports),
        "passedCases": len(executed_reports) - len(failed_evals),
        "failedCases": len(failed_evals),
        "rewriterUsedCases": rewriter_used_count if is_live else None,
        "precomputedProjectStatusEvidence": bool(precomputed_evidence_paths),
        "coverage": coverage_summary(case_reports),
    }
    if not args.cases:
        validation_failures.extend(validate_manifest(pack_dir, summary))
    full_report = {"summary": summary, "cases": case_reports}

    if args.json:
        print(json.dumps(full_report, ensure_ascii=False, indent=2))
    else:
        print(
            "Meeting-minutes-final golden eval: "
            f"mode={summary['mode']}, rewrite_mode={summary['rewriteMode']}, cases={summary['totalCases']}, "
            f"schema_failures={len(validation_failures)}, executed={summary['executedCases']}, "
            f"passed={summary['passedCases']}, failed={summary['failedCases']}"
        )
        if summary["rewriterUsedCases"] is not None:
            print(
                f"Rewriter (Gemini) actually used: {summary['rewriterUsedCases']}/{summary['executedCases']} "
                "executed cases -- a lower number than expected here (rate limits, missing key, transient "
                "errors) means the score below reflects degraded/fallback output, not necessarily a real regression."
            )
        coverage = summary["coverage"]
        print(
            "Coverage: "
            f"meeting_types={len(coverage['meetingTypes'])}, behaviours={len(coverage['behaviours'])}, "
            f"source_fixtures={len(coverage['sourceFixtures'])}"
        )
        for failure in validation_failures:
            print(f"- schema: {failure}")
        for eval_report in failed_evals:
            for failure in eval_report.get("failures", []):
                print(f"- {eval_report['case']}: {failure}")

    return 1 if validation_failures or failed_evals else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
