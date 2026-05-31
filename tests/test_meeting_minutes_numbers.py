import json
import unittest
from pathlib import Path

from scripts.python_meeting_minutes_numbers import analyse, clean_transcript_text, parse_numeric_turns


FIXTURE = Path(__file__).parent / "fixtures" / "meeting_minutes_timestamped_transcript.txt"
PROJECT_FIXTURE = Path(__file__).parent / "fixtures" / "project_update_june_2_2026.txt"


class MeetingMinutesNumbersTest(unittest.TestCase):
    def test_metadata_lines_are_removed_before_turn_parsing(self):
        transcript = """Daily AI Check In-20260602_150011-Meeting Transcript
2 June 2026, 3:00pm
4m 42s
Ciara Griffin started transcription
Ciara Griffin 0:03
Right, let's run through the AI programme items quickly.
Conor Flynn 0:15
Yeah, agreed.
Ciara Griffin stopped transcription.
"""

        cleaned = clean_transcript_text(transcript)
        turns = parse_numeric_turns(transcript)

        self.assertNotIn("started transcription", cleaned.lower())
        self.assertNotIn("stopped transcription", cleaned.lower())
        self.assertEqual([turn["speaker"] for turn in turns], ["Ciara Griffin", "Conor Flynn"])

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
        self.assertTrue(result["numberExperimentDebug"]["topicClusters"])

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
        self.assertTrue(
            any(
                "supplier" in " ".join(cluster["keywords"])
                or "renewal" in " ".join(cluster["keywords"])
                for cluster in result["numberExperimentDebug"]["topicClusters"]
            )
        )

    def test_daily_ai_check_in_fixture_runs_with_debug(self):
        transcript = PROJECT_FIXTURE.read_text(encoding="utf-8")
        result = analyse(transcript)

        self.assertTrue(result["meetingTitle"])
        self.assertIn("numberExperimentDebug", result)
        self.assertIsInstance(result["numberExperimentDebug"]["topDecisionCandidates"], list)
        self.assertIsInstance(result["numberExperimentDebug"]["topicClusters"], list)
        self.assertIsInstance(result["numberExperimentDebug"]["rejectedNavigationCandidates"], list)
        self.assertNotIn("2 June 2026,", result["participants.client"])
        self.assertFalse(any("pm 4m 42s" in point for point in result["discussionPoints"]))
        self.assertFalse(any("right, let's run through" in point.lower() for point in result["discussionPoints"]))
        self.assertFalse(any("request funnel?" in point.lower() for point in result["discussionPoints"]))
        self.assertFalse(any(point.lower().startswith("yeah she said") for point in result["discussionPoints"]))
        self.assertFalse(any("presentation clarity" in point.lower() for point in result["discussionPoints"]))
        self.assertFalse(any(point.lower().startswith(("the no", "the yes", "the it", "the that", "the this", "the okay", "the true", "the fine", "the probably", "the maybe")) for point in result["discussionPoints"]))
        self.assertGreaterEqual(len(result["discussionPoints"]), 3)
        self.assertLessEqual(len(result["discussionPoints"]), 10)
        self.assertTrue(
            any(
                any(term in point.lower() for term in ("remains", "blocked", "in review", "active", "complete"))
                for point in result["discussionPoints"]
            )
        )
        self.assertIn("Vendor strategy rollout remains in progress: interviews are complete, but the strategy document has not yet been produced.", result["discussionPoints"])
        self.assertIn("Innovation grant feedback is still pending, with follow-up planned this week.", result["discussionPoints"])
        self.assertIn("Review stage gate templates.", result["meetingActionPoint"])
        self.assertIn("Confirm AI pipeline dependencies with sales.", result["meetingActionPoint"])
        action_map = {item["meetingActionPoint"]: item for item in result["actions"]}
        self.assertTrue(action_map["Review stage gate templates."]["_evidence"])
        self.assertEqual(action_map["Review stage gate templates."]["_evidence"][0]["speaker"], "Ciara Griffin")
        self.assertEqual(action_map["Review stage gate templates."]["_evidence"][0]["timestamp"], "3:42")
        used_clusters = [cluster for cluster in result["numberExperimentDebug"]["topicClusters"] if cluster["usedInDiscussionPoints"]]
        self.assertTrue(all(cluster["selectedDiscussionPoint"] for cluster in used_clusters))
        self.assertGreaterEqual(len({cluster["selectedDiscussionPoint"] for cluster in used_clusters}), 3)
        self.assertIn("finalDiscussionPoints", result["numberExperimentDebug"])
        self.assertTrue(any(item["sourceType"] == "statusReviewPoint" for item in result["numberExperimentDebug"]["finalDiscussionPoints"]))
        self.assertIn("pending innovation grant feedback", result["executiveSummary"].lower())
        json.dumps(result)

    def test_webinar_fixture_runs_with_debug(self):
        transcript = FIXTURE.read_text(encoding="utf-8")
        result = analyse(transcript)

        self.assertEqual(result["meetingTitle"], "Webinar practice transcript")
        self.assertIn("numberExperimentDebug", result)
        json.dumps(result)

    def test_navigation_only_content_does_not_become_output(self):
        transcript = """Planning check-in

6 June 2026

Ciara Griffin:
Right, let's run through the agenda.

Conor Flynn:
Go ahead.

Ciara Griffin:
Okay, next.

Conor Flynn:
Anything else?

Ciara Griffin:
Thanks everyone.
"""

        result = analyse(transcript)

        self.assertEqual(result["discussionPoints"], [])
        self.assertEqual(result["decisions"], [])
        self.assertEqual(result["meetingActionPoint"], [])
        self.assertEqual(result["executiveSummary"], "No substantive meeting content, decisions, or actions were identified.")


if __name__ == "__main__":
    unittest.main()
