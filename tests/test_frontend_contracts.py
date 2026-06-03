import unittest
from pathlib import Path


REPO_DIR = Path(__file__).resolve().parents[1]


class FrontendContractTest(unittest.TestCase):
    def test_meeting_minutes_final_uses_date_picker_for_meeting_date(self):
        shared_js = (REPO_DIR / "public" / "test-transcript-page.js").read_text(encoding="utf-8")

        self.assertIn("function toDateInputValue", shared_js)
        self.assertIn('id="meetingDateInput" type="date"', shared_js)
        self.assertIn("toDateInputValue(schemaOutput.meetingDate)", shared_js)


if __name__ == "__main__":
    unittest.main()
