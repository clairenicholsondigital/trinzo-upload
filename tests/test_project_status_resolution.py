import json
import unittest
from pathlib import Path

from scripts.python_llm import analyse

FIXTURE = Path(__file__).parent / "fixtures" / "project_update_june_2_2026.txt"


class ProjectStatusResolutionTest(unittest.TestCase):
    def setUp(self):
        self.transcript = FIXTURE.read_text(encoding="utf-8")
        self.result = analyse(self.transcript)
        self.segments = {segment["milestone"]: segment for segment in self.result["segments"]}

    def test_split_status_fields_are_present(self):
        segment = self.segments["ai_pipeline_strategy"]
        self.assertIn("delivery_status", segment)
        self.assertIn("agreed_rag_status", segment)
        self.assertIn("health_assessment", segment)
        self.assertIn("delivery_status_confidence", segment)
        self.assertIn("agreed_rag_confidence", segment)
        self.assertIn("health_assessment_confidence", segment)
        self.assertIn("final_decision_evidence", segment)
        self.assertIn("conflicting_evidence", segment)
        self.assertIn("status_resolution_note", segment)
        self.assertIn("status_modifiers", segment)
        self.assertEqual(segment["status"], segment["delivery_status"])
        json.dumps(self.result)

    def test_june_2_milestone_resolution(self):
        repeatable = self.segments["repeatable_ai_use_cases"]
        self.assertEqual(repeatable["delivery_status"], "complete")
        self.assertEqual(repeatable["agreed_rag_status"], "green")

        intake = self.segments["use_case_intake_funnel"]
        self.assertIn(intake["delivery_status"], {"delayed", "in_progress"})
        self.assertEqual(intake["agreed_rag_status"], "amber")
        self.assertEqual(intake["raw_status"], "in_progress")

        stage_gate = self.segments["stage_gate_internal_review"]
        self.assertIn(stage_gate["delivery_status"], {"in_progress", "needs_review"})
        self.assertEqual(stage_gate["agreed_rag_status"], "green")
        self.assertTrue(any("templates" in item.lower() for item in stage_gate["evidence"] + stage_gate["conflicting_evidence"]))
        self.assertEqual(stage_gate["raw_status"], "in_progress")

        pipeline = self.segments["ai_pipeline_strategy"]
        self.assertEqual(pipeline["delivery_status"], "blocked")
        self.assertEqual(pipeline["agreed_rag_status"], "amber")
        self.assertIn(pipeline["health_assessment"], {"red", "amber"})
        self.assertIn("Let's put amber", pipeline["final_decision_evidence"])
        self.assertIn("dependency_blocked", pipeline["status_modifiers"])

        webinars = self.segments["webinars"]
        self.assertEqual(webinars["delivery_status"], "in_progress")
        self.assertEqual(webinars["agreed_rag_status"], "green")
        self.assertEqual(webinars["raw_status"], "in_progress")
        self.assertIn("partially_complete", webinars["status_modifiers"])

        impact = self.segments["ai_commercial_impact_report"]
        self.assertEqual(impact["delivery_status"], "scheduled")
        self.assertEqual(impact["agreed_rag_status"], "green")

        ad_hoc = self.segments["ad_hoc_sows"]
        self.assertEqual(ad_hoc["delivery_status"], "in_progress")
        self.assertEqual(ad_hoc["agreed_rag_status"], "green")
        self.assertTrue(any("visibility on workload" in item.lower() for item in ad_hoc["evidence"] + ad_hoc["conflicting_evidence"]))
        self.assertIn("workload_visibility_needed", ad_hoc["status_modifiers"])

        vendor = self.segments["stage_gate_vendor_strategy"]
        self.assertEqual(vendor["delivery_status"], "in_progress")
        self.assertEqual(vendor["agreed_rag_status"], "amber")

        grant = self.segments["ei_grant_feedback"]
        self.assertEqual(grant["delivery_status"], "awaiting_input")
        self.assertIn(grant["agreed_rag_status"], {"amber", "unknown"})
        self.assertEqual(grant["final_decision_evidence"], "No update.")
        self.assertEqual(grant["next_steps"], ["she said she'd follow up this week."])

        governance = self.segments["ai_governance_framework"]
        self.assertIn(governance["delivery_status"], {"complete", "needs_review"})
        self.assertEqual(governance["agreed_rag_status"], "blue")
        self.assertIn(governance["health_assessment"], {"blue", "amber"})
        self.assertIn("pending_review", governance["status_modifiers"])
        self.assertIn("awaiting_approval", governance["status_modifiers"])

    def test_confidence_fields_stay_meaningful(self):
        stage_gate = self.segments["stage_gate_internal_review"]
        repeatable = self.segments["repeatable_ai_use_cases"]
        pipeline = self.segments["ai_pipeline_strategy"]
        webinars = self.segments["webinars"]
        governance = self.segments["ai_governance_framework"]

        self.assertLess(stage_gate["delivery_status_confidence"], repeatable["delivery_status_confidence"])
        self.assertGreaterEqual(pipeline["agreed_rag_confidence"], 0.8)
        self.assertGreaterEqual(webinars["delivery_status_confidence"], 0.85)
        self.assertGreaterEqual(governance["delivery_status_confidence"], 0.8)
        self.assertLess(stage_gate["health_assessment_confidence"], 0.8)
        self.assertLessEqual(pipeline["health_assessment_confidence"], 0.6)
        self.assertLessEqual(stage_gate["confidence"], 1.0)
        self.assertLessEqual(stage_gate["milestone_match_confidence"], 1.0)
        self.assertNotEqual(stage_gate["confidence"], 100)


if __name__ == "__main__":
    unittest.main()
