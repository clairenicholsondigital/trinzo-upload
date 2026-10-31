import unittest
from pathlib import Path


REPO_DIR = Path(__file__).resolve().parents[1]


class StagedMeetingMinutesContractTest(unittest.TestCase):
    def test_later_staged_steps_use_canonical_pipeline_and_confirmed_state(self):
        api = (REPO_DIR / "routes" / "api.js").read_text(encoding="utf-8")
        staged_queue = (REPO_DIR / "utils" / "stagedMinutesQueue.js").read_text(encoding="utf-8")
        staged_evaluation = (REPO_DIR / "utils" / "stagedMinutesEvaluation.js").read_text(encoding="utf-8")
        staged_context = (REPO_DIR / "utils" / "stagedMinutesContext.js").read_text(encoding="utf-8")
        staged_response = (REPO_DIR / "utils" / "stagedMinutesCanonicalResponse.js").read_text(encoding="utf-8")
        db = (REPO_DIR / "utils" / "db.js").read_text(encoding="utf-8")
        staged_editorial = (REPO_DIR / "utils" / "stagedEditorial.js").read_text(encoding="utf-8")
        meeting_type = (REPO_DIR / "utils" / "meetingMinutesStageMeetingType.js").read_text(encoding="utf-8")
        prompts = (REPO_DIR / "utils" / "meetingMinutesAgentPrompts.js").read_text(encoding="utf-8")
        action_recovery = (REPO_DIR / "utils" / "meetingMinutesRefereeActionRecovery.js").read_text(encoding="utf-8")
        # Old unused backend presence checks were retired with their implementations.
        # Canonical dispatch, editorial behavior and queued-stage wiring remain checked.

        # buildStagedGenerationContext and the fast-context dispatch it anchored were the
        # generation backend of the pre-canonical staged path. They were deleted in the
        # Phase 5 consolidation when runStagedSequenceForEvaluation - their last caller -
        # moved onto canonicalStagedResponse, so the no-edit pass and the evaluation
        # scripts now measure the pipeline the reviewer actually sees. The contract this
        # test protects is therefore stated the other way round: the sequence must run the
        # canonical pipeline, and the old backend must stay gone.
        self.assertIn("const response = await canonicalStagedResponse(stage, transcript, input)", staged_evaluation)
        self.assertNotIn("async function buildStagedGenerationContext", api)
        self.assertNotIn("async function buildStagedSummaryResponse", api)
        self.assertNotIn("async function buildStagedDiscussionResponse", api)
        self.assertIn("function cleanStagedExecutiveSummary", staged_response)
        self.assertIn("the reviewer should check", staged_response)
        self.assertIn("filter((sentence) => !/\\bthe reviewer should check\\b/i.test(sentence))", staged_response)
        self.assertIn("buildTightStagedObjectives", api)
        # objectiveReducer existed only inside buildStagedSummaryResponse and died with it
        # in the Phase 5 consolidation; the objective machinery that outlived the dead
        # pipeline is buildTightStagedObjectives in stagedEditorial, asserted above and
        # here by its cap - the part of the contract with observable effect.
        self.assertIn("const maxObjectives = Math.max(1, Math.min(8, Number(input.maxObjectives || 3)))", staged_editorial)
        self.assertIn("Alarm changes", api)
        self.assertIn("Language changes", api)
        self.assertIn("Software versioning changes", api)
        self.assertIn("Debug review", api)
        self.assertIn("Change request", api)
        self.assertIn("function cleanStagedDiscussionText", staged_context)
        self.assertIn("reshapeStagedDiscussionCardsForHumanMinutes", api)
        self.assertIn("function polishStagedActions", api)
        self.assertIn("function stagedActionIntent", api)
        self.assertIn("function stagedActionsAreDuplicates", api)
        self.assertIn("normaliseFinalStagedActionCandidate", api)
        self.assertIn("stagedFinalActionQualityIssue", staged_editorial)
        self.assertIn("function transcriptPreservedStagedActions", api)
        self.assertIn("function mergePreservedStagedActions", api)
        self.assertIn("function buildStagedActionInventory", api)
        self.assertIn("function actionsFromEvidenceClassifier", api)
        self.assertIn("transcriptActionInventoryCount", api)
        self.assertIn("evidenceClassifierActionCount", api)
        self.assertIn("transcript_action_preservation_guard", api)
        self.assertIn("Complete the risk assessment to develop the audit plan", api)
        self.assertIn("actionPreservation", api)
        self.assertIn("function isAuditableStagedAction", api)
        self.assertIn("function cleanStagedActionText", staged_context)
        self.assertIn("function stripStagedTranscriptArtefacts", staged_context)
        self.assertIn("STAGED_PUBLIC_TIMESTAMP_PATTERN", staged_context)
        self.assertIn("STAGED_PUBLIC_SPEAKER_PATTERN", staged_context)
        self.assertIn("function capitaliseStagedDateMonths", staged_context)
        self.assertIn("function hasStagedSpeakerTurnPrefix", staged_context)
        self.assertIn("misattributed_discussion_evidence", staged_editorial)
        self.assertIn("function stagedTextHasFutureCommitmentMarker", api)
        self.assertIn("future commitment", prompts)
        self.assertIn("dependency", action_recovery)
        self.assertIn("workstreamStateCount", api)
        self.assertIn("missingWorkstreamCount", api)
        self.assertIn("missingWorkstreams", api)
        self.assertIn("workstreamQualityFlags", api)
        self.assertIn("Arrange a catch-up meeting", staged_context)
        self.assertIn("const stagedActions = actionsFromStagedMiniLM", api)
        self.assertIn("const mergedActions = mergePreservedStagedActions", api)
        self.assertIn("normaliseAndValidateActionOwner", api)
        self.assertIn("stagedDiscussionPointSimilarity", api)
        # Four assertions here died with the pre-canonical builders in the Phase 5
        # consolidation - "semantic topic evidence", the thin-output retry and its
        # droppedMisattributed/retryCount accounting all lived inside
        # buildStagedDiscussionResponse. The confirmed-topic discipline they policed is
        # asserted through the strings that survive in the living pipeline below.
        self.assertIn("evidencePackTopicCount", api)
        self.assertIn("runCanonicalLiveStage", staged_response)
        self.assertIn("const semanticTranscript = transcriptForStagedAI(transcript, input);", staged_response)
        self.assertIn("runCanonicalLiveStage(semanticTranscript.text", staged_response)
        self.assertIn("canonicalStagedResponse", api)
        self.assertIn("grammarPolishStagedExecutiveSummary", staged_response)
        self.assertIn("executiveSummaryGrammar", staged_response)
        # The grammar pass no longer receives the whole summary: the purpose sentence is
        # split off as an opaque prefix, only the remainder is polished, and the prefix is
        # reattached byte-identical. Sending the whole summary through let the LLM rewrite
        # the opening into "The session focused on..." while the purpose field above it
        # said something else - two renderings of one sentence on one screen.
        self.assertIn("await grammarPolishStagedExecutiveSummary(polishable)", staged_response)
        self.assertIn("presentationSummary.startsWith(summaryPurpose)", staged_response)
        self.assertIn("humanConfirmedInputIsAuthoritative", api)
        self.assertIn("return null;", api)
        # These three call-shapes lived inside buildStagedDiscussionResponse, deleted in
        # the Phase 5 consolidation. The functions they invoked survive and stay pinned:
        # evidence filtering and compaction now run where the canonical pipeline calls
        # them, and the reshaper assertion above covers the seam.
        self.assertIn("compactStagedDiscussionCards", api)
        self.assertIn(": [];", api)
        self.assertIn("function isNoEvidenceDiscussionText", staged_context)
        self.assertIn("decisionOrAgreement", staged_evaluation)
        self.assertIn("nextStep", api)
        self.assertIn("additionalContext: firstString", api)
        self.assertIn("additionalContext: input.additionalContext", staged_queue)
        self.assertIn("router.post('/staged-meeting-minutes/jobs'", api)
        self.assertIn("queueStagedMeetingMinutesStage", api)
        self.assertIn("updateGenerationJobProgress", staged_queue)
        self.assertIn("markGenerationJobCompleted", staged_queue)
        self.assertIn("markGenerationJobFailure", staged_queue)
        self.assertIn("runQueuedStagedMeetingMinutesStage", staged_queue)
        self.assertIn("Denoising and organising discussion evidence.", staged_queue)
        self.assertIn("payload = await generateMiniLmTrooperStage(stage, transcript.text", staged_queue)
        # The queued stage and the scorecard route the meeting type through one shared helper,
        # so the two cannot drift apart again.
        self.assertIn("function stagedGenerationMeetingType(selectedMeetingType, meetingIdentity)", meeting_type)
        self.assertIn("meetingType: stagedGenerationMeetingType(selectedMeetingType, meetingIdentity)", staged_queue)
        self.assertIn("findStagedSourceJobFromRequest", api)
        self.assertIn("function isTransientPgError", db)
        self.assertIn("code === '40P01' || code === '40001'", db)
        self.assertIn("Database query failed after retry.", db)
        self.assertIn("withTransaction(fn, options = {})", db)
        self.assertIn("input_payload->>'draftId'", api)
        self.assertIn("confirmedDetails", api)
        self.assertIn("confirmedSummary", api)
        self.assertIn("confirmedDiscussion", api)
        self.assertIn("confirmedActions", api)
        self.assertIn("parseStagedJsonObject", api)
        self.assertIn("parseStagedJsonArray", api)

    def test_staged_discussion_has_human_minutes_reshaper(self):
        staged_editorial = (REPO_DIR / "utils" / "stagedEditorial.js").read_text(encoding="utf-8")
        api = (REPO_DIR / "routes" / "api.js").read_text(encoding="utf-8")

        self.assertIn("function reshapeStagedDiscussionCardsForHumanMinutes", staged_editorial)
        self.assertIn("function orderHumanDiscussionPoints", staged_editorial)
        self.assertIn("function topicNeedsProcessDetail", staged_editorial)
        self.assertIn("processDetailPointLimit", staged_editorial)
        self.assertIn("UDI and regulatory data", staged_editorial)
        self.assertIn("EUDAMED", staged_editorial)
        self.assertIn("function finaliseDiscussionPointForMinutes", staged_editorial)
        self.assertIn("raw_transcript_discussion_points_removed", staged_editorial)
        self.assertIn("malformed_discussion_points_removed", staged_editorial)
        self.assertIn("action_only_discussion_points_removed", staged_editorial)
        self.assertIn("STAGED_SPEAKER_TURN_PREFIX", staged_editorial)
        self.assertIn("FIRST_PERSON_TRANSCRIPT_VOICE", staged_editorial)
        self.assertNotIn("clinician|clinical|audible sound", staged_editorial)
        self.assertNotIn("version 1.01 and 1.02", staged_editorial)
        # The old assertion pinned a line inside buildStagedDiscussionResponse, an entry
        # point of the pre-canonical staged path deleted in the Phase 5 consolidation.
        # What actually matters - and survives - is that the reshaper itself is wired
        # into the pipeline the reviewer sees.
        self.assertIn("reshapeStagedDiscussionCardsForHumanMinutes", api)

    def test_staged_topic_and_owner_cleanup_is_wired(self):
        api = (REPO_DIR / "routes" / "api.js").read_text(encoding="utf-8")
        trooper = (REPO_DIR / "scripts" / "meeting_minutes_trooper.py").read_text(encoding="utf-8")

        self.assertIn("function isUsableStagedTopic", api)
        self.assertIn("said that|and the other|review these topics", api)
        self.assertIn("function normaliseStagedActionOwner", api)
        self.assertIn("return 'All';", api)
        self.assertIn("def normalise_action_owner", trooper)
        self.assertIn('use "All" as the owner', trooper)

    def test_staged_actions_keep_deadlines_bound_to_source_evidence(self):
        api = (REPO_DIR / "routes" / "api.js").read_text(encoding="utf-8")
        recovery = (REPO_DIR / "utils" / "stagedActionRecovery.js").read_text(encoding="utf-8")

        self.assertIn("function enrichStagedActionDeadlinesFromTranscript", api)
        self.assertIn("const evidence = String(item?.evidence", api)
        self.assertIn("parseDeadlineEvidence(evidence)", api)
        self.assertIn("sourceTurnIds", recovery)
        self.assertIn("function parseDeadlineEvidence", recovery)
        self.assertIn("end of (?:the|next)", recovery)
        self.assertIn("return enrichStagedActionDeadlinesFromTranscript([...merged, ...preserved], transcriptText);", api)

    def test_staged_eval_replays_real_stage_builders_and_keeps_raw_recovery_text(self):
        api = (REPO_DIR / "routes" / "api.js").read_text(encoding="utf-8")
        staged_evaluation = (REPO_DIR / "utils" / "stagedMinutesEvaluation.js").read_text(encoding="utf-8")
        staged_response = (REPO_DIR / "utils" / "stagedMinutesCanonicalResponse.js").read_text(encoding="utf-8")
        runner = (REPO_DIR / "scripts" / "run_staged_meeting_minutes_eval.js").read_text(encoding="utf-8")
        scorer = (REPO_DIR / "scripts" / "run_meeting_minutes_final_golden_eval.py").read_text(encoding="utf-8")

        self.assertIn("async function runStagedSequenceForEvaluation", staged_evaluation)
        self.assertIn("stagedEvaluationVisibleOutput", staged_evaluation)
        self.assertIn("runCanonicalLiveStage", staged_response)
        self.assertIn("canonicalConfirmedStages", staged_response)
        self.assertIn("confirmedDiscussion", api)
        self.assertIn("runSequence(transcript", runner)
        self.assertIn("deterministicActionInventoryCount", runner)
        self.assertIn("--precomputed-dir", scorer)
        self.assertIn("card?.decisionOrAgreement", staged_evaluation)

    def test_staged_no_edit_endpoint_returns_browser_review_messages(self):
        api = (REPO_DIR / "routes" / "api.js").read_text(encoding="utf-8")
        staged_evaluation = (REPO_DIR / "utils" / "stagedMinutesEvaluation.js").read_text(encoding="utf-8")

        self.assertIn("router.post('/staged-meeting-minutes/no-edit-pass'", api)
        self.assertIn("mode: 'no_human_edits'", api)
        self.assertIn("function stagedNoEditReviewExperience", staged_evaluation)
        self.assertIn("Editorial checks (review before moving on)", staged_evaluation)
        self.assertIn("readyForFinalApproval", api)
        self.assertIn("requiredReviewerActions", staged_evaluation)
        self.assertIn("add_to_discussion", staged_evaluation)
        self.assertIn("intentionally_omit", staged_evaluation)
        self.assertIn("return_to_summary_topics", staged_evaluation)
        self.assertIn("Final review would remain locked", staged_evaluation)
        self.assertIn("staged_meeting_minutes_no_edit_pass_completed", api)

    def test_staged_actions_have_final_quality_gate(self):
        staged_editorial = (REPO_DIR / "utils" / "stagedEditorial.js").read_text(encoding="utf-8")
        api = (REPO_DIR / "routes" / "api.js").read_text(encoding="utf-8")
        staged_context = (REPO_DIR / "utils" / "stagedMinutesContext.js").read_text(encoding="utf-8")

        self.assertIn("function normaliseFinalStagedActionCandidate", staged_editorial)
        self.assertIn("function stagedFinalActionQualityIssue", staged_editorial)
        self.assertNotIn("missing_owner", staged_editorial)
        self.assertIn("owner: normaliseFinalActionOwner(rewritten.owner)", staged_editorial)
        self.assertIn("missing_actionable_verb", staged_editorial)
        self.assertIn("missing_concrete_object", staged_editorial)
        self.assertIn("transcript_debris", staged_editorial)
        self.assertIn("Review electrical compliance testing outputs and update the final compliance documentation", staged_editorial)
        self.assertIn("function canonicalKnownStagedPersonName", staged_context)
        self.assertIn("stagedPeopleRegistry().personByFirstName", staged_context)
        self.assertIn("normaliseDeadlineKey", api)
        self.assertIn("mute", api)

    def test_teams_speaker_turns_drive_deterministic_attendee_extraction(self):
        staged_details = (REPO_DIR / "utils" / "stagedMinutesDetails.js").read_text(encoding="utf-8")

        self.assertIn("function extractTeamsTranscriptStructure", staged_details)
        self.assertIn("function extractTeamsTranscriptHeader", staged_details)
        self.assertIn("TEAMS_PERSON_NAME_PATTERN", staged_details)
        self.assertIn("TEAMS_TIMESTAMP_PATTERN", staged_details)
        self.assertIn("TEAMS_HEADER_DATE_PATTERN", staged_details)
        self.assertIn("speakerTurnCounts", staged_details)
        self.assertIn("eventSpeakers", staged_details)
        self.assertIn("started|stopped", staged_details)
        self.assertIn("microsoft_teams_speaker_turns", staged_details)
        self.assertIn("microsoft_teams_header", staged_details)
        self.assertIn("headerDate || normaliseDateInput(rawDate)", staged_details)
        self.assertIn("durationLine", staged_details)
        self.assertIn("attendeeExtraction", staged_details)
        self.assertIn("turnCount: teamsStructure.turnCount", staged_details)
        self.assertIn("dateSource: headerDate ? 'microsoft_teams_header' : 'explicit_or_filename'", staged_details)

    def test_staged_attendee_known_name_mapping_is_wired(self):
        staged_details = (REPO_DIR / "utils" / "stagedMinutesDetails.js").read_text(encoding="utf-8")
        staged_context = (REPO_DIR / "utils" / "stagedMinutesContext.js").read_text(encoding="utf-8")
        page = (REPO_DIR / "views" / "staged-meeting-minutes.html").read_text(encoding="utf-8")

        # The known people live on the Settings page; these are its starting values.
        people = (REPO_DIR / "utils" / "settingsDefaults.js").read_text(encoding="utf-8")
        self.assertIn("function stagedPeopleRegistry", staged_context)
        self.assertIn("settingsStore.getPeople()", staged_context)
        self.assertIn("function bucketKnownStagedAttendees", staged_details)
        for name in (
            "Colm O’Rourke", "Jacqui Fox", "David Didsbury", "Conor Flynn", "Claire Nicholson",
            "Mark Kelleher", "John-Paul Hughes", "Jenny Gough", "Stuart Smith", "Grace McGroogan",
            "Andrew Kane", "Orla Skally", "Abby Lennon",
        ):
            self.assertIn(f"name: '{name}'", people)
        self.assertIn("Smith, Stuart M", people)
        self.assertIn("function canonicalStagedAttendeeAlias", staged_context)
        self.assertIn("function normaliseStagedKnownAttendeeAliasesInText", staged_context)
        self.assertNotIn("'Rebecca Cuckoo'", staged_details)
        self.assertIn("possible_attendee_name_mismatch", staged_details)
        self.assertIn("...explicitClientBuckets.internal", staged_details)
        self.assertIn("...speakerBuckets.internal", staged_details)
        self.assertIn("...unlabelledBuckets.unknown", staged_details)
        self.assertIn("...speakerBuckets.unknown", staged_details)
        self.assertIn("attendee_affiliation_unconfirmed", staged_details)
        self.assertNotIn("...(explicitClientAttendees.length ? [] : speakerBuckets.unknown)", staged_details)
        self.assertIn("knownInternalAttendeeCount", staged_details)
        self.assertIn("knownClientAttendeeCount", staged_details)
        self.assertIn("clientAttendees: attendeesFromRow(clientAttendeesRow)", page)
        self.assertIn("allAttendees: currentParticipants()", page)
        self.assertIn("renderAttendees(clientAttendeesRow, mergedDetails.clientAttendees)", page)
        self.assertNotIn("renderAttendees(clientAttendeesRow, details.allAttendees || details.clientAttendees)", page)

        client_output = (REPO_DIR / "views" / "staged-meeting-minutes-client-output.html").read_text(encoding="utf-8")
        self.assertIn("normaliseList(details.clientAttendees || details.allAttendees)", client_output)
        self.assertNotIn("normaliseList(details.allAttendees || details.clientAttendees)", client_output)

    def test_staged_attendees_and_action_owners_are_editable_from_confirmed_people(self):
        page = (REPO_DIR / "views" / "staged-meeting-minutes.html").read_text(encoding="utf-8")
        semantic = (REPO_DIR / "utils" / "canonicalMinutes" / "semanticStages.js").read_text(encoding="utf-8")

        self.assertIn('data-attendee-group="internal"', page)
        self.assertIn('data-attendee-group="client"', page)
        self.assertIn('draggable="true"', page)
        self.assertIn('attendee-drag-handle', page)
        self.assertIn('Drop attendee here', page)
        self.assertIn('contenteditable="true"', page)
        self.assertIn('data-attendee-move', page)
        self.assertIn("row === internalAttendeesRow ? 'Client' : 'Internal'", page)
        self.assertIn("function attendeeStateChanged", page)
        self.assertIn("function attendeeListsFromDetails", page)
        self.assertIn("function mergeGeneratedDetails", page)
        self.assertIn("payload && payload.stagedStage === 'details'", page)
        self.assertIn("attendeeLists.internal.join(', ')", page)
        self.assertIn("function actionOwnerOptions", page)
        self.assertIn('class="action-owner-select"', page)
        self.assertIn("Add someone new…", page)
        self.assertIn("Enter the action owner’s name:", page)
        self.assertIn("A possible commitment still needs an owner", semantic)
        self.assertNotIn("semantic commitment thread(s) require adjudication", semantic)

    def test_post_generation_terminology_qa_is_applied_with_reviewer_undo_and_audited(self):
        page = (REPO_DIR / "views" / "staged-meeting-minutes.html").read_text(encoding="utf-8")
        api = (REPO_DIR / "routes" / "api.js").read_text(encoding="utf-8")
        self.assertIn("Check these terms", page)
        self.assertIn("The tool changed ", page)
        self.assertIn("terminology-qa-details", page)
        self.assertIn("terminology-qa-details-body", page)
        self.assertIn("applyAutomaticTerminologyCorrections", page)
        self.assertIn("undoTerminologyCorrection", page)
        self.assertIn("function groupedTerminologyItems", page)
        self.assertIn("Changed in ' + group.items.length + ' places.", page)
        self.assertIn("Go to first field", page)
        self.assertIn("Undo all", page)
        self.assertIn("qa-field-highlight", page)
        self.assertIn("decideTerminologySuggestion", page)
        self.assertIn("terminology-qa/suggestions", api)
        self.assertIn("terminology-qa/decision", api)

    def test_staged_review_checks_persist_stable_resolved_keys(self):
        page = (REPO_DIR / "views" / "staged-meeting-minutes.html").read_text(encoding="utf-8")

        self.assertIn("resolvedReviewCheckKeys", page)
        self.assertIn("function reviewCheckIsResolved(key)", page)
        self.assertIn("resolvedReviewCheckKeys[resolvedKey] = true", page)
        self.assertIn("if (flagResolved) return;", page)
        self.assertIn("resolvedReviewCheckKeys: resolvedReviewCheckKeys", page)
        self.assertIn("existing.resolvedReviewCheckKeys", page)
        self.assertIn("resolveGroupedReviewItems(text.textContent, row, groupedReviewKeys)", page)
        self.assertIn("resolveReviewItem('Reviewed and dismissed transcript snippet.'", page)

    def test_staged_review_analytics_are_persisted_server_side(self):
        page = (REPO_DIR / "views" / "staged-meeting-minutes.html").read_text(encoding="utf-8")
        api = (REPO_DIR / "routes" / "api.js").read_text(encoding="utf-8")
        analytics = (REPO_DIR / "utils" / "stagedReviewAnalytics.js").read_text(encoding="utf-8")
        db = (REPO_DIR / "utils" / "db.js").read_text(encoding="utf-8")
        migration = (REPO_DIR / "sql" / "migrations" / "20260814_add_staged_review_analytics.sql").read_text(encoding="utf-8")

        self.assertIn("generatedStageVersions", page)
        self.assertIn("reviewAnalyticsPayload", page)
        self.assertIn("/api/staged-meeting-minutes/review-events", page)
        self.assertIn("final_review_completed", page)
        self.assertIn("terminologyDecisionEvents", page)
        self.assertIn("unresolvedWorkstreamList", page)
        self.assertIn("workflowInteractionEvents", page)
        self.assertIn("stage_continue_clicked", page)
        self.assertIn("action_candidate_accepted", page)
        self.assertIn("manual_action_added", page)
        self.assertIn("pdf_download_succeeded", page)
        self.assertIn("workflow_abandonment_signal", page)
        self.assertIn("buildStagedReviewDiffs", api)
        self.assertIn("stagedWorkflowInteractionEvents", api)
        self.assertIn("summariseStagedWorkflowInteractions", api)
        self.assertIn("interactionSummary", api)
        self.assertIn("wording_or_formatting_edit", analytics)
        self.assertIn("substantive_rewrite", analytics)
        self.assertIn("structural_or_semantic_change", analytics)
        self.assertIn("saveStagedMeetingMinutesReviewEvent", db)
        self.assertIn("staged_meeting_minutes_review_events", migration)
        self.assertIn("field_diffs JSONB", migration)
        self.assertIn("regeneration_events JSONB", migration)
        self.assertIn("terminology_decisions JSONB", migration)
        self.assertIn("final_review_completed BOOLEAN", migration)

    def test_staged_transcript_prep_is_deterministic_and_keeps_raw_source(self):
        api = (REPO_DIR / "routes" / "api.js").read_text(encoding="utf-8")
        staged_queue = (REPO_DIR / "utils" / "stagedMinutesQueue.js").read_text(encoding="utf-8")
        staged_evaluation = (REPO_DIR / "utils" / "stagedMinutesEvaluation.js").read_text(encoding="utf-8")
        staged_context = (REPO_DIR / "utils" / "stagedMinutesContext.js").read_text(encoding="utf-8")
        staged_response = (REPO_DIR / "utils" / "stagedMinutesCanonicalResponse.js").read_text(encoding="utf-8")
        db = (REPO_DIR / "utils" / "db.js").read_text(encoding="utf-8")

        self.assertIn("function buildPreparedTranscriptForStagedAI", staged_context)
        self.assertIn("deterministic_stage_1_prep", staged_context)
        self.assertIn("transcriptionEvent", staged_context)
        self.assertIn("timestampOnly", staged_context)
        self.assertIn("prepared.push(spoken ? `${speaker}: ${spoken}`", staged_context)
        self.assertIn("function transcriptForStagedAI", staged_context)
        self.assertIn("sourceJob.preparedTranscript", api)
        self.assertIn("canonicalStagedResponse(stage, transcript, input)", staged_evaluation)
        self.assertIn("runCanonicalLiveStage(semanticTranscript.text", staged_response)
        self.assertIn("rawTranscriptLength: transcript.text.length", staged_queue)
        self.assertIn("preparedTranscriptLength", staged_queue)
        self.assertIn("autosavePayload.preparedTranscript", db)
        self.assertIn("preparedTranscript: payload.preparedTranscript || null", db)
        self.assertIn("preparedTranscriptTelemetry: payload.preparedTranscriptTelemetry || null", db)
        self.assertIn("transcript_text, transcript_length", db)

    def test_staged_generation_has_visible_loading_state(self):
        page = (REPO_DIR / "views" / "staged-meeting-minutes.html").read_text(encoding="utf-8")

        self.assertIn(".review-status.is-loading", page)
        self.assertIn("animation:spin", page)
        self.assertIn("Generating:", page)
        self.assertIn("Denoising and organising discussion evidence.", (REPO_DIR / "utils" / "stagedMinutesQueue.js").read_text(encoding="utf-8"))
        self.assertIn("Elapsed:", page)
        self.assertIn("You can close this tab and resume from Library.", page)
        self.assertIn("isTransientStagePollError", page)
        self.assertIn("Connection hiccup. Still checking the staged generation job", page)
        self.assertIn("maxTransientPollFailures", page)
        self.assertIn("document.body.classList.add('stage-loading')", page)
        self.assertIn("aria-busy", page)
        self.assertIn("https://unpkg.com/lucide@latest/dist/umd/lucide.min.js", page)

    def test_staged_review_uses_guided_locked_stage_flow(self):
        page = (REPO_DIR / "views" / "staged-meeting-minutes.html").read_text(encoding="utf-8")

        self.assertIn("stage-decision-card", page)
        self.assertIn("Want to move onto the next stage?", page)
        self.assertIn("'Continue to ' + nextLabel.toLowerCase()", page)
        self.assertNotIn("'Yes, generate ' + nextLabel", page)
        self.assertNotIn("'Yes, move to ' + nextLabel", page)
        # "No, keep reviewing" was removed: it navigated nowhere and cancelled
        # nothing, because staying on the stage is already what happens if you
        # do not move on. It asked the reviewer to press a button to take no
        # action, beside the button that does.
        self.assertNotIn("No, keep reviewing", page)
        self.assertIn("function highestReachableScreen", page)
        self.assertIn("function lockedStageMessage", page)
        self.assertIn("item.classList.toggle('locked'", page)
        self.assertIn('data-lucide="lock"', page)
        self.assertIn('data-lucide="check"', page)
        self.assertIn("stageAdditionalContext", page)
        self.assertIn('aria-label="Optional context for the next step"', page)
        self.assertIn("formData.append('additionalContext'", page)
        self.assertIn("existing.additionalContext", page)
        self.assertNotIn("activeIndex === 0 && nextIndex === 1", page)
        self.assertIn("if (index === 1) return 'discussion'", page)
        self.assertIn("if (index === 2) return 'actions'", page)
        self.assertIn("stageNeedsGeneration(target)", page)
        self.assertIn("/api/staged-meeting-minutes/jobs?stage=", page)
        self.assertIn("stageJobId", page)
        self.assertIn("function stagedJobIsStale", page)
        self.assertIn("This staged generation had stalled. Requeuing it safely before resuming", page)
        self.assertIn("'/retry', { method: 'POST' }", page)
        self.assertIn("await pollStageJobUntilDone(stageJobId, resumedStage, targetScreen)", page)
        self.assertNotIn("Opening the job tracker.", page)
        self.assertIn("sourceJobId", page)
        self.assertIn("transcriptText || transcriptFile || storedTranscriptText || stagedSourceJobId || draftId", page)
        self.assertIn("No substantive discussion sections generated", page)
        self.assertIn('class="discussion-table"', page)
        self.assertIn("<th>Topic</th><th>Discussion points</th>", page)
        self.assertIn("discussion-topic-input", page)
        self.assertIn("discussion-points-input", page)
        self.assertIn("cleanDiscussionDisplayText", page)
        self.assertIn("linesFromDiscussionTextarea", page)
        self.assertIn("querySelector('.discussion-topic-input')", page)
        self.assertIn("querySelector('.discussion-points-input')", page)
        self.assertIn('id="addActionRowBtn"', page)
        self.assertIn('data-action-row="duplicate"', page)
        self.assertIn('data-action-row="delete"', page)
        self.assertNotIn("Add topic row", page)
        self.assertNotIn("Reorder topics", page)
        self.assertNotIn("Change owner", page)
        self.assertNotIn("Staging note:", page)
        self.assertNotIn("safeguard-banner", page)
        self.assertNotIn("What was discussed", page)
        self.assertNotIn("Hidden telemetry preview", page)
        self.assertNotIn("Final report preview", page)
        self.assertNotIn("telemetry-panel", page)
        self.assertIn("discussion-card", page)
        self.assertIn("discussion-card-chevron", page)
        self.assertIn('data-lucide="chevron-down"', page)
        self.assertIn('data-discussion-delete', page)
        self.assertIn('data-lucide="trash-2"', page)
        self.assertIn("Are you sure you want to remove this row?", page)
        self.assertNotIn('id="meetingPurpose"', page)
        self.assertNotIn('id="keyFactsList"', page)
        self.assertIn('id="actionReviewGroups"', page)
        self.assertIn('id="remainingReviewCount"', page)
        self.assertNotIn('id="reviewToolbar"', page)
        self.assertIn("<th>Owner</th><th>Action</th><th>Due</th>", page)
        self.assertNotIn("<h3>Topics discussed</h3>", page)
        self.assertNotIn(" with no date stated", page)

    def test_resume_links_name_their_stage_rather_than_a_screen_index(self):
        page = (REPO_DIR / "views" / "staged-meeting-minutes.html").read_text(encoding="utf-8")
        client_output = (REPO_DIR / "views" / "staged-meeting-minutes-client-output.html").read_text(encoding="utf-8")
        jobs = (REPO_DIR / "views" / "meeting-minutes-jobs.html").read_text(encoding="utf-8")

        # Screen indices shifted when Summary was removed, and links outlive a renumbering.
        # The stage a link names still means the same thing afterwards, so it is what the
        # page reads; an index arriving on its own is read in the numbering that wrote it.
        self.assertIn("var STAGE_SCREEN_INDEX = { details: 0, discussion: 1, actions: 2, final_review: 3 }", page)
        self.assertIn("var LEGACY_SCREEN_INDEX = [0, 1, 1, 2, 3]", page)
        self.assertIn("function resolveScreenIndex", page)
        self.assertIn("function migrateLegacyScreenIndex", page)
        self.assertIn("resolveScreenIndex({ stage: params.get('stage'), screen: params.get('screen') })", page)

        # Everything that writes a link or a draft names the stage in it.
        self.assertIn("'&stage=' + encodeURIComponent(stageNameForScreen(activeIndex))", page)
        self.assertIn("activeStage: stageNameForScreen(activeIndex)", page)
        self.assertIn("stage=final_review&screen=3", client_output)
        self.assertNotIn("&screen=4", client_output)

        # The Library resolves a draft the same way, and its step list is the flow as it is
        # now - a list still carrying Summary marked the wrong step as the one to resume.
        self.assertIn("function stagedActiveScreen", jobs)
        self.assertIn("function stagedActiveStage", jobs)
        self.assertIn("const STAGED_LEGACY_SCREEN_INDEX = [0, 1, 1, 2, 3]", jobs)
        self.assertIn("activeScreen: stagedActiveScreen(draft)", jobs)
        self.assertIn("const steps = ['Details', 'Discussion', 'Actions', 'Final review']", jobs)

        # A queued job's stage decides where it resumes, not the index it recorded.
        self.assertIn("var jobStageScreen = screenIndexForStage(params.get('stage') || payload.job.inputPayload?.stage)", page)
        self.assertNotIn("Number(params.get('screen') || requestedScreen || payload.job.inputPayload?.targetScreen || 0)", page)

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

    def test_reviewer_confirmed_purpose_and_key_facts_are_threaded_downstream(self):
        api = (REPO_DIR / "routes" / "api.js").read_text(encoding="utf-8")
        staged_response = (REPO_DIR / "utils" / "stagedMinutesCanonicalResponse.js").read_text(encoding="utf-8")
        canonical_state = (REPO_DIR / "utils" / "canonicalMinutes" / "state.js").read_text(encoding="utf-8")
        canonical_live = (REPO_DIR / "utils" / "canonicalMinutes" / "liveStages.js").read_text(encoding="utf-8")
        semantic_stages = (REPO_DIR / "utils" / "canonicalMinutes" / "semanticStages.js").read_text(encoding="utf-8")
        semantic_authority = (REPO_DIR / "utils" / "stagedSemanticAuthority.js").read_text(encoding="utf-8")

        self.assertIn("buildConfirmedUnderstanding", semantic_authority)
        self.assertIn("repairDiscussionForConfirmedUnderstanding", semantic_authority)
        self.assertIn("meetingPurpose: firstString(confirmedSummary.meetingPurpose", api)
        self.assertIn("keyFacts: confirmedUnderstanding.criticalFacts.map((fact) => fact.text)", api)
        self.assertIn("confirmedUnderstanding,", api)
        self.assertIn("reviewerConfirmedFactPreservation", staged_response)
        self.assertIn("meetingUnderstanding", canonical_state)
        self.assertIn("const meetingUnderstanding = buildConfirmedUnderstanding(summary)", canonical_live)
        self.assertIn("criticalFacts: meetingUnderstanding.criticalFacts.map((fact) => fact.text)", canonical_live)
        self.assertIn("repairDiscussionForConfirmedUnderstanding", semantic_stages)

    def test_staged_transcript_identity_isolated_between_drafts(self):
        api = (REPO_DIR / "routes" / "api.js").read_text(encoding="utf-8")
        staged_queue = (REPO_DIR / "utils" / "stagedMinutesQueue.js").read_text(encoding="utf-8")
        page = (REPO_DIR / "views" / "staged-meeting-minutes.html").read_text(encoding="utf-8")
        identity = (REPO_DIR / "utils" / "stagedIdentity.js").read_text(encoding="utf-8")

        self.assertIn("assertStagedSourceIdentity", api)
        self.assertIn("assertStagedTranscriptHash", api)
        self.assertIn("input.transcriptSha256", staged_queue)
        self.assertIn("transcriptIdentity.transcriptSha256", staged_queue)
        self.assertIn("sourceJob.inputPayload?.draftId", api)
        self.assertIn("sourceJob.inputPayload?.transcriptSha256", api)
        self.assertIn("STAGED_TRANSCRIPT_IDENTITY_MISMATCH", identity)
        self.assertIn("function resetStagedWorkflowForNewTranscript", page)
        self.assertIn("resetStagedWorkflowForNewTranscript();", page)
        self.assertIn("draftTranscriptSha256", page)
        self.assertIn("formData.append('transcriptSha256'", page)
        self.assertIn("window.crypto.randomUUID", page)

    def test_post_extraction_editorial_pass_is_wired_in(self):
        api = (REPO_DIR / "routes" / "api.js").read_text(encoding="utf-8")
        staged_queue = (REPO_DIR / "utils" / "stagedMinutesQueue.js").read_text(encoding="utf-8")
        staged_evaluation = (REPO_DIR / "utils" / "stagedMinutesEvaluation.js").read_text(encoding="utf-8")
        staged_context = (REPO_DIR / "utils" / "stagedMinutesContext.js").read_text(encoding="utf-8")
        staged_response = (REPO_DIR / "utils" / "stagedMinutesCanonicalResponse.js").read_text(encoding="utf-8")
        editorial = (REPO_DIR / "utils" / "stagedEditorial.js").read_text(encoding="utf-8")

        # The editorial helpers live in a dependency-free util so they can be unit
        # tested without the router/db, and are wired into the staged flow.
        self.assertIn("require('../utils/stagedEditorial')", api)
        self.assertIn("isMalformedStagedLine", staged_context)
        self.assertIn("hasStagedDecisionEvidence", staged_evaluation)
        self.assertIn("dedupeStagedDiscussionCards", api)
        self.assertIn("buildStagedValidationFlags", api)

        # Cross-section de-duplication runs after per-card polishing, and the
        # decision/agreement label is dropped without supporting evidence.
        self.assertIn("if (isMalformedStagedLine(cleaned)) return true;", staged_context)

        # Advisory flags are attached to the staged payloads (never auto-fixed away).
        self.assertIn("validationFlags,", api)
        self.assertIn("function stagedReviewContextFromRequest", api)
        self.assertIn("const reviewContext = stagedReviewContextFromRequest(req)", api)
        self.assertIn("reviewObjectives: input.reviewObjectives || ''", staged_queue)
        self.assertIn("reviewDiscussion: input.reviewDiscussion || ''", staged_queue)
        self.assertIn("reviewActions: input.reviewActions || ''", staged_queue)
        self.assertIn("function serialiseActionReviewCandidate", staged_response)
        self.assertIn("action-candidate-${stableActionCandidateHash(candidate)}", staged_response)
        self.assertIn("resolutionKey: `action-review-candidates:", staged_response)

        # The util exposes the mechanical fixers and the advisory flag builder.
        for name in (
            "function isMalformedStagedLine",
            "function hasStagedDecisionEvidence",
            "function dedupeStagedDiscussionCards",
            "function buildStagedValidationFlags",
        ):
            self.assertIn(name, editorial)
        self.assertIn("duplicate_section", editorial)
        self.assertIn("malformed_text", editorial)
        self.assertIn("possible_omitted_workstream", editorial)

    def test_staged_view_renders_advisory_validation_flags(self):
        page = (REPO_DIR / "views" / "staged-meeting-minutes.html").read_text(encoding="utf-8")

        self.assertIn("id=\"stageValidationFlags\"", page)
        self.assertIn("function renderValidationFlags", page)
        self.assertIn("function addValidationSuggestionToDiscussion", page)
        self.assertIn("Add to discussion", page)
        self.assertIn("if (flag && flag.discussionSuggestion)", page)
        self.assertIn("renderValidationFlags(payload && payload.validationFlags, payload && payload.stagedStage, payload && payload.actionReviewCandidates)", page)
        self.assertIn("formData.append('reviewObjectives'", page)
        self.assertIn("formData.append('reviewDiscussion'", page)
        self.assertIn("formData.append('reviewActions'", page)
        self.assertIn("Editorial checks (review before moving on)", page)

    def test_transcript_health_is_raised_on_the_first_screen(self):
        staged_response = (REPO_DIR / "utils" / "stagedMinutesCanonicalResponse.js").read_text(encoding="utf-8")
        health = (REPO_DIR / "utils" / "stagedTranscriptHealth.js").read_text(encoding="utf-8")

        # A partly read transcript makes every later stage thin, so the warning
        # belongs on details (screen 0) rather than summary (screen 1), where a
        # reviewer would already have spent time editing it.
        self.assertIn("if (stage === 'details') {\n    const healthFlag = stagedTranscriptHealthFlag(transcriptHealth);", staged_response)
        self.assertNotIn("if (stage === 'summary') {\n    const healthFlag", staged_response)
        self.assertIn("transcript_partially_parsed", health)
        self.assertIn("isPartiallyParsed(parseCoverage)", health)
        self.assertIn("measureParseCoverage", health)

        coverage = (REPO_DIR / "utils" / "canonicalMinutes" / "parseCoverage.js").read_text(encoding="utf-8")

        # The ratio needs an absolute floor beside it, or the warning fires on
        # roughly half the corpus and stops meaning anything.
        self.assertIn("PARTIAL_COVERAGE_THRESHOLD = 0.85", coverage)
        self.assertIn("MIN_UNREAD_CHARS = 200", coverage)
        self.assertIn("LARGE_UNREAD_CHARS = 2000", coverage)

    def test_topic_headings_pass_one_gate_before_a_reviewer_sees_them(self):
        editorial = (REPO_DIR / "utils" / "canonicalMinutes" / "topicEditorial.js").read_text(encoding="utf-8")
        stages = (REPO_DIR / "utils" / "canonicalMinutes" / "semanticStages.js").read_text(encoding="utf-8")

        # Several functions mint topic labels. The gate is applied once, over the
        # assembled cards, so a label source added later cannot bypass it.
        self.assertIn("function isPublishableTopicLabel", editorial)
        self.assertIn("function publishableTopicCards", editorial)
        self.assertIn("discussion: publishableDiscussion", stages)

        # A reviewer's own wording is never second-guessed. The exemption used to read
        # card?.confirmedTopic directly, and that flag was set only by
        # applyConfirmedTopicAgenda - which runs on the branch taken when there is no
        # planned discussion, never on the branch taken because the reviewer confirmed
        # topics. Going through isReviewerAuthored covers both, and cards built from a
        # confirmed plan now carry the flag.
        self.assertIn("isReviewerAuthored(card) || isPublishableTopicLabel", editorial)
        self.assertIn("const { isReviewerAuthored } = require('./state')", editorial)
        self.assertIn("confirmedTopic: workstream.provenance === 'reviewer_confirmed'", stages)

        # An empty discussion says why rather than showing a blank screen.
        self.assertIn("discussion_topics_not_publishable", stages)

        # /does?/ matches "doe", not "do" - the word the guard exists to catch.
        for path in ("utils/canonicalMinutes/topicEditorial.js", "utils/stagedEditorial.js"):
            source = (REPO_DIR / path).read_text(encoding="utf-8")
            self.assertNotIn("|does?|did)", source, f"{path} still has the doe/do slip")
            self.assertIn("|do(?:es)?|did)", source)

        # No transcript-specific phrase belongs in editorial policy.
        self.assertNotIn("belt and braces", editorial.lower())

    def test_staged_reviewer_copy_and_controls_hide_internal_processing_terms(self):
        page = (REPO_DIR / "views" / "staged-meeting-minutes.html").read_text(encoding="utf-8")
        staged_queue = (REPO_DIR / "utils" / "stagedMinutesQueue.js").read_text(encoding="utf-8")

        self.assertIn("review-check-button", page)
        self.assertIn("review-check-text-button", page)
        self.assertIn("review-target-button", page)
        self.assertIn("stage-validation-actions", page)
        self.assertIn("review-field-note", page)
        self.assertIn("stage-review-targeted", page)
        self.assertIn("Show in table", page)
        self.assertIn("✓ Reviewed", page)
        self.assertIn("review prompt' + (outstanding === 1 ? '' : 's') + ' to check'", page)
        self.assertIn("Actions are grouped below to help you review them.", page)
        self.assertIn("function reviewerFlagMessage", page)
        self.assertIn("Ready to approve the PDF?", page)
        self.assertIn("Before you finish", page)
        self.assertIn("Review in Actions", page)
        self.assertIn("Looks OK", page)
        self.assertIn("possible action' + (flag.repairCandidates.length === 1 ? ' still needs' : 's still need') + ' a decision", page)
        self.assertIn("function applyReviewFlagAnnotations", page)
        self.assertIn("function focusReviewFlagTarget", page)
        self.assertIn("renderedMessages[messageKey].push(flagKey)", page)
        self.assertIn("resolveGroupedReviewItems", page)
        self.assertIn("You’ve reviewed all editorial checks.", page)
        self.assertIn("function drawAttentionToEditorialChecks", page)
        self.assertIn("editorial-check-flash", page)
        self.assertIn("remainingReviewCount.hidden = activeIndex !== 3 || !outstanding", page)
        self.assertNotIn("Review next item", page)
        self.assertNotIn("nextReviewItemBtn", page)
        self.assertNotIn("Ready to move onto Summary?", page)
        self.assertNotIn("Continue when Details looks right, or add anything you’d like the next step to emphasise.", page)
        self.assertIn("['Details', 'Discussion', 'Actions', 'Final review']", page)
        self.assertNotIn("Anything else to add?", page)
        self.assertIn("stage-autosave-bottom", page)
        self.assertIn("action-candidate-meta", page)
        self.assertIn("' transcript snippet' + (entries.length === 1 ? '' : 's')", page)
        self.assertIn('that may contain actions</summary>', page)
        self.assertIn('Review these snippets and turn any genuine commitments into actions.', page)
        self.assertIn('aria-label="Create action from transcript snippet"', page)
        self.assertIn('aria-label="Dismiss transcript snippet"', page)
        self.assertIn(">Create action</button>", page)
        self.assertIn(">× Dismiss</button>", page)
        self.assertNotIn('Other possible follow-ups', page)
        self.assertIn("function validReviewerOwner", page)
        self.assertIn(">Add owner</option>", page)
        self.assertNotIn("Mark reviewed", page)
        self.assertNotIn("Running canonical ${stage} evidence classification.", staged_queue)
        self.assertIn("Reviewing discussion evidence.", staged_queue)
        self.assertIn("Reviewing action evidence.", staged_queue)

    def test_staged_export_uses_one_server_generated_pdf_for_download_and_preview(self):
        page = (REPO_DIR / "views" / "staged-meeting-minutes.html").read_text(encoding="utf-8")
        output = (REPO_DIR / "views" / "staged-meeting-minutes-client-output.html").read_text(encoding="utf-8")
        api = (REPO_DIR / "routes" / "api.js").read_text(encoding="utf-8")
        pdf = (REPO_DIR / "utils" / "stagedMinutesPdf.js").read_text(encoding="utf-8")

        self.assertIn('id="exportClientPdfBtn"', page)
        self.assertIn('id="previewClientPdfBtn"', page)
        self.assertIn("function generatedClientPdf", page)
        self.assertIn("/api/staged-meeting-minutes/pdf", page)
        self.assertIn("generatedPdfCache", page)
        self.assertIn("Download PDF", page)
        self.assertIn("Preview PDF", page)
        self.assertIn("router.post('/staged-meeting-minutes/pdf'", api)
        self.assertIn("displayHeaderFooter: false", pdf)
        self.assertIn("Content-Disposition", api)
        self.assertNotIn("Export, email and save are still disabled", page)
        self.assertNotIn("window.print()", page)
        self.assertNotIn("window.print()", output)


if __name__ == "__main__":
    unittest.main()
