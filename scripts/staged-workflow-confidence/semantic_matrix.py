#!/usr/bin/env python3
"""Return batched MiniLM cosine-similarity matrices for the confidence benchmark."""
from __future__ import annotations

import json
import sys


def main() -> int:
    payload = json.load(sys.stdin)
    requests = payload.get("requests") or []
    try:
        from sentence_transformers import SentenceTransformer
        import numpy as np

        model = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")
        texts = []
        for request in requests:
            texts.extend(str(item) for item in request.get("left", []))
            texts.extend(str(item) for item in request.get("right", []))
        unique = list(dict.fromkeys(text for text in texts if text.strip()))
        vectors = model.encode(unique, normalize_embeddings=True, show_progress_bar=False)
        lookup = {text: vector for text, vector in zip(unique, vectors)}
        results = []
        for request in requests:
            left = [str(item) for item in request.get("left", [])]
            right = [str(item) for item in request.get("right", [])]
            matrix = []
            for left_text in left:
                row = []
                for right_text in right:
                    score = float(np.dot(lookup[left_text], lookup[right_text])) if left_text in lookup and right_text in lookup else 0.0
                    row.append(round(score, 4))
                matrix.append(row)
            results.append({"id": request.get("id"), "matrix": matrix})
        print(json.dumps({"ok": True, "model": "sentence-transformers/all-MiniLM-L6-v2", "results": results}))
        return 0
    except Exception as error:  # noqa: BLE001
        print(json.dumps({"ok": False, "reason": str(error)}))
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
