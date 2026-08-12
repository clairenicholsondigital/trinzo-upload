#!/usr/bin/env python3
"""Combine the frozen v3 training data with contextual-head candidate rows."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd


CONTEXT_COLUMNS = [
    "previous_text", "current_text", "next_text", "context_text",
    "lifecycle_state", "context_dependency", "canonical_worthiness",
    "temporal_role", "canonical_group_id", "gold_include", "gold_section",
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="artifacts/canonical-speech-act-model-v3/training_data_used.csv")
    parser.add_argument("--contextual", default="artifacts/canonical_contextual_candidates_v1.csv")
    parser.add_argument("--output", default="artifacts/canonical_contextual_augmented_v1.csv")
    args = parser.parse_args()
    base = pd.read_csv(args.base).fillna("")
    contextual = pd.read_csv(args.contextual).fillna("")
    for column in CONTEXT_COLUMNS:
        if column not in base: base[column] = ""
        if column not in contextual: contextual[column] = ""
    for column in base.columns:
        if column not in contextual: contextual[column] = ""
    combined = pd.concat([base, contextual[base.columns]], ignore_index=True)
    leakage = combined.groupby("group_id")["recommended_split"].nunique()
    if (leakage > 1).any(): raise SystemExit(f"Group leakage: {leakage[leakage > 1].to_dict()}")
    output = Path(args.output); output.parent.mkdir(parents=True, exist_ok=True)
    combined.to_csv(output, index=False)
    report = {
        "rows": len(combined), "baseRows": len(base), "contextualRows": len(contextual),
        "groups": combined["group_id"].nunique(),
        "splitCounts": combined["recommended_split"].value_counts().to_dict(),
        "reviewStatusCounts": combined["review_status"].value_counts().to_dict(),
        "contextualLabelCounts": {column: int(combined[column].astype(str).str.strip().ne("").sum()) for column in CONTEXT_COLUMNS[4:8]},
    }
    output.with_suffix(".manifest.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__": main()
