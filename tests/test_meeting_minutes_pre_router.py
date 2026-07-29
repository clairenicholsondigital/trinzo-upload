import unittest

from scripts.meeting_minutes_trooper import (
    apply_routing_quality_gate,
    detect_transcript_route,
    prompt_for_transcript,
)


class MeetingMinutesPreRouterTests(unittest.TestCase):
    def test_router_sends_partial_webinar_gap_to_topic_summary_with_caution(self):
        transcript = """
        0:10 I just turned on the transcript, sorry.
        We were talking about the approved supplier topic and whether it works as a webinar.
        The first one in September could be more of an opening example and the November one might be governance-driven.
        30:30 The session topic to address should not sound too product-led.
        """

        route = detect_transcript_route(transcript)

        self.assertEqual(route["recommendedMode"], "topic_summary_with_caution")
        self.assertEqual(route["meetingType"], "webinar_content_planning")
        self.assertIn("partial_transcript_cue", route["signals"])
        self.assertIn("large_timestamp_gap", route["signals"])

    def test_router_keeps_clean_action_meeting_formal(self):
        transcript = """
        Sarah 0:00 We need to close the supplier onboarding review.
        Tom 0:35 I will send the updated QMS evidence pack by Wednesday.
        Sarah 1:20 Agreed, we will use the revised approval workflow from next week.
        Tom 2:10 Claire will update the actions log after the meeting.
        """

        route = detect_transcript_route(transcript)

        self.assertEqual(route["recommendedMode"], "formal_minutes")
        self.assertEqual(route["inputQuality"], "complete_transcript")

    def test_router_abstains_on_low_substance_audio_check(self):
        route = detect_transcript_route("Can everyone hear me? The red light is on. Let's stop there.")

        self.assertEqual(route["recommendedMode"], "ask_for_better_transcript")
        self.assertEqual(route["inputQuality"], "too_short")

    def test_routing_prompt_warns_against_fake_formal_actions(self):
        route = detect_transcript_route("""
        I just turned on the transcript. 0:10 The webinar topic could cover approved suppliers,
        governance drive, registration slides, and the opening example for September.
        The discussion is about which session topic to address and how product-led it should sound.
        30:30 The November one might focus on the wider approved-supplier process.
        """)
        prompt = prompt_for_transcript("webinar topic", None, route)

        self.assertIn("TRANSCRIPT_ROUTING", prompt)
        self.assertIn("Do not force it into formal action-heavy meeting minutes", prompt)

    def test_topic_summary_gate_removes_weak_actions_and_decisions(self):
        route = {"recommendedMode": "topic_summary_with_caution", "reasons": ["partial transcript"]}
        output = {
            "meetingTitle": "Meeting minutes",
            "executiveSummary": "Discussed possible webinar topics.",
            "discussionPoints": ["Approved supplier topic was discussed."],
            "decisions": ["The team decided to run an approved supplier webinar."],
            "actions": [
                {
                    "meetingActionPoint": "Prepare a webinar on approved suppliers.",
                    "meetingActionPointOwner": "Not stated",
                    "meetingActionPointDeadline": "Not stated",
                    "evidence": "approved supplier topic could be the first one",
                }
            ],
        }

        gated = apply_routing_quality_gate(output, route)

        self.assertEqual(gated["decisions"], [])
        self.assertEqual(gated["actions"], [])
        self.assertIn("Generated cautiously", gated["executiveSummary"])


if __name__ == "__main__":
    unittest.main()
