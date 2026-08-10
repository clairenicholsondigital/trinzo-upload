import importlib.util
import json
import subprocess
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "meeting_minutes_evidence_classifier.py"


def load_module():
    spec = importlib.util.spec_from_file_location("meeting_minutes_evidence_classifier", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class MeetingMinutesEvidenceClassifierTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load_module()

    def row(self, text, evidence_type="action_commitment", commitment="confirmed_action", signals=None):
        return {
            "text": text,
            "speaker": "Stuart M",
            "candidateHint": self.module.candidate_hint(text),
            "evidenceType": evidence_type,
            "evidenceConfidence": 0.6,
            "commitmentState": commitment,
            "commitmentConfidence": 0.6,
            "signals": signals or [],
        }

    def test_keeps_risk_assessment_action(self):
        row = self.row("I've got to do the risk assessment to develop the audit plan by Wednesday.")
        self.assertEqual(self.module.suppression_reason(row), "")
        self.assertTrue(self.module.keep_reason(row))
        self.assertEqual(
            self.module.canonical_action(row["text"]),
            "Complete the risk assessment to develop the audit plan",
        )

    def test_suppresses_sequence_location_hypothetical_and_noise(self):
        cases = [
            self.row("The risk assessment comes before the audit plan.", evidence_type="process_overview", commitment="not_action"),
            self.row("The SharePoint contains the existing procedure documentation.", evidence_type="document_control_task", commitment="not_action"),
            self.row("Maybe we could look at the label if there is time.", evidence_type="discussion_context", commitment="not_action"),
            self.row("I'll just share my screen now.", evidence_type="low_value_noise", commitment="not_action"),
        ]
        for row in cases:
            with self.subTest(row=row["text"]):
                self.assertNotEqual(self.module.suppression_reason(row), "")
                self.assertEqual(self.module.keep_reason(row), "")

    def test_missing_model_returns_fail_open_json(self):
        tmp = Path("/tmp/meeting-minutes-evidence-classifier-test.txt")
        tmp.write_text("Stuart M: Complete the risk assessment to develop the audit plan.", encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(SCRIPT_PATH), str(tmp), "--model", "/tmp/not-a-real-classifier.joblib"],
            check=True,
            text=True,
            capture_output=True,
        )
        payload = json.loads(result.stdout)
        self.assertFalse(payload["executed"])
        self.assertFalse(payload["modelAvailable"])
        self.assertEqual(payload["actions"], [])


if __name__ == "__main__":
    unittest.main()
