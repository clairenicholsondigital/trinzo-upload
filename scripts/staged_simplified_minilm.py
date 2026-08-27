#!/usr/bin/env python3
"""Denoise a staged transcript and allocate retained evidence to topic headings."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import meeting_minutes_usefulness_classifier as usefulness


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("transcript")
    parser.add_argument("--model", required=True)
    parser.add_argument("--topics-json", default="[]")
    parser.add_argument("--remove-threshold", type=float, default=0.85)
    parser.add_argument("--topic-threshold", type=float, default=0.25)
    args = parser.parse_args()

    topics = [usefulness.compact(value) for value in json.loads(args.topics_json) if usefulness.compact(value)]
    joblib, np, SentenceTransformer, _LogisticRegression, _report, _splitter = usefulness.load_dependencies()
    bundle = joblib.load(args.model)
    path = Path(args.transcript)
    raw_text = usefulness.read_transcript_file(path)
    rows = usefulness.parse_transcript(raw_text, path.name)
    if not rows:
        print(json.dumps({"ok": False, "reason": "no_speaker_units", "counts": {}, "evidenceByTopic": []}))
        return 0

    embedder = SentenceTransformer(bundle["embedding_model"])
    matrix = embedder.encode(
        [row["text"] for row in rows],
        normalize_embeddings=True,
        convert_to_numpy=True,
        show_progress_bar=False,
    )
    classifier = bundle["classifier"]
    probabilities = classifier.predict_proba(matrix)
    classified = []
    for row, vector, probs in zip(rows, matrix, probabilities):
        best = int(probs.argmax())
        predicted = str(classifier.classes_[best])
        confidence = float(probs[best])
        effective = "uncertain" if predicted == "remove" and confidence < args.remove_threshold else predicted
        if usefulness.FORCE_REMOVE_NOISE.search(row["text"]):
            effective = "remove"
        if effective == "remove" and usefulness.RATIONALE_OR_IMPACT.search(row["text"]):
            effective = "uncertain"
        classified.append({
            **row,
            "classification": effective,
            "confidence": round(confidence, 4),
            "vector": vector,
        })

    kept = [row for row in classified if row["classification"] != "remove"]
    counts = {
        label: sum(row["classification"] == label for row in classified)
        for label in usefulness.LABELS
    }
    prepared = usefulness.render_full_name_clean_transcript(kept)
    evidence_by_topic = [{"topic": topic, "evidence": []} for topic in topics]
    if topics and kept:
        topic_vectors = embedder.encode(
            topics,
            normalize_embeddings=True,
            convert_to_numpy=True,
            show_progress_bar=False,
        )
        for row in kept:
            scores = np.dot(topic_vectors, row["vector"])
            topic_index = int(scores.argmax())
            score = float(scores[topic_index])
            if score < args.topic_threshold:
                continue
            evidence_by_topic[topic_index]["evidence"].append({
                "id": f"line_{row['line']}_unit_{row['unit']}",
                "speaker": usefulness.compact(row.get("speaker", "")),
                "text": usefulness.clean_speech_text(row.get("text", "")),
                "line": row["line"],
                "score": round(score, 4),
            })

    safe_units = [{
        "id": f"line_{row['line']}_unit_{row['unit']}",
        "speaker": usefulness.compact(row.get("speaker", "")),
        "text": usefulness.clean_speech_text(row.get("text", "")),
        "line": row["line"],
        "classification": row["classification"],
        "confidence": row["confidence"],
    } for row in kept]
    print(json.dumps({
        "ok": True,
        "model": str(args.model),
        "embeddingModel": bundle["embedding_model"],
        "rawLength": len(raw_text),
        "preparedLength": len(prepared),
        "removedUnitCount": counts.get("remove", 0),
        "keptUnitCount": len(kept),
        "totalUnitCount": len(classified),
        "counts": counts,
        "preparedTranscript": prepared,
        "units": safe_units,
        "evidenceByTopic": evidence_by_topic,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
