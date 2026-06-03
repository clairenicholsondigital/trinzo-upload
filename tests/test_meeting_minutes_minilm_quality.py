import sys
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from meeting_minutes_minilm_experiment import (
    derive_meeting_objectives,
    formalize_transcript_discussion_point,
    has_concrete_action_commitment,
    infer_minilm_meeting_title,
    should_accept_action_candidate,
    _sanitize_rewritten_minutes_text,
)


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
        self.assertTrue(has_concrete_action_commitment("Investigate the server restart by Friday."))

    def test_transcript_label_is_removed_from_minilm_title(self):
        transcript = "📄 Transcript: AI Programme Weekly Check-In\n\nDate: 18 March 2026\n\nCiara:\nHello."

        self.assertEqual(infer_minilm_meeting_title(transcript), "AI Programme Weekly Check-In")

    def test_conversational_discussion_fragments_are_formalized(self):
        self.assertEqual(
            formalize_transcript_discussion_point(
                "One thing I’d add, we might want to start tracking leading indicators, not just status Things like resource utilisation, number of active SO.",
                [{"text": "Ws per team, dependency concentration."}],
            ),
            "Leading indicators such as resource utilisation, active SOWs per team and dependency concentration should be tracked alongside status.",
        )
        self.assertEqual(
            formalize_transcript_discussion_point(
                "I’ve got the latest report open, the 18th March one So overall status is still green across scope, schedule, financials, resources."
            ),
            "Overall programme status remained green across scope, schedule, financials and resources.",
        )
        self.assertEqual(
            formalize_transcript_discussion_point(
                "Things like resource utilisation, number of active SOWs per team, dependency concentration."
            ),
            "Leading indicators such as resource utilisation, active SOWs per team and dependency concentration should be tracked alongside status.",
        )

    def test_resource_indicator_fragment_is_not_promoted_as_raw_objective(self):
        output = {
            "discussionPoints": [
                "Leading indicators such as resource utilisation, active SOWs per team and dependency concentration should be tracked alongside status.",
                "Things like resource utilisation, number of active SOWs per team, dependency concentration.",
            ],
            "discussionPointDetails": [
                {"sourceTurnIndices": [1, 2], "evidenceScore": 0.8},
                {"sourceTurnIndices": [2], "evidenceScore": 0.7},
            ],
            "decisions": [],
            "actions": [],
        }

        objectives = derive_meeting_objectives(output)

        self.assertIn(
            "Leading indicators such as resource utilisation, active SOWs per team and dependency concentration should be tracked alongside status",
            objectives,
        )
        self.assertFalse(any(objective.lower().startswith("things like") for objective in objectives))

    def test_vague_qwen_rewrite_falls_back_to_specific_source(self):
        source = "Sales continued to progress new SOWs while delivery bandwidth was not increasing at the same pace."

        self.assertEqual(
            _sanitize_rewritten_minutes_text("Currently there's some confusion regarding the issue.", source),
            source,
        )

    def test_report_update_with_vague_points_is_not_concrete_action(self):
        self.assertFalse(has_concrete_action_commitment("I’ll update the next report with these points."))


if __name__ == "__main__":
    unittest.main()
