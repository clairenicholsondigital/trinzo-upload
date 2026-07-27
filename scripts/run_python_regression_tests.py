#!/usr/bin/env python3
"""Run the deploy-facing Python regression suite.

The historical MiniLM comparison suite is kept as a named diagnostic command
because its expectations drift independently of the deploy gate.
"""

from __future__ import annotations

import unittest
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
QUARANTINED_MODULES = {"test_minilm_comparison"}
sys.path.insert(0, str(ROOT))


def iter_tests(suite: unittest.TestSuite):
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from iter_tests(item)
        else:
            yield item


def load_suite() -> unittest.TestSuite:
    loader = unittest.defaultTestLoader
    discovered = loader.discover("tests", pattern="test_*.py")
    filtered = unittest.TestSuite()
    skipped = 0

    for test in iter_tests(discovered):
        module_name = test.__class__.__module__.rsplit(".", 1)[-1]
        if module_name in QUARANTINED_MODULES:
            skipped += 1
            continue
        filtered.addTest(test)

    print(
        "Python deploy regression suite: "
        f"quarantined {skipped} tests from {', '.join(sorted(QUARANTINED_MODULES))}."
    )
    return filtered


if __name__ == "__main__":
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(load_suite())
    raise SystemExit(0 if result.wasSuccessful() else 1)
