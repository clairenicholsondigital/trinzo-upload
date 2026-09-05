import importlib.util
import sys
import unittest
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
        }
        for meeting_type, profile in expected.items():
            with self.subTest(meeting_type=meeting_type):
                self.assertEqual(PIPELINE.retrieval_selector_profile(meeting_type)[1], profile)
        for meeting_type in ("General", "Decision meeting", "Importer obligations review",
                             "Software and technical-file weekly review", "Technical file consultancy review", ""):
            with self.subTest(meeting_type=meeting_type):
                self.assertIsNone(PIPELINE.retrieval_selector_profile(meeting_type))

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
