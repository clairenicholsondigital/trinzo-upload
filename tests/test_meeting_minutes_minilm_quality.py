import sys
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from meeting_minutes_minilm_experiment import has_concrete_action_commitment, should_accept_action_candidate


class MeetingMinutesMiniLMQualityTest(unittest.TestCase):
    def test_conversational_availability_is_not_a_concrete_action(self):
        text = "And I'm easy right here, I can come back in here, or if you want to just continue with this, I don't mind."

        self.assertFalse(has_concrete_action_commitment(text))
        accepted, reason = should_accept_action_candidate(
            {
                "text": text,
                "owner": "Owner not specified",
                "deadline": "",
                "baseScore": 0.95,
                "combinedScore": 0.95,
                "semanticScore": 0.8,
                "roleScores": {"action": 0.8},
                "source": "semantic_action_fallback",
            }
        )

        self.assertFalse(accepted)
        self.assertEqual(reason, "missing_concrete_action_commitment")

    def test_clear_next_step_is_concrete_action(self):
        self.assertTrue(has_concrete_action_commitment("Refine the webinar opening slide before Friday."))
        self.assertTrue(has_concrete_action_commitment("Double down with the upskilled team on adoption considerations."))


if __name__ == "__main__":
    unittest.main()
