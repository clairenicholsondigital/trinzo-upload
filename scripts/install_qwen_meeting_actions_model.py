#!/usr/bin/env python3
"""Reproduce the pinned local model files for the meeting-actions trial."""

from __future__ import annotations

import hashlib
from pathlib import Path

from huggingface_hub import snapshot_download


ROOT = Path(__file__).resolve().parents[1]
BASE_REPO = "Qwen/Qwen3-0.6B"
BASE_REVISION = "c1899de289a04d12100db370d81485cdf75e47ca"
ADAPTER_REPO = "clairenicholson078/qwen3-06b-meeting-actions-multiaction-v1"
ADAPTER_REVISION = "511773a88fbf0c0b45f6a619f69c53771403c4c0"
EXPECTED = {
    ROOT / ".models/qwen3-0.6b/model.safetensors": "f47f71177f32bcd101b7573ec9171e6a57f4f4d31148d38e382306f42996874b",
    ROOT / ".models/qwen3-0.6b-meeting-actions-multiaction-v1/adapter_model.safetensors": "dadb473dfc637d72d150136a71776aec29d09da70b1ae4d4509dcf70ab53239f",
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    snapshot_download(
        repo_id=BASE_REPO,
        revision=BASE_REVISION,
        local_dir=ROOT / ".models/qwen3-0.6b",
        allow_patterns=[
            "config.json",
            "generation_config.json",
            "model.safetensors",
            "tokenizer.json",
            "tokenizer_config.json",
            "vocab.json",
            "merges.txt",
            "LICENSE",
        ],
    )
    snapshot_download(
        repo_id=ADAPTER_REPO,
        revision=ADAPTER_REVISION,
        local_dir=ROOT / ".models/qwen3-0.6b-meeting-actions-multiaction-v1",
        allow_patterns=[
            "adapter_config.json",
            "adapter_model.safetensors",
            "chat_template.jinja",
            "tokenizer.json",
            "tokenizer_config.json",
            "README.md",
            "training_args.bin",
        ],
    )
    for path, expected in EXPECTED.items():
        actual = sha256(path)
        if actual != expected:
            raise RuntimeError(f"Checksum mismatch for {path}: {actual}")
    print("Pinned Qwen base model and meeting-actions adapter verified.")


if __name__ == "__main__":
    main()
