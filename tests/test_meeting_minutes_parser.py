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

    def test_action_block_headings_are_not_treated_as_speakers(self):
        transcript = """Weekly Delivery Review

5 June 2026

Ciara Griffin:
We need to tidy the final webinar prep.

Actions before the webinar:
Update the opening slide.
Check the attendee list.

Tom Baker:
Fine.
"""

        turns = parse_speaker_turns(transcript)

        self.assertEqual([turn.speaker for turn in turns], ["Ciara Griffin", "Tom Baker"])

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

    def test_action_block_before_webinar_extracts_actions_until_next_speaker_turn(self):
        transcript = """Webinar prep

6 June 2026

Ciara Griffin:
We are nearly there.

Actions before the webinar:
Update the opening slide.
Check the attendee list.

Tom Baker:
Thanks.
"""

        result = analyse(transcript)

        self.assertEqual(
            result["meetingActionPoint"][:2],
            ["Update the opening slide.", "Check the attendee list."],
        )
        self.assertEqual(result["meetingActionPointDeadline"][:2], ["Before the webinar", "Before the webinar"])
        self.assertNotIn("Actions before the webinar", result["participants.client"] + result["participants.trinzo"])

    def test_plain_actions_block_extracts_actions_without_heading_deadline(self):
        transcript = """Working session

6 June 2026

Actions:
Share the revised notes.
Prepare the follow-up email.
"""

        result = analyse(transcript)

        self.assertEqual(
            result["meetingActionPoint"][:2],
            ["Share the revised notes.", "Prepare the follow-up email."],
        )
        self.assertEqual(result["meetingActionPointDeadline"][:2], ["", ""])

    def test_next_steps_and_follow_ups_headings_are_not_treated_as_speakers(self):
        transcript = """Supplier meeting

6 June 2026

Rachel:
We need to close the renewal.

Next steps:
Review the revised contract.

Follow ups:
Send final pricing figures to finance.

David:
Fine.
"""

        turns = parse_speaker_turns(transcript)

        self.assertEqual([turn.speaker for turn in turns], ["Rachel", "David"])

        result = analyse(transcript)
        self.assertIn("Review the revised contract.", result["meetingActionPoint"])
        self.assertIn("Send final pricing figures to finance.", result["meetingActionPoint"])

    def test_action_only_text_does_not_create_duplicate_governance_discussion(self):
        transcript = """Daily AI Check In

6 June 2026

Ciara Griffin:
The intake workflow is still in progress.

Actions before next week:
Prepare governance framework for leadership review.
"""

        result = analyse(transcript)

        self.assertIn("Prepare governance framework for leadership review.", result["meetingActionPoint"])
        self.assertNotIn("governance framework", " ".join(result["discussionPoints"]).lower())

    def test_request_and_volunteer_turns_link_into_actions(self):
        transcript = """Creative review

6 June 2026

Ciara Griffin:
Can somebody update the opening image?

Emily Stone:
Yep, I'll do that.

Jack Cunningham:
Can somebody also shorten the deck?

Conor Flynn:
I'll work with Jack on that.

Ciara Griffin:
Perfect.
"""

        result = analyse(transcript)

        self.assertEqual(result["meetingType"], "general_meeting")
        self.assertIn("Update the opening image.", result["meetingActionPoint"])
        self.assertIn("Work with Jack to shorten the deck.", result["meetingActionPoint"])
        opening_index = result["meetingActionPoint"].index("Update the opening image.")
        deck_index = result["meetingActionPoint"].index("Work with Jack to shorten the deck.")
        self.assertEqual(result["meetingActionPointOwner"][opening_index], "Emily Stone")
        self.assertEqual(result["meetingActionPointOwner"][deck_index], "Conor Flynn")

    def test_can_you_request_is_owned_by_accepting_speaker_with_deadline(self):
        transcript = """Working session

6 June 2026

Jack Cunningham:
Can you update the API documentation?

Ciara Griffin:
Yes, I'll do that tomorrow.
"""

        result = analyse(transcript)

        self.assertIn("Update the API documentation.", result["meetingActionPoint"])
        index = result["meetingActionPoint"].index("Update the API documentation.")
        self.assertEqual(result["meetingActionPointOwner"][index], "Ciara Griffin")
        self.assertEqual(result["meetingActionPointDeadline"][index], "Tomorrow")

    def test_ill_do_both_resolves_recent_requests_from_same_requester(self):
        transcript = """Working session

6 June 2026

Jack Cunningham:
Can you review the templates?

Ciara Griffin:
Yes.

Jack Cunningham:
Can you also check the routing issue?

Ciara Griffin:
I'll do both this afternoon.
"""

        result = analyse(transcript)

        self.assertIn("Review the templates.", result["meetingActionPoint"])
        self.assertIn("Check the routing issue.", result["meetingActionPoint"])
        review_index = result["meetingActionPoint"].index("Review the templates.")
        routing_index = result["meetingActionPoint"].index("Check the routing issue.")
        self.assertEqual(result["meetingActionPointOwner"][review_index], "Ciara Griffin")
        self.assertEqual(result["meetingActionPointOwner"][routing_index], "Ciara Griffin")
        self.assertEqual(result["meetingActionPointDeadline"][review_index], "This afternoon")
        self.assertEqual(result["meetingActionPointDeadline"][routing_index], "This afternoon")

    def test_rejection_does_not_create_conversational_action(self):
        transcript = """Working session

6 June 2026

Jack Cunningham:
Can you check the routing issue?

Ciara Griffin:
I can't do that before Friday.
"""

        result = analyse(transcript)

        self.assertEqual(result["meetingActionPoint"], [])

    def test_refusal_then_later_acceptance_still_creates_action(self):
        transcript = """Working session

6 June 2026

Jack Cunningham:
Can you update the API documentation?

Ciara Griffin:
I won't have time before Friday.

Conor Flynn:
I will.
"""

        result = analyse(transcript)

        self.assertIn("Update the API documentation.", result["meetingActionPoint"])
        index = result["meetingActionPoint"].index("Update the API documentation.")
        self.assertEqual(result["meetingActionPointOwner"][index], "Conor Flynn")
        self.assertEqual(result["meetingActionPointDeadline"][index], "")
        evidence = result["internalEvidence"]["actions"][index]["_evidence"]
        self.assertGreaterEqual(len(evidence), 3)
        self.assertEqual(evidence[0]["speaker"], "Jack Cunningham")
        self.assertTrue(any(item["speaker"] == "Ciara Griffin" for item in evidence))
        self.assertTrue(any(item["speaker"] == "Conor Flynn" for item in evidence))

    def test_contextual_commitment_resolves_recent_problem_statement(self):
        transcript = """Working session

6 June 2026

Jack Cunningham:
The opening explanation isn't clear.

Ciara Griffin:
I'll think that through before tomorrow.
"""

        result = analyse(transcript)

        self.assertIn("Refine the opening explanation.", result["meetingActionPoint"])
        index = result["meetingActionPoint"].index("Refine the opening explanation.")
        self.assertEqual(result["meetingActionPointOwner"][index], "Ciara Griffin")
        self.assertEqual(result["meetingActionPointDeadline"][index], "Tomorrow")

    def test_contextual_commitment_clarifies_recent_confusing_point(self):
        transcript = """Working session

6 June 2026

Jack Cunningham:
The timeline slide is confusing.

Ciara Griffin:
I'll tighten that up.
"""

        result = analyse(transcript)

        self.assertIn("Clarify the timeline slide.", result["meetingActionPoint"])
        index = result["meetingActionPoint"].index("Clarify the timeline slide.")
        self.assertEqual(result["meetingActionPointOwner"][index], "Ciara Griffin")

    def test_contextual_commitment_without_prior_context_does_not_create_vague_action(self):
        transcript = """Working session

6 June 2026

Ciara Griffin:
I'll improve that.
"""

        result = analyse(transcript)

        self.assertEqual(result["meetingActionPoint"], [])

    def test_action_request_does_not_pollute_discussion_points_or_summary(self):
        transcript = """Working session

6 June 2026

Jack Cunningham:
Can you update the attendee list?

Conor Flynn:
Yes, I'll do that.
"""

        result = analyse(transcript)

        self.assertIn("Update the attendee list.", result["meetingActionPoint"])
        index = result["meetingActionPoint"].index("Update the attendee list.")
        self.assertEqual(result["meetingActionPointOwner"][index], "Conor Flynn")
        self.assertEqual(result["discussionPoints"], [])
        self.assertNotIn("can you update the attendee list", result["executiveSummary"].lower())

    def test_deadline_word_does_not_create_synthetic_discussion_point(self):
        transcript = """Working session

6 June 2026

Jack Cunningham:
The explanation isn't clear.

Ciara Griffin:
I'll think that through before Friday.
"""

        result = analyse(transcript)

        self.assertEqual(result["discussionPoints"], ["The explanation isn't clear."])
        self.assertNotIn("api documentation", " ".join(result["discussionPoints"]).lower())
        self.assertNotIn("api documentation", result["executiveSummary"].lower())

    def test_contextual_commitment_resolves_rushed_section_into_action(self):
        transcript = """Validation slides review

6 June 2026

Jack Cunningham:
The closing section feels rushed.

Ciara Griffin:
I'll improve that.
"""

        result = analyse(transcript)

        self.assertEqual(result["meetingType"], "presentation_review")
        self.assertIn("Improve the closing section.", result["meetingActionPoint"])
        index = result["meetingActionPoint"].index("Improve the closing section.")
        self.assertEqual(result["meetingActionPointOwner"][index], "Ciara Griffin")

    def test_tiny_transcript_uses_title_hints_for_meeting_type(self):
        transcript = """Validation webinar review

6 June 2026

Jack Cunningham:
Let's keep it broad.

Conor Flynn:
Agreed.
"""

        result = analyse(transcript)

        self.assertEqual(result["meetingType"], "webinar_rehearsal")

    def test_request_and_short_volunteer_reply_link_into_actions(self):
        transcript = """General check-in

6 June 2026

Ciara Griffin:
Can someone update that?

Emily Stone:
I'll do it.
"""

        result = analyse(transcript)

        self.assertEqual(result["meetingType"], "general_meeting")
        self.assertEqual(result["meetingActionPoint"], [])
        self.assertEqual(result["meetingActionPointOwner"], [])

    def test_generic_supplier_meeting_extracts_decisions_actions_and_discussion(self):
        transcript = """Supplier renewal meeting

6 June 2026

Rachel:
The team will renew with the existing supplier.

David:
Agreed.

Rachel:
The team will pursue a one-year contract rather than a three-year commitment.

Emma:
Sounds good.

Rachel:
Who is handling the supplier renewal negotiation?

David:
I can take that.

Emma:
Legal review will also be needed before signing.

David:
I'll speak with legal once the revised proposal arrives.

Emma:
Can you send final pricing figures to finance when available?

David:
Yes.
"""

        result = analyse(transcript)

        self.assertIn("The team will renew with the existing supplier.", result["decisions"])
        self.assertIn(
            "The team will pursue a one-year contract rather than a three-year commitment.",
            result["decisions"],
        )
        self.assertTrue(any("commercial options" in point.lower() or "supplier" in point.lower() for point in result["discussionPoints"]))
        self.assertIn("Handle the supplier renewal negotiation.", result["meetingActionPoint"])
        self.assertIn("Speak with legal once the revised proposal arrives.", result["meetingActionPoint"])
        self.assertIn("Send final pricing figures to finance when available.", result["meetingActionPoint"])
        handle_index = result["meetingActionPoint"].index("Handle the supplier renewal negotiation.")
        self.assertEqual(result["meetingActionPointOwner"][handle_index], "David")

    def test_generic_scheduling_decision_creates_substantive_discussion_point(self):
        transcript = """Office relocation planning

6 June 2026

Emma:
The physical office move will take place on 10 September.

David:
Agreed.

Emma:
We haven't decided whether to replace the meeting room video systems.

David:
That needs more discussion.
"""

        result = analyse(transcript)

        self.assertIn("The physical office move will take place on 10 September.", result["decisions"])
        self.assertTrue(any("timing" in point.lower() or "10 september" in point.lower() for point in result["discussionPoints"]))
        self.assertTrue(any("whether to replace the meeting room video systems" in point.lower() for point in result["discussionPoints"]))

    def test_sparse_generic_meeting_uses_clean_fallback_without_fake_content(self):
        transcript = """Quick catch-up

6 June 2026

Ciara Griffin:
Go on.

Jack Cunningham:
Not sure.

Ciara Griffin:
Anything else?

Jack Cunningham:
We'll come back to it.
"""

        result = analyse(transcript)

        self.assertEqual(result["discussionPoints"], [])
        self.assertEqual(result["meetingActionPoint"], [])
        self.assertEqual(result["decisions"], [])
        self.assertIn("did not contain enough substantive meeting content", result["executiveSummary"].lower())

    def test_action_quality_gate_rejects_transcript_fragments_and_jokes(self):
        transcript = """Creative review

6 June 2026

Ciara Griffin:
Can you do with this picture

Jack Cunningham:
Should I pretend to be good?

Conor Flynn:
I am a Kerry man

Emily Stone:
Take out this

Ciara Griffin:
Update the opening image for the deck.
"""

        result = analyse(transcript)

        self.assertIn("Update the opening image for the deck.", result["meetingActionPoint"])
        self.assertNotIn("Do with this picture.", result["meetingActionPoint"])
        self.assertNotIn("Take out this.", result["meetingActionPoint"])
        self.assertTrue(all("pretend" not in item.lower() for item in result["meetingActionPoint"]))
        self.assertTrue(all("kerry man" not in item.lower() for item in result["meetingActionPoint"]))

    def test_mine_is_resolved_to_the_speakers_own_item(self):
        transcript = """General check-in

6 June 2026

Ciara Griffin:
Can somebody update mine?

Emily Stone:
I'll do that.
"""

        result = analyse(transcript)

        self.assertEqual(result["meetingActionPoint"], ["Update Ciara's item."])
        self.assertEqual(result["meetingActionPointOwner"], ["Emily Stone"])

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
        self.assertEqual(len(result["meetingActionPoint"]), 2)
        self.assertEqual(result["meetingActionPoint"][0], "Update the slide deck by Friday and send it to Jack.")
        self.assertEqual(result["meetingActionPoint"][1], "Check the registration list before the webinar.")
        self.assertEqual(result["meetingActionPointOwner"][0], "Ciara Griffin")
        self.assertEqual(result["meetingActionPointDeadline"][0], "by Friday")
        self.assertEqual(result["meetingActionPointDeadline"][1], "Before the webinar")
        self.assertEqual(result["meetingActionPointConfidence"][0], 0.65)
        self.assertEqual(result["meetingActionPointConfidence"][1], 0.85)
        self.assertTrue(
            all(
                owner == "Owner not specified" or confidence >= 0.55
                for owner, confidence in zip(result["meetingActionPointOwner"], result["meetingActionPointConfidence"])
            )
        )
        self.assertEqual(result["meetingActionPointRelatedMilestone"], ["unlinked", "unlinked"])
        self.assertEqual(result["healthSummary"], {})
        self.assertEqual(len(result["meetingSections"]), 5)
        self.assertEqual(result["meetingSections"][0]["section"], "Webinar flow")
        self.assertEqual(len(result["decisions"]), 1)
        self.assertEqual(result["decisions"][0], "The webinar should explain the timeline and scope more clearly.")
        self.assertEqual(result["discussionPointDetails"][0]["_evidence"][0]["speaker"], "Jack Cunningham")
        self.assertEqual(result["discussionPointDetails"][0]["evidenceScore"], 0.6)
        self.assertEqual(result["actions"][0]["_evidence"][0]["speaker"], "Ciara Griffin")
        self.assertEqual(result["meetingSections"][0]["_evidence"][0]["speaker"], "Jack Cunningham")
        self.assertEqual(result["internalEvidence"]["actions"][1]["text"], "Check the registration list before the webinar.")
        self.assertEqual(result["internalEvidence"]["decisions"][0]["_evidence"][0]["speaker"], "Conor Flynn")
        self.assertGreaterEqual(result["decisionDetails"][0]["decisionConfidence"], 0.6)
        self.assertEqual(result["decisionDetails"][0]["decisionType"], "accepted_direction")
        self.assertGreaterEqual(len([s for s in result["executiveSummary"].split(". ") if s.strip()]), 3)
        self.assertIn("timeline and scope", result["executiveSummary"].lower())
        self.assertIn("actions focused on", result["executiveSummary"].lower())
        self.assertIn("updating presentation materials", result["executiveSummary"].lower())
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

    def test_decisions_drop_earlier_generic_direction_when_later_reversal_is_clearer(self):
        transcript = """Webinar practice transcript
Date: May 20, 2026
Location: Teams
Jack Cunningham   0:03Let's make this validation-specific.
Conor Flynn   0:20Agreed.
Ciara Griffin 0:40Actually, let's keep it broad.
Conor Flynn   1:00Yeah, that's better.
"""

        result = analyse(transcript)

        self.assertEqual(
            result["decisions"],
            ["The webinar should remain broad rather than validation-specific."],
        )
        self.assertEqual(len(result["decisionDetails"]), 1)
        self.assertEqual(result["decisionDetails"][0]["topic"], "audience_framing")
        self.assertEqual(
            result["discussionPoints"],
            [
                "The team discussed whether the webinar should be validation-specific or broadly applicable and agreed to keep the messaging broad."
            ],
        )
        self.assertIn("No additional actions were identified.", result["executiveSummary"])

    def test_vague_agenda_and_process_cues_are_not_extracted_as_decisions(self):
        transcript = """Validation webinar review

6 June 2026

Jack Cunningham:
Let's run through the opening.

Conor Flynn:
Let's go through the timeline next.

Ciara Griffin:
Let's move on after that.

Jack Cunningham:
Let's start with the registration flow.

Conor Flynn:
Let's see if we can do something there.

Ciara Griffin:
Let's give background on the project first.
"""

        result = analyse(transcript)

        self.assertEqual(result["decisions"], [])

    def test_validation_example_broad_reversal_uses_specific_wording(self):
        transcript = """Validation webinar review

6 June 2026

Jack Cunningham:
Let's make the validation example validation-specific.

Conor Flynn:
Agreed.

Ciara Griffin:
Actually, let's keep the validation example broad rather than too validation-specific.

Conor Flynn:
Yeah, that's better.
"""

        result = analyse(transcript)

        self.assertEqual(
            result["decisions"],
            ["The webinar should keep the validation example broad rather than too validation-specific."],
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

    def test_webinar_rehearsal_stress_test_regression(self):
        transcript = """Webinar Rehearsal Stress Test

6 June 2026

Jack Cunningham:
Let's run through the opening.

Conor Flynn:
Right, let's run through the deck from the top.

Ciara Griffin:
Let's start with the first section.

Jack Cunningham:
The opening explanation isn't clear.

Conor Flynn:
I'll think that through before Friday.

Jack Cunningham:
The timeline slide is confusing.

Conor Flynn:
I'll tighten that up tomorrow.

Jack Cunningham:
Can you update the registration list?

Conor Flynn:
Yes, I'll do that.

Jack Cunningham:
The demo intro needs a clearer spoken setup.

Conor Flynn:
I'll improve that as well.

Jack Cunningham:
Can you redesign the whole deck before Friday?

Conor Flynn:
No, I won't have time before Friday.

Ciara Griffin:
Let's see if we can do something there.

Jack Cunningham:
Keep the webinar educational rather than sales-led.

Conor Flynn:
Agreed.

Ciara Griffin:
Actually, let's keep the validation example broad rather than too validation-specific.

Conor Flynn:
Yeah, that's better.

Ciara Griffin:
Snip it then. He's hot.

Jack Cunningham:
Ignore that, no action.

Actions before the webinar:
Tighten the opening wording.
Check the client attendee list.
Run one more practice round.
"""

        result = analyse(transcript)

        expected_action_meta = {
            "Refine the opening explanation.": ("Conor Flynn", "Before Friday"),
            "Clarify the timeline slide.": ("Conor Flynn", "Tomorrow"),
            "Update the registration list.": ("Conor Flynn", ""),
            "Improve the demo intro spoken setup.": ("Conor Flynn", ""),
            "Tighten the opening wording.": ("Owner not specified", "Before the webinar"),
            "Check the client attendee list.": ("Owner not specified", "Before the webinar"),
            "Run one more practice round.": ("Owner not specified", "Before the webinar"),
        }
        self.assertTrue(set(expected_action_meta).issubset(set(result["meetingActionPoint"])))
        for action_text, (owner, deadline) in expected_action_meta.items():
            index = result["meetingActionPoint"].index(action_text)
            self.assertEqual(result["meetingActionPointOwner"][index], owner)
            self.assertEqual(result["meetingActionPointDeadline"][index], deadline)
        improve_index = result["meetingActionPoint"].index("Improve the demo intro spoken setup.")
        self.assertAlmostEqual(result["meetingActionPointConfidence"][improve_index], 0.75, places=2)
        self.assertNotIn("Redesign the whole deck before Friday.", result["meetingActionPoint"])
        self.assertEqual(
            result["decisions"],
            [
                "The webinar should remain educational rather than sounding sales-led.",
                "The webinar should keep the validation example broad rather than too validation-specific.",
            ],
        )
        self.assertIn("refining webinar messaging and delivery", result["executiveSummary"].lower())
        self.assertIn("updating attendee information", result["executiveSummary"].lower())
        self.assertIn("completing a final rehearsal", result["executiveSummary"].lower())

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
        self.assertIn("Repeatable AI use cases were confirmed as complete.", result["executiveSummary"])
        self.assertNotIn("Repeatable AI use cases was confirmed as complete.", result["executiveSummary"])
        self.assertIn(
            "Use case intake funnel, Vendor strategy rollout, and Innovation grant feedback remain active workstreams requiring further attention.",
            result["executiveSummary"],
        )
        self.assertIn("Actions focused on", result["executiveSummary"])
        self.assertIn("confirming sales dependencies for the ai pipeline", result["executiveSummary"].lower())
        self.assertIn("validating intake workflow routing", result["executiveSummary"].lower())
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
