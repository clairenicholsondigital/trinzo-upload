import json
import unittest
from pathlib import Path

from scripts.python_llm_meeting_minutes import analyse, parse_speaker_turns

FIXTURE = Path(__file__).parent / "fixtures" / "meeting_minutes_timestamped_transcript.txt"


class MeetingMinutesParserTest(unittest.TestCase):
    def setUp(self):
        self.transcript = FIXTURE.read_text(encoding="utf-8")

    def test_timestamped_turns_are_parsed_without_raw_labels(self):
        turns = parse_speaker_turns(self.transcript)

        self.assertEqual(
            [turn.to_json() for turn in turns[:3]],
            [
                {
                    "speaker": "Jack Cunningham",
                    "timestamp": "0:03",
                    "text": "And then what we want to do is work through the workshop plan, because the validation team need a clear view of what happens before the webinar.",
                },
                {
                    "speaker": "Conor Flynn",
                    "timestamp": "17:42",
                    "text": "And I think the main issue is making sure the timeline is clear and everyone understands the scope.",
                },
                {
                    "speaker": "Ciara Griffin",
                    "timestamp": "0:03",
                    "text": "No, that's fine. I will update the slide deck by Friday and send it to Jack.",
                },
            ],
        )

    def test_meeting_minutes_are_cleaner_than_raw_transcript(self):
        result = analyse(self.transcript)

        self.assertEqual(result["meetingTitle"], "Webinar practice transcript")
        self.assertEqual(result["meetingDate"], "May 20, 2026")
        self.assertEqual(result["meetingLocation"], "Teams")
        self.assertEqual(
            result["participants"]["unknown"],
            ["Jack Cunningham", "Conor Flynn", "Ciara Griffin"],
        )

        discussion_points = result["meetingItems"][0]["discussionPoints"]
        self.assertTrue(discussion_points)
        self.assertFalse(any("0:03" in point or "17:42" in point for point in discussion_points))
        self.assertFalse(any(point.startswith("Jack Cunningham") for point in discussion_points))
        self.assertLessEqual(max(len(point.split()) for point in discussion_points), 28)

        next_steps = result["nextSteps"]
        self.assertEqual(len(next_steps), 3)
        self.assertEqual(next_steps[0]["meetingActionPointOwner"], "Ciara Griffin")
        self.assertEqual(next_steps[0]["meetingActionPointDeadline"], "by Friday")
        self.assertEqual(next_steps[1]["meetingActionPointOwner"], "Conor Flynn")
        self.assertEqual(next_steps[1]["meetingActionPointDeadline"], "before the webinar")
        self.assertEqual(next_steps[2]["meetingActionPointOwner"], "")
        self.assertEqual(next_steps[2]["meetingActionPointDeadline"], "next week")
        self.assertFalse(any("working through the workshop" in item["meetingActionPoint"].lower() for item in next_steps))

        # The endpoint returns JSON, so keep the analyser output serialisable.
        json.dumps(result)


if __name__ == "__main__":
    unittest.main()
