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

    def test_deictic_handoff_uses_neighbouring_context(self):
        transcript = """
Jacqui Fox   6:45 And order to the point of the document that Mark is sharing, this is the QMS manual that he had sent through on Friday.
Orla Skally   6:52 Mm.
Jacqui Fox   7:26 I will, I will flick this over to Orla.
"""
        segments = self.module.candidate_segments(transcript)
        handoff = next(row for row in segments if "flick this over" in row["text"])
        self.assertEqual(handoff["contextReason"], "deictic_handoff_context_window")
        self.assertIn("QMS manual", handoff["classificationText"])
        self.assertEqual(
            self.module.canonical_action(handoff["text"], handoff["contextText"]),
            "Review the QMS Manual",
        )
        self.assertEqual(
            self.module.owner_from_line(handoff["speaker"], handoff["text"], handoff["contextText"]),
            "Orla Skally",
        )

    def test_context_request_to_cody_is_kept_as_assigned_handoff(self):
        row = self.row(
            "So if you're talking to Cody, could you just maybe mention it to him?",
            evidence_type="discussion_topic",
            commitment="possible_action",
        )
        row["speaker"] = "Jacqui Fox"
        row["contextText"] = (
            "Orla Skally: Cody is working with MedEnvoy, not me. "
            "Jacqui Fox: Ask Cody for a copy of the MedEnvoy project plan or task list."
        )
        self.assertEqual(self.module.suppression_reason(row), "")
        self.assertEqual(self.module.keep_reason(row), "resolved_context_handoff")
        self.assertEqual(
            self.module.owner_from_line(row["speaker"], row["text"], row["contextText"]),
            "Orla",
        )
        self.assertEqual(
            self.module.canonical_action(row["text"], row["contextText"]),
            "Follow up with Cody for the MedEnvoy project plan or task list",
        )

    def test_suppresses_deictic_handoff_without_resolved_object(self):
        row = self.row("I will flick this over to Orla.")
        row["speaker"] = "Jacqui Fox"
        self.assertEqual(
            self.module.suppression_reason(row),
            "deictic_handoff_without_resolved_object",
        )
        self.assertEqual(self.module.keep_reason(row), "")

    def test_contextual_actions_from_split_dita_evidence(self):
        transcript = """
Jacqui Fox: This is the QMS manual that Mark sent through on Friday.
Jacqui Fox: I will, I will flick this over to Orla.
Orla Skally: Cody is the one working with Med Envoy, not me, so I can go back to Cody.
Jacqui Fox: I did ask Cody for a copy of the project plan or task list from Med Envoy.
Jacqui Fox: So if you're talking to Cody, could you just maybe mention it to him?
Jenny Gough: I could have a look at the label if you wanted.
Jacqui Fox: You could do with one list of all the countries that you ship to from a language perspective for the DoCs.
John-Paul Hughes: So on the declarations of conformity, we just need to update those and include the risk rationale.
Orla Skally: The HPRA have sent me a bill and I can send a copy.
Jacqui Fox: Send it on to myself, Colm. We can have a look at it.
Orla Skally: I can send that email as well to you and Colm.
"""
        actions = self.module.contextual_actions_from_transcript(transcript)
        action_text = " | ".join(item["action"] for item in actions)
        self.assertIn("Review the QMS Manual", action_text)
        self.assertIn("Follow up with Cody for the MedEnvoy project plan or task list", action_text)
        self.assertIn("Share a copy of the new label with Jenny for review", action_text)
        self.assertIn("Share the country and language list for the Declarations of Conformity", action_text)
        self.assertIn("Review the DoCs for sunglasses for MDR and PPE compliance", action_text)
        self.assertIn("Review the HPRA invoice fee", action_text)
        by_action = {item["action"]: item["owner"] for item in actions}
        self.assertEqual(by_action["Review the QMS Manual"], "Orla Skally")
        self.assertEqual(by_action["Share a copy of the new label with Jenny for review"], "Orla Skally")
        self.assertEqual(by_action["Review the HPRA invoice fee"], "Jacqui Fox")

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
