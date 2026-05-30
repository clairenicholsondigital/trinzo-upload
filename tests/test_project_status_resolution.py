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
        self.assertIn("comparison_key", segment)
        self.assertIn("evidence_quality_flags", segment)
        self.assertIn("normalised_evidence_summary", segment)
        self.assertEqual(segment["status"], segment["delivery_status"])
        self.assertIn("project_health_summary", self.result)
        self.assertIn("comparison_snapshot", self.result)
        self.assertIn("actions", self.result)
        self.assertIn("progress_classification", segment)
        json.dumps(self.result)

    def test_june_2_milestone_resolution(self):
        repeatable = self.segments["repeatable_ai_use_cases"]
        self.assertEqual(repeatable["delivery_status"], "complete")
        self.assertEqual(repeatable["agreed_rag_status"], "green")

        intake = self.segments["use_case_intake_funnel"]
        self.assertEqual(intake["delivery_status"], "in_progress")
        self.assertEqual(intake["agreed_rag_status"], "amber")
        self.assertEqual(intake["raw_status"], "in_progress")
        self.assertIn("not_operational", intake["reason_tags"])
        self.assertNotIn("delayed", intake["reason_tags"])
        self.assertIn("not_operational", intake["status_modifiers"])

        stage_gate = self.segments["stage_gate_internal_review"]
        self.assertEqual(stage_gate["delivery_status"], "in_progress")
        self.assertEqual(stage_gate["agreed_rag_status"], "green")
        self.assertTrue(any("templates" in item.lower() for item in stage_gate["evidence"] + stage_gate["conflicting_evidence"]))
        self.assertEqual(stage_gate["raw_status"], "in_progress")
        self.assertIn("not_finalised", stage_gate["status_modifiers"])
        self.assertIn("Review stage gate templates.", stage_gate["next_steps"])

        pipeline = self.segments["ai_pipeline_strategy"]
        self.assertEqual(pipeline["delivery_status"], "blocked")
        self.assertEqual(pipeline["agreed_rag_status"], "amber")
        self.assertIn(pipeline["health_assessment"], {"red", "amber"})
        self.assertIn("Let's put amber", pipeline["final_decision_evidence"])
        self.assertIn("dependency_blocked", pipeline["status_modifiers"])
        self.assertIn("awaiting_external_input", pipeline["status_modifiers"])
        self.assertIn("Confirm AI pipeline dependencies with sales.", pipeline["next_steps"])
        self.assertEqual(pipeline["progress_classification"], "blocked")

        webinars = self.segments["webinars"]
        self.assertEqual(webinars["delivery_status"], "in_progress")
        self.assertEqual(webinars["agreed_rag_status"], "green")
        self.assertEqual(webinars["raw_status"], "in_progress")
        self.assertIn("partially_complete", webinars["status_modifiers"])
        self.assertEqual(webinars["normalised_evidence_summary"], "Two webinars have been delivered and the third is booked.")
        self.assertIn("contradicted_by_nearby_context", webinars["evidence_quality_flags"])
        self.assertEqual(webinars["progress_classification"], "active")

        impact = self.segments["ai_commercial_impact_report"]
        self.assertEqual(impact["delivery_status"], "scheduled")
        self.assertEqual(impact["agreed_rag_status"], "green")
        self.assertIn("scheduled_not_due", impact["status_modifiers"])

        ad_hoc = self.segments["ad_hoc_sows"]
        self.assertEqual(ad_hoc["delivery_status"], "in_progress")
        self.assertEqual(ad_hoc["agreed_rag_status"], "green")
        self.assertTrue(any("visibility on workload" in item.lower() for item in ad_hoc["evidence"] + ad_hoc["conflicting_evidence"]))
        self.assertIn("workload_visibility_needed", ad_hoc["status_modifiers"])
        self.assertIn("partially_complete", ad_hoc["status_modifiers"])
        self.assertIn("scope_not_defined", ad_hoc["status_modifiers"])
        self.assertEqual(ad_hoc["progress_classification"], "active")

        vendor = self.segments["stage_gate_vendor_strategy"]
        self.assertEqual(vendor["delivery_status"], "in_progress")
        self.assertEqual(vendor["agreed_rag_status"], "amber")
        self.assertEqual(vendor["raw_status"], "in_progress")
        self.assertNotIn("delayed", vendor["reason_tags"])
        self.assertIn("partially_complete", vendor["status_modifiers"])
        self.assertIn("not_finalised", vendor["status_modifiers"])
        self.assertIn("Draft vendor strategy document.", vendor["next_steps"])

        grant = self.segments["ei_grant_feedback"]
        self.assertEqual(grant["delivery_status"], "awaiting_input")
        self.assertIn(grant["agreed_rag_status"], {"amber", "unknown"})
        self.assertEqual(grant["final_decision_evidence"], "No update.")
        self.assertIn("Follow up innovation grant feedback.", grant["next_steps"])
        self.assertIn("awaiting_external_input", grant["status_modifiers"])
        self.assertEqual(grant["progress_classification"], "stalled")

        governance = self.segments["ai_governance_framework"]
        self.assertEqual(governance["delivery_status"], "in_review")
        self.assertEqual(governance["agreed_rag_status"], "blue")
        self.assertEqual(governance["health_assessment"], "blue")
        self.assertIn("pending_review", governance["status_modifiers"])
        self.assertIn("awaiting_approval", governance["status_modifiers"])
        self.assertIn("newly_added", governance["status_modifiers"])
        self.assertEqual(governance["comparison_key"], "ai_governance_framework")
        self.assertEqual(governance["progress_classification"], "awaiting_review")

    def test_confidence_fields_stay_meaningful(self):
        stage_gate = self.segments["stage_gate_internal_review"]
        repeatable = self.segments["repeatable_ai_use_cases"]
        pipeline = self.segments["ai_pipeline_strategy"]
        webinars = self.segments["webinars"]
        governance = self.segments["ai_governance_framework"]
        ad_hoc = self.segments["ad_hoc_sows"]

        self.assertLess(stage_gate["delivery_status_confidence"], repeatable["delivery_status_confidence"])
        self.assertGreaterEqual(pipeline["agreed_rag_confidence"], 0.8)
        self.assertGreaterEqual(webinars["delivery_status_confidence"], 0.85)
        self.assertGreaterEqual(governance["delivery_status_confidence"], 0.8)
        self.assertGreaterEqual(ad_hoc["delivery_status_confidence"], 0.7)
        self.assertLess(stage_gate["health_assessment_confidence"], 0.8)
        self.assertLessEqual(pipeline["health_assessment_confidence"], 0.6)
        self.assertLessEqual(stage_gate["confidence"], 1.0)
        self.assertLessEqual(stage_gate["milestone_match_confidence"], 1.0)
        self.assertNotEqual(stage_gate["confidence"], 100)

    def test_project_health_summary_and_snapshot(self):
        summary = self.result["project_health_summary"]
        snapshot = self.result["comparison_snapshot"]
        actions = self.result["actions"]

        self.assertEqual(summary["overall_health"], "amber")
        self.assertEqual(summary["rag_counts"]["green"], 5)
        self.assertEqual(summary["rag_counts"]["amber"], 4)
        self.assertEqual(summary["delivery_status_counts"]["in_review"], 1)
        self.assertEqual(summary["delivery_status_counts"]["blocked"], 1)
        self.assertEqual(summary["key_blockers"][0]["milestone"], "ai_pipeline_strategy")
        self.assertIn("use_case_intake_funnel", summary["attention_items"])
        self.assertIn("ai_governance_framework", summary["completed_items"])
        self.assertEqual(snapshot["meeting_date"], "")
        self.assertEqual(snapshot["segments"][3]["comparison_key"], "ai_pipeline_strategy")
        self.assertEqual(actions[0]["related_milestone"], "stage_gate_internal_review")
        self.assertEqual(actions[1]["related_milestone"], "ai_pipeline_strategy")
        self.assertEqual(actions[2]["related_milestone"], "stage_gate_vendor_strategy")
        self.assertEqual(actions[3]["meetingActionPointOwner"], "Emma")
        self.assertGreaterEqual(actions[4]["actionConfidence"], 0.55)
        self.assertEqual(actions[4]["meetingActionPointOwner"], "Conor Flynn")

    def test_review_state_precedence_and_conflicting_rag(self):
        transcript = "\n".join(
            [
                "Ciara Griffin 0:01 AI governance framework draft.",
                "Conor Flynn 0:03 We completed version one yesterday.",
                "Conor Flynn 0:08 Needs review from leadership though.",
                "Ciara Griffin 0:12 So complete or in review?",
                "Conor Flynn 0:15 I'd call it in review.",
                "Ciara Griffin 0:18 Status blue.",
            ]
        )
        result = analyse(transcript)
        segment = next(item for item in result["segments"] if item["milestone"] == "ai_governance_framework")
        self.assertEqual(segment["delivery_status"], "in_review")
        self.assertEqual(segment["agreed_rag_status"], "blue")
        self.assertEqual(segment["health_assessment"], "blue")
        self.assertEqual(segment["progress_classification"], "awaiting_review")

    def test_action_block_backfills_segment_next_steps(self):
        transcript = "\n".join(
            [
                "Ciara Griffin 0:01 Stage gate review process.",
                "Conor Flynn 0:03 We've done two reviews through it already.",
                "Ciara Griffin 0:07 AI pipeline strategy.",
                "Conor Flynn 0:09 Still blocked. We need sales input and we don't have it.",
                "Ciara Griffin 0:14 Vendor strategy rollout.",
                "Conor Flynn 0:16 The interviews are complete. The actual strategy document doesn't exist yet though.",
                "Ciara Griffin 0:22 Actions before next week: Review stage gate templates. Confirm AI pipeline dependencies with sales. Draft vendor strategy document.",
            ]
        )
        result = analyse(transcript)
        segments = {segment["milestone"]: segment for segment in result["segments"]}
        self.assertIn("Review stage gate templates.", segments["stage_gate_internal_review"]["next_steps"])
        self.assertIn("Confirm AI pipeline dependencies with sales.", segments["ai_pipeline_strategy"]["next_steps"])
        self.assertIn("Draft vendor strategy document.", segments["stage_gate_vendor_strategy"]["next_steps"])


if __name__ == "__main__":
    unittest.main()
