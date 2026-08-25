#!/usr/bin/env python3
"""Batch semantic similarity for the staged-minutes scorecard.

The scorecard's matcher is lexical token overlap, which under-reports real coverage: a
true paraphrase ("Review the goods flow and storage arrangements" for "Understand product
flow, warehouse, order, picking and packing") scores as a miss. This bridge lets the node
scorecard ask the MiniLM backend - the same one run_meeting_minutes_final_golden_eval.py
already uses at the same 0.6 threshold - to score every strict-unmatched pair in one
process, amortising the ~10s model load across the whole corpus.

Protocol, chosen so the node side never has to parse anything but one JSON document:
  stdin:  {"requests": [{"id": str, "expected": [str], "candidates": [str]}]}
  stdout: {"ok": true, "results": [{"id": str, "best": [{"sim": float, "index": int}]}]}
          - best[i] is the highest-scoring candidate for expected[i], index into candidates
          {"ok": false, "reason": str} when the model cannot load (sentence-transformers
          missing, no weights, ...). Always exit 0 with a JSON body; the caller treats a
          non-zero exit or unparseable output as "unavailable" and degrades to strict-only.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def main() -> None:
    payload = json.load(sys.stdin)
    requests = payload.get("requests") or []

    try:
        from meeting_minutes_minilm_experiment import MiniLMBackend
        backend = MiniLMBackend.load(enabled=True, prefer_remote=False)
    except Exception as error:  # noqa: BLE001 - degrade, never crash the scorecard
        print(json.dumps({"ok": False, "reason": f"backend import/load failed: {error}"}))
        return
    if not backend.available:
        print(json.dumps({"ok": False, "reason": backend.reason}))
        return

    results = []
    for request in requests:
        best = []
        candidates = [str(c) for c in (request.get("candidates") or [])]
        for expected in request.get("expected") or []:
            top_sim, top_index = 0.0, -1
            for index, candidate in enumerate(candidates):
                sim = backend.similarity(str(expected), candidate)
                if sim > top_sim:
                    top_sim, top_index = sim, index
            best.append({"sim": round(float(top_sim), 4), "index": top_index})
        results.append({"id": request.get("id"), "best": best})

    print(json.dumps({"ok": True, "results": results}))


if __name__ == "__main__":
    main()
