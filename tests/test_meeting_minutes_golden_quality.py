import sys
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from run_meeting_minutes_final_golden_eval import universal_quality_failures


class MeetingMinutesGoldenQualityTest(unittest.TestCase):
    def test_bad_pdf_style_transcript_leakage_is_flagged(self):
        output = {
            "meetingTitle": "Client DITA T819 Importer Obligations review plan",
            "meetingObjectives": [
                "You've got a really robust process which Disa understands and is bought into and can use and is lined up to the existing processes",
                "But also to understand the final resting place",
            ],
            "discussionPoints": [
                "There's different levels and there will be, because you've got Master UDI involved as well, basically what they do is they put the basic UDI in So there'll be the basic UDI numbers go in there.",
                "May be in trouble then obviously remains in progress because it's very important we have that input from you, i guess, from the team there on how your business works again.",
            ],
            "actions": [
                {
                    "meetingActionPoint": "Call, you know, calling it out or trying to understand how that's happening to ensure, I suppose, that it just doesn't get dropped or missed or forgotten or whatever it is, because people think that somebody else is doing it.",
                    "meetingActionPointOwner": "Owner not specified",
                    "meetingActionPointDeadline": "",
                }
            ],
        }

        failures = universal_quality_failures(output)
        failure_blob = "\n".join(failures)

        self.assertIn("second-person transcript wording", failure_blob)
        self.assertIn("conversational leakage present 'basically'", failure_blob)
        self.assertIn("conversational leakage present 'i guess'", failure_blob)
        self.assertIn("conversational leakage present 'i suppose'", failure_blob)
        self.assertIn("conversational leakage present 'you know'", failure_blob)
        self.assertIn("action item is too long/unclear", failure_blob)


if __name__ == "__main__":
    unittest.main()
