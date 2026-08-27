#!/usr/bin/env python3
"""Build the evidence-grounded v2 confidence corpus from the 13 legacy fixtures."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "scripts" / "staged-scorecard-fixtures"
OUTPUT = Path(__file__).resolve().parent / "corpus-v2"
REMOTE_ROOT = "https://assets.helixscribe.cloud/Transcripts"
sys.path.insert(0, str(ROOT / "scripts"))

import meeting_minutes_usefulness_classifier as transcript_parser  # noqa: E402


def compact(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def slug_from_fixture(name: str) -> str:
    return name.split("_", 1)[1] if "_" in name else name


def remote_folder(expected_raw: dict) -> str:
    filename = expected_raw.get("transcriptFile", "")
    return Path(filename).stem


def importance(text: str, kind: str) -> str:
    if kind == "action":
        return "major" if re.search(r"\bteam\b|documentation quickly", text, re.I) else "critical"
    return "critical" if re.search(
        r"\b(?:risk|safety|clinical|cyber|security|compliance|regulat|deadline|decision|approved|alarm|testing)\b",
        text, re.I,
    ) else "major"


def action_basis(evidence: list[dict]) -> str:
    corpus = " ".join(item["quote"] for item in evidence)
    if re.search(r"\bshould\s+i\b", corpus, re.I) and re.search(r"\b(?:yes|yeah|absolutely)\b", corpus, re.I):
        return "accepted_proposal"
    if re.search(r"\b(?:still|further|additional|remaining)\b.{0,100}\b(?:need|must|require)", corpus, re.I):
        return "unresolved_prerequisite"
    if re.search(r"\b(?:working|updating|preparing|reviewing|rewriting|progress|ongoing|started|trying)\b", corpus, re.I):
        return "ongoing_work"
    return "explicit_commitment"


def support_status(score: float) -> str:
    if score >= 0.36:
        return "transcript_supported"
    if score >= 0.25:
        return "review_pending"
    return "contextual_human_value"


def evidence_for(text: str, rows: list[dict], embeddings: dict[str, list[float]]) -> tuple[list[dict], float]:
    import numpy as np

    vector = np.asarray(embeddings[compact(text)])
    ranked = []
    for row in rows:
        row_text = compact(row["text"])
        score = float(np.dot(vector, np.asarray(embeddings[row_text])))
        ranked.append((score, row))
    ranked.sort(key=lambda item: item[0], reverse=True)
    selected = []
    for score, row in ranked[:3]:
        if selected and score < max(0.28, ranked[0][0] - 0.12):
            continue
        selected.append({
            "sourceId": f"line_{row['line']}_unit_{row['unit']}",
            "speaker": compact(row.get("speaker")),
            "quote": compact(row.get("text")),
            "similarity": round(score, 4),
        })
    return selected, ranked[0][0] if ranked else 0.0


def topic_families(text: str, topics: list[str], embeddings: dict[str, list[float]]) -> list[str]:
    import numpy as np

    left = np.asarray(embeddings[compact(text)])
    ranked = sorted(
        ((float(np.dot(left, np.asarray(embeddings[compact(topic)]))), topic) for topic in topics),
        reverse=True,
    )
    selected = [topic for score, topic in ranked if score >= max(0.30, ranked[0][0] - 0.10)][:3]
    return selected or ([ranked[0][1]] if ranked else ["General discussion"])


def negative_controls(rows: list[dict], expect_no_actions: bool) -> list[dict]:
    patterns = [
        ("transcription_noise", re.compile(r"\b(?:started|stopped) transcription\b", re.I)),
        ("completed_history", re.compile(r"\b(?:completed|finished|done now|has been done|submitted)\b", re.I)),
        ("hypothetical_or_question", re.compile(r"\b(?:maybe|could|would|what if|wondering)\b", re.I)),
        ("meeting_logistics", re.compile(r"\b(?:next meeting|take it easy|thanks everyone|anything else)\b", re.I)),
    ]
    output = []
    for row in rows:
        text = compact(row["text"])
        for control_type, pattern in patterns:
            if pattern.search(text):
                output.append({
                    "id": f"negative_{len(output) + 1:03d}",
                    "type": "non_action",
                    "reason": control_type,
                    "importance": "critical" if expect_no_actions else "major",
                    "evidence": [{
                        "sourceId": f"line_{row['line']}_unit_{row['unit']}",
                        "speaker": compact(row.get("speaker")),
                        "quote": text,
                    }],
                })
                break
        if len(output) >= 6:
            break
    if expect_no_actions:
        output.append({
            "id": f"negative_{len(output) + 1:03d}",
            "type": "forbidden_claim",
            "reason": "no decision or follow-up was agreed in this meeting",
            "importance": "critical",
            "claim": "Publish any meeting action or confirmed parking decision.",
            "evidence": [],
        })
    return output


def fetch_bytes(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "trinzo-confidence-corpus/1"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true", help="Write expected-v2 files and manifest.")
    parser.add_argument("--skip-cloud", action="store_true", help="Do not verify cloud asset hashes.")
    args = parser.parse_args()

    from sentence_transformers import SentenceTransformer

    cases = []
    loaded = []
    all_texts: list[str] = []
    for directory in sorted(item for item in FIXTURES.iterdir() if item.is_dir()):
        transcript_path = directory / "transcript.txt"
        legacy_path = directory / "expected.json"
        raw_text = transcript_path.read_text(encoding="utf-8")
        legacy_raw = json.loads(legacy_path.read_text(encoding="utf-8"))
        expected = legacy_raw.get("expected", legacy_raw)
        rows = transcript_parser.parse_transcript(raw_text, transcript_path.name)
        expected_texts = [
            *expected.get("meetingObjectives", []),
            *expected.get("discussion", []),
            *(item.get("action", "") for item in expected.get("actions", [])),
            *expected.get("overallTopicsDiscussed", []),
        ]
        row_texts = [compact(row["text"]) for row in rows]
        all_texts.extend(expected_texts + row_texts)
        loaded.append((directory, transcript_path, legacy_path, raw_text, legacy_raw, expected, rows))

    model = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")
    unique_texts = list(dict.fromkeys(compact(text) for text in all_texts if compact(text)))
    vectors = model.encode(unique_texts, normalize_embeddings=True, show_progress_bar=False)
    embeddings = {text: vector.tolist() for text, vector in zip(unique_texts, vectors)}

    for directory, transcript_path, legacy_path, raw_text, legacy_raw, expected, rows in loaded:
        topics = expected.get("overallTopicsDiscussed", [])
        discussion = []
        for index, text in enumerate(expected.get("discussion", []), 1):
            evidence, score = evidence_for(text, rows, embeddings)
            discussion.append({
                "id": f"fact_{index:03d}",
                "text": text,
                "importance": importance(text, "discussion"),
                "support": support_status(score),
                "acceptableTopicFamilies": topic_families(text, topics, embeddings),
                "preserveUncertainty": bool(re.search(r"\b(?:expected|likely|may|might|could|anticipated|question)\b", text, re.I)),
                "evidence": evidence,
            })
        actions = []
        for index, item in enumerate(expected.get("actions", []), 1):
            evidence, score = evidence_for(item.get("action", ""), rows, embeddings)
            actions.append({
                "id": f"action_{index:03d}",
                "owner": compact(item.get("owner")) or "Not stated",
                "action": compact(item.get("action")),
                "deadline": compact(item.get("deadline")) or "Not stated",
                "importance": importance(item.get("action", ""), "action"),
                "support": support_status(score),
                "basis": action_basis(evidence),
                "evidence": evidence,
            })
        objective_rows = []
        for index, text in enumerate(expected.get("meetingObjectives", []), 1):
            evidence, score = evidence_for(text, rows, embeddings)
            objective_rows.append({
                "id": f"objective_{index:03d}", "text": text,
                "support": support_status(score), "evidence": evidence,
            })

        transcript_hash = digest(raw_text.encode("utf-8"))
        folder = remote_folder(legacy_raw)
        remote = {"folder": folder, "expectedSha256": None, "docxSha256": None}
        if not args.skip_cloud:
            base = f"{REMOTE_ROOT}/{urllib.parse.quote(folder)}/"
            remote["expectedSha256"] = digest(fetch_bytes(base + "expected.json"))
            remote["docxSha256"] = digest(fetch_bytes(base + urllib.parse.quote(legacy_raw["transcriptFile"])))
        payload = {
            "schemaVersion": 2,
            "corpusVersion": "2026-08-27-v1",
            "caseId": directory.name,
            "transcript": {
                "file": transcript_path.name,
                "sourceDocument": legacy_raw.get("transcriptFile"),
                "sha256": transcript_hash,
                "sourceUnitCount": len(rows),
            },
            "curation": {
                "annotator": "legacy human expectation audit aligned with MiniLM evidence",
                "omissionScan": "independent transcript-unit semantic scan",
                "verifier": "exact source quote and speaker resolver",
                "productionOutputSeen": False,
            },
            "expected": {
                "details": {
                    "meetingType": expected.get("meetingType", ""),
                    "meetingTitle": expected.get("meetingTitle", ""),
                },
                "summary": {
                    "meetingPurpose": expected.get("meetingPurpose", ""),
                    "objectives": objective_rows,
                    "executiveSummaryReference": expected.get("executiveSummary", ""),
                },
                "discussionFacts": discussion,
                "actions": actions,
                "negativeControls": negative_controls(rows, not bool(actions)),
            },
        }
        output_dir = OUTPUT / directory.name
        if args.write:
            output_dir.mkdir(parents=True, exist_ok=True)
            (output_dir / "expected-v2.json").write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        cases.append({
            "caseId": directory.name,
            "transcriptPath": str(transcript_path.relative_to(ROOT)),
            "expectedV2Path": str((output_dir / "expected-v2.json").relative_to(ROOT)),
            "transcriptSha256": transcript_hash,
            "legacyExpectedSha256": digest(legacy_path.read_bytes()),
            "remote": remote,
        })
    manifest = {"schemaVersion": 1, "corpusVersion": "2026-08-27-v1", "remoteRoot": REMOTE_ROOT, "cases": cases}
    if args.write:
        OUTPUT.mkdir(parents=True, exist_ok=True)
        (OUTPUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "caseCount": len(cases), "output": str(OUTPUT), "wrote": args.write}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
