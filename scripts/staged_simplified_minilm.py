#!/usr/bin/env python3
"""Denoise a staged transcript with the frozen MiniLM-v3 classifier."""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import meeting_minutes_usefulness_classifier as usefulness


def clean_speech_text(text: str) -> str:
    value = usefulness.compact(text)
    value = re.sub(r"\boh\b[,.!?;:]?\s*", "", value, flags=re.I)
    repeated = re.compile(r"\b(\w+(?:[ \t,;:]+\w+){0,3})[ \t,;:]+\1\b", re.I)
    previous = None
    while previous != value:
        previous = value
        value = repeated.sub(r"\1", value)
    return usefulness.compact(value)


def render_full_name_clean_transcript(rows: list[dict]) -> str:
    return "\n".join(
        f"{usefulness.compact(row.get('speaker', '')) or 'Speaker'}: {clean_speech_text(row.get('text', ''))}"
        for row in rows if clean_speech_text(row.get("text", ""))
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("transcript")
    parser.add_argument("--model", required=True)
    parser.add_argument("--remove-threshold", type=float, default=0.85)
    args = parser.parse_args()

    joblib, _np, SentenceTransformer, *_unused = usefulness.load_dependencies()
    bundle = joblib.load(args.model)
    path = Path(args.transcript)
    raw_text = usefulness.read_transcript_file(path)
    rows = usefulness.parse_transcript(raw_text, path.name)
    if not rows:
        print(json.dumps({"ok": False, "reason": "no_speaker_units"}))
        return 0

    embedder = SentenceTransformer(bundle["embedding_model"])
    matrix = embedder.encode(
        [row["text"] for row in rows], normalize_embeddings=True,
        convert_to_numpy=True, show_progress_bar=False,
    )
    classifier = bundle["classifier"]
    probabilities = classifier.predict_proba(matrix)
    classified = []
    for row, probs in zip(rows, probabilities):
        best = int(probs.argmax())
        predicted = str(classifier.classes_[best])
        confidence = float(probs[best])
        effective = "uncertain" if predicted == "remove" and confidence < args.remove_threshold else predicted
        if usefulness.FORCE_REMOVE_NOISE.search(row["text"]):
            effective = "remove"
        if effective == "remove" and usefulness.RATIONALE_OR_IMPACT.search(row["text"]):
            effective = "uncertain"
        classified.append({**row, "classification": effective, "confidence": round(confidence, 4)})

    kept = [row for row in classified if row["classification"] != "remove"]
    prepared = render_full_name_clean_transcript(kept)
    print(json.dumps({
        "ok": True,
        "model": str(args.model),
        "embeddingModel": bundle["embedding_model"],
        "rawLength": len(raw_text),
        "preparedLength": len(prepared),
        "removedUnitCount": len(classified) - len(kept),
        "keptUnitCount": len(kept),
        "totalUnitCount": len(classified),
        "preparedTranscript": prepared,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
