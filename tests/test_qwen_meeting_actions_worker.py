import unittest

from scripts.qwen_meeting_actions_worker import extract_json_object, normalize_actions


class QwenMeetingActionWorkerTests(unittest.TestCase):
    def test_extracts_fenced_json(self):
        parsed = extract_json_object('```json\n{"actions":[]}\n```')
        self.assertEqual(parsed, {"actions": []})

    def test_normalizes_and_deduplicates(self):
        self.assertEqual(
            normalize_actions(
                {
                    "actions": [
                        {"action": " Review   plan ", "owner": " Bob ", "deadline": " Friday "},
                        {"action": "review plan", "owner": "bob"},
                        {"action": "Send notes"},
                        {"owner": "Alice"},
                    ]
                }
            ),
            [
                {"action": "Review plan", "owner": "Bob", "deadline": "Friday"},
                {"action": "Send notes", "owner": "Not stated", "deadline": "Not stated"},
            ],
        )

    def test_requires_actions_array(self):
        with self.assertRaisesRegex(ValueError, "actions array"):
            normalize_actions({})


if __name__ == "__main__":
    unittest.main()
