#!/usr/bin/env python3
"""Build an action-evidence ledger from a meeting transcript.

This is deliberately a support layer, not a final minutes writer. It uses the
trained MiniLM bundle to score transcript segments, then applies deterministic
guards so completed history, process sequencing and meeting logistics do not
become action rows.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import time
from pathlib import Path


DEFAULT_MODEL_PATH = "/root/meeting-minutes-evidence-model/runs/ai-weak-spots-20260810T202748Z/model_bundle/classifier.joblib"
SIGNAL_THRESHOLD = 0.45

TURN_RE = re.compile(r"^\s*(?:\d{1,2}:\d{2}(?::\d{2})?\s+)?([A-Z][A-Za-z .'\-]{1,60}):\s+(.+)$")
TEAMS_TURN_RE = re.compile(r"^\s*([A-Z][A-Za-z .,'\-]{1,70})\s+(\d{1,2}:\d{2}(?::\d{2})?)(.+)$")
SENTENCE_RE = re.compile(r"(?<=[.!?])\s+")
NOISE_RE = re.compile(r"^(?:yeah|yes|no|ok|okay|mm|mhm|right|thanks?|grand|lovely|brilliant|super|fine|cool|sorry)[\s.!,]*$", re.I)
ACTION_HINT_RE = re.compile(
    r"\b(?:will|shall|to\s+(?:review|share|send|follow up|complete|update|provide|confirm|prepare|approve|sign off|generate|trace|identify|document)|"
    r"need(?:s)?\s+to|have\s+to|got\s+to|can\s+send|could\s+you|please|review|share|send|follow up|complete|update|provide|confirm|prepare|approve|sign off)\b",
    re.I,
)
EVIDENCE_RE = re.compile(
    r"\b(?:qms|manual|label|labels|doc|docs|declaration|conformity|hpra|invoice|fee|medenvoy|udimed|udi|mdr|ppe|audit|risk|assessment|plan|"
    r"standard|standards|change request|debug|test|testing|driver|tracker|sharepoint|code of conduct|attestation|packaging|warehouse|picked|packed|distribution)\b",
    re.I,
)
DEADLINE_RE = re.compile(
    r"\b(?:today|tomorrow|before arrival|before [A-Z][a-z]+ arrives|next\s+(?:monday|tuesday|wednesday|thursday|friday|week)|this\s+week|"
    r"w/e\s+\d{1,2}(?:st|nd|rd|th)?\s+[A-Z][a-z]+|end\s+of\s+[A-Z][a-z]+|monday|tuesday|wednesday|thursday|friday|"
    r"\d{1,2}(?:st|nd|rd|th)(?:\s+of)?\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)|"
    r"\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December))\b",
    re.I,
)
IMPERATIVE_RE = re.compile(
    r"^\s*(?:arrange|update|review|send|share|confirm|prepare|complete|finali[sz]e|provide|draft|submit|circulate|issue|upload|book|schedule|agree|approve|sign(?:\s+off)?|trace|generate|identify|document)\b",
    re.I,
)
COMMITMENT_RE = re.compile(r"\b(?:will|shall|need(?:s)?\s+to|have\s+to|got\s+to|agreed\s+to|action\s+is|owner)\b", re.I)
COMPLETED_RE = re.compile(r"\b(?:already|has been|have been|was|were|completed|done|closed|sent|shared|reviewed|approved|signed off|uploaded|issued)\b", re.I)
HYPOTHETICAL_RE = re.compile(r"\b(?:maybe|might|could|possibly|potentially|if we|if you|would|should consider|thinking about|look at whether)\b", re.I)
SEQUENCE_RE = re.compile(r"\b(?:comes before|follows|depends on|once|after|before|prior to|subsequent to|prerequisite)\b", re.I)
RECORD_LOCATION_RE = re.compile(r"\b(?:contains|is stored in|already includes|sits in|available on|located in|held in|saved in)\b", re.I)
LOGISTICS_RE = re.compile(r"\b(?:share my screen|screen share|can't hear|can you hear|teams|mute|unmute|camera|holiday|travel|flight|hotel)\b", re.I)


def compact(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def candidate_hint(text: str) -> float:
    score = 0.0
    if ACTION_HINT_RE.search(text):
        score += 0.45
    if EVIDENCE_RE.search(text):
        score += 0.35
    if DEADLINE_RE.search(text):
        score += 0.15
    if re.search(r"\b[A-Z][a-z]+(?:-[A-Z][a-z]+)?\b", text):
        score += 0.05
    return round(score, 3)


def owner_from_line(speaker: str, text: str) -> str:
    body = compact(text)
    if re.search(r"\bNiamh\b", body) and re.search(r"\b(?:you(?:'ll| will)?|niamh)\s+(?:need|will|to sign|sign)\b", body, re.I):
        return "Niamh"
    if compact(speaker):
        return compact(speaker)
    return "Not stated"


def deadline_from_text(text: str) -> str:
    match = DEADLINE_RE.search(text or "")
    if not match:
        return ""
    return compact(re.sub(r"^next\s+", "", match.group(0), flags=re.I).replace("w/e", "W/E"))


def candidate_segments(text: str, max_chars: int = 420) -> list[dict]:
    segments: list[dict] = []
    current_speaker = ""
    for line_no, raw in enumerate(text.splitlines(), start=1):
        line = compact(raw)
        if not line:
            continue
        match = TURN_RE.match(line)
        if match:
            current_speaker = compact(match.group(1))
            body = compact(match.group(2))
        elif teams_match := TEAMS_TURN_RE.match(line):
            current_speaker = compact(teams_match.group(1))
            body = compact(teams_match.group(3))
        else:
            body = line
        if len(body) < 16:
            continue
        for sentence in SENTENCE_RE.split(body):
            sentence = compact(sentence)
            word_count = len(re.findall(r"[A-Za-z0-9]+", sentence))
            if len(sentence) < 16 or word_count < 4 or NOISE_RE.match(sentence):
                continue
            if len(sentence) > max_chars:
                sentence = sentence[: max_chars - 1].rstrip() + "..."
            segments.append({
                "line": line_no,
                "speaker": current_speaker,
                "text": sentence,
                "candidateHint": candidate_hint(sentence),
            })
    return segments


def has_signal(row: dict, label: str, min_score: float = SIGNAL_THRESHOLD) -> bool:
    return any(item.get("label") == label and float(item.get("score", 0)) >= min_score for item in row.get("signals", []))


def canonical_action(text: str) -> str:
    cleaned = compact(text).strip(" -")
    low = cleaned.lower()
    if "risk assessment" in low and "audit plan" in low:
        return "Complete the risk assessment to develop the audit plan"
    if "risk analysis" in low and re.search(r"\bshare|send\b", low):
        return "Share the risk analysis"
    if "code of conduct" in low and re.search(r"\bsign|attestation\b", low):
        return "Sign the Code of Conduct attestation"
    if re.search(r"\bdeclaration of conformity\b|\bdoc\b", low) and re.search(r"\bupdate|send|share|provide\b", low):
        return "Update and share the Declaration of Conformity documentation"
    if IMPERATIVE_RE.search(cleaned):
        return cleaned.rstrip(".")
    will_match = re.search(
        r"\b(?:i|we|they|he|she|[A-Z][a-z]+)\s*(?:'ll| will| shall| need(?:s)? to| have to| got to)\s+(.+)$",
        cleaned,
        re.I,
    )
    if will_match:
        fragment = compact(will_match.group(1)).rstrip(".")
        return fragment[:1].upper() + fragment[1:]
    return cleaned.rstrip(".")


def suppression_reason(row: dict) -> str:
    text = row.get("text", "")
    evidence_type = row.get("evidenceType", "")
    commitment = row.get("commitmentState", "")
    strong_direct = bool(IMPERATIVE_RE.search(text) or COMMITMENT_RE.search(text))
    if evidence_type == "low_value_noise" or LOGISTICS_RE.search(text):
        return "low_value_or_meeting_logistics"
    if RECORD_LOCATION_RE.search(text):
        return "record_location_not_action"
    if SEQUENCE_RE.search(text) and not strong_direct:
        return "process_sequence_not_action"
    if commitment == "completed_history" or has_signal(row, "completed_tense", 0.5):
        if not IMPERATIVE_RE.search(text):
            return "completed_history_not_future_action"
    if HYPOTHETICAL_RE.search(text) and not strong_direct:
        return "hypothetical_without_assignment"
    if len(canonical_action(text).split()) < 4:
        return "too_short_or_no_object"
    return ""


def keep_reason(row: dict) -> str:
    text = row.get("text", "")
    commitment = row.get("commitmentState", "")
    evidence_type = row.get("evidenceType", "")
    if suppression_reason(row):
        return ""
    if IMPERATIVE_RE.search(text):
        return "imperative_action_table_or_minutes_fragment"
    if commitment == "confirmed_action" and (row.get("candidateHint", 0) >= 0.45 or evidence_type in {"action_commitment", "risk_dependency", "document_control_task"}):
        return "confirmed_action_with_evidence"
    if COMMITMENT_RE.search(text) and EVIDENCE_RE.search(text):
        return "commitment_language_with_deliverable"
    return ""


def top_prob(classes, probs):
    idx = int(probs.argmax())
    return str(classes[idx]), float(probs[idx])


def classify(model_path: Path, segments: list[dict], limit: int) -> dict:
    import joblib
    import numpy as np
    from sentence_transformers import SentenceTransformer

    bundle = joblib.load(model_path)
    embedder = SentenceTransformer(bundle["embedding_model"])
    texts = [segment["text"] for segment in segments]
    if not texts:
        return {"items": [], "actions": [], "counts": {}, "segmentsScored": 0, "modelName": bundle.get("embedding_model", "")}
    matrix = embedder.encode(texts, normalize_embeddings=True, convert_to_numpy=True, batch_size=32, show_progress_bar=False)
    evidence_probs = bundle["status_classifier"].predict_proba(matrix)
    commitment_clf = bundle.get("action_state_classifier")
    commitment_le = bundle.get("action_state_label_encoder")
    commitment_probs = commitment_clf.predict_proba(matrix) if commitment_clf is not None and commitment_le is not None else None
    signal_clf = bundle.get("signal_classifier")
    signal_mlb = bundle.get("signal_binarizer")
    signal_probs = np.asarray(signal_clf.predict_proba(matrix)) if signal_clf is not None and signal_mlb is not None else None

    rows = []
    counts: dict[str, int] = {}
    for idx, segment in enumerate(segments):
        evidence_type, evidence_conf = top_prob(bundle["status_label_encoder"].classes_, evidence_probs[idx])
        if commitment_probs is not None:
            commitment_state, commitment_conf = top_prob(commitment_le.classes_, commitment_probs[idx])
        else:
            commitment_state, commitment_conf = "", 0.0
        signals = []
        if signal_probs is not None:
            order = np.argsort(-signal_probs[idx])
            for signal_idx in order[:8]:
                score = float(signal_probs[idx][signal_idx])
                if score >= SIGNAL_THRESHOLD:
                    signals.append({"label": str(signal_mlb.classes_[signal_idx]), "score": round(score, 3)})
        counts[evidence_type] = counts.get(evidence_type, 0) + 1
        row = {
            **segment,
            "evidenceType": evidence_type,
            "evidenceConfidence": round(evidence_conf, 3),
            "commitmentState": commitment_state,
            "commitmentConfidence": round(commitment_conf, 3),
            "signals": signals,
        }
        suppress = suppression_reason(row)
        keep = keep_reason(row)
        rank = float(row.get("candidateHint", 0)) + evidence_conf
        if keep:
            rank += 0.65
        if commitment_state == "confirmed_action":
            rank += 0.35
        if suppress:
            rank -= 1.0
        row["suppressReason"] = suppress
        row["keepReason"] = keep
        row["rankScore"] = round(rank, 3)
        rows.append(row)

    rows.sort(key=lambda row: row["rankScore"], reverse=True)
    actions = []
    seen = set()
    for row in rows:
        if not row["keepReason"]:
            continue
        action = canonical_action(row["text"])
        key = re.sub(r"[^a-z0-9]+", " ", action.lower()).strip()
        if not key or key in seen:
            continue
        seen.add(key)
        actions.append({
            "owner": owner_from_line(row.get("speaker", ""), row.get("text", "")),
            "action": action,
            "deadline": deadline_from_text(row.get("text", "")) or "Not stated",
            "source": "meeting_minutes_evidence_classifier",
            "evidence": row.get("text", ""),
            "evidenceType": row.get("evidenceType", ""),
            "commitmentState": row.get("commitmentState", ""),
            "keepReason": row.get("keepReason", ""),
        })
        if len(actions) >= limit:
            break
    return {
        "items": rows[: max(limit * 3, 30)],
        "actions": actions,
        "counts": counts,
        "segmentsScored": len(rows),
        "modelName": bundle.get("embedding_model", ""),
    }


def main() -> int:
    started = time.time()
    parser = argparse.ArgumentParser()
    parser.add_argument("text_file")
    parser.add_argument("--model", default=os.environ.get("MEETING_MINUTES_EVIDENCE_MODEL_PATH", DEFAULT_MODEL_PATH))
    parser.add_argument("--limit", type=int, default=20)
    args = parser.parse_args()

    model_path = Path(args.model)
    if not model_path.exists():
        print(json.dumps({
            "executed": False,
            "modelAvailable": False,
            "modelPath": str(model_path),
            "modelReason": "Evidence classifier bundle not found.",
            "actions": [],
            "items": [],
            "counts": {},
            "timingMs": {"total": round((time.time() - started) * 1000)},
        }))
        return 0

    text = Path(args.text_file).read_text(encoding="utf-8", errors="replace")
    segments = candidate_segments(text)
    try:
        result = classify(model_path, segments, args.limit)
        print(json.dumps({
            "executed": True,
            "modelAvailable": True,
            "modelPath": str(model_path),
            "modelName": result.get("modelName", ""),
            "modelReason": "Evidence classifier completed.",
            "segmentsConsidered": len(segments),
            "segmentsScored": result.get("segmentsScored", 0),
            "counts": result.get("counts", {}),
            "actions": result.get("actions", []),
            "items": result.get("items", []),
            "timingMs": {"total": round((time.time() - started) * 1000)},
        }, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({
            "executed": False,
            "modelAvailable": False,
            "modelPath": str(model_path),
            "modelReason": f"Evidence classifier failed: {exc}",
            "actions": [],
            "items": [],
            "counts": {},
            "timingMs": {"total": round((time.time() - started) * 1000)},
        }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
