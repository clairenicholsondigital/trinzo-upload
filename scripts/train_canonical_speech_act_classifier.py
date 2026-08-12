#!/usr/bin/env python3
"""Train a group-split MiniLM classifier candidate from reviewed contrast data."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import joblib
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import classification_report, confusion_matrix, f1_score
from sklearn.preprocessing import LabelEncoder, MultiLabelBinarizer
from sentence_transformers import SentenceTransformer


def single_head(frame, matrix, target):
    encoder = LabelEncoder().fit(frame[target])
    labels = encoder.transform(frame[target])
    train = frame["recommended_split"].eq("train").to_numpy()
    model = LogisticRegression(max_iter=3000, class_weight="balanced").fit(matrix[train], labels[train])
    metrics = {}
    for split in ("validation", "test"):
        mask = frame["recommended_split"].eq(split).to_numpy()
        predicted = model.predict(matrix[mask])
        metrics[split] = {
            "macroF1": f1_score(labels[mask], predicted, average="macro"),
            "report": classification_report(labels[mask], predicted, labels=range(len(encoder.classes_)), target_names=encoder.classes_, output_dict=True, zero_division=0),
            "confusionMatrix": confusion_matrix(labels[mask], predicted, labels=range(len(encoder.classes_))).tolist(),
        }
    return encoder, model, metrics


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--allow-unreviewed", action="store_true")
    args = parser.parse_args()
    frame = pd.read_csv(args.data).fillna("")
    if not args.allow_unreviewed and not frame["review_status"].eq("human_approved").all():
        raise SystemExit("Refusing to train: candidate rows require human approval. Use --allow-unreviewed only for an experimental benchmark.")
    leakage = frame.groupby("group_id")["recommended_split"].nunique()
    if (leakage > 1).any():
        raise SystemExit("Group leakage detected across data splits.")
    output = Path(args.output); output.mkdir(parents=True, exist_ok=False)
    model_name = "sentence-transformers/all-MiniLM-L6-v2"
    embedder = SentenceTransformer(model_name)
    matrix = embedder.encode(frame["text"].tolist(), normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False)
    evidence_encoder, evidence_model, evidence_metrics = single_head(frame, matrix, "evidence_type")
    action_encoder, action_model, action_metrics = single_head(frame, matrix, "action_state")
    all_signals = sorted({signal for value in frame["signals"] for signal in str(value).split("|") if signal})
    signal_encoder = MultiLabelBinarizer(classes=all_signals)
    signal_matrix = signal_encoder.fit_transform([[signal for signal in value.split("|") if signal] for value in frame["signals"]])
    train = frame["recommended_split"].eq("train").to_numpy()
    from sklearn.multiclass import OneVsRestClassifier
    signal_model = OneVsRestClassifier(LogisticRegression(max_iter=3000, class_weight="balanced")).fit(matrix[train], signal_matrix[train])
    bundle = {
        "embedding_model": model_name, "status_label_encoder": evidence_encoder, "status_classifier": evidence_model,
        "action_state_label_encoder": action_encoder, "action_state_classifier": action_model,
        "signal_binarizer": signal_encoder, "signal_classifier": signal_model, "all_signal_labels": all_signals,
        "training_contract": {"groupSplit": True, "candidateOnly": not frame["review_status"].eq("human_approved").all()},
    }
    joblib.dump(bundle, output / "classifier.joblib")
    metrics = {"rows": len(frame), "groups": frame["group_id"].nunique(), "evidenceType": evidence_metrics, "actionState": action_metrics}
    (output / "metrics.json").write_text(json.dumps(metrics, indent=2) + "\n")
    frame.to_csv(output / "training_data_used.csv", index=False)
    print(json.dumps(metrics, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
