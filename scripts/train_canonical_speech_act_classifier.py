#!/usr/bin/env python3
"""Train a group-split MiniLM classifier candidate from reviewed contrast data."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import classification_report, confusion_matrix, f1_score
from sklearn.preprocessing import LabelEncoder, MultiLabelBinarizer
from sentence_transformers import SentenceTransformer


def single_head(frame, matrix, target):
    labelled = frame[target].astype(str).str.strip().ne("").to_numpy()
    encoder = LabelEncoder().fit(frame.loc[labelled, target])
    labels = encoder.transform(frame.loc[labelled, target])
    labelled_matrix = matrix[labelled]
    labelled_frame = frame.loc[labelled]
    train = labelled_frame["recommended_split"].eq("train").to_numpy()
    if len(encoder.classes_) < 2 or len(set(labels[train])) < 2:
        raise ValueError(f"Head {target} requires at least two labelled training classes")
    model = LogisticRegression(max_iter=3000, class_weight="balanced").fit(labelled_matrix[train], labels[train])
    metrics = {}
    for split in ("validation", "test"):
        mask = labelled_frame["recommended_split"].eq(split).to_numpy()
        if not mask.any():
            metrics[split] = {"rows": 0, "macroF1": None, "report": {}, "confusionMatrix": []}
            continue
        predicted = model.predict(labelled_matrix[mask])
        metrics[split] = {
            "rows": int(mask.sum()),
            "macroF1": f1_score(labels[mask], predicted, average="macro"),
            "report": classification_report(labels[mask], predicted, labels=range(len(encoder.classes_)), target_names=encoder.classes_, output_dict=True, zero_division=0),
            "confusionMatrix": confusion_matrix(labels[mask], predicted, labels=range(len(encoder.classes_))).tolist(),
        }
    return encoder, model, {"rows": int(labelled.sum()), **metrics}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--allow-unreviewed", action="store_true")
    parser.add_argument("--base-bundle", help="Preserve existing heads from this bundle and train only contextual heads")
    parser.add_argument("--discourse-data", help="Optional contextual discourse-role training CSV")
    args = parser.parse_args()
    frame = pd.read_csv(args.data).fillna("")
    contextual_targets = ("lifecycle_state", "context_dependency", "canonical_worthiness", "temporal_role")
    contextual_rows = frame[[column for column in contextual_targets if column in frame]].astype(str).apply(lambda column: column.str.strip().ne("")).any(axis=1)
    approval_scope = contextual_rows if args.base_bundle else frame.index.to_series().map(lambda _index: True)
    if not args.allow_unreviewed and not frame.loc[approval_scope, "review_status"].eq("human_approved").all():
        raise SystemExit("Refusing to train: labelled rows in this training scope require human approval. Use --allow-unreviewed only for an experimental benchmark.")
    leakage = frame.groupby("group_id")["recommended_split"].nunique()
    if (leakage > 1).any():
        raise SystemExit("Group leakage detected across data splits.")
    output = Path(args.output); output.mkdir(parents=True, exist_ok=False)
    model_name = "sentence-transformers/all-MiniLM-L6-v2"
    embedder = SentenceTransformer(model_name)
    if "current_text" not in frame:
        frame["current_text"] = frame["text"]
    else:
        frame["current_text"] = frame["current_text"].where(frame["current_text"].astype(str).str.strip().ne(""), frame["text"])
    for column in ("previous_text", "next_text"):
        if column not in frame: frame[column] = ""
    frame["context_text"] = frame.apply(lambda row: str(row.get("context_text") or f"[PREVIOUS]\n{row['previous_text']}\n[CURRENT]\n{row['current_text']}\n[NEXT]\n{row['next_text']}"), axis=1)
    matrix = embedder.encode(frame["current_text"].tolist(), normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False)
    context_matrix = embedder.encode(frame["context_text"].tolist(), normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False)
    if args.base_bundle:
        bundle = joblib.load(args.base_bundle)
        evidence_metrics = action_metrics = {"preserved": True, "sourceBundle": args.base_bundle}
    else:
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
        }
    bundle["bundle_schema_version"] = 4
    bundle["training_contract"] = {"groupSplit": True, "sparseHeads": True, "preservedExistingHeads": bool(args.base_bundle), "contextualLabelsHumanApproved": bool(frame.loc[contextual_rows, "review_status"].eq("human_approved").all()), "candidateOnly": bool(args.allow_unreviewed)}
    contextual_metrics = {}
    for target, prefix in (("lifecycle_state", "lifecycle"), ("context_dependency", "context_dependency"), ("canonical_worthiness", "canonical_worthiness"), ("temporal_role", "temporal_role")):
        if target not in frame or not frame[target].astype(str).str.strip().ne("").any():
            contextual_metrics[target] = {"available": False, "reason": "no_labelled_rows"}
            continue
        encoder, model, head_metrics = single_head(frame, context_matrix, target)
        bundle[f"{prefix}_label_encoder"] = encoder
        bundle[f"{prefix}_classifier"] = model
        contextual_metrics[target] = {"available": True, **head_metrics}
    discourse_metrics = {"available": False, "reason": "no_discourse_data"}
    if args.discourse_data:
        discourse_frame = pd.read_csv(args.discourse_data).fillna("")
        discourse_leakage = discourse_frame.groupby("group_id")["recommended_split"].nunique()
        if (discourse_leakage > 1).any():
            raise SystemExit("Discourse-role group leakage detected across data splits.")
        discourse_current = embedder.encode(discourse_frame["current_text"].tolist(), normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False)
        discourse_context = embedder.encode(discourse_frame["context_text"].tolist(), normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False)
        discourse_features = np.hstack([discourse_current, discourse_context, np.abs(discourse_current - discourse_context), discourse_current * discourse_context])
        discourse_encoder, discourse_model, discourse_metrics = single_head(discourse_frame, discourse_features, "discourse_role")
        bundle["discourse_role_label_encoder"] = discourse_encoder
        bundle["discourse_role_classifier"] = discourse_model
        bundle["discourse_role_feature_contract"] = "current_context_absdiff_product_v1"
        discourse_metrics = {"available": True, **discourse_metrics}
        bundle["bundle_schema_version"] = max(5, bundle.get("bundle_schema_version", 4))
    joblib.dump(bundle, output / "classifier.joblib")
    metrics = {"rows": len(frame), "groups": frame["group_id"].nunique(), "evidenceType": evidence_metrics, "actionState": action_metrics, "contextualHeads": contextual_metrics, "discourseRole": discourse_metrics}
    (output / "metrics.json").write_text(json.dumps(metrics, indent=2) + "\n")
    frame.to_csv(output / "training_data_used.csv", index=False)
    print(json.dumps(metrics, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
