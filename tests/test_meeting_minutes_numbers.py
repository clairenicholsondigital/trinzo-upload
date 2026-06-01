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

    def test_implicit_broad_preference_becomes_decision(self):
        transcript = """Validation webinar review

6 June 2026

Jack:
The validation-specific version feels too narrow.

Conor:
Broad is probably safer.

Ciara:
Yeah, broad works better.
"""

        result = analyse(transcript)

        self.assertIn("The webinar should remain broad rather than validation-specific.", result["decisions"])

    def test_later_decision_supersedes_earlier_same_topic(self):
        transcript = """Launch timing review

6 June 2026

Leah:
We should launch in July.

Tom:
Agreed.

Leah:
Actually, we should move the launch to September.

Tom:
Yes, that's better.
"""

        result = analyse(transcript)

        self.assertIn("The team will move the launch to September.", result["decisions"])
        self.assertNotIn("The team will launch in July.", result["decisions"])
        self.assertIn("decisionTopicGraphs", result["numberExperimentDebug"])
        self.assertTrue(any(len(graph["nodes"]) >= 2 for graph in result["numberExperimentDebug"]["decisionTopicGraphs"]))

    def test_implicit_one_year_option_becomes_decision(self):
        transcript = """Supplier review

6 June 2026

Emma:
The three-year term still feels too long.

David:
The one-year option is safer.

Emma:
Fine, one-year option then.
"""

        result = analyse(transcript)

        self.assertIn("The team will pursue a one-year contract term rather than a three-year commitment.", result["decisions"])

    def test_schedule_resolution_is_promoted_into_final_decision(self):
        transcript = """Weekly check-in planning

4 November 2026

Grace:
I am offsite next Wednesday so I will miss the usual weekly check-in.

David:
We should move the check-in instead of cancelling it.

Emma:
Friday works for me.

David:
Friday at noon works best.

Grace:
Fine, Friday at noon then.
"""

        result = analyse(transcript)

        self.assertIn("the team will move the check-in to friday at noon.", [decision.lower() for decision in result["decisions"]])
        self.assertNotIn("The team will move the check-in instead of cancelling it.", result["decisions"])

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

    def test_request_acceptance_chain_creates_action(self):
        transcript = """Floor plan follow-up

19 August 2026

Clare:
Can you send the updated floor plan this afternoon?

Nina:
Yes, I'll do that.
"""

        result = analyse(transcript)

        self.assertIn("Send the updated floor plan this afternoon.", result["meetingActionPoint"])

    def test_dependency_deadline_is_preserved_from_request_thread(self):
        transcript = """Submission follow-up

19 August 2026

Clare:
Can you send the submission after legal signs it off?

Nina:
Yes, I'll do that.
"""

        result = analyse(transcript)

        self.assertIn("Send the submission after legal signs it off.", result["meetingActionPoint"])
        index = result["meetingActionPoint"].index("Send the submission after legal signs it off.")
        self.assertEqual(result["meetingActionPointDeadline"][index], "After legal signs it off")

    def test_ownership_question_inherits_action(self):
        transcript = """Negotiation Ownership

20 August 2026

Rachel:
Who is handling the negotiation?

David:
I can take that.
"""

        result = analyse(transcript)

        self.assertIn("Handle the negotiation.", result["meetingActionPoint"])

    def test_investigation_commitment_inherits_previous_actionable_context(self):
        transcript = """Bug Investigation

21 August 2026

Liam:
We should reproduce it on Safari before touching the payment token code.

Priya:
I'll look into that.
"""

        result = analyse(transcript)

        self.assertIn("Reproduce it on Safari before touching the payment token code.", result["meetingActionPoint"])

    def test_dependency_deadline_is_preserved_from_explicit_commitment(self):
        transcript = """Legal coordination

21 August 2026

David:
I'll speak with legal once the revised proposal arrives.
"""

        result = analyse(transcript)

        self.assertIn("Speak with legal once the revised proposal arrives.", result["meetingActionPoint"])
        index = result["meetingActionPoint"].index("Speak with legal once the revised proposal arrives.")
        self.assertEqual(result["meetingActionPointDeadline"][index], "Once the revised proposal arrives")

    def test_orphan_commitment_does_not_create_action(self):
        transcript = """Loose follow-up

22 August 2026

Maya:
I'll do that.

Jon:
Okay.
"""

        result = analyse(transcript)

        self.assertEqual(result["meetingActionPoint"], [])

    def test_rejected_request_with_new_owner_is_reassigned_not_suppressed(self):
        transcript = """Slide reassignment

22 August 2026

Jack:
Can you update the slides before Friday?

Ciara:
No, I can't before Friday.

Emma:
I'll do it.
"""

        result = analyse(transcript)

        self.assertIn("Update the slides before Friday.", result["meetingActionPoint"])
        index = result["meetingActionPoint"].index("Update the slides before Friday.")
        self.assertEqual(result["meetingActionPointOwner"][index], "Emma")
        self.assertFalse(result["numberExperimentDebug"]["suppressedRejectedActions"])
        self.assertTrue(
            any(
                event.get("threadKind") == "request"
                and event.get("eventType") == "thread_resolved_by_generic_commitment"
                and event.get("state") == "accepted"
                for event in result["numberExperimentDebug"]["intermediateEvents"]
            )
        )

    def test_generic_commitment_can_resolve_non_adjacent_request_thread(self):
        transcript = """Delayed follow-up

22 August 2026

Rachel:
Can you send the updated floor plan this afternoon?

Nina:
The supplier call is still running over.

Tom:
We'll need the revised timings in a minute.

Nina:
Yes, I'll do that.
"""

        result = analyse(transcript)

        self.assertIn("Send the updated floor plan this afternoon.", result["meetingActionPoint"])
        index = result["meetingActionPoint"].index("Send the updated floor plan this afternoon.")
        self.assertEqual(result["meetingActionPointOwner"][index], "Nina")

    def test_generic_commitment_can_resolve_longer_gap_strong_request_thread(self):
        transcript = """Delayed follow-up

22 August 2026

Rachel:
Can you send the updated floor plan this afternoon?

Nina:
The supplier call is still running over.

Tom:
We still need the revised timings for the venue.

Emma:
The registration page is ready now.

David:
Finance has already signed off the travel line.

Nina:
Yes, I'll do that.
"""

        result = analyse(transcript)

        self.assertIn("Send the updated floor plan this afternoon.", result["meetingActionPoint"])
        index = result["meetingActionPoint"].index("Send the updated floor plan this afternoon.")
        self.assertEqual(result["meetingActionPointOwner"][index], "Nina")

    def test_generic_commitment_prefers_explicit_request_over_intervening_issue(self):
        transcript = """Delivery review

1 June 2026

Rachel:
Can you send the revised deck by Wednesday?

Tom:
Before that, the legal comments are still coming in.

Nina:
The appendix also needs the new pricing table.

Tom:
Yes, I'll do that.
"""

        result = analyse(transcript)

        self.assertIn("Send the revised deck by Wednesday.", result["meetingActionPoint"])
        deck_index = result["meetingActionPoint"].index("Send the revised deck by Wednesday.")
        self.assertEqual(result["meetingActionPointOwner"][deck_index], "Tom")
        self.assertFalse(
            any(
                owner == "Tom" and "pricing table" in action.lower()
                for action, owner in zip(result["meetingActionPoint"], result["meetingActionPointOwner"])
            )
        )
        self.assertTrue(
            any(
                event.get("threadKind") == "request"
                and event.get("eventType") == "thread_resolved_by_generic_commitment"
                and event.get("resolvedOwner") == "Tom"
                for event in result["numberExperimentDebug"]["intermediateEvents"]
            )
        )

    def test_generic_commitment_does_not_resolve_bare_issue_thread(self):
        transcript = """Ops review

1 June 2026

Rachel:
The supplier list still needs a clean export.

Tom:
Yes, I'll do that.
"""

        result = analyse(transcript)

        self.assertEqual(result["meetingActionPoint"], [])
        self.assertFalse(
            any(
                event.get("threadKind") == "issue"
                and event.get("eventType") == "thread_resolved_by_generic_commitment"
                for event in result["numberExperimentDebug"]["intermediateEvents"]
            )
        )

    def test_micro_formatting_requests_do_not_become_actions(self):
        transcript = """Webinar rehearsal

1 June 2026

Ciara Griffin:
Can you put it in as an image?

Conor Flynn:
I can do that.

Ciara Griffin:
Put it on the same colour background and bring it over as an image.
"""

        result = analyse(transcript)

        self.assertEqual(result["meetingActionPoint"], [])

    def test_multi_owner_commitments_in_one_turn_are_split(self):
        transcript = """Planning review

22 August 2026

Rachel:
Tom will confirm the venue and Emma will update the attendee page.
"""

        result = analyse(transcript)

        self.assertIn("Confirm the venue.", result["meetingActionPoint"])
        self.assertIn("Update the attendee page.", result["meetingActionPoint"])
        first_index = result["meetingActionPoint"].index("Confirm the venue.")
        second_index = result["meetingActionPoint"].index("Update the attendee page.")
        self.assertEqual(result["meetingActionPointOwner"][first_index], "Tom")
        self.assertEqual(result["meetingActionPointOwner"][second_index], "Emma")
        self.assertTrue(
            any(event.get("eventType") == "named_commitment_action" for event in result["numberExperimentDebug"]["intermediateEvents"])
        )

    def test_weak_status_prompt_does_not_create_malformed_workstream(self):
        transcript = """Status review

22 August 2026

Claire:
No recommendation yet?

Sam:
It's not stopping anyone doing work.

Claire:
Yeah she said she'd follow up this week.

Emma:
The governance framework?

Sam:
Pending leadership review.
"""

        result = analyse(transcript)

        self.assertFalse(any(point.lower().startswith("the no") for point in result["discussionPoints"]))
        self.assertFalse(any("said she'd follow" in point.lower() for point in result["discussionPoints"]))
        self.assertIn("The AI governance framework draft is pending leadership review.", result["discussionPoints"])

    def test_vendor_strategy_pending_review_does_not_create_draft_action(self):
        transcript = """Status review

22 August 2026

Claire:
Vendor strategy?

Sam:
Pending leadership review.
"""

        result = analyse(transcript)

        self.assertIn(
            "Vendor strategy rollout remains in progress and is pending leadership review.",
            result["discussionPoints"],
        )
        self.assertNotIn("Draft vendor strategy document.", result["meetingActionPoint"])

    def test_status_review_only_pipeline_blocker_does_not_create_action(self):
        transcript = """Status review

22 August 2026

Claire:
AI pipeline strategy.

Sam:
Sales input is still required.
"""

        result = analyse(transcript)

        self.assertIn(
            "AI pipeline strategy remains blocked because sales input is still required.",
            result["discussionPoints"],
        )
        self.assertNotIn("Confirm AI pipeline dependencies with sales.", result["meetingActionPoint"])

    def test_adjacent_topic_prompts_do_not_collapse_distinct_workstreams(self):
        transcript = """Ops review

22 August 2026

Claire:
Customer onboarding workflow?

Sam:
Routing is still broken in the intake form.

Claire:
Customer onboarding webinar?

Emma:
Slides are ready and the rehearsal is booked.
"""

        result = analyse(transcript)
        lowered_points = [point.lower() for point in result["discussionPoints"]]

        self.assertTrue(any("routing" in point or "intake workflow" in point for point in lowered_points))
        self.assertTrue(any("rehearsal" in point or "slides" in point or "webinar" in point for point in lowered_points))
        self.assertGreaterEqual(len(result["numberExperimentDebug"]["topicClusters"]), 2)

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
The renewal would increase annual costs by around twelve percent.

Rachel:
There would be a migration effort and some retraining requirements.

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
        self.assertIn("The renewal would increase annual costs by around twelve percent.", result["discussionPoints"])
        self.assertIn("There would be a migration effort and some retraining requirements.", result["discussionPoints"])
        self.assertFalse(any(point == "The team reviewed renewal increase annual." for point in result["discussionPoints"]))
        self.assertFalse(any(point == "The team reviewed migration effort some." for point in result["discussionPoints"]))
        self.assertFalse(any(point == "The team reviewed send those across." for point in result["discussionPoints"]))
        self.assertTrue(any("customer support contract renewal" in point.lower() for point in result["discussionPoints"]))
        self.assertNotIn("The supplier has proposed a three-year commitment.", result["decisions"])
        self.assertFalse(any("send those across" in point.lower() for point in result["discussionPoints"]))
        self.assertTrue(
            any(
                "supplier" in " ".join(cluster["keywords"])
                or "renewal" in " ".join(cluster["keywords"])
                for cluster in result["numberExperimentDebug"]["topicClusters"]
            )
        )
        self.assertTrue(
            any(
                cluster.get("selectedRepresentativeSentence") == "The renewal would increase annual costs by around twelve percent."
                or cluster.get("selectedRepresentativeSentence") == "There would be a migration effort and some retraining requirements."
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
        self.assertNotIn("The no remains in progress.", result["discussionPoints"])
        self.assertFalse(any(point.lower().startswith(("the no", "the yes", "the it", "the that", "the this", "the okay", "the true", "the fine", "the probably", "the maybe")) for point in result["discussionPoints"]))
        self.assertGreaterEqual(len(result["discussionPoints"]), 3)
        self.assertLessEqual(len(result["discussionPoints"]), 10)
        self.assertEqual(len(result["discussionPoints"]), len(set(result["discussionPoints"])))
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
        self.assertNotEqual(result["executiveSummary"], "Actions were identified from the discussion.")
        self.assertIn("intermediateEvents", result["numberExperimentDebug"])
        self.assertTrue(any(event["eventType"] == "meeting_type_prediction" for event in result["numberExperimentDebug"]["intermediateEvents"]))
        self.assertTrue(any(event["eventType"] == "status_review_workstream" for event in result["numberExperimentDebug"]["intermediateEvents"]))
        self.assertIn("statusReviewWorkstreams", result["numberExperimentDebug"])
        self.assertTrue(any(item["topic"] for item in result["numberExperimentDebug"]["statusReviewWorkstreams"]))
        point_positions = {point: index for index, point in enumerate(result["discussionPoints"])}
        self.assertLess(
            point_positions["Vendor strategy rollout remains in progress: interviews are complete, but the strategy document has not yet been produced."],
            point_positions["Innovation grant feedback is still pending, with follow-up planned this week."],
        )
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
