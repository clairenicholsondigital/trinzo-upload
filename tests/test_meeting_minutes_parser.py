import json
import unittest
from pathlib import Path

from scripts.python_llm import analyse as analyse_project
from scripts.python_llm_meeting_minutes import analyse, parse_speaker_turns

FIXTURE = Path(__file__).parent / "fixtures" / "meeting_minutes_timestamped_transcript.txt"


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
        self.assertEqual(result["participants.client"], ["Ciara Griffin"])
        self.assertEqual(result["participants.trinzo"], ["Conor Flynn", "Jack Cunningham"])
        self.assertEqual(result["itemTopic"], "Webinar rehearsal and presentation review")
        self.assertEqual(len(result["discussionPoints"]), 5)
        self.assertEqual(len(result["meetingActionPoint"]), 3)
        self.assertEqual(result["meetingActionPointOwner"][0], "Ciara Griffin")
        self.assertEqual(result["meetingActionPointDeadline"][0], "by Friday")
        self.assertEqual(result["meetingActionPointDeadline"][1], "Before the webinar")
        self.assertEqual(result["meetingActionPointDeadline"][2], "Before next week")
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
