import importlib.util
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "build_contextual_evidence_training.py"
spec = importlib.util.spec_from_file_location("contextual_evidence_data", SCRIPT)
module = importlib.util.module_from_spec(spec)
sys.path.insert(0, str(ROOT / "scripts"))
spec.loader.exec_module(module)


class ContextualEvidenceTrainingTest(unittest.TestCase):
    def setUp(self):
        self.rows = [row for index, scenario in enumerate(module.SCENARIOS, 1) for row in module.rows_for_scenario(index, scenario)]

    def test_curriculum_is_complete_and_group_safe(self):
        report = module.validate(self.rows)
        self.assertEqual(report["rows"], 320)
        self.assertEqual(report["errors"], [])
        self.assertEqual(report["groupLeakage"], {})
        self.assertEqual(set(report["splitCounts"]), {"train", "validation", "test"})

    def test_context_contract_and_review_gate(self):
        self.assertTrue(all("[PREVIOUS]\n" in row["context_text"] and "\n[CURRENT]\n" in row["context_text"] and "\n[NEXT]\n" in row["context_text"] for row in self.rows))
        self.assertTrue(all(row["review_status"] == "human_approved" for row in self.rows))


if __name__ == "__main__": unittest.main()
