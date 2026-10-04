#!/usr/bin/env python3
"""Denoise a staged transcript with the frozen MiniLM-v3 classifier."""
from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path

import meeting_minutes_usefulness_classifier as usefulness


# SentenceTransformer handles a full meeting much more efficiently as one
# model batch. This still bounds unusually large transcripts while the caller
# gives each worker request its own contention-aware transport deadline.
REMOTE_EMBED_BATCH_SIZE = 512


def remote_embedding_matrix(texts: list[str], model_name: str, np_module, backend=None):
    """Use the resident MiniLM worker when it exposes the classifier's model.

    Upload preparation used to instantiate SentenceTransformer for every file.
    On a busy VPS that duplicates the already-running worker's model and can
    spend the entire request budget loading swapped model pages. Keep batches
    bounded so one large transcript does not monopolise the worker request.
    Returning ``None`` preserves the former local-model fallback.
    """
    worker_url = os.environ.get("MINUTES_MINILM_WORKER_URL", "").strip()
    if backend is None:
        if not worker_url:
            return None
        from meeting_minutes_minilm_experiment import MiniLMBackend
        backend = MiniLMBackend.load(enabled=True, prefer_remote=True)
    if not backend.available or backend.model_name != model_name:
        return None

    vectors = []
    for start in range(0, len(texts), REMOTE_EMBED_BATCH_SIZE):
        batch = texts[start:start + REMOTE_EMBED_BATCH_SIZE]
        encoded = backend.encode_many(batch)
        for text in batch:
            # MiniLMBackend keys remote results with normalize_text_fragment,
            # which compacts whitespace but deliberately preserves case.
            key = usefulness.compact(text)
            vector = encoded.get(key)
            if not isinstance(vector, list) or not vector:
                return None
            vectors.append(vector)
    return np_module.asarray(vectors)


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


# A whole turn such as "Okay." or "Will do." is how a person accepts a
# request, and "No." how they refuse one. The shared parser drops any sentence
# under three words, which silently removed those replies; with
# --keep-short-replies they are kept as ordinary lines.
REPLY_WORDS = {
    "okay", "ok", "yes", "yeah", "yep", "yup", "sure", "will", "do", "no", "problem", "absolutely",
    "of", "course", "perfect", "great", "fine", "that's", "thats", "sounds", "good", "agreed",
    "done", "grand", "lovely", "cool", "alright", "definitely", "certainly", "nope", "not", "right",
}


# Only a reply to something asked of the listener counts: "David, if you want
# to have a look at that?" / "Okay." A "Yes." murmured during someone else's
# update is listening noise and would read as a false acceptance.
REQUEST_CUE = re.compile(
    r"\?|\b(?:can|could|would|will) you\b|\bif you (?:want|could|can|don't mind|wouldn't mind)\b|\bplease\b"
    r"|\bdo you (?:want|mind|think)\b|\bare you (?:able|happy|ok|okay|alright)\b|\bcan we\b|\bwould it be possible\b"
    r"|\bneed you to\b|\bwant you to\b|\bleave (?:it|that) with you\b",
    re.I,
)


def short_reply_rows(raw_text: str, source: str) -> list[dict]:
    rows = []
    current = None
    previous = None

    def close(turn, before):
        if not turn:
            return
        body = usefulness.compact(turn["body"])
        words = [word.lower() for word in re.findall(r"[A-Za-z']+", body)]
        if not (1 <= len(words) <= 4 and all(word in REPLY_WORDS for word in words)):
            return
        if not before or before["speaker"] == turn["speaker"]:
            return
        if not REQUEST_CUE.search(usefulness.compact(before["body"])[-300:]):
            return
        rows.append({"source": source, "line": turn["line"], "unit": 0, "speaker": turn["speaker"],
                     "timestamp": turn["timestamp"], "text": body, "shortReply": True})

    for line_no, raw in enumerate(raw_text.splitlines(), 1):
        line = usefulness.compact(raw)
        if not line or usefulness.TRANSCRIPTION_MARKER.search(line):
            continue
        match = usefulness.SPEAKER_LINE.match(line)
        if match:
            close(current, previous)
            if current:
                previous = current
            current = {"line": line_no, "speaker": usefulness.compact(match.group("speaker")),
                       "timestamp": match.group("timestamp"), "body": usefulness.compact(match.group("text"))}
        elif current:
            current["body"] = f"{current['body']} {line}"
    close(current, previous)
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("transcript")
    parser.add_argument("--model", required=True)
    parser.add_argument("--remove-threshold", type=float, default=0.85)
    parser.add_argument("--keep-short-replies", action="store_true")
    args = parser.parse_args()

    import joblib
    import numpy as np

    bundle = joblib.load(args.model)
    path = Path(args.transcript)
    raw_text = usefulness.read_transcript_file(path)
    rows = usefulness.parse_transcript(raw_text, path.name)
    if rows and args.keep_short_replies:
        rows = sorted(rows + short_reply_rows(raw_text, path.name), key=lambda row: (row["line"], row.get("unit", 0)))
    if not rows:
        print(json.dumps({"ok": False, "reason": "no_speaker_units"}))
        return 0

    texts = [row["text"] for row in rows]
    matrix = remote_embedding_matrix(texts, bundle["embedding_model"], np)
    embedding_source = "worker" if matrix is not None else ""
    if matrix is None and not os.environ.get("MINUTES_MINILM_WORKER_URL", "").strip():
        # Development and recovery path when no compatible worker is running.
        # Importing sentence-transformers lazily keeps the normal upload path
        # from loading a second copy of Torch and the embedding model.
        from sentence_transformers import SentenceTransformer
        embedder = SentenceTransformer(bundle["embedding_model"])
        matrix = embedder.encode(
            texts, normalize_embeddings=True,
            convert_to_numpy=True, show_progress_bar=False,
        )
        embedding_source = "local"
    classifier = bundle["classifier"]
    # If the configured resident worker is temporarily unavailable, fail open
    # with the deterministic labels used to train this classifier. Uploads
    # must not fail merely because the optional noise-removal pass is busy.
    probabilities = classifier.predict_proba(matrix) if matrix is not None else None
    if probabilities is None:
        embedding_source = "heuristic_fallback"
    classified = []
    for sequence, row in enumerate(rows, 1):
        if probabilities is None:
            predicted, _reason = usefulness.bootstrap_label(row["text"])
            confidence = 1.0
        else:
            probs = probabilities[sequence - 1]
            best = int(probs.argmax())
            predicted = str(classifier.classes_[best])
            confidence = float(probs[best])
        effective = "uncertain" if predicted == "remove" and confidence < args.remove_threshold else predicted
        if usefulness.FORCE_REMOVE_NOISE.search(row["text"]):
            effective = "remove"
        if effective == "remove" and usefulness.RATIONALE_OR_IMPACT.search(row["text"]):
            effective = "uncertain"
        if row.get("shortReply"):
            effective = "keep"
        classified.append({
            **row,
            "id": f"T{sequence:04d}",
            "sequence": sequence,
            "cleanedText": clean_speech_text(row.get("text", "")),
            "classification": effective,
            "confidence": round(confidence, 4),
            "restored": False,
        })

    kept = [row for row in classified if row["classification"] != "remove"]
    prepared = render_full_name_clean_transcript(kept)
    print(json.dumps({
        "ok": True,
        "model": str(args.model),
        "embeddingModel": bundle["embedding_model"],
        "embeddingSource": embedding_source,
        "rawLength": len(raw_text),
        "preparedLength": len(prepared),
        "removedUnitCount": len(classified) - len(kept),
        "keptUnitCount": len(kept),
        "totalUnitCount": len(classified),
        "preparedTranscript": prepared,
        "sourceUnits": [{
            "id": row["id"],
            "sequence": row["sequence"],
            "speaker": usefulness.compact(row.get("speaker", "")),
            "timestamp": row.get("timestamp", ""),
            "text": row.get("cleanedText", "") or clean_speech_text(row.get("text", "")),
            "classification": row["classification"],
            "confidence": row["confidence"],
            "restored": False,
        } for row in classified],
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
