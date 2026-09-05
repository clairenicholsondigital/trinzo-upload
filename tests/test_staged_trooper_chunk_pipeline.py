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
