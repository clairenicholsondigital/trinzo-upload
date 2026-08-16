#!/usr/bin/env python3
"""Build the semantic profile used by the isolated canonical minutes route.

Input is a JSON evidence document produced by the JavaScript transcript parser.
The output deliberately contains classifications and clusters, not minutes.
"""

from __future__ import annotations

import json
import math
import os
import re
import sys
from pathlib import Path

from meeting_minutes_minilm_experiment import MiniLMBackend

REPO_CLASSIFIER_PATH = Path(__file__).resolve().parent.parent / "artifacts" / "canonical-speech-act-model-v9" / "classifier.joblib"
DEFAULT_CLASSIFIER_PATH = str(REPO_CLASSIFIER_PATH if REPO_CLASSIFIER_PATH.exists() else Path("/root/meeting-minutes-evidence-model/runs/owner-framing-20260810T224329Z/model_bundle/classifier.joblib"))


PROTOTYPES = {
    "commitment": [
        "A person commits to completing a concrete future task.",
        "Someone accepts responsibility for a deliverable or follow-up.",
        "An owner says they will carry out the next step.",
    ],
    "request": [
        "One participant asks another person to complete a concrete task.",
        "A task is assigned to a named owner.",
    ],
    "acceptance": [
        "The participant accepts the task they were just assigned.",
        "The person confirms that they will take responsibility for it.",
    ],
    "decision": [
        "The team reaches a final choice or agrees a direction.",
        "A proposed option is approved, rejected, or selected.",
    ],
    "risk": [
        "A future problem, dependency, uncertainty, or adverse outcome could affect delivery.",
        "The speaker identifies a blocker or an issue requiring monitoring.",
    ],
    "completed": [
        "The task was already completed before or during this meeting.",
        "This is completed history rather than outstanding work.",
    ],
    "hypothetical": [
        "This is only a possibility, suggestion, or hypothetical option and is not agreed.",
        "The speaker is exploring something that might happen in the future.",
    ],
    "rejection": [
        "The proposed action or option is explicitly cancelled, rejected, or not required.",
        "The speaker says not to proceed with the earlier proposal.",
    ],
    "informational": [
        "This is a factual status update or general information, with no commitment or decision.",
        "The speaker explains background context for the meeting.",
    ],
    "administrative": [
        "This is greeting, travel, hotel, screen sharing, or routine meeting administration.",
        "This is social chatter or meeting logistics rather than substantive content.",
    ],
    "substantive": [
        "This is meaningful technical, regulatory, operational, product, customer, or project evidence.",
        "This sentence contains substantive meeting content suitable for minutes.",
    ],
}


def cosine(left: list[float], right: list[float]) -> float:
    return sum(a * b for a, b in zip(left, right)) if left and right else 0.0


def normalise(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


def centroid(vectors: list[list[float]]) -> list[float]:
    if not vectors:
        return []
    value = [sum(items) / len(items) for items in zip(*vectors)]
    length = math.sqrt(sum(item * item for item in value)) or 1.0
    return [item / length for item in value]


def matrix_has_features(matrix) -> bool:
    shape = getattr(matrix, "shape", ())
    return len(shape) == 2 and shape[0] > 0 and shape[1] > 0


def cluster_events(records: list[dict], embeddings: dict[str, list[float]]) -> list[dict]:
    eligible = [record for record in records if record.get("scores", {}).get("substantive", 0) >= 0.36 and record.get("scores", {}).get("administrative", 0) < 0.55]
    clusters: list[dict] = []
    for record in eligible:
        vector = embeddings.get(record["text"], [])
        if not vector:
            continue
        best_index, best_score = -1, 0.0
        for index, cluster in enumerate(clusters):
            similarity = cosine(vector, cluster["centroid"])
            continuity = 0.035 if record["turnIndex"] - cluster["lastTurnIndex"] <= 2 else 0.0
            if similarity + continuity > best_score:
                best_index, best_score = index, similarity + continuity
        if best_index >= 0 and best_score >= 0.5:
            cluster = clusters[best_index]
            cluster["records"].append(record)
            cluster["vectors"].append(vector)
            cluster["centroid"] = centroid(cluster["vectors"])
            cluster["lastTurnIndex"] = record["turnIndex"]
        else:
            clusters.append({"records": [record], "vectors": [vector], "centroid": vector, "lastTurnIndex": record["turnIndex"]})

    output = []
    for index, cluster in enumerate(clusters):
        records_in_cluster = cluster["records"]
        if not records_in_cluster:
            continue
        representative = max(records_in_cluster, key=lambda item: (item["scores"].get("substantive", 0) - item["scores"].get("administrative", 0), len(item["text"])))
        output.append({
            "id": f"topic_{index + 1:02d}",
            "representativeText": representative["text"],
            "evidenceIds": [item["id"] for item in records_in_cluster],
            "turnStart": min(item["turnIndex"] for item in records_in_cluster),
            "turnEnd": max(item["turnIndex"] for item in records_in_cluster),
            "cohesion": round(sum(cosine(embeddings.get(item["text"], []), cluster["centroid"]) for item in records_in_cluster) / len(records_in_cluster), 4),
        })
    # Singleton clusters remain valid workstreams; downstream selection bounds
    # visible output and favours broader/cohesive clusters. Dropping singletons
    # here erased short but important topics from moderately sized meetings.
    minimum_size = 1
    return sorted((item for item in output if len(item["evidenceIds"]) >= minimum_size), key=lambda item: (-len(item["evidenceIds"]), -item["cohesion"], item["turnStart"]))


def main() -> None:
    payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    events = payload.get("events", [])
    backend = MiniLMBackend.load(enabled=True)
    if not backend.available:
        print(json.dumps({"available": False, "reason": backend.reason, "modelName": backend.model_name, "events": {}, "topics": []}))
        return

    texts = [normalise(event.get("text")) for event in events if normalise(event.get("text"))]
    prototype_texts = [text for values in PROTOTYPES.values() for text in values]
    embeddings = backend.encode_many(texts + prototype_texts)
    prototype_centroids = {
        label: centroid([embeddings.get(normalise(text), []) for text in values if embeddings.get(normalise(text), [])])
        for label, values in PROTOTYPES.items()
    }
    classifier_path = Path(os.environ.get("MEETING_MINUTES_EVIDENCE_MODEL", DEFAULT_CLASSIFIER_PATH))
    trained = None
    matrix = None
    if classifier_path.exists():
        import joblib
        import numpy as np
        trained = joblib.load(classifier_path)
        matrix = np.asarray([embeddings.get(text, []) for text in texts])
        if matrix_has_features(matrix):
            evidence_matrix = trained["status_classifier"].predict_proba(matrix)
            evidence_classes = list(trained["status_label_encoder"].classes_)
            action_matrix = trained["action_state_classifier"].predict_proba(matrix)
            action_classes = list(trained["action_state_label_encoder"].classes_)
            signal_matrix = trained["signal_classifier"].predict_proba(matrix)
            signal_classes = list(trained["signal_binarizer"].classes_)
            context_texts = [normalise(event.get("contextText") or f"[PREVIOUS]\n{event.get('previousText', '')}\n[CURRENT]\n{event.get('text', '')}\n[NEXT]\n{event.get('nextText', '')}") for event in events]
            context_embeddings = backend.encode_many(context_texts)
            context_matrix = np.asarray([context_embeddings.get(text, []) for text in context_texts])
            contextual_predictions = {}
            if matrix_has_features(context_matrix):
                for prefix, output_key in (("lifecycle", "lifecycleProbabilities"), ("context_dependency", "contextDependencyProbabilities"), ("canonical_worthiness", "canonicalWorthinessProbabilities"), ("temporal_role", "temporalRoleProbabilities")):
                    classifier = trained.get(f"{prefix}_classifier")
                    encoder = trained.get(f"{prefix}_label_encoder")
                    if classifier is not None and encoder is not None:
                        contextual_predictions[output_key] = (classifier.predict_proba(context_matrix), list(encoder.classes_))
                discourse_classifier = trained.get("discourse_role_classifier")
                discourse_encoder = trained.get("discourse_role_label_encoder")
                if discourse_classifier is not None and discourse_encoder is not None:
                    if trained.get("discourse_role_feature_contract") == "current_context_absdiff_product_v1":
                        discourse_features = np.hstack([matrix, context_matrix, np.abs(matrix - context_matrix), matrix * context_matrix])
                    else:
                        discourse_features = context_matrix
                    contextual_predictions["discourseRoleProbabilities"] = (discourse_classifier.predict_proba(discourse_features), list(discourse_encoder.classes_))
        else:
            trained = None

    records = []
    event_output = {}
    for event_index, event in enumerate(events):
        text = normalise(event.get("text"))
        vector = embeddings.get(text, [])
        scores = {label: round(cosine(vector, center), 4) for label, center in prototype_centroids.items()}
        trained_details = {}
        if trained is not None:
            evidence_probs = {label: float(evidence_matrix[event_index][idx]) for idx, label in enumerate(evidence_classes)}
            action_probs = {label: float(action_matrix[event_index][idx]) for idx, label in enumerate(action_classes)}
            signal_probs = {label: float(signal_matrix[event_index][idx]) for idx, label in enumerate(signal_classes)}
            scores.update({
                "commitment": round(action_probs.get("confirmed_action", 0) + (0.45 * action_probs.get("possible_action", 0)), 4),
                "request": round(max(scores["request"], signal_probs.get("named_owner", 0) * signal_probs.get("explicit_commitment_verb", 0)), 4),
                "decision": round(max(evidence_probs.get("decision_agreement", 0), signal_probs.get("decision_language", 0)), 4),
                "risk": round(max(evidence_probs.get("risk_dependency", 0), signal_probs.get("risk_language", 0)), 4),
                "completed": round(action_probs.get("completed_history", 0), 4),
                "hypothetical": round(max(signal_probs.get("hypothetical_language", 0), scores["hypothetical"] * 0.7), 4),
                "rejection": round(scores["rejection"] * 0.55, 4),
                "informational": round(evidence_probs.get("background_context", 0), 4),
                "administrative": round(evidence_probs.get("low_value_noise", 0), 4),
                "substantive": round(1 - evidence_probs.get("low_value_noise", 0) - (0.45 * evidence_probs.get("background_context", 0)), 4),
            })
            trained_details = {
                **{key: {label: round(float(values[event_index][idx]), 4) for idx, label in enumerate(labels)} for key, (values, labels) in contextual_predictions.items()},
                "evidenceProbabilities": {key: round(value, 4) for key, value in evidence_probs.items()},
                "actionProbabilities": {key: round(value, 4) for key, value in action_probs.items()},
                "signalProbabilities": {key: round(value, 4) for key, value in signal_probs.items()},
            }
            trained_details["derivedLabels"] = {
                key.removesuffix("Probabilities"): max(probabilities, key=probabilities.get)
                for key, probabilities in trained_details.items()
                if key in contextual_predictions and probabilities
            }
        ranked = sorted(scores.items(), key=lambda item: item[1], reverse=True)
        record = {"id": event["id"], "text": text, "turnIndex": event.get("turnIndex", 0), "scores": scores}
        records.append(record)
        event_output[event["id"]] = {
            "scores": scores,
            "primaryRole": ranked[0][0] if ranked else "informational",
            "confidence": ranked[0][1] if ranked else 0,
            "margin": round(ranked[0][1] - ranked[1][1], 4) if len(ranked) > 1 else 0,
            **trained_details,
        }
    print(json.dumps({
        "available": True,
        "profileSchemaVersion": 3,
        "shadow": {"enabled": bool(os.environ.get("MEETING_MINUTES_ENRICHED_SHADOW", "1") != "0"), "bundleSchemaVersion": int(trained.get("bundle_schema_version", 3)) if trained else None, "headsAvailable": sorted(contextual_predictions.keys()) if trained else []},
        "modelName": backend.model_name,
        "classifierModel": str(classifier_path) if trained is not None else "prototype_only",
        "events": event_output,
        "topics": cluster_events(records, embeddings),
        "thresholds": {"candidate": 0.36, "strong": 0.46, "cluster": 0.5},
    }))


if __name__ == "__main__":
    main()
