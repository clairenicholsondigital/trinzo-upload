import json
import unittest
from pathlib import Path

from scripts.python_meeting_minutes_numbers import analyse


FIXTURE = Path(__file__).parent / "fixtures" / "meeting_minutes_timestamped_transcript.txt"
PROJECT_FIXTURE = Path(__file__).parent / "fixtures" / "project_update_june_2_2026.txt"


class MeetingMinutesNumbersTest(unittest.TestCase):
    def test_low_content_fallback(self):
        transcript = """Random notes

6 June 2026

Alice:
Bananas.

Bob:
Apples.

Alice:
Oranges.

Bob:
Meeting over.
"""

        result = analyse(transcript)

        self.assertEqual(result["discussionPoints"], [])
        self.assertEqual(result["decisions"], [])
        self.assertEqual(result["meetingActionPoint"], [])
        self.assertEqual(result["executiveSummary"], "No substantive meeting content, decisions, or actions were identified.")
        self.assertIn("numberExperimentDebug", result)

    def test_validation_specific_vs_broad_decision(self):
        transcript = """Validation webinar review

6 June 2026

Jack:
Let's make this validation-specific.

Conor:
Agreed.

Ciara:
Actually, let's keep it broad.

Conor:
Yeah, that's better.
"""

        result = analyse(transcript)

        self.assertIn("The webinar should remain broad rather than validation-specific.", result["decisions"])

    def test_webinar_stress_test_extracts_actions(self):
        transcript = """Webinar Rehearsal Stress Test

6 June 2026

Jack Cunningham:
The demo intro needs a clearer spoken setup.

Conor Flynn:
I'll improve that as well.

Actions before the webinar:
Check the client attendee list.
Run one more practice round.
"""

        result = analyse(transcript)

        self.assertIn("Improve the demo intro spoken setup.", result["meetingActionPoint"])
        self.assertIn("Check the client attendee list.", result["meetingActionPoint"])

    def test_office_relocation_discussion_and_decision(self):
        transcript = """Office relocation planning

6 June 2026

Emma:
The physical office move will take place on 10 September.

David:
Agreed.

Emma:
We haven't decided whether to replace the meeting room video systems.
"""

        result = analyse(transcript)

        self.assertIn("The physical office move will take place on 10 September.", result["decisions"])
        self.assertTrue(any("office move timeline" in point.lower() or "meeting room video systems" in point.lower() for point in result["discussionPoints"]))

    def test_supplier_contract_renewal_outputs(self):
        transcript = """Customer support contract renewal

6 June 2026

Rachel:
The main item today is the customer support contract renewal.

Emma:
The existing supplier is still the safer option on service levels and response times.

David:
Agreed.

Rachel:
The supplier has proposed a three-year commitment.

Emma:
I'd rather accept the higher annual cost than lock ourselves in for three years.

David:
That's sensible.

Emma:
We'll pursue the one-year option.

Rachel:
Who is handling the supplier renewal negotiation?

David:
I can take that.

Emma:
Legal review will also be needed before signing.

David:
I'll speak with legal once the revised proposal arrives.

Rachel:
The finance team will need the final figures for next year's budget.

Emma:
Can you send those across when available?

David:
Yes.
"""

        result = analyse(transcript)

        self.assertIn("The team will renew with the existing supplier.", result["decisions"])
        self.assertIn("The team will pursue a one-year contract term rather than a three-year commitment.", result["decisions"])
        self.assertIn("Handle the supplier renewal negotiation.", result["meetingActionPoint"])
        self.assertIn("Speak with legal once the revised proposal arrives.", result["meetingActionPoint"])
        self.assertIn("Send final pricing figures to finance when available.", result["meetingActionPoint"])
        self.assertTrue(any("customer support contract renewal" in point.lower() for point in result["discussionPoints"]))
        self.assertNotIn("The supplier has proposed a three-year commitment.", result["decisions"])

    def test_daily_ai_check_in_fixture_runs_with_debug(self):
        transcript = PROJECT_FIXTURE.read_text(encoding="utf-8")
        result = analyse(transcript)

        self.assertTrue(result["meetingTitle"])
        self.assertIn("numberExperimentDebug", result)
        self.assertIsInstance(result["numberExperimentDebug"]["topDecisionCandidates"], list)
        json.dumps(result)

    def test_webinar_fixture_runs_with_debug(self):
        transcript = FIXTURE.read_text(encoding="utf-8")
        result = analyse(transcript)

        self.assertEqual(result["meetingTitle"], "Webinar practice transcript")
        self.assertIn("numberExperimentDebug", result)
        json.dumps(result)


if __name__ == "__main__":
    unittest.main()
