import json
import unittest
from pathlib import Path

from scripts.project_update_minilm import annotate_report_with_project_context, build_context_first_milestones

REPO_DIR = Path(__file__).resolve().parents[1]
FIXTURE = REPO_DIR / "tests" / "fixtures" / "project_context_contract.json"


class ProjectContextContractTests(unittest.TestCase):
    def load_context(self):
        return json.loads(FIXTURE.read_text(encoding="utf-8"))

    def test_context_fixture_has_canonical_node_to_python_keys(self):
        context = self.load_context()
        required_top_level = {
            "projectId",
            "projectName",
            "found",
            "projectResolution",
            "activeMilestones",
            "activeRisks",
            "recentReports",
            "healthHistory",
            "milestoneHistory",
            "riskSuggestions",
            "latestSnapshot",
            "generatedAt",
        }
        self.assertTrue(required_top_level.issubset(context.keys()))
        milestone = context["activeMilestones"][0]
        self.assertIn("comparisonKey", milestone)
        self.assertIn("latestAssessment", milestone)
        self.assertIn("previousAssessment", milestone)
        self.assertEqual(context["projectResolution"]["matchedBy"], "id")

    def test_python_annotation_compares_against_contract_context(self):
        context = self.load_context()
        report = {
            "healthAreas": {"schedule": {"status": "on_track", "trend": "stable", "evidence": []}},
            "milestones": [
                {
                    "milestone": "Data migration phase 1",
                    "comparison_key": "data_migration_phase_1",
                    "delivery_status": "blocked",
                    "normalised_evidence_summary": "Still blocked pending ownership.",
                    "excerpt": "Still blocked pending ownership.",
                }
            ],
            "risks": [{"riskTitle": "Ownership gap risk", "description": "Ownership remains unclear."}],
            "comparisonSnapshot": {},
        }

        annotated, diagnostics = annotate_report_with_project_context(report, context)

        self.assertGreater(diagnostics["milestonesCompared"], 0)
        self.assertGreater(diagnostics["healthAreasCompared"], 0)
        self.assertGreater(diagnostics["riskTitlesCompared"], 0)
        self.assertEqual(annotated["milestones"][0]["previous_status"], "blocked")
        self.assertIn(annotated["milestones"][0]["trend"], {"stable", "deteriorating"})
        self.assertEqual(annotated["risks"][0]["core_risk_id"], 601)

    def test_context_first_milestones_carry_forward_absent_contract_milestones(self):
        context = self.load_context()
        milestones = build_context_first_milestones(
            [
                {
                    "milestone": "Data migration phase 1",
                    "comparison_key": "data_migration_phase_1",
                    "delivery_status": "blocked",
                    "health_assessment": "blocked",
                    "normalised_evidence_summary": "Data migration is blocked pending ownership.",
                    "excerpt": "Data migration is blocked pending ownership.",
                    "next_steps": ["Assign a single owner."],
                    "milestone_match_confidence": 0.9,
                }
            ],
            context,
        )

        milestone_names = [item["milestone"] for item in milestones]
        self.assertIn("Data migration phase 1", milestone_names)
        self.assertIn("Training plan", milestone_names)
        carried = next(item for item in milestones if item["milestone"] == "Training plan")
        self.assertEqual(carried["transcript_update_status"], "carried_forward")


if __name__ == "__main__":
    unittest.main()
