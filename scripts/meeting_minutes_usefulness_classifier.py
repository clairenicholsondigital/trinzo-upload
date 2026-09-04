#!/usr/bin/env python3
"""Experimental MiniLM classifier for transcript usefulness.

The classifier works on speaker-attributed sentence units and returns one of:
retain, remove, or uncertain.  It is deliberately fail-open: uncertain units
remain in the cleaned transcript.  The initial labels are bootstrap labels and
must be reviewed before using this in production.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path


MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
LABELS = ("retain", "remove", "uncertain")
SPEAKER_LINE = re.compile(r"^\s*(?P<speaker>[A-Za-z][A-Za-z .,'()&/\-]{1,90}?)\s+(?P<timestamp>\d{1,2}:\d{2}(?::\d{2})?)(?P<text>.*)$")
SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9\"'])")
NOISE = re.compile(
    r"\b(?:share my screen|screen share|can you hear|can't hear|mute|unmute|camera|"
    r"transcription|mic(?:rophone)?|audio|connection|hold on|one second|sorry about that|"
    r"going to sneeze|need to sneeze|sneeze|sneezing)\b",
    re.I,
)
TRANSCRIPTION_MARKER = re.compile(r"\b(?:started|stopped)\s+transcription\b", re.I)
FORCE_REMOVE_NOISE = re.compile(r"\b(?:going to sneeze|need to sneeze|sneeze|sneezing)\b", re.I)
BACKCHANNEL = re.compile(r"^(?:yeah|yes|no|okay|ok|right|great|thanks|thank you|lovely|brilliant|fine|cool|mm|mhm|yep|exactly)[.!?, ]*$", re.I)
MINUTES_SIGNAL = re.compile(
    r"\b(?:decid(?:e|ed|es|ing)|agreed|approved|reject(?:ed|ion)?|will|shall|need(?:s)? to|"
    r"have to|action|owner|deadline|by (?:monday|tuesday|wednesday|thursday|friday|next week)|"
    r"risk|block(?:er|ed)?|issue|problem|budget|cost|date|deliver|complete|review|send|share|"
    r"update|prepare|confirm|provide|submit|launch|release|status|progress|target|"
    r"because|therefore|however|not enough|cannot|can't)\b",
    re.I,
)
CONCRETE = re.compile(r"(?:\b\d+(?:[.,]\d+)?\b|\b[A-Z][A-Za-z]{2,}\b|\b(?:QMS|MDR|PPE|HPRA|UDI|DoC)\b)")
RATIONALE_OR_IMPACT = re.compile(
    r"\b(?:because|based on|justif(?:y|ied|ication)|rationale|evidence|support(?:s|ing)?|"
    r"risk (?:score|rating|assessment)|occurrence|severity|benefit.?risk|consequence|"
    r"introduce another software change|another software change|clinical delay|no incidences?)\b",
    re.I,
)


def compact(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def read_transcript_file(path: Path) -> str:
    """Read plain text or the visible paragraphs from a Word DOCX transcript."""
    if path.suffix.lower() != ".docx":
        return path.read_text(encoding="utf-8")
    with zipfile.ZipFile(path) as archive:
        root = ET.fromstring(archive.read("word/document.xml"))
    namespace = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    paragraphs = []
    for paragraph in root.iter(f"{namespace}p"):
        pieces = []
        for node in paragraph.iter():
            if node.tag == f"{namespace}t":
                pieces.append(node.text or "")
            elif node.tag in {f"{namespace}tab", f"{namespace}br"}:
                pieces.append(" ")
        value = compact("".join(pieces))
        if value:
            paragraphs.append(value)
    return "\n".join(paragraphs)


def parse_transcript(text: str, source: str = "") -> list[dict]:
    """Parse Teams-style lines while retaining speaker and timestamp."""
    units: list[dict] = []
    current: dict | None = None
    for line_no, raw in enumerate(text.splitlines(), 1):
        line = compact(raw)
        if not line:
            continue
        if TRANSCRIPTION_MARKER.search(line):
            continue
        match = SPEAKER_LINE.match(line)
        if match:
            if current:
                units.extend(split_unit(current))
            current = {
                "source": source,
                "line": line_no,
                "speaker": compact(match.group("speaker")),
                "timestamp": match.group("timestamp"),
                "body": compact(match.group("text")),
            }
        elif current and not re.match(r"^(?:\d+ June \d{4}|\d+m \d+s|.+ started transcription)$", line, re.I):
            current["body"] = compact(f"{current['body']} {line}")
    if current:
        units.extend(split_unit(current))
    return units


def split_unit(turn: dict) -> list[dict]:
    body = compact(turn.get("body", ""))
    if not body:
        return []
    parts = [compact(item) for item in SENTENCE_SPLIT.split(body) if compact(item)]
    # Transcripts frequently omit punctuation. Keep a meaningful utterance as one unit.
    if len(parts) == 1 and len(body) > 650:
        parts = [body]
    result = []
    for index, part in enumerate(parts):
        words = re.findall(r"[A-Za-z0-9']+", part)
        if len(words) < 3:
            continue
        result.append({
            "source": turn["source"], "line": turn["line"], "unit": index,
            "speaker": turn["speaker"], "timestamp": turn["timestamp"], "text": part,
        })
    return result


def bootstrap_label(text: str) -> tuple[str, str]:
    """Return a cautious seed label and the human-readable reason."""
    value = compact(text)
    words = len(re.findall(r"[A-Za-z0-9']+", value))
    if BACKCHANNEL.fullmatch(value):
        return "remove", "backchannel"
    if TRANSCRIPTION_MARKER.search(value):
        return "remove", "transcription marker"
    if NOISE.search(value):
        return "remove", "meeting logistics or audio noise"
    if words <= 5:
        return "remove", "very short low-information utterance"
    if RATIONALE_OR_IMPACT.search(value) and words >= 8:
        return "retain", "risk rationale or project-impact evidence"
    if MINUTES_SIGNAL.search(value) and (CONCRETE.search(value) or words >= 9):
        return "retain", "minutes signal"
    if CONCRETE.search(value) and words >= 10:
        return "retain", "concrete substantive statement"
    return "uncertain", "requires human review"


def load_dependencies():
    try:
        import joblib
        import numpy as np
        from sentence_transformers import SentenceTransformer
        from sklearn.linear_model import LogisticRegression
        from sklearn.metrics import classification_report
        from sklearn.model_selection import GroupShuffleSplit
    except ImportError as exc:
        raise SystemExit(f"Missing experimental ML dependency: {exc}. Install requirements-experimental-minilm.txt")
    return joblib, np, SentenceTransformer, LogisticRegression, classification_report, GroupShuffleSplit


def discover_transcripts(root: Path) -> list[Path]:
    return sorted(root.glob("*/transcript.txt"))


def write_review_csv(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = ["id", "source", "line", "speaker", "timestamp", "text", "bootstrap_label", "bootstrap_reason", "reviewed_label"]
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({field: row.get(field, "") for field in fields})


def train(args: argparse.Namespace) -> int:
    joblib, np, SentenceTransformer, LogisticRegression, classification_report, GroupShuffleSplit = load_dependencies()
    transcript_paths = discover_transcripts(Path(args.transcripts))
    if not transcript_paths:
        raise SystemExit(f"No transcript.txt files found under {args.transcripts}")
    rows: list[dict] = []
    for path in transcript_paths:
        for row in parse_transcript(read_transcript_file(path), path.parent.name):
            label, reason = bootstrap_label(row["text"])
            row.update({"id": f"{row['source']}:{row['line']}:{row['unit']}", "bootstrap_label": label, "bootstrap_reason": reason, "reviewed_label": ""})
            rows.append(row)
    if args.augmentation:
        with Path(args.augmentation).open(encoding="utf-8") as handle:
            for index, item in enumerate(csv.DictReader(handle)):
                label = compact(item.get("label", "")).lower()
                text = compact(item.get("text", ""))
                if label not in LABELS or not text:
                    continue
                rows.append({
                    "id": f"ai_augmentation:{index}", "source": item.get("source", "ai_augmentation"),
                    "line": "", "unit": index, "speaker": "", "timestamp": "", "text": text,
                    "bootstrap_label": label, "bootstrap_reason": item.get("reason", "curated augmentation"),
                    "reviewed_label": label,
                })
    if args.labels and Path(args.labels).exists():
        reviewed = {}
        with Path(args.labels).open(encoding="utf-8") as handle:
            for row in csv.DictReader(handle):
                if row.get("reviewed_label") in LABELS:
                    reviewed[row.get("id", "")] = row["reviewed_label"]
        for row in rows:
            if row["id"] in reviewed:
                row["reviewed_label"] = reviewed[row["id"]]
    labels = [row["reviewed_label"] or row["bootstrap_label"] for row in rows]
    if len(set(labels)) < 3:
        raise SystemExit("Training needs all three labels; review or expand the bootstrap data.")
    embedder = SentenceTransformer(MODEL_NAME)
    matrix = embedder.encode([row["text"] for row in rows], normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=True)
    groups = np.array([row["source"] for row in rows])
    y = np.array(labels)
    splitter = GroupShuffleSplit(n_splits=1, test_size=0.25, random_state=42)
    train_idx, test_idx = next(splitter.split(matrix, y, groups))
    model = LogisticRegression(max_iter=3000, class_weight="balanced").fit(matrix[train_idx], y[train_idx])
    predictions = model.predict(matrix[test_idx])
    metrics = {
        "embedding_model": MODEL_NAME, "transcripts": len(transcript_paths), "units": len(rows),
        "label_counts": {label: labels.count(label) for label in LABELS},
        "test_units": len(test_idx),
        "group_split": True,
        "classification_report": classification_report(y[test_idx], predictions, labels=list(LABELS), output_dict=True, zero_division=0),
        "warning": "Bootstrap labels are experimental and require human review before production use.",
    }
    output = Path(args.output); output.mkdir(parents=True, exist_ok=True)
    joblib.dump({"embedding_model": MODEL_NAME, "classifier": model, "labels": LABELS, "schema_version": 1}, output / "classifier.joblib")
    (output / "metrics.json").write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf-8")
    write_review_csv(output / "review_labels.csv", rows)
    print(json.dumps(metrics, indent=2))
    return 0


def classify(args: argparse.Namespace) -> int:
    joblib, _np, SentenceTransformer, _LogisticRegression, _report, _splitter = load_dependencies()
    bundle = joblib.load(args.model)
    path = Path(args.transcript)
    rows = parse_transcript(read_transcript_file(path), path.name)
    embedder = SentenceTransformer(bundle["embedding_model"])
    matrix = embedder.encode([row["text"] for row in rows], normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False)
    model = bundle["classifier"]
    probabilities = model.predict_proba(matrix)
    results = []
    for row, probs in zip(rows, probabilities):
        best = int(probs.argmax())
        predicted = str(model.classes_[best])
        confidence = float(probs[best])
        # Never delete a borderline item. The caller can opt into removing only
        # high-confidence junk with --remove-threshold.
        effective = "uncertain" if predicted == "remove" and confidence < args.remove_threshold else predicted
        if FORCE_REMOVE_NOISE.search(row["text"]):
            effective = "remove"
        # Supporting rationale and project-impact consequences are easy to
        # mistake for non-action discussion. Preserve them if the model wants
        # to remove them; they remain visible and reviewable as uncertain.
        if effective == "remove" and RATIONALE_OR_IMPACT.search(row["text"]):
            effective = "uncertain"
        results.append({**row, "classification": effective, "confidence": round(confidence, 4), "probabilities": {str(label): round(float(prob), 4) for label, prob in zip(model.classes_, probs)}})
    kept = [row for row in results if row["classification"] != "remove"]
    cleaned = "\n".join(f"{row['speaker']} {row['timestamp']} {row['text']}" for row in kept)
    output = {"executed": True, "model": str(args.model), "input": str(path), "counts": {label: sum(row["classification"] == label for row in results) for label in LABELS}, "units": results, "cleaned_transcript": cleaned}
    print(json.dumps(output, indent=2, ensure_ascii=False))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    train_parser = commands.add_parser("train")
    train_parser.add_argument("--transcripts", required=True, help="directory containing transcript fixture directories")
    train_parser.add_argument("--output", required=True, help="directory for model, metrics, and review CSV")
    train_parser.add_argument("--labels", help="optional reviewed CSV from a previous run")
    train_parser.add_argument("--augmentation", help="optional CSV of curated text,label,reason examples")
    train_parser.set_defaults(function=train)
    classify_parser = commands.add_parser("classify")
    classify_parser.add_argument("transcript")
    classify_parser.add_argument("--model", required=True)
    classify_parser.add_argument("--remove-threshold", type=float, default=0.85)
    classify_parser.set_defaults(function=classify)
    args = parser.parse_args()
    return args.function(args)


if __name__ == "__main__":
    raise SystemExit(main())
