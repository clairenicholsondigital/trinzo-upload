#!/usr/bin/env python3
"""Merge reviewed master evidence rows with isolated speech-act candidates."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--master", required=True)
    parser.add_argument("--candidates", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    master = pd.read_csv(args.master).fillna("")
    master = master[
        master["include_in_training"].eq(1)
        & master["train_evidence_head"].eq(1)
        & master["train_action_head"].eq(1)
        & ~master["label_review_status"].astype(str).str.contains("human_review_required")
    ].copy()
    base = pd.DataFrame({
        "row_id": master["row_id"], "text": master["model_text"], "speech_act": "legacy_reviewed",
        "evidence_type": master["evidence_type"], "action_state": master["action_state"], "signals": master["signals"],
        "domain": master["dataset_family"], "group_id": master["group_id"], "recommended_split": master["recommended_split"],
        "source": master["source"], "review_status": "human_approved",
    })
    candidates = pd.read_csv(args.candidates).fillna("")
    combined = pd.concat([base, candidates], ignore_index=True)
    combined = combined.drop_duplicates(subset=["text", "evidence_type", "action_state"], keep="first")
    leakage = combined.groupby("group_id")["recommended_split"].nunique()
    if (leakage > 1).any():
        raise SystemExit(f"Group leakage detected: {leakage[leakage > 1].to_dict()}")
    output = Path(args.output); output.parent.mkdir(parents=True, exist_ok=True)
    combined.to_csv(output, index=False)
    summary = {
        "rows": len(combined), "reviewedMasterRows": len(base), "candidateRows": len(candidates),
        "groups": combined["group_id"].nunique(), "splitCounts": combined["recommended_split"].value_counts().to_dict(),
        "evidenceTypeCounts": combined["evidence_type"].value_counts().to_dict(),
        "actionStateCounts": combined["action_state"].value_counts().to_dict(), "groupLeakage": False,
    }
    output.with_suffix(".manifest.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
