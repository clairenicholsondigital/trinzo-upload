#!/usr/bin/env python3
"""Score contextual transcript windows for targeted missed-action recovery."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import joblib
from sentence_transformers import SentenceTransformer

from train_action_recall_classifier import matrix


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input_json")
    parser.add_argument("--model", required=True)
    args = parser.parse_args()
    rows = list(json.loads(Path(args.input_json).read_text(encoding="utf-8")).get("windows") or [])
    if not rows:
        print(json.dumps({"ok": True, "decisions": [], "threshold": None}))
        return 0
    bundle = joblib.load(args.model)
    embedder = SentenceTransformer(bundle["embedding_model"])
    classifier = bundle["classifier"]
    probabilities = classifier.predict_proba(matrix(embedder, rows))
    positive = list(classifier.classes_).index(1)
    threshold = float(bundle["rescue_threshold"])
    decisions = [{
        "id": row.get("id") or f"window_{index + 1}",
        "rescue": float(probability[positive]) >= threshold,
        "actionProbability": round(float(probability[positive]), 4),
    } for index, (row, probability) in enumerate(zip(rows, probabilities))]
    print(json.dumps({"ok": True, "modelSchemaVersion": bundle.get("schema_version"),
                      "embeddingModel": bundle["embedding_model"], "threshold": threshold, "decisions": decisions}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
