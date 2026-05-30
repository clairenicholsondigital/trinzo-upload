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

    def test_colon_style_turns_are_parsed_without_timestamps(self):
        transcript = """Weekly Delivery Review

5 June 2026

Ciara Griffin:
Okay, before we start, has everyone seen the customer feedback?

Tom Baker:
Some of it.

Jack Cunningham:
Most of it.

Conor Flynn:
Yeah.
"""

        turns = parse_speaker_turns(transcript)

        self.assertEqual(len(turns), 4)
        self.assertEqual(
            [(turn.speaker, turn.timestamp) for turn in turns],
            [
                ("Ciara Griffin", ""),
                ("Tom Baker", ""),
                ("Jack Cunningham", ""),
                ("Conor Flynn", ""),
            ],
        )
        self.assertTrue(turns[0].text.startswith("Okay, before we start"))

    def test_colon_style_meeting_preserves_unknown_participants_and_resolution_decisions(self):
        transcript = """Weekly Delivery Review

5 June 2026

Ciara Griffin:
Okay, before we start, has everyone seen the customer feedback?

Tom Baker:
Some of it.

Jack Cunningham:
Most of it.

Conor Flynn:
Yeah.

Ciara Griffin:
Right. So the biggest issue seems to be report export speed.

Tom Baker:
Although that's actually improved since Monday.

Jack Cunningham:
Correct. Average export time dropped from thirty seconds to twelve.

Ciara Griffin:
Good. So that's not really a blocker anymore.

Tom Baker:
The notifications bug is still causing confusion for clients.

Conor Flynn:
Agreed, that needs to stay as the main priority for next week.
"""

        result = analyse(transcript)

        self.assertCountEqual(result["participants.trinzo"], ["Ciara Griffin", "Jack Cunningham", "Conor Flynn"])
        self.assertEqual(result["participants.client"], ["Tom Baker"])
        self.assertIn("The previously raised issue was no longer considered a blocker.", result["decisions"])
        self.assertIn("That needs to stay as the main priority for next week.", result["decisions"])

    def test_general_meeting_keeps_named_actions_and_non_priority_decision(self):
        transcript = """Weekly Delivery Review

5 June 2026

Ciara Griffin:
Okay, before we start, has everyone seen the customer feedback?

Tom Baker:
Some of it.

Jack Cunningham:
Most of it.

Conor Flynn:
Yeah.

Ciara Griffin:
Right. So the biggest issue seems to be report export speed.

Tom Baker:
Although that's actually improved since Monday.

Jack Cunningham:
Correct. Average export time dropped from thirty seconds to twelve.

Ciara Griffin:
Good. So that's not really a blocker anymore.

Tom Baker:
The notification emails are still failing occasionally.

Conor Flynn:
Only for a handful of users.

Jack Cunningham:
Do we know why?

Tom Baker:
Not yet.

Ciara Griffin:
Okay. We need an investigation there.

Conor Flynn:
I can look into it.

Tom Baker:
There was also a suggestion around custom branding.

Jack Cunningham:
That came from one customer.

Ciara Griffin:
Let's not prioritise that yet.

Tom Baker:
Agreed.

Conor Flynn:
By the way, I still haven't finished the reporting API documentation.

Jack Cunningham:
That's been hanging around for a while.

Conor Flynn:
I know.

Ciara Griffin:
When can it be done?

Conor Flynn:
Friday.

Jack Cunningham:
Provided nobody changes the API again.

(Laughter)

Tom Baker:
No promises.

Ciara Griffin:
Fine. Let's capture actions. Conor to investigate notification email failures. Conor to complete API documentation by Friday.

Tom Baker:
Should we also add custom branding?

Ciara Griffin:
No, discussion only. No action for that.
"""

        result = analyse(transcript)

        self.assertEqual(result["meetingType"], "general_meeting")
        self.assertEqual(result["participants.client"], ["Tom Baker"])
        self.assertCountEqual(result["participants.trinzo"], ["Ciara Griffin", "Jack Cunningham", "Conor Flynn"])
        self.assertEqual(
            result["meetingActionPoint"][:2],
            [
                "Investigate notification email failures.",
                "Complete API documentation by Friday.",
            ],
        )
        self.assertEqual(result["meetingActionPointOwner"][:2], ["Conor Flynn", "Conor Flynn"])
        self.assertEqual(result["meetingActionPointDeadline"][:2], ["", "by Friday"])
        self.assertIn("Let's not prioritise that yet.", result["decisions"])
        self.assertNotIn("Let's capture actions.", result["decisions"])
        self.assertGreaterEqual(len(result["discussionPoints"]), 3)
        self.assertIn("notification email", " ".join(result["discussionPoints"]).lower())
        self.assertIn("custom branding", " ".join(result["discussionPoints"]).lower())
        self.assertIn("api documentation", result["executiveSummary"].lower())

    def test_meeting_minutes_use_the_flat_skill_style_output(self):
        result = analyse(self.transcript)

        self.assertEqual(result["meetingTitle"], "Webinar practice transcript")
        self.assertEqual(result["meetingDate"], "20 May 2026")
        self.assertEqual(result["meetingLocation"], "Teams")
        self.assertEqual(result["meetingType"], "webinar_rehearsal")
        self.assertEqual(result["meetingStyle"], "feedback_review")
        self.assertEqual(result["meetingTheme"], "Webinar rehearsal and presentation review")
        self.assertEqual(result["participants.client"], [])
        self.assertEqual(result["participants.trinzo"], ["Ciara Griffin", "Conor Flynn", "Jack Cunningham"])
        self.assertEqual(result["itemTopic"], "Webinar rehearsal and presentation review")
        self.assertEqual(
            result["meetingObjectives"],
            ["Review the webinar flow, confirm presentation readiness, and agree final preparation actions."],
        )
        self.assertEqual(len(result["discussionPoints"]), 5)
        self.assertIn("workshop plan", result["discussionPoints"][0].lower())
        self.assertIn("registration list", result["discussionPoints"][3].lower())
        self.assertIn("process questions", result["discussionPoints"][4].lower())
        self.assertTrue(all("Agreed RAG status:" not in point for point in result["discussionPoints"]))
        self.assertEqual(len(result["meetingActionPoint"]), 3)
        self.assertEqual(result["meetingActionPoint"][0], "Update the slide deck by Friday and send it to Jack.")
        self.assertEqual(result["meetingActionPoint"][1], "Check the registration list before the webinar.")
        self.assertEqual(result["meetingActionPoint"][2], "Confirm the client attendee list next week.")
        self.assertEqual(result["meetingActionPointOwner"][0], "Ciara Griffin")
        self.assertEqual(result["meetingActionPointDeadline"][0], "by Friday")
        self.assertEqual(result["meetingActionPointDeadline"][1], "Before the webinar")
        self.assertEqual(result["meetingActionPointOwner"][2], "Owner not specified")
        self.assertEqual(result["meetingActionPointDeadline"][2], "Before next week")
        self.assertEqual(result["meetingActionPointConfidence"][0], 0.8)
        self.assertEqual(result["meetingActionPointConfidence"][1], 0.85)
        self.assertEqual(result["meetingActionPointConfidence"][2], 0.2)
        self.assertTrue(
            all(
                owner == "Owner not specified" or confidence >= 0.55
                for owner, confidence in zip(result["meetingActionPointOwner"], result["meetingActionPointConfidence"])
            )
        )
        self.assertEqual(result["meetingActionPointRelatedMilestone"], ["unlinked", "unlinked", "unlinked"])
        self.assertEqual(result["healthSummary"], {})
        self.assertEqual(len(result["meetingSections"]), 5)
        self.assertEqual(result["meetingSections"][0]["section"], "Webinar flow")
        self.assertEqual(len(result["decisions"]), 1)
        self.assertEqual(result["decisions"][0], "The webinar should explain the timeline and scope more clearly.")
        self.assertEqual(result["discussionPointDetails"][0]["_evidence"][0]["speaker"], "Jack Cunningham")
        self.assertEqual(result["discussionPointDetails"][0]["evidenceScore"], 0.75)
        self.assertEqual(result["actions"][0]["_evidence"][0]["speaker"], "Ciara Griffin")
        self.assertEqual(result["meetingSections"][0]["_evidence"][0]["speaker"], "Jack Cunningham")
        self.assertEqual(result["internalEvidence"]["actions"][1]["text"], "Check the registration list before the webinar.")
        self.assertEqual(result["internalEvidence"]["decisions"][0]["_evidence"][0]["speaker"], "Conor Flynn")
        self.assertGreaterEqual(result["decisionDetails"][0]["decisionConfidence"], 0.6)
        self.assertEqual(result["decisionDetails"][0]["decisionType"], "accepted_direction")
        self.assertGreaterEqual(len([s for s in result["executiveSummary"].split(". ") if s.strip()]), 4)
        self.assertIn("workshop plan", result["executiveSummary"].lower())
        self.assertIn("key decisions included", result["executiveSummary"].lower())
        self.assertTrue("executiveSummary" in result)
        json.dumps(result)

    def test_decisions_use_later_turn_overrides_for_same_topic(self):
        transcript = """Webinar practice transcript
Date: May 20, 2026
Location: Teams
Jack Cunningham   0:03I think we could keep it broad at the start.
Conor Flynn   0:40No, let's make it specific to the validation team before the webinar.
Ciara Griffin 1:10Agreed, let's keep it educational rather than salesy.
Jack Cunningham   1:42We should explain the timeline and scope more clearly.
"""

        result = analyse(transcript)

        self.assertIn("The webinar should be framed specifically for the validation team.", result["decisions"])
        self.assertNotIn("The webinar should stay broad rather than targeting one audience too early.", result["decisions"])
        self.assertIn("The webinar should remain educational rather than sounding sales-led.", result["decisions"])
        self.assertIn("The webinar should explain the timeline and scope more clearly.", result["decisions"])
        self.assertTrue(all(detail["decisionConfidence"] >= 0.6 for detail in result["decisionDetails"]))
        self.assertIn(
            result["decisionDetails"][0]["decisionType"],
            {"accepted_direction", "approved_change", "rejected_option"},
        )

    def test_questions_and_descriptions_are_not_extracted_as_decisions(self):
        transcript = """Webinar practice transcript
Date: May 20, 2026
Location: Teams
Jack Cunningham   0:03Should I pretend to be good?
Conor Flynn   0:20What we want to do is work through the workshop plan.
Ciara Griffin 0:42We're working through the workshop material and the risk is that people may ask detailed process questions.
Jack Cunningham   1:10Agreed, let's keep the session educational rather than sales-led.
"""

        result = analyse(transcript)

        self.assertEqual(
            result["decisions"],
            ["The webinar should remain educational rather than sounding sales-led."],
        )

    def test_project_minutes_are_derived_from_milestone_output(self):
        project_transcript = PROJECT_FIXTURE.read_text(encoding="utf-8")
        result = analyse(project_transcript)

        self.assertEqual(result["meetingType"], "project_status_review")
        self.assertEqual(result["meetingStyle"], "status_review")
        self.assertEqual(result["meetingTheme"], "AI delivery and governance review")
        self.assertEqual(result["meetingTitle"], "AI delivery and governance review")
        self.assertEqual(
            result["meetingObjectives"],
            ["Review programme milestones, confirm status updates, identify blockers, and agree actions before the next review cycle."],
        )
        self.assertEqual(result["itemTopic"], "AI delivery and governance review")
        self.assertEqual(result["participants.client"], [])
        self.assertEqual(result["participants.trinzo"], ["Ciara Griffin", "Conor Flynn"])
        self.assertEqual(len(result["discussionPoints"]), 10)
        self.assertEqual(
            result["discussionPoints"][2],
            "Stage gate review process remains in progress. Two reviews have already been completed through the process, but the templates have not yet been finalised. Agreed RAG status: green.",
        )
        self.assertEqual(
            result["discussionPoints"][3],
            "AI pipeline strategy remains blocked, although the team agreed an amber status pending further review. Sales input is still required before work can progress. Agreed RAG status: amber.",
        )
        self.assertEqual(
            result["discussionPoints"][4],
            "AI webinars remain in progress. Two webinars have been delivered and the third webinar is booked. Agreed RAG status: green.",
        )
        self.assertEqual(
            result["discussionPoints"][6],
            "Ad hoc Statement of Work (SOW) delivery remains in progress. One request is scheduled, one is underway, and one has not yet been scoped. Clearer visibility on workload is still needed. Agreed RAG status: green.",
        )
        self.assertEqual(
            result["discussionPoints"][7],
            "Vendor strategy rollout remains in progress and requires attention. The research interviews are complete, but the strategy document has not yet been produced. Agreed RAG status: amber.",
        )
        self.assertEqual(result["meetingActionPointRelatedMilestone"][0], "stage_gate_internal_review")
        self.assertEqual(result["meetingActionPointRelatedMilestone"][1], "ai_pipeline_strategy")
        self.assertEqual(result["meetingActionPointRelatedMilestone"][2], "stage_gate_vendor_strategy")
        self.assertEqual(result["meetingActionPointRelatedMilestone"][3], "ei_grant_feedback")
        self.assertEqual(result["meetingActionPointOwner"][3], "Emma")
        self.assertEqual(result["meetingActionPointConfidence"][3], 0.85)
        self.assertEqual(result["actions"][3]["_evidence"][0]["speaker"], "Ciara Griffin")
        self.assertEqual(result["healthSummary"]["blue"], 1)
        self.assertEqual(result["healthSummary"]["blocked"], 1)
        self.assertEqual(result["healthSummary"]["in_review"], 1)
        self.assertIn("AI pipeline strategy remains blocked pending further input.", result["executiveSummary"])
        self.assertIn(
            "Use case intake funnel, Vendor strategy rollout, and Innovation grant feedback remain active workstreams requiring further attention.",
            result["executiveSummary"],
        )
        self.assertNotIn("Three AI webinars delivered. Not complete.", " ".join(result["discussionPoints"]))
        self.assertEqual(result["meetingSections"], [])
        self.assertEqual(result["decisions"], [])
        json.dumps(result)

    def test_glossary_expands_known_abbreviations_in_minutes_output(self):
        project_transcript = PROJECT_FIXTURE.read_text(encoding="utf-8")
        result = analyse(project_transcript)

        self.assertIn("Statement of Work (SOW)", " ".join(result["discussionPoints"]))

    def test_project_analyser_handles_inline_turn_transcripts(self):
        result = analyse_project(self.transcript)

        self.assertEqual(result["turn_count_raw"], 6)
        self.assertEqual(result["turn_count_cleaned"], 6)
        self.assertTrue(result["cleaned_turns"])
        self.assertEqual(result["cleaned_turns"][0]["speaker"], "Jack Cunningham")
        json.dumps(result)


if __name__ == "__main__":
    unittest.main()
