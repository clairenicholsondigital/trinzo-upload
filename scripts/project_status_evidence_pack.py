#!/usr/bin/env python3
"""Build a project-status evidence pack for meeting-minutes generation.

This is intentionally read-only: it uses the separate
/root/project-update-status-model bundle as an attention layer, then returns
small transcript-backed hints for the Trooper writer.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any


DEFAULT_PROJECT_STATUS_DIR = Path("/root/project-update-status-model")
DEFAULT_MODEL_PATH = DEFAULT_PROJECT_STATUS_DIR / "models" / "production" / "classifier.joblib"
DEFAULT_MODEL_PYTHON = DEFAULT_PROJECT_STATUS_DIR / ".venv" / "bin" / "python"
IMPORTANT_STATUSES = {"blocked", "at_risk", "off_track", "watch", "complete"}
IMPORTANT_ACTIONS = {
    "action_required",
    "decision_required",
    "dependency",
    "follow_up_required",
    "internal_action_needed",
    "needs_information",
}
IMPORTANT_SIGNALS = {
    "approval_needed",
    "client_action_needed",
    "decision_needed",
    "dependency",
    "delivery",
    "internal_action_needed",
    "missing_access",
    "scope",
    "supplier_action_needed",
    "technical",
    "testing",
    "timeline",
    "quality",
    "security_privacy",
}


def clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())


def load_predict_module(project_dir: Path):
    predict_path = project_dir / "scripts" / "predict.py"
    if not predict_path.exists():
        raise FileNotFoundError(f"predict.py not found at {predict_path}")
    spec = importlib.util.spec_from_file_location("project_status_predict", predict_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load project status predict module from {predict_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def split_transcript(text: str, max_chars: int = 900, overlap_chars: int = 180) -> list[str]:
    paragraphs = [clean_text(part) for part in re.split(r"\n\s*\n+", text) if clean_text(part)]
    chunks: list[str] = []
    for paragraph in paragraphs or [clean_text(text)]:
        if len(paragraph) <= max_chars:
            chunks.append(paragraph)
            continue
        sentences = [clean_text(part) for part in re.split(r"(?<=[.!?])\s+", paragraph) if clean_text(part)]
        current = ""
        for sentence in sentences or [paragraph]:
            if current and len(current) + len(sentence) + 1 > max_chars:
                chunks.append(current)
                current = current[-overlap_chars:].strip()
            current = clean_text(f"{current} {sentence}")
        if current:
            chunks.append(current)
    return [chunk for chunk in chunks if len(chunk) >= 40]


def top_ranked(classes, probs, limit: int = 3) -> list[dict[str, Any]]:
    order = sorted(range(len(probs)), key=lambda i: float(probs[i]), reverse=True)
    return [{"label": str(classes[i]), "score": round(float(probs[i]), 3)} for i in order[:limit]]


def classify_chunks(chunks: list[str], model_path: Path, project_dir: Path, max_chunks: int) -> dict[str, Any]:
    import joblib
    import numpy as np
    from sentence_transformers import SentenceTransformer

    predict_module = load_predict_module(project_dir)
    bundle = joblib.load(model_path)
    embedder = SentenceTransformer(bundle["embedding_model"])
    selected_chunks = chunks[:max_chunks]
    embeddings = embedder.encode(
        selected_chunks,
        normalize_embeddings=True,
        convert_to_numpy=True,
        show_progress_bar=False,
    )

    status_classes = bundle["status_label_encoder"].classes_
    status_matrix = bundle["status_classifier"].predict_proba(embeddings)
    action_clf = bundle.get("action_state_classifier")
    action_le = bundle.get("action_state_label_encoder")
    signal_clf = bundle.get("signal_classifier")
    signal_binarizer = bundle.get("signal_binarizer")
    signal_threshold = float(bundle.get("signal_threshold", 0.5))

    evidence_items: list[dict[str, Any]] = []
    for index, chunk in enumerate(selected_chunks):
        status_probs = predict_module.apply_status_postprocessing(chunk, status_classes, status_matrix[index])
        statuses = top_ranked(status_classes, status_probs, 3)

        actions: list[dict[str, Any]] = []
        if action_clf is not None and action_le is not None:
            action_probs = action_clf.predict_proba(embeddings[index : index + 1])[0]
            action_probs = predict_module.apply_action_postprocessing(chunk, action_le.classes_, action_probs)
            actions = top_ranked(action_le.classes_, action_probs, 3)

        signals: list[dict[str, Any]] = []
        if signal_clf is not None and signal_binarizer is not None and len(getattr(signal_binarizer, "classes_", [])):
            signal_probs = np.asarray(signal_clf.predict_proba(embeddings[index : index + 1]))[0]
            signal_probs = predict_module.apply_signal_postprocessing(chunk, signal_binarizer.classes_, signal_probs)
            order = sorted(range(len(signal_probs)), key=lambda i: float(signal_probs[i]), reverse=True)
            signals = [
                {"label": str(signal_binarizer.classes_[i]), "score": round(float(signal_probs[i]), 3)}
                for i in order[:8]
                if float(signal_probs[i]) >= min(signal_threshold, 0.45)
            ]

        best_status = statuses[0] if statuses else {"label": "", "score": 0.0}
        best_action = actions[0] if actions else {"label": "", "score": 0.0}
        strong_signals = [item for item in signals if item["label"] in IMPORTANT_SIGNALS and item["score"] >= 0.52]
        keep = (
            best_status["label"] in IMPORTANT_STATUSES
            and best_status["score"] >= 0.42
        ) or (
            best_action["label"] in IMPORTANT_ACTIONS
            and best_action["score"] >= 0.42
        ) or bool(strong_signals)

        if not keep:
            continue

        priority = max(
            [best_status["score"], best_action["score"], *[item["score"] for item in strong_signals]]
        )
        evidence_items.append(
            {
                "chunkIndex": index,
                "priority": round(float(priority), 3),
                "status": statuses,
                "actionState": actions,
                "signals": signals[:6],
                "transcriptSnippet": chunk[:1200],
            }
        )

    evidence_items.sort(key=lambda item: item["priority"], reverse=True)
    return {
        "available": True,
        "projectDir": str(project_dir),
        "modelPath": str(model_path),
        "embeddingModel": bundle.get("embedding_model"),
        "chunksAnalysed": len(selected_chunks),
        "items": evidence_items[:12],
    }


def build_pack(transcript_text: str, model_path: Path, project_dir: Path, max_chunks: int) -> dict[str, Any]:
    started = time.perf_counter()
    chunks = split_transcript(transcript_text)
    pack: dict[str, Any] = {
        "enabled": True,
        "available": False,
        "modelPath": str(model_path),
        "projectDir": str(project_dir),
        "chunksBuilt": len(chunks),
        "chunksAnalysed": 0,
        "items": [],
        "reason": "",
    }
    try:
        if not model_path.exists():
            pack["reason"] = f"Project status model bundle not found at {model_path}"
            return pack
        if not chunks:
            pack["reason"] = "Transcript produced no usable chunks."
            return pack
        result = classify_chunks(chunks, model_path, project_dir, max_chunks=max_chunks)
        pack.update(result)
        pack["reason"] = "Project-status evidence pack built." if pack["items"] else "No high-confidence project-status evidence found."
        return pack
    except Exception as exc:
        pack["reason"] = f"Project-status evidence failed: {clean_text(exc)[:300]}"
        return pack
    finally:
        pack["runtimeMs"] = round((time.perf_counter() - started) * 1000, 2)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build project-status evidence for meeting minutes.")
    parser.add_argument("transcript_path")
    parser.add_argument("--model", default=os.environ.get("PROJECT_STATUS_MODEL_BUNDLE", str(DEFAULT_MODEL_PATH)))
    parser.add_argument("--project-dir", default=os.environ.get("PROJECT_STATUS_MODEL_DIR", str(DEFAULT_PROJECT_STATUS_DIR)))
    parser.add_argument("--max-chunks", type=int, default=int(os.environ.get("PROJECT_STATUS_EVIDENCE_MAX_CHUNKS", "80")))
    return parser.parse_args(argv)


def maybe_reexec_with_model_python(args: argparse.Namespace) -> None:
    """Use the status-model venv when available, without making it mandatory."""
    if os.environ.get("PROJECT_STATUS_MODEL_NO_REEXEC"):
        return
    model_path = Path(args.model)
    if not model_path.exists():
        return
    preferred = Path(os.environ.get("PROJECT_STATUS_MODEL_PYTHON", str(Path(args.project_dir) / ".venv" / "bin" / "python")))
    if not preferred.exists():
        preferred = DEFAULT_MODEL_PYTHON
    if not preferred.exists():
        return
    try:
        if preferred.absolute() == Path(sys.executable).absolute():
            return
    except OSError:
        return
    os.execv(str(preferred), [str(preferred), str(Path(__file__).resolve()), *sys.argv[1:]])


def main() -> int:
    args = parse_args(sys.argv[1:])
    maybe_reexec_with_model_python(args)
    transcript_text = Path(args.transcript_path).read_text(encoding="utf-8")
    pack = build_pack(
        transcript_text,
        model_path=Path(args.model),
        project_dir=Path(args.project_dir),
        max_chunks=max(1, args.max_chunks),
    )
    print(json.dumps(pack, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
