#!/usr/bin/env python3
"""Score saved live-path action runs: matched / duplicate / noise, per fixture and in total.

Two matchers are reported side by side:
  semantic - all-MiniLM-L6-v2 cosine >= 0.55 to an expected action (the ranker/flow evals used this)
  lexical  - the scorecard's content-token overlap >= 0.5 (owner ignored), for comparison with
             earlier tables
A row is "matched" if it is the first row to hit an expected action, "dup" if it hits an expected
action another row already hit or is >= 0.70 cosine to an earlier unmatched row, otherwise "noise".
Rows carrying tier == 1 are also scored on their own, so a tiered presentation can be judged on
what the reviewer sees first without hiding what was demoted.

Usage: python3 scripts/score_live_action_runs.py artifacts/live-action-path-eval/baseline/run-*.json
"""
from __future__ import annotations

import argparse
import json
import os
import re
import statistics
from pathlib import Path

os.environ.setdefault("HF_HUB_OFFLINE", "1")

STOP = {"the", "a", "an", "and", "or", "of", "to", "for", "in", "on", "at", "by", "with", "as", "is", "are", "was", "were", "be", "been", "it", "its", "that", "this", "these", "those", "from", "into", "their", "our", "your", "not", "stated"}


def tokens(value: str) -> set[str]:
    return {re.sub(r"(?:ing|ed|es|s)$", "", token) for token in re.findall(r"[a-z][a-z0-9'’-]{2,}", str(value or "").lower()) if token not in STOP}


def overlap(left: str, right: str) -> float:
    a, b = tokens(left), tokens(right)
    if not a or not b:
        return 0.0
    return len(a & b) / min(len(a), len(b))


def score_fixture(item: dict, embedder, threshold: float, dup_threshold: float) -> dict:
    import numpy as np
    expected = [row["action"] for row in item.get("expected", {}).get("actions", [])]
    rows = item.get("actions", [])
    stats = {"expected": len(expected), "shown": len(rows), "matched": 0, "dup": 0, "noise": 0,
             "lexMatched": 0, "tier1Shown": 0, "tier1Matched": 0, "tier1Noise": 0}
    if not rows:
        return stats
    texts = [str(row.get("action", "")) for row in rows]
    R = embedder.encode(texts, normalize_embeddings=True)
    E = embedder.encode(expected, normalize_embeddings=True) if expected else np.zeros((0, R.shape[1]))
    seen: set[int] = set()
    tier1_seen: set[int] = set()
    kept: list = []
    for row, text, vector in zip(rows, texts, R):
        tier1 = row.get("tier", 1) == 1
        stats["tier1Shown"] += int(tier1)
        hit = None
        if len(E):
            sims = E @ vector
            if float(sims.max()) >= threshold:
                hit = int(sims.argmax())
        if hit is not None:
            if hit in seen:
                stats["dup"] += 1
            else:
                seen.add(hit)
                stats["matched"] += 1
            if tier1:
                tier1_seen.add(hit)
            continue
        if kept and max(float(k @ vector) for k in kept) >= dup_threshold:
            stats["dup"] += 1
        else:
            stats["noise"] += 1
            stats["tier1Noise"] += int(tier1)
        kept.append(vector)
    stats["tier1Matched"] = len(tier1_seen)
    lex_seen = set()
    for text in texts:
        best, best_score = None, 0.0
        for index, exp in enumerate(expected):
            value = overlap(exp, text)
            if value > best_score:
                best, best_score = index, value
        if best is not None and best_score >= 0.5:
            lex_seen.add(best)
    stats["lexMatched"] = len(lex_seen)
    return stats


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("runs", nargs="+")
    parser.add_argument("--threshold", type=float, default=0.55)
    parser.add_argument("--dup-threshold", type=float, default=0.70)
    args = parser.parse_args()
    from sentence_transformers import SentenceTransformer
    embedder = SentenceTransformer("all-MiniLM-L6-v2")
    per_run: list[dict[str, dict]] = []
    for path in args.runs:
        payload = json.loads(Path(path).read_text())
        per_run.append({item["name"]: score_fixture(item, embedder, args.threshold, args.dup_threshold) for item in payload["results"]})
    names = sorted({name for run in per_run for name in run})
    keys = ["expected", "shown", "matched", "dup", "noise", "lexMatched", "tier1Shown", "tier1Matched", "tier1Noise"]
    tiered = any(any(stats["tier1Shown"] != stats["shown"] for stats in run.values()) for run in per_run)

    def median(values: list[float]) -> float:
        return statistics.median(values) if values else 0.0

    print(f"{len(per_run)} run(s): {', '.join(args.runs)}")
    header = "fixture                              exp | shown  match  dup  noise | recall  prec | lex" + ("  | tier1 shown/match/noise" if tiered else "")
    print(header)
    print("-" * len(header))
    totals = {key: [] for key in keys}
    for name in names:
        rows = [run[name] for run in per_run if name in run]
        med = {key: median([r[key] for r in rows]) for key in keys}
        exp = med["expected"]
        recall = (med["matched"] / exp * 100) if exp else float("nan")
        prec = (med["matched"] / med["shown"] * 100) if med["shown"] else 0
        line = f"{name:36} {int(exp):3} | {med['shown']:5.0f}  {med['matched']:5.0f}  {med['dup']:3.0f}  {med['noise']:5.0f} | {recall:5.1f}%  {prec:4.0f}% | {med['lexMatched']:3.0f}"
        if tiered:
            line += f"  | {med['tier1Shown']:3.0f}/{med['tier1Matched']:3.0f}/{med['tier1Noise']:3.0f}"
        print(line)
    print("-" * len(header))
    run_totals = [{key: sum(stats[key] for stats in run.values()) for key in keys} for run in per_run]
    for index, total in enumerate(run_totals, 1):
        line = (f"run {index:<32} {total['expected']:3} | {total['shown']:5}  {total['matched']:5}  {total['dup']:3}  {total['noise']:5} | "
                f"{total['matched'] / total['expected'] * 100:5.1f}%  {total['matched'] / max(total['shown'], 1) * 100:4.0f}% | {total['lexMatched']:3}")
        if tiered:
            line += f"  | {total['tier1Shown']:3}/{total['tier1Matched']:3}/{total['tier1Noise']:3}"
        print(line)
    med = {key: median([t[key] for t in run_totals]) for key in keys}
    line = (f"{'MEDIAN':36} {int(med['expected']):3} | {med['shown']:5.0f}  {med['matched']:5.0f}  {med['dup']:3.0f}  {med['noise']:5.0f} | "
            f"{med['matched'] / med['expected'] * 100:5.1f}%  {med['matched'] / max(med['shown'], 1) * 100:4.0f}% | {med['lexMatched']:3.0f}")
    if tiered:
        line += f"  | {med['tier1Shown']:3.0f}/{med['tier1Matched']:3.0f}/{med['tier1Noise']:3.0f}"
    print(line)


if __name__ == "__main__":
    main()
