#!/usr/bin/env python3
"""Compatibility wrapper for Claire's original Colab meeting compiler experiment.

The notebook-style prototype has been promoted into:

    scripts/meeting_minutes_ai_improvement_lab.py

Run locally:

    python3 tests/compiler_colabtest.py --golden-cases 021_real_dita_importer_obligations_transcript

Run in Google Colab after cloning/uploading the repo:

    !python3 tests/compiler_colabtest.py --golden-cases 021_real_dita_importer_obligations_transcript --with-ai

Why this wrapper exists:
- The original file used Colab notebook magics and `google.colab.ai` directly.
- This version delegates to the repo-safe improvement lab, which uses the real
  meeting-minutes extractor, the golden evaluation pack, and optional Colab AI
  critique without letting AI blindly edit production code.
"""

from __future__ import annotations

import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from meeting_minutes_ai_improvement_lab import main


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
