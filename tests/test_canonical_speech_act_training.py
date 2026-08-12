import importlib.util
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "build_canonical_speech_act_training.py"
spec = importlib.util.spec_from_file_location("canonical_speech_data", SCRIPT)
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = module
spec.loader.exec_module(module)


class CanonicalSpeechActTrainingTest(unittest.TestCase):
    def setUp(self):
        self.rows = [row for index, scenario in enumerate(module.SCENARIOS, 1) for row in module.rows_for_scenario(index, scenario)]
        split = module.assign_splits([row["group_id"] for row in self.rows], 761819)
        for row in self.rows:
            row["recommended_split"] = split[row["group_id"]]

    def test_contrast_families_cover_required_speech_acts(self):
        report = module.validate(self.rows)
        self.assertEqual(report["rows"], 500)
        self.assertEqual(report["missingSpeechActs"], [])
        self.assertEqual(report["duplicateTexts"], [])

    def test_semantic_siblings_never_cross_splits(self):
        report = module.validate(self.rows)
        self.assertEqual(report["groupLeakage"], {})
        self.assertEqual(set(report["splitCounts"]), {"train", "validation", "test"})

    def test_generated_rows_are_review_gated(self):
        self.assertTrue(all(row["review_status"] == "assistant_reviewed_candidate" for row in self.rows))


if __name__ == "__main__":
    unittest.main()
