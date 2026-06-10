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

    def test_snippet_level_feedback_and_ai_shortcuts_are_wired(self):
        meeting_minutes_final = (REPO_DIR / "views" / "meeting-minutes-final.html").read_text(encoding="utf-8")
        shared_js = (REPO_DIR / "public" / "test-transcript-page.js").read_text(encoding="utf-8")
        api = (REPO_DIR / "routes" / "api.js").read_text(encoding="utf-8")

        self.assertIn("snippetImproveEndpoint: '/api/meeting-minutes-final/improve-snippet'", meeting_minutes_final)
        self.assertIn('id="feedbackSnippetQuote"', meeting_minutes_final)
        self.assertIn("event.key.toLowerCase() === 'f'", meeting_minutes_final)
        self.assertIn("Selected snippet for this feedback", meeting_minutes_final)
        self.assertIn("What should change about the selected snippet?", meeting_minutes_final)
        self.assertIn("selectedSnippet: currentSnippet", meeting_minutes_final)
        self.assertNotIn("Feedback about selected snippet", meeting_minutes_final)
        self.assertIn("function getEditableSnippetSelection", shared_js)
        self.assertIn("Ctrl+Shift+M (Cmd+Shift+M on Mac)", shared_js)
        self.assertIn("selection.replace(improved)", shared_js)
        self.assertIn("router.post('/meeting-minutes-final/improve-snippet'", api)
        self.assertIn("selectedSnippet: selectedSnippet || null", api)
        self.assertIn("meeting_minutes_rewrite_snippet.py", api)

    def test_feedback_listing_is_authenticated_and_editable(self):
        server = (REPO_DIR / "server.js").read_text(encoding="utf-8")
        auth = (REPO_DIR / "routes" / "auth.js").read_text(encoding="utf-8")
        api = (REPO_DIR / "routes" / "api.js").read_text(encoding="utf-8")
        db = (REPO_DIR / "utils" / "db.js").read_text(encoding="utf-8")
        listing = (REPO_DIR / "views" / "meeting-minutes-feedback.html").read_text(encoding="utf-8")
        login = (REPO_DIR / "views" / "auth-login.html").read_text(encoding="utf-8")

        self.assertIn("app.get('/meeting-minutes-feedback', authRoutes.requireAuth", server)
        self.assertIn("router.requireAuth = requireAuth", auth)
        self.assertIn("router.get('/meeting-minutes-final/feedback-submissions', requireAuth", api)
        self.assertIn("router.patch('/meeting-minutes-final/feedback-submissions/:feedbackId', requireAuth", api)
        self.assertIn("listMeetingMinutesFeedback", db)
        self.assertIn("updateMeetingMinutesFeedback", db)
        self.assertIn("selectedSnippet", db)
        self.assertIn("claire_comments", db)
        self.assertIn("fix_details", db)
        self.assertIn("/api/meeting-minutes-final/feedback-submissions", listing)
        self.assertIn("Comments from Claire", listing)
        self.assertIn("Fix details", listing)
        self.assertIn("Self-registration is disabled", auth)
        self.assertIn("res.redirect('/auth/login')", server)
        self.assertNotIn("Create account", login)
        self.assertNotIn("/auth/register", login)


if __name__ == "__main__":
    unittest.main()
