#!/usr/bin/env python3
"""Train an evidence-aware MiniLM publication filter for final action rows.

The model is deliberately a second-stage filter: it receives an already-retrieved
action plus the nearest supporting transcript units. Evaluation is leave-one-meeting-
out so repeated runs of a transcript cannot leak into its test fold.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import joblib
import numpy as np
from sentence_transformers import SentenceTransformer
from sklearn.linear_model import LogisticRegression


ROOT = Path(__file__).resolve().parent.parent
MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
CORPUS = ROOT / "scripts" / "staged-workflow-confidence" / "corpus-v2"
sys.path.insert(0, str(ROOT / "scripts"))
import meeting_minutes_usefulness_classifier as transcript_parser  # noqa: E402


def compact(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def normalise(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", compact(value).lower()).strip()


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def action_rows(payload: dict) -> list[dict]:
    for screen in payload.get("ui", {}).get("screens", []):
        if screen.get("key") == "actions":
            return list(screen.get("data") or [])
    return []


def load_cases() -> dict[str, dict]:
    manifest = load_json(CORPUS / "manifest.json")
    cases = {}
    for item in manifest["cases"]:
        case_id = item["caseId"]
        expected = load_json(ROOT / item["expectedV2Path"])["expected"]
        transcript_path = ROOT / item["transcriptPath"]
        units = transcript_parser.parse_transcript(transcript_path.read_text(encoding="utf-8"), transcript_path.name)
        cases[case_id] = {
            "expected": [row for row in expected["actions"] if row.get("support") == "transcript_supported"],
            "negative_controls": expected.get("negativeControls", []),
            "units": units,
        }
    return cases


def collect_runs(report_path: Path) -> tuple[dict, list[dict]]:
    report = load_json(report_path)
    base = report_path.parent
    rows = []
    for scored in report["runs"]:
        raw = load_json(base / "raw" / f"run-{int(scored['run']):02d}" / f"{scored['caseId']}.json")
        generated = action_rows(raw["payload"])
        matched = {int(pair["generatedIndex"]) for pair in scored["metrics"]["actions"]["pairs"]}
        rows.append({
            "id": scored["id"], "case_id": scored["caseId"], "run": int(scored["run"]),
            "expected_total": int(scored["metrics"]["actions"]["expectedTotal"]),
            "generated": generated, "matched_indices": matched,
        })
    return report, rows


def cosine(left: np.ndarray, right: np.ndarray) -> np.ndarray:
    if not len(left) or not len(right):
        return np.zeros((len(left), len(right)), dtype=np.float32)
    return left @ right.T


def evidence_text(evidence: list[dict]) -> str:
    return " ".join(compact(row.get("quote") or row.get("text")) for row in evidence if compact(row.get("quote") or row.get("text")))


def nearest_evidence(action: str, units: list[dict], vectors: dict[str, np.ndarray], count: int = 3) -> tuple[str, float]:
    if not units:
        return "", 0.0
    action_vector = vectors[compact(action)]
    unit_vectors = np.asarray([vectors[compact(row["text"])] for row in units])
    scores = unit_vectors @ action_vector
    best = np.argsort(-scores)[:count]
    # Preserve transcript order after semantic selection. Speaker names help the model
    # distinguish a concrete commitment from an unattributed subject summary.
    selected = sorted(int(index) for index in best)
    text = " ".join(f"{compact(units[index].get('speaker'))}: {compact(units[index]['text'])}" for index in selected)
    return text, float(scores[best[0]])


def feature_matrix(embedder: SentenceTransformer, examples: list[dict]) -> np.ndarray:
    actions = embedder.encode(
        [f"Meeting-minutes action: {row['text']}" for row in examples],
        normalize_embeddings=True, show_progress_bar=False,
    )
    evidence = embedder.encode(
        [f"Transcript evidence: {row['evidence']}" for row in examples],
        normalize_embeddings=True, show_progress_bar=False,
    )
    support = np.sum(actions * evidence, axis=1, keepdims=True)
    lexical = []
    for row in examples:
        evidence_text_value = compact(row["evidence"])
        candidate = compact(row["text"])
        lexical.append([
            bool(re.search(r"\b(?:maybe|might|could|would|suppose|perhaps|what if)\b", evidence_text_value, re.I)),
            "?" in evidence_text_value,
            bool(re.search(r"\b(?:no|not|doesn['’]t|won['’]t|pointless|too (?:dear|late)|rejected|park it)\b", evidence_text_value, re.I)),
            bool(re.search(r"\b(?:I|we)\s*(?:['’]ll|will|shall|need to|must|have to|am going to|are going to)\b", evidence_text_value, re.I)),
            bool(re.search(r"\b(?:working|updating|preparing|reviewing|testing|developing|completing|in progress)\b", evidence_text_value, re.I)),
            bool(re.search(r"\b(?:still|further|additional|remaining)\b.{0,100}\b(?:need|must|require)", evidence_text_value, re.I)),
            bool(re.search(r"\b(?:everyone|someone|somebody|all of us|the team)\b", candidate, re.I)),
            normalise(row.get("owner", "Not stated")) != "not stated",
            normalise(row.get("deadline", "Not stated")) != "not stated",
        ])
    return np.concatenate([actions, evidence, support, np.asarray(lexical, dtype=np.float32)], axis=1)


def build_dataset(embedder: SentenceTransformer, runs: list[dict], cases: dict, negative_similarity: float) -> tuple[list[dict], dict]:
    all_text = []
    for case in cases.values():
        all_text.extend(compact(unit["text"]) for unit in case["units"])
        all_text.extend(compact(row["action"]) for row in case["expected"])
    all_text.extend(compact(item["action"]) for run in runs for item in run["generated"])
    unique = list(dict.fromkeys(text for text in all_text if text))
    matrix = embedder.encode(unique, normalize_embeddings=True, show_progress_bar=False)
    vectors = dict(zip(unique, matrix))

    examples = []
    nearest_by_candidate = {}
    for run in runs:
        case = cases[run["case_id"]]
        for index, item in enumerate(run["generated"]):
            nearest_by_candidate[(run["case_id"], run["run"], index)] = nearest_evidence(item["action"], case["units"], vectors)

    # Human expected actions are positive anchors with their curated exact evidence.
    for case_id, case in cases.items():
        for item in case["expected"]:
            examples.append({
                "case_id": case_id, "text": compact(item["action"]),
                "evidence": evidence_text(item.get("evidence", [])),
                "owner": compact(item.get("owner")) or "Not stated",
                "deadline": compact(item.get("deadline")) or "Not stated",
                "label": 1, "source": "expected_action",
            })
        # Curated negative controls are the cleanest available examples of language
        # that can resemble an action but must not be published (questions, rejected
        # suggestions, completed history and logistics). They are transcript evidence,
        # not production-model output.
        for item in case["negative_controls"]:
            evidence = evidence_text(item.get("evidence", []))
            candidate = compact(item.get("claim")) or evidence
            if candidate and evidence:
                examples.append({
                    "case_id": case_id, "text": candidate, "evidence": evidence,
                    "owner": "Not stated", "deadline": "Not stated",
                    "label": 0, "source": f"curated_negative:{item.get('reason', 'non_action')}",
                })

    uncertain = 0
    negative_sources = {}
    for run in runs:
        case = cases[run["case_id"]]
        expected_vectors = np.asarray([vectors[compact(row["action"])] for row in case["expected"]])
        negative_quotes = [evidence_text(row.get("evidence", [])) for row in case["negative_controls"]]
        negative_quotes = [text for text in negative_quotes if text]
        negative_vectors = embedder.encode(negative_quotes, normalize_embeddings=True, show_progress_bar=False) if negative_quotes else np.zeros((0, 384))
        for index, item in enumerate(run["generated"]):
            action = compact(item["action"])
            nearest, support_score = nearest_by_candidate[(run["case_id"], run["run"], index)]
            if index in run["matched_indices"]:
                label, source = 1, "benchmark_match"
            elif not case["expected"]:
                label, source = 0, "no_action_control"
            else:
                action_vector = vectors[action].reshape(1, -1)
                expected_similarity = float(np.max(cosine(action_vector, expected_vectors)))
                negative_similarity_score = float(np.max(cosine(action_vector, negative_vectors))) if len(negative_vectors) else 0.0
                if negative_similarity_score >= 0.62:
                    label, source = 0, "negative_control_match"
                elif expected_similarity < negative_similarity:
                    label, source = 0, "distant_unmatched"
                else:
                    uncertain += 1
                    continue
            negative_sources[source] = negative_sources.get(source, 0) + int(label == 0)
            examples.append({
                "case_id": run["case_id"], "text": action, "evidence": nearest,
                "owner": compact(item.get("owner")) or "Not stated",
                "deadline": compact(item.get("deadline")) or "Not stated",
                "evidence_similarity": round(support_score, 4), "label": label, "source": source,
            })

    # Collapse stochastic repetitions within each meeting. Positive evidence wins over
    # a weak negative for identical wording.
    collapsed = {}
    for row in examples:
        key = (row["case_id"], normalise(row["text"]))
        current = collapsed.get(key)
        if current is None or row["label"] > current["label"]:
            collapsed[key] = row
    dataset = list(collapsed.values())
    return dataset, {
        "rows": len(dataset), "show": sum(row["label"] == 1 for row in dataset),
        "remove": sum(row["label"] == 0 for row in dataset), "uncertainExcluded": uncertain,
        "negativeSources": negative_sources, "negativeSimilarityCeiling": negative_similarity,
    }


def metrics_for_runs(runs: list[dict], probabilities: dict[tuple[str, int, int], float], threshold: float) -> dict:
    per_run = []
    for run in runs:
        kept = [index for index in range(len(run["generated"])) if probabilities[(run["case_id"], run["run"], index)] >= threshold]
        matched = sum(index in run["matched_indices"] for index in kept)
        per_run.append({
            "id": run["id"], "caseId": run["case_id"], "run": run["run"],
            "before": len(run["generated"]), "kept": len(kept), "removed": len(run["generated"]) - len(kept),
            "matchedBefore": len(run["matched_indices"]), "matchedAfter": matched,
            "recallBefore": len(run["matched_indices"]) / run["expected_total"] if run["expected_total"] else 1.0,
            "recallAfter": matched / run["expected_total"] if run["expected_total"] else 1.0,
            "precisionBefore": len(run["matched_indices"]) / len(run["generated"]) if run["generated"] else 1.0,
            "precisionAfter": matched / len(kept) if kept else (1.0 if not run["expected_total"] else 0.0),
        })
    mean = lambda field: float(np.mean([row[field] for row in per_run]))
    matched_before = sum(row["matchedBefore"] for row in per_run)
    matched_after = sum(row["matchedAfter"] for row in per_run)
    return {
        "threshold": threshold, "matchedRetention": matched_after / matched_before if matched_before else 1.0,
        "macroRecallBefore": mean("recallBefore"), "macroRecallAfter": mean("recallAfter"),
        "macroPrecisionBefore": mean("precisionBefore"), "macroPrecisionAfter": mean("precisionAfter"),
        "meanRowsBefore": mean("before"), "meanRowsAfter": mean("kept"), "meanRowsRemoved": mean("removed"),
        "runs": per_run,
    }


def quality_gate(selected: dict) -> dict:
    losses = [row for row in selected["runs"] if row["matchedAfter"] < row["matchedBefore"]]
    abbott = [row for row in selected["runs"] if row["caseId"] == "01_abbott_audit_kickoff"]
    parking = [row for row in selected["runs"] if row["caseId"] == "13_parking_no_decision"]
    precision_gain = selected["macroPrecisionAfter"] - selected["macroPrecisionBefore"]
    checks = {
        "matchedRetentionAtLeast95Percent": selected["matchedRetention"] >= 0.95,
        "macroPrecisionGainAtLeast5Points": precision_gain >= 0.05,
        "noRunLosesMoreThanOneMatch": all(row["matchedBefore"] - row["matchedAfter"] <= 1 for row in losses),
        "abbottRetainsAtLeast90Percent": sum(r["matchedAfter"] for r in abbott) >= 0.9 * sum(r["matchedBefore"] for r in abbott),
        "parkingRemovesAtLeast75Percent": sum(row["removed"] for row in parking) >= 0.75 * sum(row["before"] for row in parking),
    }
    return {"passed": all(checks.values()), "checks": checks, "precisionGain": precision_gain}


def train_and_evaluate(args: argparse.Namespace) -> dict:
    report_path, output = Path(args.report).resolve(), Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    _report, runs = collect_runs(report_path)
    cases = load_cases()
    embedder = SentenceTransformer(MODEL_NAME)
    dataset, dataset_stats = build_dataset(embedder, runs, cases, args.negative_similarity)
    matrix = feature_matrix(embedder, dataset)
    labels = np.asarray([row["label"] for row in dataset])
    groups = np.asarray([row["case_id"] for row in dataset])

    probabilities = {}
    folds = []
    for held_out in sorted(set(groups)):
        train = groups != held_out
        model = LogisticRegression(max_iter=4000, class_weight="balanced", C=args.regularisation).fit(matrix[train], labels[train])
        candidates = []
        candidate_keys = []
        case = cases[held_out]
        # Reconstruct evidence independently for held-out generated rows.
        texts = list(dict.fromkeys([compact(unit["text"]) for unit in case["units"]] + [compact(item["action"]) for run in runs if run["case_id"] == held_out for item in run["generated"]]))
        encoded = embedder.encode(texts, normalize_embeddings=True, show_progress_bar=False)
        vectors = dict(zip(texts, encoded))
        for run in runs:
            if run["case_id"] != held_out:
                continue
            for index, item in enumerate(run["generated"]):
                evidence, _score = nearest_evidence(item["action"], case["units"], vectors)
                candidates.append({
                    "text": compact(item["action"]), "evidence": evidence,
                    "owner": compact(item.get("owner")) or "Not stated",
                    "deadline": compact(item.get("deadline")) or "Not stated",
                })
                candidate_keys.append((run["case_id"], run["run"], index))
        scores = model.predict_proba(feature_matrix(embedder, candidates))[:, list(model.classes_).index(1)]
        probabilities.update({key: float(score) for key, score in zip(candidate_keys, scores)})
        folds.append({"heldOut": held_out, "trainRows": int(train.sum()), "testActions": len(candidates)})

    candidates = []
    for threshold in np.arange(0.05, 0.86, 0.01):
        result = metrics_for_runs(runs, probabilities, float(round(threshold, 2)))
        if result["matchedRetention"] >= args.minimum_matched_retention:
            candidates.append(result)
    if not candidates:
        raise RuntimeError("No threshold retained the required matched actions.")
    selected = max(candidates, key=lambda row: (row["macroPrecisionAfter"], row["meanRowsRemoved"], row["threshold"]))
    gate = quality_gate(selected)

    final_model = LogisticRegression(max_iter=4000, class_weight="balanced", C=args.regularisation).fit(matrix, labels)
    joblib.dump({
        "schema_version": 2, "embedding_model": MODEL_NAME, "classifier": final_model,
        "labels": {"remove": 0, "show": 1}, "show_threshold": selected["threshold"],
        "input_format": "MiniLM(action) + MiniLM(nearest transcript evidence) + cosine support",
        "quality_gate_passed": gate["passed"],
    }, output / "classifier.joblib")
    with (output / "training_data.jsonl").open("w", encoding="utf-8") as handle:
        for row in dataset:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    metrics = {
        "schemaVersion": 2, "model": MODEL_NAME, "sourceReport": str(report_path),
        "evaluation": "leave_one_meeting_out", "dataset": dataset_stats, "folds": folds,
        "minimumMatchedRetention": args.minimum_matched_retention, "selected": selected,
        "qualityGate": gate,
    }
    (output / "metrics.json").write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf-8")
    return metrics


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--negative-similarity", type=float, default=0.42)
    parser.add_argument("--minimum-matched-retention", type=float, default=0.95)
    parser.add_argument("--regularisation", type=float, default=0.5)
    args = parser.parse_args()
    print(json.dumps(train_and_evaluate(args), indent=2))


if __name__ == "__main__":
    main()
