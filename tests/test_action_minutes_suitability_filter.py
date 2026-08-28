import json
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "action_minutes_suitability_filter.py"
MODEL = ROOT / "artifacts" / "action-minutes-suitability-experimental-v1" / "classifier.joblib"


class ActionMinutesSuitabilityFilterTests(unittest.TestCase):
    def run_filter(self, actions, threshold=None):
        with tempfile.TemporaryDirectory() as directory:
            input_path = Path(directory) / "actions.json"
            input_path.write_text(json.dumps({"actions": actions}), encoding="utf-8")
            command = [str(ROOT / ".venv" / "bin" / "python"), str(SCRIPT), str(input_path), "--model", str(MODEL)]
            if threshold is not None:
                command.extend(["--threshold", str(threshold)])
            result = subprocess.run(
                command,
                check=True, capture_output=True, text=True,
            )
            return json.loads(result.stdout)

    def test_returns_one_stable_decision_per_candidate(self):
        output = self.run_filter([{
            "id": "action_1", "owner": "Alex Smith", "action": "Verify the release evidence.",
            "deadline": "Friday", "evidence": [{"speaker": "Alex Smith", "text": "I will verify the release evidence by Friday."}],
        }])
        self.assertTrue(output["ok"])
        self.assertEqual(output["modelSchemaVersion"], 2)
        self.assertEqual(output["decisions"][0]["id"], "action_1")
        self.assertIsInstance(output["decisions"][0]["keep"], bool)
        self.assertGreaterEqual(output["decisions"][0]["showProbability"], 0)
        self.assertLessEqual(output["decisions"][0]["showProbability"], 1)

    def test_missing_evidence_fails_closed_inside_script(self):
        output = self.run_filter([{"id": "action_1", "action": "Do something."}])
        self.assertFalse(output["ok"])
        self.assertIn("evidence", output["reason"])

    def test_deployment_can_raise_the_preserved_models_publication_threshold(self):
        action = {
            "id": "action_1", "owner": "Alex Smith", "action": "Verify the release evidence.",
            "deadline": "Friday", "evidence": [{"speaker": "Alex Smith", "text": "I will verify the release evidence by Friday."}],
        }
        output = self.run_filter([action], threshold=0.35)
        self.assertEqual(output["threshold"], 0.35)
        self.assertEqual(output["decisions"][0]["keep"], output["decisions"][0]["showProbability"] >= 0.35)


if __name__ == "__main__":
    unittest.main()
