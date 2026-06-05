import sys
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from meeting_minutes_minilm_experiment import (
    collect_minilm_only_context,
    collect_action_candidates,
    derive_meeting_objectives,
    formalize_transcript_discussion_point,
    has_concrete_action_commitment,
    infer_minilm_meeting_title,
    sanitize_public_output_items,
    should_accept_action_candidate,
    strip_action_deadline_phrase,
    _sanitize_rewritten_minutes_text,
)


class MeetingMinutesMiniLMQualityTest(unittest.TestCase):
    def test_conversational_availability_is_not_a_concrete_action(self):
        text = "And I'm easy right here, I can come back in here, or if you want to just continue with this, I don't mind."

        self.assertFalse(has_concrete_action_commitment(text))
        accepted, reason = should_accept_action_candidate(
            {
                "text": text,
                "owner": "Owner not specified",
                "deadline": "",
                "baseScore": 0.95,
                "combinedScore": 0.95,
                "semanticScore": 0.8,
                "roleScores": {"action": 0.8},
                "source": "semantic_action_fallback",
            }
        )

        self.assertFalse(accepted)
        self.assertEqual(reason, "missing_concrete_action_commitment")

    def test_clear_next_step_is_concrete_action(self):
        self.assertTrue(has_concrete_action_commitment("Refine the webinar opening slide before Friday."))
        self.assertTrue(has_concrete_action_commitment("Double down with the upskilled team on adoption considerations."))
        self.assertTrue(has_concrete_action_commitment("Investigate the server restart by Friday."))

    def test_transcript_label_is_removed_from_minilm_title(self):
        transcript = "📄 Transcript: AI Programme Weekly Check-In\n\nDate: 18 March 2026\n\nCiara:\nHello."

        self.assertEqual(infer_minilm_meeting_title(transcript), "AI Programme Weekly Check-In")

    def test_generic_notion_transcript_heading_is_not_used_as_title(self):
        transcript = """Transcript
Transcript file: Project Phoenix transcript v3 🔥
Claire: The meeting is the Phoenix delivery checkpoint.
"""

        self.assertEqual(infer_minilm_meeting_title(transcript), "Phoenix delivery checkpoint")

    def test_noisy_speakerless_opening_is_not_used_as_title(self):
        transcript = """All right.
Yeah.
The poster hall clicks and poster views are not the same measure, so the analytics review needs to separate click heatmaps from actual poster engagement.
"""

        self.assertEqual(infer_minilm_meeting_title(transcript), "Meeting review")

    def test_speakerless_context_reports_parser_fallback(self):
        transcript = """All right.
Yeah.
So the poster hall clicks and poster views are not the same measure. The heatmap is counting clicks into areas of the poster hall, while the poster view export is counting actual poster engagement. We need to explain that clearly because the delegate totals will look inconsistent otherwise.
Thank you.
The research hub numbers should be treated separately from search by research area. One report shows delegates using the hub itself, while the search counts represent repeated clicks and filter behaviour. The 414 delegates and 809 clicks figure should not be compared directly with the 1,009 and 4,758 search totals.
"""

        context = collect_minilm_only_context(transcript)

        self.assertGreater(context["parserDiagnostics"]["parsedTurnCount"], 0)
        self.assertGreater(context["parserDiagnostics"]["recordCount"], 0)
        self.assertTrue(context["parserDiagnostics"]["speakerlessFallbackApplied"])

    def test_explicit_meeting_title_instruction_overrides_export_header(self):
        transcript = """Transcript
Support metrics call transcript
00:12 Maya: The meeting title should be Support Metrics Review, not AutoNote recording.
00:35 Chris: Decision: keep abandonment rate as the lead metric for June.
"""

        self.assertEqual(infer_minilm_meeting_title(transcript), "Support Metrics Review")

    def test_export_title_words_are_removed_from_plain_header(self):
        transcript = """Transcript
Risk review transcript
Ibrahim: The purpose is to decide whether the integration risk is acceptable for pilot.
"""

        self.assertEqual(infer_minilm_meeting_title(transcript), "Risk review")

    def test_matching_deadline_is_removed_from_action_text(self):
        self.assertEqual(
            strip_action_deadline_phrase(
                "Update the risk register language by Friday so it no longer says immediate action required.",
                "By Friday",
            ),
            "Update the risk register language so it no longer says immediate action required",
        )
        self.assertEqual(
            strip_action_deadline_phrase("Draft the governance note by Monday.", "By Monday"),
            "Draft the governance note",
        )

    def test_conversational_discussion_fragments_are_formalized(self):
        self.assertEqual(
            formalize_transcript_discussion_point(
                "One thing I’d add, we might want to start tracking leading indicators, not just status Things like resource utilisation, number of active SO.",
                [{"text": "Ws per team, dependency concentration."}],
            ),
            "Leading indicators such as resource utilisation, active SOWs per team and dependency concentration should be tracked alongside status.",
        )
        self.assertEqual(
            formalize_transcript_discussion_point(
                "I’ve got the latest report open, the 18th March one So overall status is still green across scope, schedule, financials, resources."
            ),
            "Overall programme status remained green across scope, schedule, financials and resources.",
        )
        self.assertEqual(
            formalize_transcript_discussion_point(
                "Things like resource utilisation, number of active SOWs per team, dependency concentration."
            ),
            "Leading indicators such as resource utilisation, active SOWs per team and dependency concentration should be tracked alongside status.",
        )

    def test_speakerless_analytics_fragments_are_formalized(self):
        self.assertEqual(
            formalize_transcript_discussion_point(
                "Basically, process was looked at the 2025 graph and the non-session features were receiving the interaction.",
                [{"text": "taking out all of the session related content"}],
            ),
            "The feature-interaction graph should exclude session-related content so it shows which non-session platform features received engagement.",
        )
        self.assertEqual(
            formalize_transcript_discussion_point(
                "For this particular measure it does include just views of the poster hall rather than only views of posters.",
                [{"text": "people clicked clinical research posters but potentially not opened any of the posters"}],
            ),
            "Poster hall engagement should be described as poster-hall interaction, not individual poster views, because the measure includes delegates clicking into poster halls even when they did not open specific posters.",
        )
        self.assertEqual(
            formalize_transcript_discussion_point(
                "Some stupid, stupidly small number So about 47 and a few percent.",
                [{"text": "47% of the views were on Tuesday, not 47% of delegates"}],
            ),
            "Around 47 percent of the relevant views occurred on Tuesday, but the wording should refer to views rather than delegates.",
        )
        self.assertEqual(
            formalize_transcript_discussion_point(
                "I'm not sure, has the number seen the numbers of the swag bag? For some parts of the platform, they're a bit small.",
            ),
            "Some feature counts, including swag bag figures, were small enough that comparisons should be treated cautiously.",
        )
        self.assertEqual(
            formalize_transcript_discussion_point(
                "Some stupid, stupidly small number So about 47 and a few percent and a few little at a few decimal places of a percentage.",
            ),
            "A Tuesday-related percentage appears to be around 47 percent, but the wording should clarify whether it refers to views, clicks or delegates.",
        )
        self.assertEqual(
            formalize_transcript_discussion_point(
                "For some parts of the platform, they're a bit small They look really small to be honest at some parts.",
                [{"text": "the numbers seem really small and in a few places we're talking about 30 people or 30 users"}],
            ),
            "Small sample sizes in some platform areas limit how confidently differences between features can be interpreted.",
        )

    def test_resource_indicator_fragment_is_not_promoted_as_raw_objective(self):
        output = {
            "discussionPoints": [
                "Leading indicators such as resource utilisation, active SOWs per team and dependency concentration should be tracked alongside status.",
                "Things like resource utilisation, number of active SOWs per team, dependency concentration.",
            ],
            "discussionPointDetails": [
                {"sourceTurnIndices": [1, 2], "evidenceScore": 0.8},
                {"sourceTurnIndices": [2], "evidenceScore": 0.7},
            ],
            "decisions": [],
            "actions": [],
        }

        objectives = derive_meeting_objectives(output)

        self.assertIn(
            "Leading indicators such as resource utilisation, active SOWs per team and dependency concentration should be tracked alongside status",
            objectives,
        )
        self.assertFalse(any(objective.lower().startswith("things like") for objective in objectives))

    def test_vague_qwen_rewrite_falls_back_to_specific_source(self):
        source = "Sales continued to progress new SOWs while delivery bandwidth was not increasing at the same pace."

        self.assertEqual(
            _sanitize_rewritten_minutes_text("Currently there's some confusion regarding the issue.", source),
            source,
        )

    def test_report_update_with_vague_points_is_not_concrete_action(self):
        self.assertFalse(has_concrete_action_commitment("I’ll update the next report with these points."))

    def test_vague_recorded_assignment_fragment_is_not_action(self):
        text = "Assign that properly."

        self.assertFalse(has_concrete_action_commitment(text))
        accepted, reason = should_accept_action_candidate(
            {
                "text": text,
                "owner": "Owner not specified",
                "deadline": "",
                "baseScore": 0.9,
                "combinedScore": 0.9,
                "semanticScore": 0.7,
                "roleScores": {"action": 0.8},
                "source": "semantic_action_fallback",
            }
        )

        self.assertFalse(accepted)
        self.assertEqual(reason, "missing_concrete_action_commitment")

    def test_public_output_sanitizer_removes_speaker_timestamps_and_rejected_context(self):
        output = {
            "discussionPoints": [
                "09:00 Leah: The original plan was to announce the Spain launch in July. Partner paperwork was unfinished.",
                "Nina: Maybe we stop pushing the healthcare prospect this quarter. Legal review is still blocking enterprise deals.",
            ],
            "discussionPointDetails": [
                {
                    "discussionPoint": "09:00 Leah: The original plan was to announce the Spain launch in July. Partner paperwork was unfinished."
                }
            ],
            "decisions": ["Jon: Sign the one-year extension and keep the exit clause unchanged"],
            "decisionDetails": [{"decision": "Jon: Sign the one-year extension and keep the exit clause unchanged"}],
            "actions": [
                {
                    "meetingActionPoint": "12:04 Dan: call the customer",
                    "meetingActionPointOwner": "Dan",
                    "meetingActionPointDeadline": "Noon",
                }
            ],
        }

        sanitize_public_output_items(output, {"Leah", "Jon", "Dan", "Nina"})

        self.assertIn("Partner paperwork was unfinished.", output["discussionPoints"])
        self.assertIn("Legal review is still blocking enterprise deals.", output["discussionPoints"])
        self.assertTrue(
            all("healthcare prospect this quarter" not in item.lower() for item in output["discussionPoints"])
        )
        self.assertEqual(output["discussionPointDetails"][0]["discussionPoint"], "Partner paperwork was unfinished.")
        self.assertEqual(output["decisions"], ["Sign the one-year extension."])
        self.assertEqual(output["decisionDetails"][0]["decision"], "Sign the one-year extension.")
        self.assertEqual(output["meetingActionPoint"], ["Call the customer."])
        self.assertEqual(output["meetingActionPointOwner"], ["Dan"])
        self.assertEqual(output["meetingActionPointDeadline"], ["Noon"])

    def test_first_person_action_fallback_captures_speaker_and_nearby_deadline(self):
        candidates = collect_action_candidates(
            {
                "records": [
                    {"speaker": "Dan", "text": "I'll call the customer.", "scores": {"action": 0.2}},
                    {"speaker": "Dan", "text": "Noon works for that.", "scores": {"action": 0.0}},
                ],
                "actionEvents": [],
            },
            backend=None,
        )

        self.assertTrue(
            any(
                candidate["text"] == "Call the customer."
                and candidate["owner"] == "Dan"
                and candidate["deadline"] == "Noon"
                and candidate["source"] == "first_person_action_fallback"
                for candidate in candidates
            )
        )


if __name__ == "__main__":
    unittest.main()
