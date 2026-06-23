import sys
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from meeting_minutes_minilm_experiment import (
    collect_minilm_only_context,
    collect_action_candidates,
    collect_discussion_candidates,
    build_minilm_only_output,
    derive_meeting_objectives,
    synthesize_meeting_scope_objective,
    formalize_transcript_discussion_point,
    has_concrete_action_commitment,
    infer_minilm_meeting_title,
    apply_client_facing_minutes_schema,
    detail_budget_for_meeting,
    enrich_discussion_point_details,
    is_safe_deterministic_discussion_fallback,
    is_valid_discussion_point,
    is_low_quality_objective_text,
    sanitize_public_output_items,
    should_keep_discussion_candidate,
    should_accept_action_candidate,
    explicit_action_object,
    cluster_has_clear_topic,
    is_keyword_soup_sentence,
    public_discussion_sentence_from_evidence,
    public_sentence_supported_by_evidence,
    public_attributed_sentence_from_evidence_item,
    public_speaker_name,
    is_context_dependent_meta_question,
    is_facilitation_self_check_text,
    is_context_dependent_opening,
    normalize_public_attributed_sentence,
    infer_theme_label_from_evidence,
    is_social_banter_text,
    derive_evidence_backed_meeting_objectives,
    enforce_evidence_first_final_contract,
    strip_action_deadline_phrase,
    _sanitize_rewritten_minutes_text,
    sanitize_public_minutes_text,
)

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"


class DeterministicMiniLMBackend:
    available = True
    reason = "deterministic test backend"
    model_name = "deterministic-test"

    _dimensions = (
        "ai", "pipeline", "sales", "liam", "webinar", "webinars", "vendor", "strategy",
        "stage", "gate", "intake", "funnel", "sow", "sows", "grant", "commercial",
        "impact", "report", "status", "blocked", "track", "complete",
    )

    def encode_many(self, texts):
        lookup = {}
        for text in texts:
            cleaned = " ".join(str(text).split())
            if not cleaned:
                continue
            tokens = set(cleaned.lower().replace(".", "").replace(",", "").split())
            lookup[cleaned] = [1.0 if dimension in tokens else 0.0 for dimension in self._dimensions]
        return lookup

    def score_against_prototypes(self, text, prototype_group):
        lowered = str(text).lower()
        if prototype_group == "action":
            return 0.72 if any(term in lowered for term in ("confirm", "follow up", "review", "validate", "draft")) else 0.08
        if prototype_group == "status":
            return 0.82 if any(term in lowered for term in ("blocked", "on track", "in progress", "complete", "scheduled", "green", "amber", "under pressure")) else 0.25
        if prototype_group == "blocker":
            return 0.82 if any(term in lowered for term in ("blocked", "risk", "under pressure", "sales input")) else 0.08
        if prototype_group == "milestone":
            return 0.72 if any(term in lowered for term in ("milestone", "pipeline", "webinar", "vendor", "stage", "sow", "grant", "intake")) else 0.15
        if prototype_group == "discussion":
            return 0.62 if len(lowered.split()) > 5 else 0.15
        return 0.05


class MeetingMinutesMiniLMQualityTest(unittest.TestCase):
    def test_public_minutes_repairs_stitched_sentence_boundaries(self):
        self.assertEqual(
            sanitize_public_minutes_text(
                "Data mapping for finance is ready, but warehouse is still missing three required fields We will start onboarding with finance first."
            ),
            "Data mapping for finance is ready, but warehouse is still missing three required fields. We will start onboarding with finance first.",
        )
        self.assertEqual(
            sanitize_public_minutes_text(
                "The basic UDI numbers go in So all characteristics are entered at that level. may be in trouble."
            ),
            "The basic UDI numbers go in. So all characteristics are entered at that level. May be in trouble.",
        )

    def test_client_facing_schema_is_added_without_removing_legacy_fields(self):
        output = {
            "meetingTitle": "Customer Onboarding Review",
            "meetingLocation": "",
            "discussionPoints": ["Finance onboarding is ready."],
            "actions": [
                {
                    "meetingActionPoint": "Send the missing-field list.",
                    "meetingActionPointOwner": "Mina",
                    "meetingActionPointDeadline": "Today",
                }
            ],
            "meetingActionPoint": ["Send the missing-field list."],
        }

        apply_client_facing_minutes_schema(output)

        self.assertEqual(output["meetingLocation"], "Online")
        self.assertEqual(output["itemTopic"], "Customer Onboarding Review")
        self.assertEqual(
            output["meetingMinutes"],
            [{"topic": "Customer Onboarding Review", "discussionPoints": ["Finance onboarding is ready."]}],
        )
        self.assertEqual(
            output["nextSteps"],
            [{"action": "Send the missing-field list.", "owner": "Mina", "deadline": "Today"}],
        )
        self.assertEqual(output["meetingActionPoint"], ["Send the missing-field list."])

    def test_client_facing_schema_uses_evidence_backed_detail_sections_when_available(self):
        output = {
            "meetingTitle": "Importer Obligations Review",
            "meetingLocation": "",
            "discussionPoints": ["The importer obligations review covered QMS alignment and documentation gaps."],
            "discussionPointDetails": [
                {
                    "discussionPoint": "The importer obligations review covered QMS alignment and documentation gaps.",
                    "cleanedCandidateSentences": [
                        "The quality manual needs to align with the importer responsibilities.",
                        "The documentation pack is missing evidence for some role boundaries.",
                    ],
                    "_evidence": [
                        {"speaker": "A", "timestamp": "00:01", "text": "The quality manual needs to align with the importer responsibilities.", "turnIndex": 1},
                        {"speaker": "B", "timestamp": "00:02", "text": "The documentation pack is missing evidence for some role boundaries.", "turnIndex": 2},
                    ],
                    "sourceTurnIndices": [1, 2],
                }
            ],
            "actions": [],
        }

        enrich_discussion_point_details(output, {"level": "detailed", "supportingContext": 2})
        apply_client_facing_minutes_schema(output)

        self.assertEqual(len(output["meetingMinutes"]), 1)
        minute = output["meetingMinutes"][0]
        self.assertEqual(minute["detailLevel"], "detailed")
        self.assertNotIn("summary", minute)
        self.assertEqual(minute["topicLabel"], "The importer obligations review covered QMS alignment and documentation gaps")
        self.assertIn("The quality manual needs to align with the importer responsibilities.", minute["supportingContext"])
        self.assertIn("The documentation pack is missing evidence for some role boundaries.", minute["supportingContext"])
        self.assertEqual(minute["evidenceSupportCount"], 2)

    def test_detail_budget_adapts_to_transcript_density_without_content_hardcoding(self):
        short_budget = detail_budget_for_meeting({"records": [{"text": "Short update."}] * 20}, "Short update")
        dense_budget = detail_budget_for_meeting({"records": [{"text": "Detailed update."}] * 260}, "QMS importer obligations review")

        self.assertEqual(short_budget["level"], "basic")
        self.assertEqual(short_budget["supportingContext"], 1)
        self.assertEqual(dense_budget["level"], "detailed")
        self.assertGreater(dense_budget["discussionPoints"], short_budget["discussionPoints"])
        self.assertGreater(dense_budget["supportingContext"], short_budget["supportingContext"])

    def test_public_speaker_name_uses_first_name_only(self):
        self.assertEqual(public_speaker_name("Mark Kelleher"), "Mark")
        self.assertEqual(public_speaker_name("Jacqui O'Brien"), "Jacqui")
        self.assertEqual(public_speaker_name("Meeting"), "The speaker")

    def test_social_banter_is_not_attributed_as_discussion_detail(self):
        evidence = {"speaker": "Jacqui", "text": "Oh, you have the doggy in work today again, I see.", "turnIndex": 12}

        self.assertTrue(is_social_banter_text(evidence["text"]))
        self.assertEqual(public_attributed_sentence_from_evidence_item(evidence), "")

    def test_evidence_backed_topics_expand_into_attributed_detail_points(self):
        transcript = """Meeting: Client working session planning
Mark: The applicable regulatory requirements can go into the procedure, but it only becomes meaningful if we understand how DISA actually works day to day.
Jacqui: We should schedule recurring working sessions with the client next week so we can go through outstanding questions and information gaps.
Jenny: The warehouse process matters because we need to understand scanners, ERP records and verification activities.
John-Paul: The labels need a regulatory review, especially if an IFU is introduced, because the label symbols and IFU explanations need to be consistent.
Jacqui: PPE requirements should be included for the sunglasses, and I will confirm that approach with the client.
"""
        output, _diagnostics = build_minilm_only_output(
            transcript,
            collect_minilm_only_context(transcript),
            DeterministicMiniLMBackend(),
            rewriter=None,
            include_diagnostics=True,
        )

        discussion_points = output.get("discussionPoints", [])
        self.assertGreaterEqual(len(discussion_points), 4)
        self.assertTrue(all((" said that " in point or " mentioned that " in point or " asked whether " in point) for point in discussion_points))
        self.assertTrue(any("working sessions" in point.lower() for point in discussion_points))
        self.assertTrue(any("warehouse" in point.lower() for point in discussion_points))
        self.assertTrue(any("labels" in point.lower() or "ifu" in point.lower() for point in discussion_points))
        self.assertTrue(any(topic.get("attributedDetailPoints") for topic in output.get("evidenceBackedTopics", [])))
        self.assertTrue(any(topic.get("themeLabel") for topic in output.get("evidenceBackedTopics", [])))
        self.assertIn("Define the engagement approach needed to develop client-specific QMS and regulatory documentation.", output.get("meetingObjectives", []))

    def test_evidence_backed_objectives_are_derived_from_meeting_themes(self):
        output = {
            "evidenceBackedTopics": [
                {
                    "themeLabel": "Working session approach",
                    "topicLabel": "Mark said that the applicable regulatory requirements needed to be incorporated into the procedure and aligned with how DISA works.",
                    "attributedDetailPoints": ["Jacqui said that we should schedule recurring working sessions with the client next week."],
                    "directEvidence": [{"text": "QMS regulatory procedure client working sessions DISA business process"}],
                }
            ]
        }

        self.assertEqual(
            derive_evidence_backed_meeting_objectives(output)[0],
            "Define the engagement approach needed to develop client-specific QMS and regulatory documentation.",
        )

    def test_theme_label_infers_chatgpt_style_groups_without_generation(self):
        self.assertEqual(infer_theme_label_from_evidence(["recurring working sessions with the client next week"]), "Working session approach")
        self.assertEqual(infer_theme_label_from_evidence(["Declarations of Conformity may need translation into all EU languages"]), "Declaration of Conformity language requirements")
        self.assertEqual(infer_theme_label_from_evidence(["label symbols and IFU explanations must be consistent"]), "Labelling and IFU considerations")

    def test_broken_attribution_prefixes_are_repaired_or_rejected(self):
        self.assertEqual(
            normalize_public_attributed_sentence("Mark said that. It's minimal impact to the organisation when these are rolled out."),
            "Mark said that it's minimal impact to the organisation when these are rolled out.",
        )
        self.assertEqual(normalize_public_attributed_sentence("Jacqui said that and required documents from a compliance point of view."), "")
        self.assertEqual(normalize_public_attributed_sentence("Jenny asked whether it is, it's by SKU."), "")
        self.assertEqual(normalize_public_attributed_sentence("Jacqui said that it was around the QMS manual or that."), "")

    def test_context_dependent_meta_questions_are_not_discussion_points(self):
        evidence = {
            "speaker": "Mark Kelleher",
            "text": "Is this what you were talking about a minute ago?",
            "turnIndex": 9,
        }

        self.assertTrue(is_context_dependent_meta_question(evidence["text"]))
        self.assertEqual(public_attributed_sentence_from_evidence_item(evidence), "")

    def test_facilitation_self_checks_are_not_discussion_points(self):
        evidence = {
            "speaker": "Jacqui",
            "text": "Have I addressed that right and is that the correct reflection of how it works?",
            "turnIndex": 18,
        }

        self.assertTrue(is_facilitation_self_check_text(evidence["text"]))
        self.assertEqual(public_attributed_sentence_from_evidence_item(evidence), "")
        self.assertEqual(normalize_public_attributed_sentence("Jacqui asked whether Have I addressed that right and is that the correct reflection of how it works."), "")

    def test_context_dependent_conditional_fragments_are_not_standalone_points(self):
        evidence = {
            "speaker": "Mark",
            "text": "If that's not the case, then things will just diverge and it won't be followed.",
            "turnIndex": 22,
        }

        self.assertTrue(is_context_dependent_opening(evidence["text"]))
        self.assertEqual(public_attributed_sentence_from_evidence_item(evidence), "")
        self.assertEqual(normalize_public_attributed_sentence("Mark said that If that's not the case, then things will just diverge and it won't be followed."), "")

    def test_attributed_question_auxiliaries_are_lowercased_when_valid(self):
        self.assertEqual(
            public_attributed_sentence_from_evidence_item({"speaker": "Paula", "text": "Have the labels been reviewed for IFU consistency?"}),
            "Paula asked whether the labels have been reviewed for IFU consistency.",
        )

    def test_raw_transcript_chunks_become_attributed_discussion_sentences(self):
        samples = [
            (
                {
                    "speaker": "Orla",
                    "text": "And shoot up.And to that point, Orla, I know when we did the kickoff for this particular scope, I did reference and ask Cody to get an overview and did follow up with him last week, which is the mail you refer to at start, a copy of that, either the project plan or the task list from med envoy in relation to their activities, because that will help us understand.",
                    "turnIndex": 1,
                },
                "Orla said that the project plan or task list from Med Envoy would help the team understand Med Envoy's activities.",
            ),
            (
                {
                    "speaker": "Paula",
                    "text": "Paula, can I just, sorry, can I just ask while Mark's sharing screen, is the warehouse automated at all or is it a fully manual warehouse?",
                    "turnIndex": 2,
                },
                "Paula asked whether the warehouse was automated or fully manual.",
            ),
            (
                {
                    "speaker": "Mark",
                    "text": "Does the understanding the applicable reg requirements, so MDR and so on, and making sure that they're incorporated in the procedure, but also for it to be meaningful and usable for DISA, we have to understand how the business works so that we fit in as much as possible into your existing.",
                    "turnIndex": 3,
                },
                "Mark said that the applicable regulatory requirements needed to be incorporated into the procedure and aligned with how DISA works.",
            ),
            (
                {"speaker": "Paula", "text": "Obviously, for new products, they have to go into Udimed immediately.", "turnIndex": 4},
                "Paula said that new products have to go into Udimed immediately.",
            ),
            (
                {"speaker": "Mark", "text": "There's different levels and there will be, because you've got Master UDI involved as well, basically what they do is they put the basic UDI in.", "turnIndex": 5},
                "Mark mentioned that Master UDI and basic UDI were involved.",
            ),
        ]

        for evidence, expected in samples:
            self.assertEqual(public_attributed_sentence_from_evidence_item(evidence), expected)

    def test_keyword_soup_labels_are_not_public_discussion_points(self):
        bad_labels = [
            "Med not envoy responsibility like inc",
            "Storage netherlands kind around warehousing scenario",
            "Warehouse product netherlands order suppose through",
            "Procedure business possible providing deliverables theres",
            "Importer point view mean check required",
            "Whether IFUs manufacturer information notes needed relevant optical",
        ]
        for label in bad_labels:
            self.assertTrue(is_keyword_soup_sentence(label), label)
            self.assertEqual(public_discussion_sentence_from_evidence([{"text": label, "speaker": "Claire", "turnIndex": 0}]), "")

    def test_generated_sentence_must_be_supported_by_evidence_terms(self):
        evidence = [{"text": "Storage netherlands kind around warehousing scenario", "speaker": "Claire", "turnIndex": 0}]

        self.assertFalse(public_sentence_supported_by_evidence(
            "The team clarified the storage and logistics flow, including fiscal clearance in the Netherlands and onward storage in Dublin.",
            evidence,
        ))
        self.assertTrue(public_sentence_supported_by_evidence(
            "Med Envoy's project plan and timelines were reviewed in relation to registration responsibilities.",
            [{"text": "Med Envoy's project plan and timelines were reviewed in relation to registration responsibilities.", "speaker": "Claire", "turnIndex": 0}],
        ))

    def test_evidence_first_contract_excludes_non_sentence_topic_labels(self):
        output = {
            "explicitActions": [],
            "evidenceBackedTopics": [
                {
                    "topicLabel": "Storage netherlands kind around warehousing scenario",
                    "directEvidence": [{"speaker": "Claire", "timestamp": "", "text": "Storage netherlands kind around warehousing scenario", "turnIndex": 3}],
                    "sourceTurnIndices": [3],
                },
                {
                    "topicLabel": "Med Envoy's project plan and timelines were reviewed in relation to registration responsibilities.",
                    "directEvidence": [{"speaker": "Claire", "timestamp": "", "text": "Med Envoy's project plan and timelines were reviewed in relation to registration responsibilities.", "turnIndex": 1}],
                    "sourceTurnIndices": [1],
                },
            ],
            "excludedWeakCandidates": [],
            "meetingOverview": {},
        }

        enforce_evidence_first_final_contract(output)

        self.assertEqual(output["discussionPoints"], ["Claire said that Med Envoy's project plan and timelines were reviewed in relation to registration responsibilities."])
        self.assertEqual(len(output["evidenceBackedTopics"]), 1)
        self.assertEqual(output["excludedWeakCandidates"][0]["rejectionReason"], "non_sentence_topic_label")

    def test_explicit_action_requires_direct_action_language_and_evidence(self):
        records = [
            {"speaker": "Claire", "timestamp": "00:01", "text": "Please send the documentation pack to the client before Friday.", "turnIndex": 0},
        ]
        action = explicit_action_object(
            {"text": "send the documentation pack to the client", "owner": "Claire", "deadline": "Friday", "baseScore": 0.9},
            records,
        )

        self.assertIsNotNone(action)
        self.assertEqual(action["owner"], "Claire")
        self.assertEqual(action["deadline"], "Friday")
        self.assertEqual(action["sourceTurnIndices"], [0])
        self.assertEqual(action["evidence"][0]["text"], "Please send the documentation pack to the client before Friday.")

    def test_vague_send_copy_is_not_promoted_without_object_context(self):
        records = [
            {"speaker": "Claire", "timestamp": "00:01", "text": "Please send a copy.", "turnIndex": 0},
        ]

        self.assertIsNone(explicit_action_object({"text": "send a copy", "owner": "", "deadline": "", "baseScore": 0.9}, records))

    def test_weak_cluster_rejected_without_two_clear_related_evidence_turns(self):
        ok, reason = cluster_has_clear_topic([
            {"speaker": "A", "timestamp": "00:01", "text": "Send a copy.", "turnIndex": 0},
            {"speaker": "B", "timestamp": "00:02", "text": "As discussed, that sounds fine.", "turnIndex": 1},
        ])

        self.assertFalse(ok)
        self.assertIn(reason, {"vague_evidence_only", "top_evidence_turns_do_not_share_clear_topic", "no_clear_topic_tokens"})

    def test_rejected_original_plan_is_not_a_valid_objective(self):
        self.assertTrue(is_low_quality_objective_text("The original plan was to announce the Spain launch in July"))

    def test_second_person_transcript_leakage_is_not_a_valid_objective(self):
        self.assertTrue(
            is_low_quality_objective_text(
                "You've got a really robust process which Disa understands and is bought into and can use and is lined up to the existing processes"
            )
        )
        self.assertTrue(is_low_quality_objective_text("But also to understand the final resting place"))

    def test_real_regulatory_transcript_objective_is_synthesised_from_topics(self):
        output = {
            "meetingTitle": "Client DITA T819 Importer Obligations review plan",
            "meetingObjectives": [
                "You've got a really robust process which Disa understands and is bought into and can use and is lined up to the existing processes",
                "But also to understand the final resting place",
            ],
            "discussionPoints": [
                "The QMS manual and importer obligations need to align with the existing business process.",
                "The warehousing and storage flow covers fiscal clearance in the Netherlands and storage in Dublin.",
                "UDI and UDAMED responsibilities need to be clear between the manufacturer, importer and authorised representative.",
                "The Med Envoy project plan will help clarify role boundaries and follow-up actions.",
            ],
            "actions": [],
        }

        self.assertEqual(derive_meeting_objectives(output), [])
        self.assertEqual(
            synthesize_meeting_scope_objective(output),
            [
                "Review Client DITA T819 Importer Obligations review plan, focusing on QMS alignment, storage and warehousing flow, UDI and UDAMED responsibilities and Med Envoy role boundaries."
            ],
        )

    def test_conversational_availability_is_not_a_concrete_action(self):
        text = "And I'm easy right here, I can come back in here, or if you want to just continue with this, I don't mind."

        self.assertFalse(has_concrete_action_commitment(text))
        accepted, reason = should_accept_action_candidate(
            {
                "text": text,
                "owner": "Owner not specified",
                "deadline": "",
                "baseScore": 0.95,
                "combinedScore": 0.95,
                "semanticScore": 0.8,
                "roleScores": {"action": 0.8},
                "source": "semantic_action_fallback",
            }
        )

        self.assertFalse(accepted)
        self.assertEqual(reason, "missing_concrete_action_commitment")

    def test_clear_next_step_is_concrete_action(self):
        self.assertTrue(has_concrete_action_commitment("Refine the webinar opening slide before Friday."))
        self.assertTrue(has_concrete_action_commitment("Double down with the upskilled team on adoption considerations."))
        self.assertTrue(has_concrete_action_commitment("Investigate the server restart by Friday."))

    def test_transcript_label_is_removed_from_minilm_title(self):
        transcript = "📄 Transcript: AI Programme Weekly Check-In\n\nDate: 18 March 2026\n\nCiara:\nHello."

        self.assertEqual(infer_minilm_meeting_title(transcript), "AI Programme Weekly Check-In")

    def test_teams_export_title_after_generic_heading_is_used(self):
        transcript = (FIXTURES_DIR / "meeting_minutes_teams_glued_status_review.txt").read_text(encoding="utf-8")

        self.assertEqual(infer_minilm_meeting_title(transcript), "Daily AI Check In")
        self.assertNotIn("Conor Flynn", infer_minilm_meeting_title(transcript))
        self.assertNotIn("0 03", infer_minilm_meeting_title(transcript))

    def test_teams_glued_status_review_recovers_useful_minutes(self):
        transcript = (FIXTURES_DIR / "meeting_minutes_teams_glued_status_review.txt").read_text(encoding="utf-8")
        output, diagnostics = build_minilm_only_output(
            transcript,
            collect_minilm_only_context(transcript),
            DeterministicMiniLMBackend(),
            rewriter=None,
            include_diagnostics=True,
        )

        self.assertEqual(output["meetingTitle"], "Daily AI Check In")
        discussion_blob = "\n".join(output["discussionPoints"]).lower()
        action_blob = "\n".join(output["meetingActionPoint"]).lower()

        self.assertGreaterEqual(len(output["discussionPoints"]), 3)
        self.assertNotIn("ai pipeline strategy remains blocked because sales input is still required", discussion_blob)
        self.assertIn("webinars", discussion_blob)
        self.assertIn("on track", discussion_blob)
        self.assertIn("stage gate and vendor strategy rollout remain in progress", discussion_blob)
        self.assertEqual(action_blob, "")
        self.assertTrue(diagnostics.get("statusReviewWorkstreamRecovery", {}).get("applied"))
        self.assertIn("evidenceBackedTopics", output)
        self.assertIn("excludedWeakCandidates", output)

        public_blob = "\n".join(output["discussionPoints"] + output["meetingActionPoint"])
        for forbidden in (
            "Conor Flynn 0 03",
            "Two one's time might make one do this.Me",
            "That milestone, I suppose, is green. Nothing to deliver",
            "good stuff, okay.go for it",
            "Ws and the EI grant",
        ):
            self.assertNotIn(forbidden.lower(), public_blob.lower())

    def test_generic_notion_transcript_heading_is_not_used_as_title(self):
        transcript = """Transcript
Transcript file: Project Phoenix transcript v3 🔥
Claire: The meeting is the Phoenix delivery checkpoint.
"""

        self.assertEqual(infer_minilm_meeting_title(transcript), "Phoenix delivery checkpoint")

    def test_noisy_speakerless_opening_is_not_used_as_title(self):
        transcript = """All right.
Yeah.
The poster hall clicks and poster views are not the same measure, so the analytics review needs to separate click heatmaps from actual poster engagement.
"""

        self.assertEqual(infer_minilm_meeting_title(transcript), "Meeting review")

    def test_speakerless_context_reports_parser_fallback(self):
        transcript = """All right.
Yeah.
So the poster hall clicks and poster views are not the same measure. The heatmap is counting clicks into areas of the poster hall, while the poster view export is counting actual poster engagement. We need to explain that clearly because the delegate totals will look inconsistent otherwise.
Thank you.
The research hub numbers should be treated separately from search by research area. One report shows delegates using the hub itself, while the search counts represent repeated clicks and filter behaviour. The 414 delegates and 809 clicks figure should not be compared directly with the 1,009 and 4,758 search totals.
"""

        context = collect_minilm_only_context(transcript)

        self.assertGreater(context["parserDiagnostics"]["parsedTurnCount"], 0)
        self.assertGreater(context["parserDiagnostics"]["recordCount"], 0)
        self.assertTrue(context["parserDiagnostics"]["speakerlessFallbackApplied"])

    def test_explicit_meeting_title_instruction_overrides_export_header(self):
        transcript = """Transcript
Support metrics call transcript
00:12 Maya: The meeting title should be Support Metrics Review, not AutoNote recording.
00:35 Chris: Decision: keep abandonment rate as the lead metric for June.
"""

        self.assertEqual(infer_minilm_meeting_title(transcript), "Support Metrics Review")

    def test_export_title_words_are_removed_from_plain_header(self):
        transcript = """Transcript
Risk review transcript
Ibrahim: The purpose is to decide whether the integration risk is acceptable for pilot.
"""

        self.assertEqual(infer_minilm_meeting_title(transcript), "Risk review")

    def test_matching_deadline_is_removed_from_action_text(self):
        self.assertEqual(
            strip_action_deadline_phrase(
                "Update the risk register language by Friday so it no longer says immediate action required.",
                "By Friday",
            ),
            "Update the risk register language so it no longer says immediate action required",
        )
        self.assertEqual(
            strip_action_deadline_phrase("Draft the governance note by Monday.", "By Monday"),
            "Draft the governance note",
        )

    def test_conversational_discussion_fragments_are_formalized(self):
        self.assertEqual(
            formalize_transcript_discussion_point(
                "One thing I’d add, we might want to start tracking leading indicators, not just status Things like resource utilisation, number of active SO.",
                [{"text": "Ws per team, dependency concentration."}],
            ),
            "Leading indicators such as resource utilisation, active SOWs per team and dependency concentration should be tracked alongside status.",
        )
        self.assertEqual(
            formalize_transcript_discussion_point(
                "I’ve got the latest report open, the 18th March one So overall status is still green across scope, schedule, financials, resources."
            ),
            "Overall programme status remained green across scope, schedule, financials and resources.",
        )
        self.assertEqual(
            formalize_transcript_discussion_point(
                "Things like resource utilisation, number of active SOWs per team, dependency concentration."
            ),
            "Leading indicators such as resource utilisation, active SOWs per team and dependency concentration should be tracked alongside status.",
        )

    def test_speakerless_analytics_fragments_are_formalized(self):
        self.assertEqual(
            formalize_transcript_discussion_point(
                "Basically, process was looked at the 2025 graph and the non-session features were receiving the interaction.",
                [{"text": "taking out all of the session related content"}],
            ),
            "The feature-interaction graph should exclude session-related content so it shows which non-session platform features received engagement.",
        )
        self.assertEqual(
            formalize_transcript_discussion_point(
                "For this particular measure it does include just views of the poster hall rather than only views of posters.",
                [{"text": "people clicked clinical research posters but potentially not opened any of the posters"}],
            ),
            "Poster hall engagement should be described as poster-hall interaction, not individual poster views, because the measure includes delegates clicking into poster halls even when they did not open specific posters.",
        )
        self.assertEqual(
            formalize_transcript_discussion_point(
                "Some stupid, stupidly small number So about 47 and a few percent.",
                [{"text": "47% of the views were on Tuesday, not 47% of delegates"}],
            ),
            "Around 47 percent of the relevant views occurred on Tuesday, but the wording should refer to views rather than delegates.",
        )
        self.assertEqual(
            formalize_transcript_discussion_point(
                "I'm not sure, has the number seen the numbers of the swag bag? For some parts of the platform, they're a bit small.",
            ),
            "Some feature counts, including swag bag figures, were small enough that comparisons should be treated cautiously.",
        )
        self.assertEqual(
            formalize_transcript_discussion_point(
                "Some stupid, stupidly small number So about 47 and a few percent and a few little at a few decimal places of a percentage.",
            ),
            "A Tuesday-related percentage appears to be around 47 percent, but the wording should clarify whether it refers to views, clicks or delegates.",
        )
        self.assertEqual(
            formalize_transcript_discussion_point(
                "For some parts of the platform, they're a bit small They look really small to be honest at some parts.",
                [{"text": "the numbers seem really small and in a few places we're talking about 30 people or 30 users"}],
            ),
            "Small sample sizes in some platform areas limit how confidently differences between features can be interpreted.",
        )

    def test_resource_indicator_fragment_is_not_promoted_as_raw_objective(self):
        output = {
            "discussionPoints": [
                "Leading indicators such as resource utilisation, active SOWs per team and dependency concentration should be tracked alongside status.",
                "Things like resource utilisation, number of active SOWs per team, dependency concentration.",
            ],
            "discussionPointDetails": [
                {"sourceTurnIndices": [1, 2], "evidenceScore": 0.8},
                {"sourceTurnIndices": [2], "evidenceScore": 0.7},
            ],
            "decisions": [],
            "actions": [],
        }

        objectives = derive_meeting_objectives(output)

        self.assertIn(
            "Leading indicators such as resource utilisation, active SOWs per team and dependency concentration should be tracked alongside status",
            objectives,
        )
        self.assertFalse(any(objective.lower().startswith("things like") for objective in objectives))

    def test_vague_qwen_rewrite_falls_back_to_specific_source(self):
        source = "Sales continued to progress new SOWs while delivery bandwidth was not increasing at the same pace."

        self.assertEqual(
            _sanitize_rewritten_minutes_text("Currently there's some confusion regarding the issue.", source),
            source,
        )

    def test_report_update_with_vague_points_is_not_concrete_action(self):
        self.assertFalse(has_concrete_action_commitment("I’ll update the next report with these points."))

    def test_vague_recorded_assignment_fragment_is_not_action(self):
        text = "Assign that properly."

        self.assertFalse(has_concrete_action_commitment(text))
        accepted, reason = should_accept_action_candidate(
            {
                "text": text,
                "owner": "Owner not specified",
                "deadline": "",
                "baseScore": 0.9,
                "combinedScore": 0.9,
                "semanticScore": 0.7,
                "roleScores": {"action": 0.8},
                "source": "semantic_action_fallback",
            }
        )

        self.assertFalse(accepted)
        self.assertEqual(reason, "missing_concrete_action_commitment")

    def test_stitched_transcript_fragment_is_not_promoted_as_discussion(self):
        text = "We have kind of a good plan for the next one. We come back and add what the milestones are. Two one's time might make one do this.Me."
        candidate = {
            "text": text,
            "source": "semantic_discussion_fallback",
            "baseScore": 0.92,
            "supportScore": 0.82,
            "scores": {},
            "evidence": [{"speaker": "Ciara Griffin", "timestamp": "1:02", "text": text}],
        }

        self.assertFalse(is_safe_deterministic_discussion_fallback(candidate))
        self.assertEqual(should_keep_discussion_candidate(candidate), (False, "transcript_stitch_fragment"))
        self.assertEqual(is_valid_discussion_point(text, 1), (False, "transcript_stitch_fragment"))

    def test_vague_demonstrative_status_fragment_is_not_discussion_point(self):
        text = "That milestone, I suppose, is green. Nothing to deliver at the minute. Um, stage gate and vendor strategy roll out."
        candidate = {
            "text": text,
            "source": "semantic_discussion_fallback",
            "baseScore": 0.92,
            "supportScore": 0.82,
            "scores": {},
            "evidence": [{"speaker": "Conor Flynn", "timestamp": "0:32", "text": text}],
        }

        self.assertFalse(is_safe_deterministic_discussion_fallback(candidate))
        self.assertEqual(should_keep_discussion_candidate(candidate), (False, "vague_demonstrative_status_fragment"))
        self.assertEqual(is_valid_discussion_point(text, 1), (False, "vague_demonstrative_status_fragment"))

    def test_specific_status_review_discussion_remains_available(self):
        text = "Vendor strategy rollout remains in progress because the latest status is green and there is nothing further to deliver at the minute."
        candidate = {
            "text": text,
            "source": "semantic_discussion_fallback",
            "baseScore": 0.92,
            "supportScore": 0.82,
            "scores": {},
            "evidence": [{"speaker": "Ciara Griffin", "timestamp": "0:45", "text": text}],
        }

        self.assertTrue(is_safe_deterministic_discussion_fallback(candidate))
        self.assertEqual(should_keep_discussion_candidate(candidate), (True, "deterministic_fallback"))
        self.assertEqual(is_valid_discussion_point(text, 1), (True, ""))

    def test_personal_status_recount_is_not_discussion_point(self):
        text = "I gave Liam, that's definitely Amber, I gave Liam another nudge in our one-to-one today."
        candidate = {
            "text": text,
            "source": "parser",
            "baseScore": 0.7,
            "supportScore": 1.0,
            "scores": {},
            "evidence": [
                {"speaker": "Ciara Griffin", "timestamp": "1:06", "text": "AI pipeline strategy defined"},
                {"speaker": "Conor Flynn", "timestamp": "1:09", "text": text},
            ],
        }

        self.assertEqual(should_keep_discussion_candidate(candidate), (False, "personal_status_recount_fragment"))
        self.assertEqual(is_valid_discussion_point(text, 2), (False, "personal_status_recount_fragment"))

    def test_filler_status_fragments_are_not_meeting_objectives(self):
        self.assertTrue(is_low_quality_objective_text("Um, stage gate and vendor strategy roll out."))
        self.assertTrue(
            is_low_quality_objective_text(
                "Stay same with the same stage gate internal review completed not to the end of the quarter, so it's on track for now."
            )
        )

    def test_public_output_sanitizer_removes_speaker_timestamps_and_rejected_context(self):
        output = {
            "discussionPoints": [
                "09:00 Leah: The original plan was to announce the Spain launch in July. Partner paperwork was unfinished.",
                "Nina: Maybe we stop pushing the healthcare prospect this quarter. Legal review is still blocking enterprise deals.",
            ],
            "discussionPointDetails": [
                {
                    "discussionPoint": "09:00 Leah: The original plan was to announce the Spain launch in July. Partner paperwork was unfinished."
                }
            ],
            "decisions": ["Jon: Sign the one-year extension and keep the exit clause unchanged"],
            "decisionDetails": [{"decision": "Jon: Sign the one-year extension and keep the exit clause unchanged"}],
            "actions": [
                {
                    "meetingActionPoint": "12:04 Dan: call the customer",
                    "meetingActionPointOwner": "Dan",
                    "meetingActionPointDeadline": "Noon",
                }
            ],
        }

        sanitize_public_output_items(output, {"Leah", "Jon", "Dan", "Nina"})

        self.assertIn("Partner paperwork was unfinished.", output["discussionPoints"])
        self.assertIn("Legal review is still blocking enterprise deals.", output["discussionPoints"])
        self.assertTrue(
            all("healthcare prospect this quarter" not in item.lower() for item in output["discussionPoints"])
        )
        self.assertEqual(output["discussionPointDetails"][0]["discussionPoint"], "Partner paperwork was unfinished.")
        self.assertEqual(output["decisions"], ["Sign the one-year extension."])
        self.assertEqual(output["decisionDetails"][0]["decision"], "Sign the one-year extension.")
        self.assertEqual(output["meetingActionPoint"], ["Call the customer."])
        self.assertEqual(output["meetingActionPointOwner"], ["Dan"])
        self.assertEqual(output["meetingActionPointDeadline"], ["Noon"])

    def test_public_output_sanitizer_removes_raw_discussion_transcript_leakage(self):
        output = {
            "discussionPoints": [
                "I did check on Friday and there's no product information in there yet.",
                "The other thing is, I know what, as an importer, there should be a link between the two.",
                "And we then apply the final label on the outer box.which is the label the store sees.",
                "may be in trouble then obviously remains in progress because it's very important we have that input from you, i guess, from the team there on how your business works again.",
                "Us or manufacturer information notes were needed for the relevant optical and sunglasses products.",
                "UDAMED responsibilities were discussed, with the manufacturer responsible for uploading data and the importer and authorised representative responsible for checking it is present.",
            ],
            "discussionPointDetails": [
                {"discussionPoint": "I did check on Friday and there's no product information in there yet."},
                {"discussionPoint": "Us or manufacturer information notes were needed for the relevant optical and sunglasses products."},
                {"discussionPoint": "UDAMED responsibilities were discussed, with the manufacturer responsible for uploading data and the importer and authorised representative responsible for checking it is present."},
            ],
            "decisions": [],
            "actions": [],
        }

        sanitize_public_output_items(output, set())

        self.assertEqual(
            output["discussionPoints"],
            [
                "IFUs or manufacturer information notes were needed for the relevant optical and sunglasses products.",
                "UDAMED responsibilities were discussed, with the manufacturer responsible for uploading data and the importer and authorised representative responsible for checking it is present.",
            ],
        )
        detail_blob = "\n".join(detail.get("discussionPoint", "") for detail in output["discussionPointDetails"])
        self.assertNotIn("I did check", detail_blob)
        self.assertIn("IFUs or manufacturer information notes", detail_blob)

    def test_first_person_action_fallback_captures_speaker_and_nearby_deadline(self):
        candidates = collect_action_candidates(
            {
                "records": [
                    {"speaker": "Dan", "text": "I'll call the customer.", "scores": {"action": 0.2}},
                    {"speaker": "Dan", "text": "Noon works for that.", "scores": {"action": 0.0}},
                ],
                "actionEvents": [],
            },
            backend=None,
        )

        self.assertTrue(
            any(
                candidate["text"] == "Call the customer."
                and candidate["owner"] == "Dan"
                and candidate["deadline"] == "Noon"
                and candidate["source"] == "first_person_action_fallback"
                for candidate in candidates
            )
        )

    def test_real_t819_transcript_recovers_broader_regulated_discussion_topics(self):
        transcript = (
            Path(__file__).resolve().parents[1]
            / "scripts/meeting-minutes-final-golden/021_real_dita_importer_obligations_transcript/transcript.txt"
        ).read_text(encoding="utf-8")
        context = collect_minilm_only_context(transcript)
        candidates, _rejections = collect_discussion_candidates(context, backend=None)
        discussion_blob = "\n".join(candidate["text"] for candidate in candidates).lower()

        for expected in (
            "qms and importer-obligation procedures",
            "storage and logistics flow",
            "order fulfilment and warehouse workflow",
            "udi, barcode and labelling requirements",
            "udamed responsibilities",
            "med envoy's project plan",
            "ifus or manufacturer information notes",
            "declarations of conformity",
            "hpra billing",
        ):
            self.assertIn(expected, discussion_blob)

    def test_real_t819_transcript_recovers_contextual_actions(self):
        transcript = (
            Path(__file__).resolve().parents[1]
            / "scripts/meeting-minutes-final-golden/021_real_dita_importer_obligations_transcript/transcript.txt"
        ).read_text(encoding="utf-8")
        context = collect_minilm_only_context(transcript)
        candidates = collect_action_candidates(context, backend=None)
        action_blob = "\n".join(candidate["text"] for candidate in candidates).lower()

        self.assertIn("follow up on the med envoy project plan or task list", action_blob)
        self.assertIn("send the hpra authorised-representative bill for review", action_blob)
        self.assertIn("review the declarations of conformity and ppe risk rationale", action_blob)
        self.assertIn("share the hpra confirmation and company-size follow-up documents", action_blob)


if __name__ == "__main__":
    unittest.main()
