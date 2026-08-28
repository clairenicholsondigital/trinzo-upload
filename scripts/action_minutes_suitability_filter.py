#!/usr/bin/env python3
"""Score final action candidates for inclusion in a draft minutes Actions table."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import joblib
import numpy as np
from sentence_transformers import SentenceTransformer


def compact(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def normalise(value: object) -> str:
    return re.sub(r"[^a-z0-9]+", " ", compact(value).lower()).strip()


def evidence_text(row: dict) -> str:
    return " ".join(
        f"{compact(item.get('speaker'))}: {compact(item.get('text'))}"
        for item in row.get("evidence", [])
        if compact(item.get("text"))
    )


def features(embedder: SentenceTransformer, rows: list[dict]) -> np.ndarray:
    evidence = [evidence_text(row) for row in rows]
    actions = embedder.encode(
        [f"Meeting-minutes action: {compact(row.get('action'))}" for row in rows],
        normalize_embeddings=True, show_progress_bar=False,
    )
    evidence_vectors = embedder.encode(
        [f"Transcript evidence: {text}" for text in evidence],
        normalize_embeddings=True, show_progress_bar=False,
    )
    support = np.sum(actions * evidence_vectors, axis=1, keepdims=True)
    lexical = []
    for row, source in zip(rows, evidence):
        candidate = compact(row.get("action"))
        lexical.append([
            bool(re.search(r"\b(?:maybe|might|could|would|suppose|perhaps|what if)\b", source, re.I)),
            "?" in source,
            bool(re.search(r"\b(?:no|not|doesn['’]t|won['’]t|pointless|too (?:dear|late)|rejected|park it)\b", source, re.I)),
            bool(re.search(r"\b(?:I|we)\s*(?:['’]ll|will|shall|need to|must|have to|am going to|are going to)\b", source, re.I)),
            bool(re.search(r"\b(?:working|updating|preparing|reviewing|testing|developing|completing|in progress)\b", source, re.I)),
            bool(re.search(r"\b(?:still|further|additional|remaining)\b.{0,100}\b(?:need|must|require)", source, re.I)),
            bool(re.search(r"\b(?:everyone|someone|somebody|all of us|the team)\b", candidate, re.I)),
            normalise(row.get("owner", "Not stated")) != "not stated",
            normalise(row.get("deadline", "Not stated")) != "not stated",
        ])
    return np.concatenate([actions, evidence_vectors, support, np.asarray(lexical, dtype=np.float32)], axis=1)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input_json")
    parser.add_argument("--model", required=True)
    parser.add_argument(
        "--threshold",
        type=float,
        help="Override the model bundle publication threshold for deployment calibration.",
    )
    args = parser.parse_args()
    payload = json.loads(Path(args.input_json).read_text(encoding="utf-8"))
    rows = list(payload.get("actions") or [])
    if not rows:
        print(json.dumps({"ok": True, "decisions": [], "threshold": None}))
        return 0
    if any(not compact(row.get("action")) or not evidence_text(row) for row in rows):
        print(json.dumps({"ok": False, "reason": "Every action requires text and cited transcript evidence."}))
        return 0
    bundle = joblib.load(args.model)
    embedder = SentenceTransformer(bundle["embedding_model"])
    classifier = bundle["classifier"]
    probabilities = classifier.predict_proba(features(embedder, rows))
    show_index = list(classifier.classes_).index(1)
    threshold = float(args.threshold if args.threshold is not None else bundle["show_threshold"])
    if not 0 <= threshold <= 1:
        raise ValueError("Publication threshold must be between 0 and 1.")
    decisions = [{
        "id": compact(row.get("id")) or f"action_{index + 1}",
        "keep": float(probability[show_index]) >= threshold,
        "showProbability": round(float(probability[show_index]), 4),
    } for index, (row, probability) in enumerate(zip(rows, probabilities))]
    print(json.dumps({
        "ok": True, "modelSchemaVersion": bundle.get("schema_version"),
        "embeddingModel": bundle["embedding_model"], "threshold": threshold,
        "decisions": decisions,
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
