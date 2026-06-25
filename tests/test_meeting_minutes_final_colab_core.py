import json
import sys
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from meeting_minutes_final_colab import parse_colab_minutes
from meeting_minutes_final_colab_core import (
    _dynamic_topic_from_remaining_sources,
    _is_useful_generic_action,
    generate_polished_minutes_pass,
)
from run_meeting_minutes_final_golden_eval import evaluate_case, load_json


GOLDEN_DIR = SCRIPTS_DIR / "meeting-minutes-final-golden"


class MeetingMinutesFinalColabCoreTests(unittest.TestCase):
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
