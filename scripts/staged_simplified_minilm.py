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


# A whole turn such as "Okay." or "Will do." is how a person accepts a
# request, and "No." how they refuse one. The shared parser drops any sentence
# under three words, which silently removed those replies; with
# --keep-short-replies they are kept as ordinary lines.
REPLY_WORDS = {
    "okay", "ok", "yes", "yeah", "yep", "yup", "sure", "will", "do", "no", "problem", "absolutely",
    "of", "course", "perfect", "great", "fine", "that's", "thats", "sounds", "good", "agreed",
    "done", "grand", "lovely", "cool", "alright", "definitely", "certainly", "nope", "not", "right",
}


def short_reply_rows(raw_text: str, source: str) -> list[dict]:
    rows = []
    current = None

    def close(turn):
        if not turn:
            return
        body = usefulness.compact(turn["body"])
        words = [word.lower() for word in re.findall(r"[A-Za-z']+", body)]
        if 1 <= len(words) <= 4 and all(word in REPLY_WORDS for word in words):
            rows.append({"source": source, "line": turn["line"], "unit": 0, "speaker": turn["speaker"],
                         "timestamp": turn["timestamp"], "text": body, "shortReply": True})

    for line_no, raw in enumerate(raw_text.splitlines(), 1):
        line = usefulness.compact(raw)
        if not line or usefulness.TRANSCRIPTION_MARKER.search(line):
            continue
        match = usefulness.SPEAKER_LINE.match(line)
        if match:
            close(current)
            current = {"line": line_no, "speaker": usefulness.compact(match.group("speaker")),
                       "timestamp": match.group("timestamp"), "body": usefulness.compact(match.group("text"))}
        elif current:
            current["body"] = f"{current['body']} {line}"
    close(current)
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("transcript")
    parser.add_argument("--model", required=True)
    parser.add_argument("--remove-threshold", type=float, default=0.85)
    parser.add_argument("--keep-short-replies", action="store_true")
    args = parser.parse_args()

    joblib, _np, SentenceTransformer, *_unused = usefulness.load_dependencies()
    bundle = joblib.load(args.model)
    path = Path(args.transcript)
    raw_text = usefulness.read_transcript_file(path)
    rows = usefulness.parse_transcript(raw_text, path.name)
    if rows and args.keep_short_replies:
        rows = sorted(rows + short_reply_rows(raw_text, path.name), key=lambda row: (row["line"], row.get("unit", 0)))
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
    for sequence, (row, probs) in enumerate(zip(rows, probabilities), 1):
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
