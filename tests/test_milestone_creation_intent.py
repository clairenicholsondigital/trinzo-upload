import json
from pathlib import Path
import unittest

from scripts.milestone_creation_intent import has_milestone_creation_intent
from scripts.project_update_minilm import (
    inferred_milestone_names, infer_transcript_milestone_segments,
    build_context_first_milestones, build_project_update_output,
)


class MilestoneCreationIntentTests(unittest.TestCase):
    def test_shared_admission_cases(self):
        cases = json.loads((Path(__file__).parent / "fixtures/milestone_creation_intent.json").read_text())
        for case in cases:
            with self.subTest(source=case["source"], name=case["name"]):
                self.assertEqual(has_milestone_creation_intent(case["name"], case["source"]), case["expected"])

    def test_descriptive_quote_never_becomes_tracked_milestone(self):
        text = 'Alex: The files are "scattered across folders" and need tidying.'
        self.assertEqual(inferred_milestone_names(text), [])
        self.assertEqual(infer_transcript_milestone_segments([text], []), [])
        result = build_project_update_output(text, use_minilm=False, use_rewrite=False)
        self.assertFalse(any("scattered" in row["milestone"].lower()
                             for row in result["projectReport"]["milestones"]))

    def test_known_quoted_name_still_updates_without_creation_wording(self):
        source = 'The "Validation complete" work is blocked.'
        segments = infer_transcript_milestone_segments([source], [], ["Validation complete"])
        rows = build_context_first_milestones(segments, {"activeMilestones": [
            {"milestoneId": 7, "milestoneName": "Validation complete"}
        ]})
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["milestoneId"], 7)
        self.assertEqual(rows[0]["transcript_update_status"], "updated_from_transcript")

    def test_unknown_progress_does_not_mean_invalid_new_milestone(self):
        source = 'Add a new milestone called "Security sign-off".'
        segments = infer_transcript_milestone_segments([source], [])
        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0]["delivery_status"], "unknown")
        self.assertEqual(len(build_context_first_milestones(segments, {})), 1)

    def test_unmatched_generated_label_is_not_promoted_by_summary_alone(self):
        rows = build_context_first_milestones([{
            "milestone": "Scattered across folders", "excerpt": 'The files are "scattered across folders".',
            "delivery_status": "unknown",
        }], {})
        self.assertEqual(rows, [])
