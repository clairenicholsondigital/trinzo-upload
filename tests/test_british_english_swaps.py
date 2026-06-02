import unittest

from scripts.meeting_minutes_text import apply_british_english_to_payload


class BritishEnglishDirectSwapsTest(unittest.TestCase):
    def test_applies_only_direct_spelling_swaps_recursively(self):
        payload = {
            "meetingObjectives": ["Analyze and improve the process."],
            "discussionPoints": ["The team analyzed the checklist and began analyzing outcomes."],
            "nested": {"text": "Analyzed outputs should be reviewed."},
        }

        result = apply_british_english_to_payload(payload)

        self.assertEqual(result["meetingObjectives"], ["Analyse and improve the process."])
        self.assertEqual(
            result["discussionPoints"],
            ["The team analysed the checklist and began analysing outcomes."],
        )
        self.assertEqual(result["nested"]["text"], "Analysed outputs should be reviewed.")


if __name__ == "__main__":
    unittest.main()
