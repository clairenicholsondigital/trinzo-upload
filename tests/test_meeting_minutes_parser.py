import json
import unittest
from pathlib import Path

from scripts.python_llm import analyse as analyse_project
from scripts.python_llm_meeting_minutes import analyse, parse_speaker_turns

FIXTURE = Path(__file__).parent / "fixtures" / "meeting_minutes_timestamped_transcript.txt"
PROJECT_FIXTURE = Path(__file__).parent / "fixtures" / "project_update_june_2_2026.txt"


class MeetingMinutesParserTest(unittest.TestCase):
    def setUp(self):
        self.transcript = FIXTURE.read_text(encoding="utf-8")

    def test_timestamped_turns_are_parsed_from_inline_format(self):
        turns = parse_speaker_turns(self.transcript)

        self.assertEqual(
            [(turn.speaker, turn.timestamp) for turn in turns[:3]],
            [
                ("Jack Cunningham", "0:03"),
                ("Conor Flynn", "17:42"),
                ("Ciara Griffin", "0:03"),
            ],
        )
        self.assertTrue(turns[0].text.startswith("And then what we want to do"))

    def test_meeting_minutes_use_the_flat_skill_style_output(self):
        result = analyse(self.transcript)

        self.assertEqual(result["meetingTitle"], "Webinar practice transcript")
        self.assertEqual(result["meetingDate"], "20 May 2026")
        self.assertEqual(result["meetingLocation"], "Teams")
        self.assertEqual(result["meetingType"], "webinar_rehearsal")
        self.assertEqual(result["meetingTheme"], "Webinar rehearsal and presentation review")
        self.assertEqual(result["participants.client"], ["Ciara Griffin"])
        self.assertEqual(result["participants.trinzo"], ["Conor Flynn", "Jack Cunningham"])
        self.assertEqual(result["itemTopic"], "Webinar rehearsal and presentation review")
        self.assertEqual(
            result["meetingObjectives"],
            ["Review the webinar flow, confirm presentation readiness, and agree final preparation actions."],
        )
        self.assertEqual(len(result["discussionPoints"]), 5)
        self.assertEqual(len(result["meetingActionPoint"]), 3)
        self.assertEqual(result["meetingActionPointOwner"][0], "Ciara Griffin")
        self.assertEqual(result["meetingActionPointDeadline"][0], "by Friday")
        self.assertEqual(result["meetingActionPointDeadline"][1], "Before the webinar")
        self.assertEqual(result["meetingActionPointOwner"][2], "Owner not specified")
        self.assertEqual(result["meetingActionPointDeadline"][2], "Before next week")
        self.assertEqual(result["meetingActionPointConfidence"][0], 0.95)
        self.assertEqual(result["meetingActionPointConfidence"][2], 0.2)
        self.assertTrue("executiveSummary" in result)
        json.dumps(result)

    def test_project_minutes_are_derived_from_milestone_output(self):
        project_transcript = PROJECT_FIXTURE.read_text(encoding="utf-8")
        result = analyse(project_transcript)

        self.assertEqual(result["meetingType"], "project_status_review")
        self.assertEqual(result["meetingTheme"], "AI delivery and governance review")
        self.assertEqual(result["meetingTitle"], "AI delivery and governance review")
        self.assertEqual(
            result["meetingObjectives"],
            ["Review programme milestones, confirm status updates, identify blockers, and agree actions before the next review cycle."],
        )
        self.assertEqual(result["itemTopic"], "AI delivery and governance review")
        self.assertEqual(result["participants.client"], ["Ciara Griffin"])
        self.assertEqual(result["participants.trinzo"], ["Conor Flynn"])
        self.assertEqual(len(result["discussionPoints"]), 10)
        self.assertIn("Agreed RAG status: amber.", result["discussionPoints"][1])
        self.assertIn("AI pipeline strategy remains blocked", " ".join(result["discussionPoints"]))
        self.assertEqual(result["meetingActionPointRelatedMilestone"][0], "stage_gate_internal_review")
        self.assertEqual(result["meetingActionPointRelatedMilestone"][1], "ai_pipeline_strategy")
        self.assertEqual(result["meetingActionPointRelatedMilestone"][2], "stage_gate_vendor_strategy")
        self.assertEqual(result["meetingActionPointRelatedMilestone"][3], "ei_grant_feedback")
        self.assertEqual(result["meetingActionPointOwner"][3], "Emma")
        self.assertEqual(result["meetingActionPointConfidence"][3], 0.85)
        self.assertEqual(result["healthSummary"]["blue"], 1)
        self.assertEqual(result["healthSummary"]["blocked"], 1)
        self.assertIn("AI pipeline strategy remains blocked", result["executiveSummary"])
        json.dumps(result)

    def test_project_analyser_handles_inline_turn_transcripts(self):
        result = analyse_project(self.transcript)

        self.assertEqual(result["turn_count_raw"], 6)
        self.assertEqual(result["turn_count_cleaned"], 6)
        self.assertTrue(result["cleaned_turns"])
        self.assertEqual(result["cleaned_turns"][0]["speaker"], "Jack Cunningham")
        json.dumps(result)


if __name__ == "__main__":
    unittest.main()
