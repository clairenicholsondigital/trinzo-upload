import unittest
from pathlib import Path


REPO_DIR = Path(__file__).resolve().parents[1]


class StagedMeetingMinutesContractTest(unittest.TestCase):
    def test_staged_steps_use_trooper_and_keep_minilm_as_fallback(self):
        api = (REPO_DIR / "routes" / "api.js").read_text(encoding="utf-8")

        self.assertIn("async function buildStagedTrooperContext", api)
        self.assertIn("runPythonTranscriptScript('meeting_minutes_trooper.py'", api)
        self.assertIn("const fallbackContext = trooperContext.ok ? null : await buildStagedMiniLMContext(transcript)", api)
        self.assertIn("trooperUsed: trooperContext.rewriterAvailable", api)
        self.assertIn("router.post('/staged-meeting-minutes/jobs'", api)
        self.assertIn("queueStagedMeetingMinutesStage", api)
        self.assertIn("updateGenerationJobProgress", api)
        self.assertIn("markGenerationJobCompleted", api)
        self.assertIn("markGenerationJobFailure", api)
        self.assertIn("runQueuedStagedMeetingMinutesStage", api)
        self.assertIn("findStagedSourceJobFromRequest", api)
        self.assertIn("input_payload->>'draftId'", api)

    def test_staged_topic_and_owner_cleanup_is_wired(self):
        api = (REPO_DIR / "routes" / "api.js").read_text(encoding="utf-8")
        trooper = (REPO_DIR / "scripts" / "meeting_minutes_trooper.py").read_text(encoding="utf-8")

        self.assertIn("function isUsableStagedTopic", api)
        self.assertIn("said that|and the other|review these topics", api)
        self.assertIn("function normaliseStagedActionOwner", api)
        self.assertIn("return 'All';", api)
        self.assertIn("def normalise_action_owner", trooper)
        self.assertIn('use "All" as the owner', trooper)

    def test_staged_generation_has_visible_loading_state(self):
        page = (REPO_DIR / "views" / "staged-meeting-minutes.html").read_text(encoding="utf-8")

        self.assertIn(".review-status.is-loading", page)
        self.assertIn("animation:spin", page)
        self.assertIn("Generating with Trooper:", page)
        self.assertIn("Generating summary and topics with AI", page)
        self.assertIn("document.body.classList.add('stage-loading')", page)
        self.assertIn("aria-busy", page)
        self.assertIn("https://unpkg.com/lucide@latest/dist/umd/lucide.min.js", page)

    def test_staged_review_uses_guided_locked_stage_flow(self):
        page = (REPO_DIR / "views" / "staged-meeting-minutes.html").read_text(encoding="utf-8")

        self.assertIn("stage-decision-card", page)
        self.assertIn("Want to move onto the next stage?", page)
        self.assertIn("No, keep reviewing", page)
        self.assertIn("function highestReachableScreen", page)
        self.assertIn("function lockedStageMessage", page)
        self.assertIn("item.classList.toggle('locked'", page)
        self.assertIn('data-lucide="lock"', page)
        self.assertIn('data-lucide="check"', page)
        self.assertIn("stageNeedsGeneration(nextIndex)", page)
        self.assertIn("/api/staged-meeting-minutes/jobs?stage=", page)
        self.assertIn("stageJobId", page)
        self.assertIn("sourceJobId", page)
        self.assertIn("transcriptText || transcriptFile || storedTranscriptText || stagedSourceJobId || draftId", page)

    def test_staged_transcript_is_carried_across_stages(self):
        page = (REPO_DIR / "views" / "staged-meeting-minutes.html").read_text(encoding="utf-8")

        # The transcript is stored in the browser (keyed by draftId) and re-sent for every
        # later stage, and generation streams in place instead of redirecting to Jobs.
        self.assertIn("STAGED_TRANSCRIPTS_KEY", page)
        self.assertIn("function persistTranscript", page)
        self.assertIn("function loadStoredTranscript", page)
        self.assertIn("storedTranscriptText = loadStoredTranscript(draftId)", page)
        self.assertIn("else if (storedTranscriptText) {", page)
        self.assertIn("pollStageJobUntilDone", page)
        self.assertNotIn("window.location.href = payload.jobsUrl", page)


if __name__ == "__main__":
    unittest.main()
