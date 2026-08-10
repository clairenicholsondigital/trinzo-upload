import unittest
from pathlib import Path


REPO_DIR = Path(__file__).resolve().parents[1]


class StagedMeetingMinutesContractTest(unittest.TestCase):
    def test_later_staged_steps_use_targeted_trooper_and_keep_fast_fallback(self):
        api = (REPO_DIR / "routes" / "api.js").read_text(encoding="utf-8")

        self.assertIn("async function buildStagedTrooperContext", api)
        self.assertIn("function buildStagedTrooperPrompt", api)
        self.assertIn("function stagedTrooperSchema", api)
        self.assertIn("async function buildStagedGenerationContext", api)
        self.assertIn("stagedFastContextIsUsable", api)
        self.assertIn("const trooperContext = await buildStagedTrooperContext(stage, transcript, req)", api)
        self.assertIn("const fastContext = await buildStagedMiniLMContext(transcript)", api)
        self.assertIn("AI stage was unavailable", api)
        self.assertIn("CONFIRMED_CONTEXT", api)
        self.assertIn("STAGE_INSTRUCTIONS", api)
        self.assertIn("staged_${stage}_targeted", api)
        self.assertIn("Write stage 2 only", api)
        self.assertIn("Write stage 3 only", api)
        self.assertIn("Write stage 4 only", api)
        self.assertIn("response_format: { type: 'json_object' }", api)
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

    def test_teams_speaker_turns_drive_deterministic_attendee_extraction(self):
        api = (REPO_DIR / "routes" / "api.js").read_text(encoding="utf-8")

        self.assertIn("function extractTeamsTranscriptStructure", api)
        self.assertIn("function extractTeamsTranscriptHeader", api)
        self.assertIn("TEAMS_PERSON_NAME_PATTERN", api)
        self.assertIn("TEAMS_TIMESTAMP_PATTERN", api)
        self.assertIn("TEAMS_HEADER_DATE_PATTERN", api)
        self.assertIn("speakerTurnCounts", api)
        self.assertIn("eventSpeakers", api)
        self.assertIn("started|stopped", api)
        self.assertIn("microsoft_teams_speaker_turns", api)
        self.assertIn("microsoft_teams_header", api)
        self.assertIn("headerDate || normaliseDateInput(rawDate)", api)
        self.assertIn("durationLine", api)
        self.assertIn("attendeeExtraction", api)
        self.assertIn("turnCount: teamsStructure.turnCount", api)
        self.assertIn("dateSource: headerDate ? 'microsoft_teams_header' : 'explicit_or_filename'", api)

    def test_staged_generation_has_visible_loading_state(self):
        page = (REPO_DIR / "views" / "staged-meeting-minutes.html").read_text(encoding="utf-8")

        self.assertIn(".review-status.is-loading", page)
        self.assertIn("animation:spin", page)
        self.assertIn("Generating:", page)
        self.assertIn("Generating summary and topics with AI", page)
        self.assertIn("Elapsed:", page)
        self.assertIn("You can close this tab and resume from Jobs.", page)
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
