import json
import sys
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from meeting_minutes_final_colab import enrich_fallback_meeting_fields, parse_colab_minutes
from meeting_minutes_final_colab_core import (
    _decision_entries,
    _dynamic_topic_from_remaining_sources,
    _is_useful_generic_action,
    generate_polished_minutes_pass,
)
from google_ai_studio_minutes import (
    build_google_minutes_evidence_pack,
    generate_minutes_with_google_ai_studio,
    run_minilm_quality_control,
    _normalise_minutes_output,
)
from run_meeting_minutes_final_golden_eval import evaluate_case, load_json


GOLDEN_DIR = SCRIPTS_DIR / "meeting-minutes-final-golden"


class MeetingMinutesFinalColabCoreTests(unittest.TestCase):
    def test_google_ai_studio_pack_uses_minilm_evidence_not_raw_prompt_context(self):
        sections = {
            "topics": [
                {
                    "topic": "Supplier readiness",
                    "sections": {
                        "Discussion points": [
                            {
                                "text": "The team reviewed supplier readiness for launch.",
                                "sources": [{"text": "We need to check supplier readiness before the launch date."}],
                            }
                        ],
                        "Open questions": [
                            {
                                "text": "The launch date still needs confirmation.",
                                "sources": [{"text": "I do not think the launch date is confirmed yet."}],
                            }
                        ],
                    },
                }
            ],
            "actions": [
                {
                    "text": "Confirm supplier launch readiness.",
                    "owner": "Maya",
                    "deadline": "Friday",
                    "sources": [{"text": "Maya will confirm whether the supplier is ready by Friday."}],
                }
            ],
            "decisions": [],
        }
        pack = build_google_minutes_evidence_pack(sections, {"executiveSummary": "Fallback summary"})

        self.assertEqual(pack["topics"][0]["topic"], "Supplier readiness")
        self.assertEqual(pack["topics"][0]["discussionPoints"][0]["text"], "The team reviewed supplier readiness for launch.")
        self.assertEqual(pack["actions"][0]["owner"], "Maya")
        self.assertIn("supplier is ready", pack["actions"][0]["evidence"][0])

    def test_google_ai_studio_falls_back_when_key_is_missing(self):
        output, diagnostics = generate_minutes_with_google_ai_studio(
            {"topics": [], "actions": [], "decisions": []},
            {"discussionPoints": ["Existing MiniLM point."]},
            api_key="",
        )

        self.assertIsNone(output)
        self.assertFalse(diagnostics["available"])
        self.assertIn("GOOGLE_AI_STUDIO_API_KEY", diagnostics["error"])

    def test_google_normalisation_preserves_fallback_title_and_filters_admin_objectives(self):
        output = _normalise_minutes_output(
            {
                "meetingTitle": "",
                "meetingObjectives": [
                    "Get external access to the SharePoint before the audit starts on Monday.",
                ],
                "decisions": [
                    "Get external access to the SharePoint before the audit starts on Monday.",
                    "Smith, Stuart M 20:27Yes.Yes, so I'll share with you the tracker that we use that transmits.",
                    "And it also means it frees us up to use specialist expertise.",
                ],
                "executiveSummary": "The audit kick-off covered scope and preparation.",
            },
            {
                "meetingTitle": "Client Abbott T796 Audit kick off Sylmar",
                "meetingObjectives": ["Review the audit kick-off scope, preparation priorities and follow-up actions."],
                "discussionPoints": [],
                "decisions": [],
                "actions": [],
            },
        )

        self.assertEqual(output["meetingTitle"], "Client Abbott T796 Audit kick off Sylmar")
        self.assertEqual(output["meetingObjectives"], ["Review the audit kick-off scope, preparation priorities and follow-up actions."])
        self.assertEqual(output["decisions"], [])

    def test_fallback_output_gets_title_and_objective_from_transcript(self):
        transcript = "Client Abbott T796 - Audit kick off Sylmar-20260622_113805-Meeting Transcript\n\nJacqui Fox 0:03 We need to review audit scope, software risks and cybersecurity controls."
        output = enrich_fallback_meeting_fields(
            {
                "meetingTitle": "",
                "meetingObjectives": [],
                "discussionPoints": [
                    "The discussion covered software changes, alarm behaviour and version traceability.",
                    "The discussion covered cybersecurity, risk management updates and USB access controls.",
                ],
                "actions": [],
            },
            transcript,
        )

        self.assertEqual(output["meetingTitle"], "Client Abbott T796 Audit kick off Sylmar")
        self.assertTrue(output["meetingObjectives"])
        self.assertNotIn("SharePoint", output["meetingObjectives"][0])

    def test_minilm_quality_control_flags_unsupported_public_items(self):
        evidence_pack = {
            "topics": [
                {
                    "topic": "Supplier readiness",
                    "discussionPoints": [{"text": "The team reviewed supplier readiness for launch."}],
                    "responsibilities": [],
                    "evidenceRequired": [],
                    "risks": [],
                    "openQuestions": [],
                }
            ],
            "actions": [],
            "decisions": [],
        }
        diagnostics = run_minilm_quality_control(
            {
                "discussionPoints": [
                    "The team reviewed supplier readiness for launch.",
                    "The board approved a new budget increase.",
                ],
                "actions": [],
                "decisions": [],
            },
            evidence_pack,
        )

        self.assertEqual(diagnostics["checkedItems"], 2)
        self.assertTrue(any("budget increase" in item["text"] for item in diagnostics["unsupportedItems"]))

    def test_conversational_fragments_are_not_useful_actions(self):
        rejected = [
            "I was hoping that we would have more follow up.",
            "Yeah, if you need a follow up, just let me know.",
            "Review it and then we can have another call and we can go from there.",
            "Hey, we need to bring somebody in.",
        ]
        for text in rejected:
            with self.subTest(text=text):
                self.assertFalse(_is_useful_generic_action(text))

    def test_sharepoint_access_setup_is_not_a_decision(self):
        report = {
            "scorecard": {},
            "buckets": {
                "decision": [
                    {
                        "speaker": "Jacqui Fox",
                        "text": "And we'll have to get you external access to the SharePoint that we use during the audit before we start on the Monday.",
                    }
                ]
            },
        }

        self.assertEqual(_decision_entries(report, ""), [])

    def test_dynamic_topic_rejects_low_information_terms(self):
        report = {
            "buckets": {
                "action": [
                    {"speaker": "Hannah Quinn", "text": "Yeah, good, all follow up and then come back."},
                    {"speaker": "Steve Martin", "text": "You are right and it is fine."},
                ],
                "responsibility": [
                    {"speaker": "Steve Martin", "text": "The team talked about you and then this thing."}
                ],
                "question": [
                    {"speaker": "Hannah Quinn", "text": "Do you know where it is?"}
                ],
            }
        }
        self.assertIsNone(_dynamic_topic_from_remaining_sources(report, set()))

    def test_real_qip_case_study_transcript_passes_colab_semantic_expectations(self):
        case = GOLDEN_DIR / "026_real_qip_assessment_tool_case_study_transcript"
        transcript = (case / "transcript.txt").read_text(encoding="utf-8")
        expected = load_json(case / "expected.json")
        result = generate_polished_minutes_pass(transcript_text=transcript)
        output = parse_colab_minutes(result["minutes"])

        report = evaluate_case(case.name, output, expected)
        self.assertTrue(report["passed"], json.dumps(report, indent=2))


if __name__ == "__main__":
    unittest.main()
