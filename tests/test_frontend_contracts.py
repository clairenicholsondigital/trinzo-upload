import unittest
from pathlib import Path


REPO_DIR = Path(__file__).resolve().parents[1]


class FrontendContractTest(unittest.TestCase):
    def test_meeting_minutes_final_uses_date_picker_for_meeting_date(self):
        shared_js = (REPO_DIR / "public" / "test-transcript-page.js").read_text(encoding="utf-8")

        self.assertIn("function toDateInputValue", shared_js)
        self.assertIn('id="meetingDateInput" type="date"', shared_js)
        self.assertIn("toDateInputValue(schemaOutput.meetingDate)", shared_js)

    def test_feedback_widget_is_scoped_to_meeting_minutes_final(self):
        meeting_minutes_final = (REPO_DIR / "views" / "meeting-minutes-final.html").read_text(encoding="utf-8")
        index = (REPO_DIR / "views" / "index.html").read_text(encoding="utf-8")
        api = (REPO_DIR / "routes" / "api.js").read_text(encoding="utf-8")
        db = (REPO_DIR / "utils" / "db.js").read_text(encoding="utf-8")

        self.assertIn('id="feedbackWidgetButton"', meeting_minutes_final)
        self.assertIn("/api/meeting-minutes-final/feedback", meeting_minutes_final)
        self.assertIn("Please avoid sharing transcript content", meeting_minutes_final)
        self.assertIn(".feedback-backdrop.hidden { display:none; }", meeting_minutes_final)
        self.assertNotIn("Please don’t paste transcripts or sensitive meeting details here.", meeting_minutes_final)
        self.assertNotIn('id="feedbackEmail"', meeting_minutes_final)
        self.assertNotIn('id="feedbackWidgetButton"', index)
        self.assertIn("router.post('/meeting-minutes-final/feedback'", api)
        self.assertIn("saveMeetingMinutesFeedback", api)
        self.assertIn("meeting_minutes_feedback", db)
        self.assertNotIn("transcriptText", api.split("router.post('/meeting-minutes-final/feedback'", 1)[1].split("router.post('/project-update-test'", 1)[0])


if __name__ == "__main__":
    unittest.main()
