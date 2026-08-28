#!/usr/bin/env python3
"""Train a MiniLM classifier that nominates transcript windows for missed-action recovery."""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from pathlib import Path

import joblib
import numpy as np
from sentence_transformers import SentenceTransformer
from sklearn.linear_model import LogisticRegression


ROOT = Path(__file__).resolve().parent.parent
MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
CORPUS = ROOT / "scripts" / "staged-workflow-confidence" / "corpus-v2"


def compact(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def lexical(text: str) -> list[float]:
    return [
        bool(re.search(r"\b(?:I|we)\s*(?:['’]ll|will|shall|need to|must|have to|am going to|are going to)\b", text, re.I)),
        bool(re.search(r"\b(?:send|share|review|verify|check|confirm|complete|update|prepare|investigate|document|test|follow up|come back)\b", text, re.I)),
        bool(re.search(r"\b(?:working on|in progress|still|remaining|further|next step|roadblock|outstanding)\b", text, re.I)),
        bool(re.search(r"\b(?:need(?:s)? to|must|require(?:s|d)?|before .* can|depends? on|prerequisite)\b", text, re.I)),
        bool(re.search(r"\b(?:maybe|might|could|would|suppose|perhaps|what if)\b", text, re.I)),
        "?" in text,
        bool(re.search(r"\b(?:completed|finished|done|sent|submitted|purchased|last week|yesterday|already)\b", text, re.I)),
        bool(re.search(r"\b(?:no|not|won['’]t|doesn['’]t|rejected|pointless|park it|leave it)\b", text, re.I)),
        bool(re.search(r"\b(?:agenda|next meeting|thanks everyone|bye|break|screen share|frozen|at my door)\b", text, re.I)),
        min(1.0, text.count("\n") / 5.0),
    ]


def recovery_eligible(text: str) -> bool:
    action = r"(?:send|share|review|verify|check|confirm|complete|update|prepare|investigate|document|test|follow up|finalise|finalize|deliver|provide|load|incorporate|compile|email|call)"
    return any([
        bool(re.search(r"\b(?:I|we|you|he|she|they)\s*(?:['’]ll|will|shall|need to|must|have to|am going to|are going to)\b", text, re.I)),
        bool(re.search(rf"\b(?:need(?:s)? to|must|has to|have to|required|outstanding)\b.{{0,100}}\b{action}\b", text, re.I)),
        bool(re.search(rf"\b(?:working on|in progress|currently|continuing|being done|under review|started)\b.{{0,120}}\b{action}\w*\b", text, re.I)),
        bool(re.search(rf"\b(?:can|could|will|would) you\b.{{0,100}}\b{action}\b", text, re.I)),
        bool(re.search(rf"\bshould I\b.{{0,100}}\b{action}\b.*\b(?:yes|absolutely|okay|agreed)\b", text, re.I)),
        bool(re.search(rf"\b{action}\w*\b.{{0,100}}\b(?:tomorrow|next week|by (?:monday|tuesday|wednesday|thursday|friday)|before the end of)\b", text, re.I)),
    ])


def matrix(embedder: SentenceTransformer, rows: list[dict]) -> np.ndarray:
    embeddings = embedder.encode(
        [f"Transcript window potentially supporting an outstanding meeting action: {row['text']}" for row in rows],
        normalize_embeddings=True, show_progress_bar=False,
    )
    return np.concatenate([embeddings, np.asarray([lexical(row["text"]) for row in rows], dtype=np.float32)], axis=1)


def load_importance() -> dict[tuple[str, str], str]:
    manifest = read_json(CORPUS / "manifest.json")
    output = {}
    for case in manifest["cases"]:
        expected = read_json(ROOT / case["expectedV2Path"])["expected"]
        for action in expected.get("actions", []):
            if action.get("support") == "transcript_supported":
                output[(case["caseId"], action["id"])] = action.get("importance", "major")
    return output


def build_rows(windows: dict, adjudication: dict) -> tuple[list[dict], dict]:
    decisions = {(case["caseId"], row["id"]): row for case in adjudication["cases"] for row in case["decisions"]}
    rows = []
    excluded = Counter()
    for case in windows["cases"]:
        for row in case.get("anchors", []):
            rows.append({"case_id": case["caseId"], "id": row["id"], "text": row["text"], "label": 1,
                         "source": "human_expected_evidence", "expected_action_ids": row.get("expectedActionIds", [])})
        for row in case.get("sampled", []):
            decision = decisions.get((case["caseId"], row["id"]))
            if decision and decision.get("label") == "non_action":
                rows.append({"case_id": case["caseId"], "id": row["id"], "text": row["text"], "label": 0,
                             "source": "dual_ai_non_action", "expected_action_ids": []})
            else:
                excluded[decision.get("label", "missing") if decision else "missing"] += 1
    unique = {}
    for row in rows:
        key = (row["case_id"], row["id"])
        if key not in unique or row["label"] > unique[key]["label"]:
            unique[key] = row
    return list(unique.values()), dict(excluded)


def score(rows: list[dict], probabilities: np.ndarray, threshold: float, importance: dict) -> dict:
    predicted = probabilities >= threshold
    labels = np.asarray([row["label"] for row in rows], dtype=bool)
    tp = int(np.sum(predicted & labels)); fp = int(np.sum(predicted & ~labels))
    fn = int(np.sum(~predicted & labels)); tn = int(np.sum(~predicted & ~labels))
    expected = {}
    for index, row in enumerate(rows):
        for action_id in row.get("expected_action_ids", []):
            key = (row["case_id"], action_id)
            expected[key] = expected.get(key, False) or bool(predicted[index])
    critical = [value for key, value in expected.items() if importance.get(key) == "critical"]
    by_case = []
    for case_id in sorted(set(row["case_id"] for row in rows)):
        indexes = [i for i, row in enumerate(rows) if row["case_id"] == case_id]
        case_expected = [value for (cid, _), value in expected.items() if cid == case_id]
        by_case.append({
            "caseId": case_id, "selectedWindows": int(np.sum(predicted[indexes])),
            "negativeWindowsSelected": int(np.sum(predicted[indexes] & ~labels[indexes])),
            "actionCoverage": float(np.mean(case_expected)) if case_expected else 1.0,
        })
    return {
        "threshold": threshold, "rows": len(rows), "tp": tp, "fp": fp, "fn": fn, "tn": tn,
        "precision": tp / (tp + fp) if tp + fp else 1.0,
        "recall": tp / (tp + fn) if tp + fn else 1.0,
        "specificity": tn / (tn + fp) if tn + fp else 1.0,
        "expectedActionCoverage": float(np.mean(list(expected.values()))) if expected else 1.0,
        "criticalActionCoverage": float(np.mean(critical)) if critical else 1.0,
        "cases": by_case,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--windows", required=True)
    parser.add_argument("--adjudication", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    output = Path(args.output); output.mkdir(parents=True, exist_ok=True)
    rows, excluded = build_rows(read_json(Path(args.windows)), read_json(Path(args.adjudication)))
    labels = np.asarray([row["label"] for row in rows])
    groups = np.asarray([row["case_id"] for row in rows])
    embedder = SentenceTransformer(MODEL_NAME)
    features = matrix(embedder, rows)
    oof = np.zeros(len(rows), dtype=np.float32)
    folds = []
    for held_out in sorted(set(groups)):
        train = groups != held_out
        model = LogisticRegression(max_iter=4000, class_weight="balanced", C=0.5).fit(features[train], labels[train])
        test = np.where(groups == held_out)[0]
        oof[test] = model.predict_proba(features[test])[:, list(model.classes_).index(1)]
        folds.append({"heldOut": held_out, "trainRows": int(np.sum(train)), "testRows": len(test)})
    importance = load_importance()
    candidates = []
    for threshold in np.arange(0.05, 0.91, 0.01):
        result = score(rows, oof, float(round(threshold, 2)), importance)
        if result["expectedActionCoverage"] >= 0.95 and result["criticalActionCoverage"] >= 0.97:
            candidates.append(result)
    if not candidates:
        raise RuntimeError("No recall threshold retained the required expected and critical action coverage.")
    selected = max(candidates, key=lambda row: (row["specificity"], row["precision"], row["threshold"]))
    gate = {
        "expectedActionCoverageAtLeast95Percent": selected["expectedActionCoverage"] >= 0.95,
        "criticalActionCoverageAtLeast97Percent": selected["criticalActionCoverage"] >= 0.97,
        "negativeSpecificityAtLeast55Percent": selected["specificity"] >= 0.55,
        "parkingNegativeSelectionsAtMostFour": next(row for row in selected["cases"] if row["caseId"] == "13_parking_no_decision")["negativeWindowsSelected"] <= 4,
    }
    final = LogisticRegression(max_iter=4000, class_weight="balanced", C=0.5).fit(features, labels)
    joblib.dump({
        "schema_version": 1, "embedding_model": MODEL_NAME, "classifier": final,
        "labels": {"non_action": 0, "action_evidence": 1}, "rescue_threshold": selected["threshold"],
        "window_contract": {"size": 5, "overlap": 3}, "maximum_runtime_windows": 1,
        "quality_gate_passed": all(gate.values()),
    }, output / "classifier.joblib")
    with (output / "training_data.jsonl").open("w", encoding="utf-8") as handle:
        for row in rows: handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    metrics = {
        "schemaVersion": 1, "evaluation": "leave_one_meeting_out", "model": MODEL_NAME,
        "dataset": {"rows": len(rows), "positive": int(np.sum(labels)), "negative": int(np.sum(labels == 0)), "excluded": excluded},
        "folds": folds, "selected": selected, "qualityGate": {"passed": all(gate.values()), "checks": gate},
    }
    (output / "metrics.json").write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "output": str(output), "dataset": metrics["dataset"], "selected": selected, "qualityGate": metrics["qualityGate"]}, indent=2))


if __name__ == "__main__":
    main()
