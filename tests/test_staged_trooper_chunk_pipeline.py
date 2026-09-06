import importlib.util
import os
import sys
import unittest
from unittest import mock
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "staged_trooper_chunk_pipeline.py"
SPEC = importlib.util.spec_from_file_location("staged_trooper_chunk_pipeline", SCRIPT)
PIPELINE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = PIPELINE
SPEC.loader.exec_module(PIPELINE)


class StagedTrooperChunkPipelineTests(unittest.TestCase):
    def test_numbering_is_one_based_and_preserves_turn_text(self):
        turns, numbered = PIPELINE.numbered_turns("Alice: First\n\nBob: Second")
        self.assertEqual(turns, ["Alice: First", "Bob: Second"])
        self.assertEqual(numbered, "[1] Alice: First\n[2] Bob: Second")

    def test_boundaries_are_contiguous_and_force_the_45_turn_limit(self):
        chunks = PIPELINE.safe_boundaries([{"number": 1, "start": 1, "end": 100}], 100)
        self.assertEqual([(row["start"], row["end"]) for row in chunks], [(1, 45), (46, 90), (91, 100)])

    def test_action_normalisation_tolerates_missing_and_null_evidence_arrays(self):
        result = {"actionCandidates": [{
            "action": "Email the revised plan", "status": "COMMITTED", "owner": "Alex",
            "deadline": "Friday", "taskEvidenceTurns": [2, None, 99], "ownerEvidenceTurns": None,
        }]}
        actions = PIPELINE.normalise_actions(result, {"number": 1, "start": 1, "end": 10})
        self.assertEqual(actions[0]["evidenceIds"], ["turn_2"])
        self.assertEqual(actions[0]["status"], "COMMITTED")

    def test_importer_actual_action_selector_runs_after_four_word_gate(self):
        actions = [
            {"owner": "Alex", "action": "Check the report", "evidenceIds": ["turn_1"]},
            {"owner": "Blair", "action": "Send the final report", "evidenceIds": ["turn_2"]},
            {"owner": "Casey", "action": "Review the signed supplier agreement", "evidenceIds": ["turn_3"]},
        ]
        original = PIPELINE.call_trooper
        captured = {}
        try:
            def fake_call(prompt, max_tokens, schema):
                captured["prompt"] = prompt
                return {"candidateNumbers": [2, 99]}
            PIPELINE.call_trooper = fake_call
            selected = PIPELINE.select_importer_actual_actions(actions, ["A: One", "B: Two", "C: Three"])
        finally:
            PIPELINE.call_trooper = original
        self.assertNotIn("Check the report", captured["prompt"])
        self.assertEqual([row["action"] for row in selected], ["Review the signed supplier agreement"])

    def test_importer_actual_action_route_is_meeting_type_specific(self):
        self.assertTrue(PIPELINE.is_importer_obligations_type("Importer obligations review"))
        self.assertFalse(PIPELINE.is_importer_obligations_type("General"))

    def test_importer_prompt_has_no_action_quota(self):
        self.assertIn("no minimum or target", PIPELINE.IMPORTER_ACTUAL_ACTIONS_PROMPT)
        self.assertIn("Return none", PIPELINE.IMPORTER_ACTUAL_ACTIONS_PROMPT)
        self.assertNotIn("15 strongest", PIPELINE.IMPORTER_ACTUAL_ACTIONS_PROMPT)

    def test_final_selector_is_limited_to_two_proven_meeting_types(self):
        hybrid = PIPELINE.selective_actual_action_profile("Software and technical-file weekly review")
        decision = PIPELINE.selective_actual_action_profile("Decision meeting")
        self.assertEqual(hybrid[1], "hybrid_technical_actual_actions")
        self.assertEqual(decision[1], "decision_meeting_actual_actions")
        for meeting_type in ("Software weekly review", "Technical file review", "Audit kick-off / planning",
                             "Webinar rehearsal", "Process / pipeline planning", "General", ""):
            with self.subTest(meeting_type=meeting_type):
                self.assertIsNone(PIPELINE.selective_actual_action_profile(meeting_type))

    def test_selective_final_selector_runs_after_four_word_gate_without_quota(self):
        actions = [{"owner": "Alex", "action": "Check the report", "status": "REQUIRED", "evidenceIds": ["turn_1"]}]
        actions.extend({"owner": "Alex", "action": f"Review technical document number {number}",
                        "status": "REQUIRED", "evidenceIds": ["turn_1"]} for number in range(1, 18))
        original = PIPELINE.call_trooper
        captured = {}
        try:
            def fake_call(prompt, max_tokens, schema):
                captured["prompt"] = prompt
                return {"candidateNumbers": list(range(1, 18))}
            PIPELINE.call_trooper = fake_call
            selected = PIPELINE.select_actual_actions(
                actions, ["Alex: I will review the documents."], PIPELINE.HYBRID_TECHNICAL_SELECTOR_GUIDANCE)
        finally:
            PIPELINE.call_trooper = original
        self.assertNotIn("Check the report", captured["prompt"])
        self.assertEqual(len(selected), 17)
        self.assertIn("There is no target or maximum", captured["prompt"])

    def test_retrieval_selector_routes_only_exact_validated_types(self):
        expected = {
            "Audit kick-off / planning": "audit_retrieval",
            "Technical file review": "technical_retrieval",
            "Webinar rehearsal": "webinar_retrieval",
            "Software weekly review": "software_retrieval",
            "Process / pipeline planning": "process_retrieval",
            "Importer obligations review": "importer_retrieval",
        }
        for meeting_type, profile in expected.items():
            with self.subTest(meeting_type=meeting_type):
                self.assertEqual(PIPELINE.retrieval_selector_profile(meeting_type)[1], profile)
        for meeting_type in ("General", "Decision meeting",
                             "Software and technical-file weekly review", "Technical file consultancy review", ""):
            with self.subTest(meeting_type=meeting_type):
                self.assertIsNone(PIPELINE.retrieval_selector_profile(meeting_type))

    def test_audit_v2_flag_routes_dedicated_extractor_and_selector(self):
        with mock.patch.dict(os.environ, {"STAGED_AUDIT_ACTION_V2": "1"}):
            prompt, action_profile = PIPELINE.action_prompt_for_meeting_type("Audit kick-off / planning")
            guidance, selector_profile = PIPELINE.retrieval_selector_profile("Audit kick-off / planning")
        self.assertEqual(action_profile, "audit_planning_v2")
        self.assertEqual(selector_profile, "audit_retrieval_v2")
        self.assertIs(prompt, PIPELINE.AUDIT_ACTION_PROMPT)
        self.assertIn("previous or other audits", prompt)
        self.assertNotIn("whether an auditor will run a separate track", prompt)
        self.assertIn("travel", guidance)

    def test_audit_v2_flag_does_not_change_other_meeting_types(self):
        with mock.patch.dict(os.environ, {"STAGED_AUDIT_ACTION_V2": "1"}):
            self.assertEqual(PIPELINE.action_prompt_for_meeting_type("Software weekly review")[1], "software_weekly_review")
            self.assertEqual(PIPELINE.retrieval_selector_profile("Importer obligations review")[1], "importer_retrieval")

    def test_retrieval_selector_requires_consensus_and_protects_explicit_commitment(self):
        class Backend:
            available = True
            def encode_many(self, texts):
                return {text: [1.0, 0.0] if "discussion" not in text.lower() else [0.0, 1.0] for text in texts}
        actions = [
            {"owner": "Alex", "action": "Send the revised audit plan", "status": "COMMITTED", "evidenceIds": ["turn_1"]},
            {"owner": "Not stated", "action": "Discuss the possible colour scheme", "status": "PROPOSED", "evidenceIds": ["turn_2"]},
        ]
        original = PIPELINE.call_trooper
        try:
            def fake_call(prompt, max_tokens, schema):
                numbers = [int(value) for value in __import__('re').findall(r"(?m)^(\d+)\. Owner:", prompt)]
                return {"decisions": [{"candidateNumber": number, "decision": "REMOVE",
                    "rejectionCode": "DISCUSSION_ONLY", "evidenceTurns": [1]} for number in numbers]}
            PIPELINE.call_trooper = fake_call
            selected = PIPELINE.select_retrieval_grounded_actions(
                actions, ["Alex: I will send the revised audit plan.", "Blair: This is only discussion."],
                "Audit guidance", Backend())
        finally:
            PIPELINE.call_trooper = original
        self.assertEqual([row["action"] for row in selected], ["Send the revised audit plan"])

    def test_retrieval_selector_fails_open_on_incomplete_decisions(self):
        class Backend:
            available = True
            def encode_many(self, texts): return {text: [1.0] for text in texts}
        actions = [{"owner": "Alex", "action": "Review the complete technical report",
                    "status": "PROPOSED", "evidenceIds": ["turn_1"]}]
        original = PIPELINE.call_trooper
        try:
            PIPELINE.call_trooper = lambda *_args: {"decisions": []}
            selected = PIPELINE.select_retrieval_grounded_actions(actions, ["Alex: Maybe review it."], "Rules", Backend())
        finally:
            PIPELINE.call_trooper = original
        self.assertEqual(selected, actions)

    def test_audit_v2_selector_does_not_bypass_consensus_removal_via_generic_protection(self):
        class Backend:
            available = True
            def encode_many(self, texts): return {text: [1.0] for text in texts}
        actions = [{"owner": "Stuart", "action": "Attend the audit on Wednesday",
                    "status": "COMMITTED", "evidenceIds": ["turn_1"]}]
        original = PIPELINE.call_trooper
        prompts = []
        try:
            def remove_all(prompt, *_args):
                prompts.append(prompt)
                return {"decisions": [{
                    "candidateNumber": 1, "decision": "REMOVE", "rejectionCode": "MEETING_ADMIN",
                    "evidenceTurns": [1],
                }]}
            PIPELINE.call_trooper = remove_all
            selected = PIPELINE.select_retrieval_grounded_actions(
                actions, ["Stuart: I will attend the audit on Wednesday.", "Alex: Understood.",
                          "Alex: This is a nearby turn.", "Alex: Unrelated distant audit wording."],
                PIPELINE.AUDIT_RETRIEVAL_V2_GUIDANCE, Backend(), profile="audit_retrieval_v2")
        finally:
            PIPELINE.call_trooper = original
        self.assertEqual(selected, [])
        self.assertEqual(len(prompts), 2)
        self.assertTrue(all("Turn 2:" in prompt for prompt in prompts))

    def test_audit_v2_drops_candidate_without_object_in_its_cited_evidence(self):
        class Backend:
            available = True
            def encode_many(self, texts): return {text: [1.0] for text in texts}
        action = {"owner": "Unknown", "action": "Decide whether an auditor runs a separate track",
                  "status": "REQUIRED", "evidenceIds": ["turn_1"]}
        self.assertFalse(PIPELINE.audit_candidate_has_lexical_anchor(
            action, ["Jacqui: I will share some opening key points."]))
        original = PIPELINE.call_trooper
        try:
            PIPELINE.call_trooper = lambda *_args: self.fail("ungrounded audit candidate reached selector")
            selected = PIPELINE.select_retrieval_grounded_actions(
                [action], ["Jacqui: I will share some opening key points."],
                PIPELINE.AUDIT_RETRIEVAL_V2_GUIDANCE, Backend(), profile="audit_retrieval_v2")
        finally:
            PIPELINE.call_trooper = original
        self.assertEqual(selected, [])

    def test_importer_quality_filter_rejects_generic_objects(self):
        rows = [
            {"action": "Clarify points for better clarity"},
            {"action": "Clarify points about supplier registration evidence"},
        ]
        self.assertEqual(PIPELINE.filter_importer_selected_actions(rows), [rows[1]])

    def test_importer_quality_filter_keeps_specific_contained_duplicate(self):
        rows = [
            {"action": "Review the records with additional information"},
            {"action": "Review the records with additional information for authorised-representative registration"},
        ]
        self.assertEqual(PIPELINE.filter_importer_selected_actions(rows), [rows[1]])

    def test_live_prompt_is_the_short_verb_sweep(self):
        for verb in ("Review", "Resolve", "Arrange", "Plan", "Email"):
            self.assertIn(f"- {verb}", PIPELINE.ACTION_PROMPT)
        self.assertNotIn("Work through", PIPELINE.ACTION_PROMPT)

    def test_action_prompt_routes_supported_meeting_types(self):
        cases = {
            "Webinar rehearsal": "webinar_rehearsal",
            "Technical file review": "technical_file_review",
            "Software Weekly Review": "software_weekly_review",
            "Software and technical-file weekly review": "software_weekly_review",
            "Process / pipeline planning": "process_or_pipeline_planning",
            "Lead generation pipeline review": "process_or_pipeline_planning",
            "General": "general",
            "": "general",
        }
        for meeting_type, expected in cases.items():
            with self.subTest(meeting_type=meeting_type):
                _, profile = PIPELINE.action_prompt_for_meeting_type(meeting_type)
                self.assertEqual(profile, expected)

    def test_discussion_prompt_routes_supported_specialist_types(self):
        audit, audit_profile = PIPELINE.discussion_prompt_for_meeting_type("Audit kick-off / planning")
        importer, importer_profile = PIPELINE.discussion_prompt_for_meeting_type("Importer obligations review")
        webinar, webinar_profile = PIPELINE.discussion_prompt_for_meeting_type("Webinar rehearsal")
        technical, technical_profile = PIPELINE.discussion_prompt_for_meeting_type("Technical file review")
        software, software_profile = PIPELINE.discussion_prompt_for_meeting_type("Software weekly review")
        hybrid, hybrid_profile = PIPELINE.discussion_prompt_for_meeting_type("Software and technical-file weekly review")
        general, general_profile = PIPELINE.discussion_prompt_for_meeting_type("General")
        self.assertEqual(audit_profile, "audit_planning")
        self.assertEqual(importer_profile, "importer_obligations")
        self.assertEqual(webinar_profile, "webinar_rehearsal")
        self.assertEqual(technical_profile, "technical_file_review")
        self.assertEqual(software_profile, "software_weekly_review")
        self.assertEqual(hybrid_profile, "software_weekly_review")
        self.assertIs(hybrid, software)
        self.assertEqual(general_profile, "general")
        for term in ("missing animations", "spoken cues", "dead-air risks", "private warnings"):
            self.assertIn(term, webinar)
        for term in ("FIRST THIRD", "no-AI", "CVE", "end-of-day coordination"):
            self.assertIn(term, audit)
        for term in ("EUDAMED", "GUDID", "COUNTRY/LANGUAGE", "checks needed before payment"):
            self.assertIn(term, importer)
        for term in ("tracker movement", "change-request review", "retrospective-testing condition"):
            self.assertIn(term, technical)
        for term in ("debug commands", "State timing and status literally", "numerical risk rationale"):
            self.assertIn(term, software)
        self.assertIs(general, PIPELINE.DISCUSSION_PROMPT)

    def test_chunk_candidate_filter_is_limited_to_hybrid_weekly_type(self):
        self.assertTrue(PIPELINE.discussion_uses_chunk_candidate_filter(
            "Software and technical-file weekly review"))
        for meeting_type in ("Software weekly review", "Technical file review", "General", ""):
            with self.subTest(meeting_type=meeting_type):
                self.assertFalse(PIPELINE.discussion_uses_chunk_candidate_filter(meeting_type))

    def test_discussion_candidate_normalisation_requires_in_chunk_evidence(self):
        result = {"candidates": [
            {"workstream": "Alarm behaviour", "state": "Three priorities were demonstrated.",
             "evidenceTurns": [2, 3, 99]},
            {"workstream": "", "state": "Missing heading", "evidenceTurns": [4]},
            {"workstream": "Risk", "state": "No evidence", "evidenceTurns": []},
        ]}
        rows = PIPELINE.normalise_discussion_candidates(
            result, {"number": 2, "start": 2, "end": 10})
        self.assertEqual(rows, [{
            "workstream": "Alarm behaviour", "state": "Three priorities were demonstrated.",
            "evidenceTurns": [2, 3], "chunk": 2,
        }])

    def test_discussion_from_candidates_groups_topics_and_deduplicates_exact_states(self):
        rows = PIPELINE.discussion_from_candidates([
            {"workstream": "Risk", "state": "The risk file is under review."},
            {"workstream": "risk", "state": "The risk file is under review."},
            {"workstream": "Risk", "state": "A control decision remains open."},
        ])
        self.assertEqual(rows, [{"topic": "Risk", "points": [
            "The risk file is under review.", "A control decision remains open.",
        ]}])

    def test_discussion_two_half_route_is_limited_to_coverage_sensitive_types(self):
        for meeting_type in ("Workshop", "Technical file review"):
            with self.subTest(meeting_type=meeting_type):
                self.assertTrue(PIPELINE.discussion_uses_two_halves(meeting_type))
        for meeting_type in ("Audit kick-off / planning", "Importer obligations review",
                             "Process / pipeline planning", "Lead generation pipeline review",
                             "Webinar rehearsal",
                             "General", "Decision meeting"):
            with self.subTest(meeting_type=meeting_type):
                self.assertFalse(PIPELINE.discussion_uses_two_halves(meeting_type))

    def test_discussion_three_third_route_is_for_audits_and_pure_software_weeklies(self):
        self.assertTrue(PIPELINE.discussion_uses_three_thirds("Audit kick-off / planning"))
        self.assertTrue(PIPELINE.discussion_uses_three_thirds("Importer obligations review"))
        self.assertTrue(PIPELINE.discussion_uses_three_thirds("Software weekly review"))
        self.assertTrue(PIPELINE.discussion_uses_three_thirds("General"))
        self.assertTrue(PIPELINE.discussion_uses_three_thirds("Process / pipeline planning"))
        self.assertTrue(PIPELINE.discussion_uses_three_thirds("Lead generation pipeline review"))
        self.assertTrue(PIPELINE.discussion_uses_three_thirds("Technical file consultancy review"))
        for meeting_type in ("Software and technical-file weekly review", "Technical file review", "Client update"):
            with self.subTest(meeting_type=meeting_type):
                self.assertFalse(PIPELINE.discussion_uses_three_thirds(meeting_type))

    def test_specialised_prompts_preserve_the_required_sweeps(self):
        webinar, _ = PIPELINE.action_prompt_for_meeting_type("Webinar rehearsal")
        technical, _ = PIPELINE.action_prompt_for_meeting_type("Technical file review")
        software, _ = PIPELINE.action_prompt_for_meeting_type("Software weekly review")
        pipeline, _ = PIPELINE.action_prompt_for_meeting_type("Process pipeline planning")
        for term in ("grouping chat questions", "Q&A", "dead air", "assignment recaps"):
            self.assertIn(term, webinar)
        for term in ("CONTINUE", "TRACE", "INCORPORATE", "controlled documents"):
            self.assertIn(term, technical)
        for term in ("full general sweep", "owner-by-owner action ledger", "retrospective test", "recurring review"):
            self.assertIn(term, software.lower())
        for term in ("manual tests", "conditional candidate", "Salesforce", "TRACK"):
            self.assertIn(term, pipeline)


if __name__ == "__main__":
    unittest.main()


class DeterministicActionCleanupTests(unittest.TestCase):
    def test_undersized_chunks_merge_into_a_neighbour_within_the_limit(self):
        chunks = PIPELINE.safe_boundaries([
            {"start": 1, "end": 17}, {"start": 18, "end": 20}, {"start": 21, "end": 43}, {"start": 44, "end": 60}], 60)
        self.assertEqual([(row["start"], row["end"]) for row in chunks], [(1, 20), (21, 43), (44, 60)])
        self.assertEqual([row["number"] for row in chunks], [1, 2, 3])

    def test_undersized_chunk_is_left_alone_when_no_merge_fits(self):
        chunks = PIPELINE.safe_boundaries([{"start": 1, "end": 45}, {"start": 46, "end": 48}, {"start": 49, "end": 93}], 93)
        self.assertEqual([(row["start"], row["end"]) for row in chunks], [(1, 45), (46, 48), (49, 93)])

    def test_completed_rows_are_dropped_and_identical_wording_is_pooled(self):
        actions = [
            {"owner": "Not stated", "action": "Review the standard again", "status": "PROPOSED", "evidenceIds": ["turn_3"]},
            {"owner": "David", "action": "Review the standard again.", "status": "PROPOSED", "evidenceIds": ["turn_9"]},
            {"owner": "Andrew", "action": "Add five languages to the code", "status": "COMPLETED", "evidenceIds": ["turn_4"]},
        ]
        cleaned = PIPELINE.dedupe_identical_actions(PIPELINE.drop_completed_actions(actions))
        self.assertEqual(len(cleaned), 1)
        self.assertEqual(cleaned[0]["evidenceIds"], ["turn_3", "turn_9"])
        self.assertEqual(cleaned[0]["owner"], "David")

    def test_short_actions_are_rewritten_from_their_cited_turns_or_removed(self):
        turns = ["Jacqui: I have that code of conduct, so I'll get that over to you today as well, Niamh.",
                 "Jacqui: I will quickly share so we can go through the key points."]
        actions = [
            {"owner": "Jacqui Fox", "action": "send", "status": "COMMITTED", "evidenceIds": ["turn_1"]},
            {"owner": "Jacqui Fox", "action": "share", "status": "COMMITTED", "evidenceIds": ["turn_2"]},
            {"owner": "Stuart", "action": "Share the risk analysis with Niamh", "status": "COMMITTED", "evidenceIds": ["turn_1"]},
        ]
        original = PIPELINE.call_trooper
        try:
            PIPELINE.call_trooper = lambda prompt, max_tokens, schema: {"repairs": [
                {"candidateNumber": 1, "action": "Send the code of conduct to Niamh"},
                {"candidateNumber": 2, "action": ""}]}
            repaired = PIPELINE.repair_short_actions(actions, turns)
        finally:
            PIPELINE.call_trooper = original
        self.assertEqual([row["action"] for row in repaired],
                         ["Send the code of conduct to Niamh", "Share the risk analysis with Niamh"])
        self.assertEqual(repaired[0]["repairedFrom"], "send")

    def test_short_action_repair_fails_open(self):
        actions = [{"owner": "A", "action": "send", "status": "COMMITTED", "evidenceIds": ["turn_1"]}]
        original = PIPELINE.call_trooper
        try:
            def boom(prompt, max_tokens, schema):
                raise RuntimeError("down")
            PIPELINE.call_trooper = boom
            self.assertEqual(PIPELINE.repair_short_actions(actions, ["A: text"]), actions)
        finally:
            PIPELINE.call_trooper = original

    def test_recall_protection_ignores_process_language(self):
        action = {"status": "REQUIRED"}
        self.assertFalse(PIPELINE.action_has_recall_protection(action, ["Stuart: you need to do a desktop audit, it must be done"]))
        self.assertTrue(PIPELINE.action_has_recall_protection(action, ["Stuart: I'll share the risk analysis before you arrive"]))

    def test_audit_repairs_prerequisite_addressee_and_track_decision_object(self):
        turns = [
            "Niamh Lynch: What do I need to complete?",
            "Jacqui Fox: The training documents are next.",
            "Smith, Stuart M: You will need to complete the code of conduct first.",
            "Niamh Lynch: Are you going to have me on a separate track?",
            "Smith, Stuart M: I am working through the logistics and risk analysis for a separate track.",
        ]
        rows = PIPELINE.repair_audit_actions([
            {"owner": "Smith, Stuart M", "action": "Complete the code of conduct",
             "status": "REQUIRED", "evidenceIds": ["turn_3"]},
            {"owner": "Smith, Stuart M", "action": "Work through logistics and risk analysis",
             "status": "ASSIGNED", "evidenceIds": ["turn_5"]},
        ], turns)
        self.assertEqual(rows[0]["owner"], "Niamh Lynch")
        self.assertEqual(rows[1]["owner"], "Smith, Stuart M")
        self.assertEqual(rows[1]["action"],
                         "Decide whether Niamh should run a separate audit track based on the risk analysis and logistics")

    def test_audit_repairs_joint_owners_for_accepted_hotel_catch_up(self):
        rows = PIPELINE.repair_audit_actions([{
            "owner": "Niamh Lynch", "action": "Arrange a catch-up meeting at the hotel",
            "status": "ASSIGNED", "evidenceIds": ["turn_1", "turn_2"],
        }], [
            "Niamh Lynch: Do we need a catch-up meeting?",
            "Stuart M: Yes, we can meet at the hotel.",
        ])
        self.assertEqual(rows[0]["owner"], "Stuart M and Niamh Lynch")

    def test_audit_consolidates_complementary_work_package_fragments(self):
        rows = PIPELINE.consolidate_audit_actions([
            {"owner": "Stuart M", "action": "Build out the audit scope and product classifications",
             "status": "ASSIGNED", "support": 2, "sampleCount": 3,
             "mergedCandidateCount": 2, "evidenceIds": ["turn_12"]},
            {"owner": "Smith, Stuart M", "action": "Determine the list of applicable standards",
             "status": "REQUIRED", "support": 3, "sampleCount": 3,
             "mergedCandidateCount": 3, "evidenceIds": ["turn_21"]},
            {"owner": "Stuart M", "action": "Complete the risk assessment",
             "status": "COMMITTED", "support": 2, "sampleCount": 3,
             "mergedCandidateCount": 2, "evidenceIds": ["turn_204"]},
        ])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["action"],
                         "Prepare the audit scope, applicable standards, product classifications and risk-assessment inputs")
        self.assertEqual(rows[0]["support"], 3)
        self.assertEqual(rows[0]["mergedCandidateCount"], 7)
        self.assertEqual(rows[0]["evidenceIds"], ["turn_12", "turn_21", "turn_204"])

    def test_audit_consolidates_materials_access_prerequisites_and_catchup_separately(self):
        rows = PIPELINE.consolidate_audit_actions([
            {"owner": "Stuart", "action": "Share the risk analysis with Niamh", "evidenceIds": ["turn_205"]},
            {"owner": "Stuart M", "action": "Share complaints, CAPA and deviations data", "evidenceIds": ["turn_213"]},
            {"owner": "Stuart", "action": "Share the audit findings tracker", "evidenceIds": ["turn_218"]},
            {"owner": "Jacqui", "action": "Arrange access or sharing of documents", "evidenceIds": ["turn_169"]},
            {"owner": "Jacqui Fox", "action": "Figure out a way to get Niamh external SharePoint access", "evidenceIds": ["turn_170"]},
            {"owner": "Niamh", "action": "Complete the code of conduct", "evidenceIds": ["turn_158"]},
            {"owner": "Niamh Lynch", "action": "Complete the training attestation", "evidenceIds": ["turn_192"]},
            {"owner": "Stuart and Niamh", "action": "Arrange a catch-up meeting before the audit", "evidenceIds": ["turn_185"]},
            {"owner": "Stuart M and Niamh Lynch", "action": "Arrange a face-to-face catch-up at the hotel", "evidenceIds": ["turn_188"]},
        ])
        self.assertEqual([row.get("auditConsolidatedFamily") for row in rows], [
            "audit_material_sharing", "secure_document_access", "prerequisite_completion", "pre_audit_catchup",
        ])
        self.assertEqual(rows[0]["action"],
                         "Share the risk analysis, the audit tracker, complaints data, CAPA data and deviations data")
        self.assertEqual(rows[1]["action"], "Arrange secure document sharing and external SharePoint access")
        self.assertEqual(rows[2]["action"], "Complete the code of conduct and the training attestation")
        self.assertEqual(rows[3]["action"], "Arrange the face-to-face pre-audit catch-up at the hotel before the audit starts")

    def test_audit_does_not_merge_sending_with_completing_or_cross_owner_access(self):
        rows = PIPELINE.consolidate_audit_actions([
            {"owner": "Jacqui", "action": "Send the code of conduct to Niamh", "evidenceIds": ["turn_157"]},
            {"owner": "Niamh", "action": "Complete the code of conduct", "evidenceIds": ["turn_158"]},
            {"owner": "Jacqui", "action": "Arrange external SharePoint access", "evidenceIds": ["turn_169"]},
            {"owner": "Stuart", "action": "Arrange secure document sharing", "evidenceIds": ["turn_170"]},
            {"owner": "Niamh", "action": "Arrange travel before the audit", "evidenceIds": ["turn_267"]},
        ])
        self.assertEqual(len(rows), 5)
        self.assertEqual([row["action"] for row in rows[:2]],
                         ["Send the code of conduct to Niamh", "Complete the code of conduct"])


class SampledActionSupportTests(unittest.TestCase):
    class FakeBackend:
        available = True
        def __init__(self, vectors):
            self.vectors = vectors
        def encode_many(self, texts):
            return {text: self.vectors[text] for text in texts if text in self.vectors}

    def test_samples_merge_by_embedding_and_owner_and_carry_support(self):
        vectors = {
            "Share the risk analysis with Niamh": [1.0, 0.0],
            "Send Niamh the risk analysis before she arrives": [0.95, 0.31],
            "Book the hotel for the audit week": [0.0, 1.0],
        }
        actions = [
            {"owner": "Not stated", "action": "Share the risk analysis with Niamh", "status": "PROPOSED", "evidenceIds": ["turn_31"], "sample": 0},
            {"owner": "Stuart", "action": "Send Niamh the risk analysis before she arrives", "status": "ASSIGNED", "evidenceIds": ["turn_209"], "sample": 1},
            {"owner": "Stuart", "action": "Share the risk analysis with Niamh", "status": "COMMITTED", "evidenceIds": ["turn_31"], "sample": 2},
            {"owner": "Jacqui", "action": "Book the hotel for the audit week", "status": "COMMITTED", "evidenceIds": ["turn_2"], "sample": 1},
        ]
        merged = PIPELINE.merge_sampled_actions(actions, 3, self.FakeBackend(vectors))
        self.assertEqual(len(merged), 2)
        risk = merged[0]
        self.assertEqual(risk["action"], "Send Niamh the risk analysis before she arrives")
        self.assertEqual(risk["owner"], "Stuart")
        self.assertEqual(risk["support"], 3)
        self.assertEqual(risk["evidenceIds"], ["turn_31", "turn_209"])
        self.assertEqual(merged[1]["support"], 1)
        self.assertNotIn("sample", risk)
        tiers = [row["tier"] for row in PIPELINE.assign_action_tiers(merged, 3)]
        self.assertEqual(tiers, [1, 2])

    def test_audit_threshold_can_merge_consistent_lower_similarity_wording(self):
        vectors = {
            "Prepare the audit scope and applicable standards": [1.0, 0.0],
            "Build the scope, classifications and standards list": [0.65, 0.76],
        }
        actions = [
            {"owner": "Stuart", "action": text, "status": "ASSIGNED",
             "evidenceIds": [f"turn_{index}"], "sample": index - 1}
            for index, text in enumerate(vectors, 1)
        ]
        backend = self.FakeBackend(vectors)
        self.assertEqual(len(PIPELINE.merge_sampled_actions(actions, 3, backend)), 2)
        merged = PIPELINE.merge_sampled_actions(actions, 3, backend, threshold=0.64)
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["support"], 2)

    def test_single_sample_proposals_are_dropped_and_other_minority_rows_are_raised(self):
        rows = [
            {"action": "a", "support": 1, "status": "PROPOSED"},
            {"action": "b", "support": 1, "status": "REQUIRED"},
            {"action": "c", "support": 2, "status": "PROPOSED"},
            {"action": "d", "support": 3, "status": "PROPOSED"},
        ]
        tiered = PIPELINE.assign_action_tiers(rows, 3)
        self.assertEqual([(row["action"], row["tier"]) for row in tiered], [("b", 2), ("c", 1), ("d", 1)])

    def test_different_stated_owners_do_not_merge(self):
        vectors = {"Review the alarm code changes": [1.0, 0.0], "Review the alarm code changes again": [0.99, 0.1]}
        actions = [
            {"owner": "David", "action": "Review the alarm code changes", "status": "ASSIGNED", "evidenceIds": [], "sample": 0},
            {"owner": "Rebecca", "action": "Review the alarm code changes again", "status": "ASSIGNED", "evidenceIds": [], "sample": 1},
        ]
        self.assertEqual(len(PIPELINE.merge_sampled_actions(actions, 2, self.FakeBackend(vectors))), 2)

    def test_without_minilm_only_identical_wording_merges(self):
        actions = [
            {"owner": "A", "action": "Send the pack", "status": "COMMITTED", "evidenceIds": [], "sample": 0},
            {"owner": "A", "action": "Send the pack.", "status": "COMMITTED", "evidenceIds": [], "sample": 1},
            {"owner": "A", "action": "Send the information pack", "status": "COMMITTED", "evidenceIds": [], "sample": 2},
        ]
        merged = PIPELINE.merge_sampled_actions(actions, 3, None)
        self.assertEqual([row["support"] for row in merged], [2, 1])

    def test_single_sample_runs_have_every_row_in_tier_one(self):
        rows = PIPELINE.assign_action_tiers([{"action": "x"}], 1)
        self.assertEqual(rows[0]["tier"], 1)


class TrooperTransportTests(unittest.TestCase):
    def test_429_is_retried_and_other_client_errors_are_not(self):
        import io
        import urllib.error
        calls = {"n": 0}
        good = io.BytesIO(b'{"choices":[{"message":{"content":"{\\"ok\\":true}"}}]}')
        good.status = 200
        class Response:
            def __init__(self, body): self.body = body
            def __enter__(self): return self.body
            def __exit__(self, *args): return False
        def urlopen(request, timeout=0):
            calls["n"] += 1
            if calls["n"] == 1:
                raise urllib.error.HTTPError("u", 429, "limit", {}, io.BytesIO(b""))
            return Response(good)
        original_open, original_sleep, original_key = PIPELINE.urllib.request.urlopen, PIPELINE.time.sleep, PIPELINE.os.environ.get("TROOPER_API_KEY")
        try:
            PIPELINE.os.environ["TROOPER_API_KEY"] = "test"
            PIPELINE.urllib.request.urlopen = urlopen
            PIPELINE.time.sleep = lambda seconds: None
            self.assertEqual(PIPELINE.call_trooper("p", 10, {}), {"ok": True})
            self.assertEqual(calls["n"], 2)
            calls["n"] = 0
            def forbidden(request, timeout=0):
                calls["n"] += 1
                raise urllib.error.HTTPError("u", 401, "no", {}, io.BytesIO(b""))
            PIPELINE.urllib.request.urlopen = forbidden
            with self.assertRaisesRegex(RuntimeError, "HTTP 401"):
                PIPELINE.call_trooper("p", 10, {})
            self.assertEqual(calls["n"], 1)
        finally:
            PIPELINE.urllib.request.urlopen, PIPELINE.time.sleep = original_open, original_sleep
            if original_key is None:
                PIPELINE.os.environ.pop("TROOPER_API_KEY", None)
            else:
                PIPELINE.os.environ["TROOPER_API_KEY"] = original_key


class DeliverableMergeTests(unittest.TestCase):
    class FakeBackend:
        available = True
        def __init__(self, vectors): self.vectors = vectors
        def encode_many(self, texts): return {t: self.vectors[t] for t in texts if t in self.vectors}

    def test_same_deliverable_nearby_merges_and_far_needs_stronger_agreement(self):
        vectors = {"pre-audit catch-up meeting": [1.0, 0.0], "meeting at the hotel": [0.85, 0.53], "hotel booking": [0.1, 0.99]}
        actions = [
            {"owner": "Stuart M", "action": "Meet Niamh before the first week.", "status": "ASSIGNED", "evidenceIds": ["turn_176"]},
            {"owner": "Niamh", "action": "Have a catch-up at the hotel.", "status": "PROPOSED", "evidenceIds": ["turn_188"]},
            {"owner": "Jacqui", "action": "Book the hotel.", "status": "COMMITTED", "evidenceIds": ["turn_2"]},
            {"owner": "Stuart", "action": "Catch up at the hotel after week one.", "status": "PROPOSED", "evidenceIds": ["turn_400"]},
        ]
        structured = {1: {"deliverable": "pre-audit catch-up meeting", "verb": "ARRANGE", "recipient": ""},
                      2: {"deliverable": "meeting at the hotel", "verb": "ATTEND", "recipient": "Stuart"},
                      3: {"deliverable": "hotel booking", "verb": "ARRANGE", "recipient": ""},
                      4: {"deliverable": "meeting at the hotel", "verb": "ARRANGE", "recipient": ""}}
        merged = PIPELINE.merge_by_deliverable(actions, structured, self.FakeBackend(vectors))
        self.assertEqual([row["action"] for row in merged],
                         ["Meet Niamh before the first week.", "Book the hotel.", "Catch up at the hotel after week one."])
        self.assertEqual(merged[0]["evidenceIds"], ["turn_176", "turn_188"])
        self.assertEqual(merged[0]["mergedFrom"], ["Have a catch-up at the hotel."])
        self.assertEqual(merged[0]["owner"], "Stuart M and Niamh")

    def test_incompatible_verbs_or_owners_do_not_merge(self):
        vectors = {"risk files": [1.0, 0.0]}
        actions = [
            {"owner": "Rebecca", "action": "Update the risk files", "status": "ASSIGNED", "evidenceIds": ["turn_10"]},
            {"owner": "Rebecca", "action": "Review the risk files", "status": "ASSIGNED", "evidenceIds": ["turn_12"]},
            {"owner": "David", "action": "Update the risk files too", "status": "ASSIGNED", "evidenceIds": ["turn_14"]},
        ]
        structured = {1: {"deliverable": "risk files", "verb": "UPDATE", "recipient": ""},
                      2: {"deliverable": "risk files", "verb": "REVIEW", "recipient": ""},
                      3: {"deliverable": "risk files", "verb": "UPDATE", "recipient": ""}}
        self.assertEqual(len(PIPELINE.merge_by_deliverable(actions, structured, self.FakeBackend(vectors))), 3)

    def test_merge_is_skipped_without_structure(self):
        actions = [{"owner": "A", "action": "x y z w", "evidenceIds": []}, {"owner": "A", "action": "x y z w v", "evidenceIds": []}]
        self.assertEqual(PIPELINE.merge_by_deliverable(actions, {}, self.FakeBackend({})), actions)


class ImporterRoutingTests(unittest.TestCase):
    def test_importer_type_uses_the_evidence_grounded_selector_by_default(self):
        guidance, profile = PIPELINE.retrieval_selector_profile("Importer obligations review")
        self.assertEqual(profile, "importer_retrieval")
        self.assertIn("standing regulatory obligations", guidance)


class AlternativeChunkingTests(unittest.TestCase):
    def test_each_sample_gets_a_different_contiguous_chunking(self):
        base = PIPELINE.safe_boundaries([{"start": 1, "end": 30}, {"start": 31, "end": 60}, {"start": 61, "end": 100}], 100)
        chunkings = PIPELINE.alternative_chunkings(base, 100, 3)
        self.assertEqual(len(chunkings), 3)
        self.assertEqual([(c["start"], c["end"]) for c in chunkings[0]], [(1, 30), (31, 60), (61, 100)])
        self.assertEqual([(c["start"], c["end"]) for c in chunkings[1]], [(1, 15), (16, 45), (46, 90), (91, 100)])
        self.assertEqual([(c["start"], c["end"]) for c in chunkings[2]], [(1, 30), (31, 60), (61, 90), (91, 100)])
        for chunking in chunkings:
            self.assertEqual(chunking[0]["start"], 1)
            self.assertEqual(chunking[-1]["end"], 100)
            for left, right in zip(chunking, chunking[1:]):
                self.assertEqual(right["start"], left["end"] + 1)

    def test_single_sample_keeps_the_model_boundaries(self):
        base = [{"number": 1, "start": 1, "end": 20}]
        self.assertEqual(PIPELINE.alternative_chunkings(base, 20, 1), [base])


class SelectorBatchingTests(unittest.TestCase):
    def test_batches_respect_count_and_character_limits(self):
        small = [(n, "x" * 100) for n in range(1, 21)]
        self.assertEqual([len(b) for b in PIPELINE.selector_batches(small)], [15, 5])
        big = [(n, "y" * 9000) for n in range(1, 6)]
        self.assertEqual([len(b) for b in PIPELINE.selector_batches(big)], [2, 2, 1])
        self.assertEqual(PIPELINE.selector_batches([]), [])
