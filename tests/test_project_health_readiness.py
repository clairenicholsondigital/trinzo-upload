import copy
import unittest
from unittest.mock import patch

from scripts.python_llm import build_project_health_summary
from scripts.project_update_minilm import build_report_payload, build_project_update_output, rewrite_report_summary


def segment(rag="unknown", status="unknown", **extra):
    return {"milestone": "Migration", "comparison_key": "migration", "agreed_rag_status": rag,
            "delivery_status": status, **extra}


def assemble(rows=(), texts=(), context=None):
    diagnostics = {"healthAreaMatches": {}}
    report = build_report_payload(
        {"project_health_summary": {"overall_health": "green", "overall_health_reason": "Most milestones are on track or complete."}},
        list(rows), diagnostics, minilm_first_context={"rawTranscriptTexts": list(texts)}, project_context=context,
    )
    return report, diagnostics


class ProjectHealthReadinessTests(unittest.TestCase):
    def test_no_evidence_and_all_unknown_are_not_green(self):
        for rows in [[], [segment()], [segment(status="not_started")]]:
            with self.subTest(rows=rows):
                summary = build_project_health_summary(rows)
                self.assertEqual(summary["overall_health"], "unknown")
                self.assertIn("insufficient current evidence", summary["overall_health_reason"])
                self.assertNotIn("most milestones", summary["overall_health_reason"].lower())

    def test_explicit_adverse_assessments_cannot_fall_through_to_green(self):
        for row, expected in [(segment("red", "delayed"), "red"), (segment("amber"), "amber"),
                              (segment(status="blocked"), "amber"), (segment(status="delayed"), "amber"),
                              (segment(status="awaiting_input"), "amber")]:
            with self.subTest(row=row):
                result = build_project_health_summary([row])
                self.assertEqual(result["overall_health"], expected)
                self.assertIn(expected.title(), result["overall_health_reason"])
                self.assertNotIn("most milestones", result["overall_health_reason"].lower())

    def test_two_blockers_still_escalate_to_red(self):
        self.assertEqual(build_project_health_summary([segment(status="blocked"),
                        segment(status="blocked", milestone="Training")])["overall_health"], "red")

    def test_supported_green_and_completed_work_remain_distinct(self):
        for row, expected in [(segment("green", "in_progress"), "green"), (segment("blue", "complete"), "blue")]:
            result = build_project_health_summary([row])
            self.assertEqual(result["overall_health"], expected)
            self.assertEqual(result["assessed_segment_count"], 1)
            self.assertIn("1 of 1", result["overall_health_reason"])

    def test_explicit_green_agreement_is_not_relabelled_as_project_completion(self):
        self.assertEqual(build_project_health_summary([segment("green", "complete")])["overall_health"], "green")

    def test_canonical_report_statuses_are_counted_as_assessments(self):
        for status, expected in [("on_track", "green"), ("at_risk", "amber"), ("off_track", "red"), ("completed", "blue")]:
            with self.subTest(status=status):
                result = build_project_health_summary([segment(status=status)])
                self.assertEqual(result["overall_health"], expected)
                self.assertEqual(result["assessed_segment_count"], 1)

    def test_mixed_unknown_coverage_has_no_majority_claim(self):
        result = build_project_health_summary([segment("green", "in_progress"), segment(milestone="Training")])
        self.assertEqual(result["overall_health"], "green")
        self.assertIn("1 of 2", result["overall_health_reason"])
        self.assertNotIn("most", result["overall_health_reason"].lower())

    def test_final_assembly_explanation_agrees_with_changed_health(self):
        for text, expected in [("Project delivery is slipping behind schedule.", "amber"),
                               ("A major regression completely blocks our release.", "red"),
                               ("Let us reschedule this project review call.", "unknown")]:
            with self.subTest(text=text):
                report, _ = assemble(texts=[text])
                self.assertEqual(report["overallHealthRag"], expected)
                self.assertIn({"amber": "Amber", "red": "Red", "unknown": "Not yet assessed"}[expected], report["summary"])
                self.assertNotIn("most milestones", report["summary"].lower())

    def test_direct_project_health_signal_can_be_green_without_milestone_coverage(self):
        report, diagnostics = assemble(texts=["Overall project health is still green."])
        self.assertEqual(report["overallHealthRag"], "green")
        self.assertIn("meeting-level health signals", report["summary"])
        self.assertEqual(diagnostics["healthCoverage"]["assessed"], 0)

    def test_sparse_project_coverage_excludes_carried_forward_assessments(self):
        context = {"found": True, "activeMilestones": [
            {"milestoneId": 1, "milestoneName": "Migration", "comparisonKey": "migration"},
            {"milestoneId": 2, "milestoneName": "Training", "comparisonKey": "training",
             "latestAssessment": {"status": "completed", "summary": "Approved previously.", "reportId": 7, "reportVersionId": 9}},
        ], "healthHistory": [], "activeRisks": [], "riskSuggestions": []}
        row = segment("amber", "blocked", milestoneId=1, normalised_evidence_summary="Migration is blocked.", evidence=["Migration is blocked."])
        report, diagnostics = assemble([row], context=context)
        self.assertEqual(report["overallHealthRag"], "amber")
        self.assertIn("1 of 2 configured milestones", report["summary"])
        self.assertIn("remaining milestones have not been reassessed", report["summary"])
        self.assertEqual(diagnostics["healthCoverage"]["assessed"], 1)
        self.assertEqual(report["milestones"][1]["transcript_update_status"], "carried_forward")

    def test_previous_approved_status_is_not_current_meeting_evidence(self):
        context = {"activeMilestones": [{"milestoneId": 1, "milestoneName": "Migration", "comparisonKey": "migration",
                   "latestAssessment": {"status": "on_track", "summary": "Previously green."}}]}
        report, _ = assemble(context=context)
        self.assertEqual(report["overallHealthRag"], "unknown")
        self.assertIn("0 of 1 configured milestones", report["summary"])

    def test_supported_warning_is_not_lost_when_source_sentences_are_empty(self):
        report, _ = assemble([segment("red", "delayed", normalised_evidence_summary="Release is delayed.")])
        self.assertEqual(report["overallHealthRag"], "red")
        self.assertIn("Red", report["summary"])

    def test_rewriter_cannot_change_generated_health_or_evidence(self):
        class ContraryRewriter:
            available, model_name, model_path, reason = True, "fake", "fake", ""
            def rewrite_items(self, items):
                raise AssertionError("The calculated health statement must not be rewritten")
        report, _ = assemble(texts=["A major regression completely blocks our release."])
        before = copy.deepcopy(report)
        rewritten, diagnostics = rewrite_report_summary(report, ContraryRewriter(), preserve_health_summary=True)
        self.assertEqual(rewritten, before)
        self.assertEqual(diagnostics["rewriteEdits"], [])

    def test_full_generation_does_not_load_rewriter_and_stays_consistent(self):
        for rewrite in [False, True]:
            with patch("scripts.project_update_minilm.LocalMinutesRewriter.load") as load:
                load.return_value.available = False
                load.return_value.model_name = load.return_value.model_path = load.return_value.reason = ""
                result = build_project_update_output("Team: A major regression completely blocks our release.", use_minilm=False, use_rewrite=rewrite)
                load.assert_called_once_with(enabled=False)
            report = result["projectReport"]
            self.assertEqual(report["overallHealthRag"], "red")
            self.assertIn("Red", report["summary"])
            self.assertIn("health_summary_consistency", result["modelDiagnostics"]["pipelineOrder"])


if __name__ == "__main__":
    unittest.main()
