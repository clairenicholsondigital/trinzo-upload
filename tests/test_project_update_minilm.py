import json
import subprocess
import sys
import unittest
from pathlib import Path

from scripts.project_update_minilm import build_project_update_output


REPO_DIR = Path(__file__).resolve().parents[1]
FIXTURE = REPO_DIR / "tests" / "fixtures" / "project_update_june_2_2026.txt"


class ProjectUpdateMiniLMWorkflowTest(unittest.TestCase):
    def test_builds_project_report_without_models(self):
        transcript = FIXTURE.read_text(encoding="utf-8")
        result = build_project_update_output(transcript, use_minilm=False, use_rewrite=False)

        self.assertEqual(result["mode"], "project_update_minilm")
        self.assertIn("segments", result)
        self.assertIn("projectReport", result)
        self.assertIn("modelDiagnostics", result)
        self.assertFalse(result["modelDiagnostics"]["minilmAvailable"])
        self.assertFalse(result["modelDiagnostics"]["rewriterAvailable"])
        self.assertGreater(len(result["projectReport"]["milestones"]), 0)
        self.assertEqual(result["projectReport"]["reportStatus"], "draft")
        self.assertIn(result["projectReport"]["overallHealth"], {"on_track", "at_risk", "off_track", "completed", "unknown"})
        self.assertGreaterEqual(len(result["projectReport"]["healthAreas"]), 5)
        json.dumps(result)

    def test_cli_outputs_json(self):
        completed = subprocess.run(
            [
                sys.executable,
                str(REPO_DIR / "scripts" / "project_update_minilm.py"),
                str(FIXTURE),
                "--skip-minilm",
                "--skip-rewrite",
            ],
            cwd=REPO_DIR,
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        payload = json.loads(completed.stdout)
        self.assertEqual(payload["mode"], "project_update_minilm")
        self.assertIn("projectReport", payload)

    def test_project_route_uses_project_script_and_meeting_final_stays_separate(self):
        api = (REPO_DIR / "routes" / "api.js").read_text(encoding="utf-8")
        self.assertIn("runPythonTranscriptScript('project_update_minilm.py'", api)
        self.assertIn("runPythonTranscriptScript('python_llm.py'", api)
        self.assertIn("router.post('/meeting-minutes-final'", api)
        meeting_route = api.split("router.post('/meeting-minutes-final'", 1)[1].split("router.post('/meeting-minutes-final/improve'", 1)[0]
        self.assertIn("meeting_minutes_minilm_only.py", meeting_route)
        self.assertNotIn("project_update_minilm.py", meeting_route)

    def test_project_update_page_enables_editable_report_ui(self):
        page = (REPO_DIR / "views" / "project-update-test.html").read_text(encoding="utf-8")
        shared_js = (REPO_DIR / "public" / "test-transcript-page.js").read_text(encoding="utf-8")

        self.assertIn("projectReportUi: true", page)
        self.assertIn("buttonText: 'Process meeting'", page)
        self.assertIn(".project-tabs", page)
        self.assertIn("renderProjectReport", shared_js)
        self.assertIn("Copy report JSON", shared_js)
        self.assertIn("renderSelectField", shared_js)
        self.assertIn("['draft', 'in_review', 'approved', 'archived']", shared_js)
        self.assertIn('<details class="raw-json">', shared_js)
        self.assertIn('data-project-add="milestones"', shared_js)
        self.assertIn('data-project-remove="milestones"', shared_js)
        self.assertIn("baseline_finish_date", shared_js)
        self.assertIn("forecast_finish_date", shared_js)
        self.assertIn("queueProjectAutosave", shared_js)
        self.assertNotIn("RAG colour", shared_js)
        self.assertIn("Overall summary", shared_js)
        self.assertIn("Settings", shared_js)
        self.assertIn("project-colour-swatch", page)
        self.assertIn("renderColourField", shared_js)
        self.assertIn("data-project-baseline-deadline", shared_js)
        self.assertIn("data-project-forecast-deadline", shared_js)

    def test_project_risk_titles_are_human_friendly(self):
        transcript = FIXTURE.read_text(encoding="utf-8")
        result = build_project_update_output(transcript, use_minilm=False, use_rewrite=False)
        risk_titles = [risk["riskTitle"] for risk in result["projectReport"]["risks"]]

        self.assertGreater(len(risk_titles), 0)
        self.assertTrue(any("AI Pipeline Strategy needs attention" == title for title in risk_titles))
        self.assertFalse(any("_" in title for title in risk_titles))

    def test_project_update_browsing_routes_are_registered(self):
        server = (REPO_DIR / "server.js").read_text(encoding="utf-8")
        api = (REPO_DIR / "routes" / "api.js").read_text(encoding="utf-8")
        db = (REPO_DIR / "utils" / "db.js").read_text(encoding="utf-8")

        self.assertIn("project-update-reports.html", server)
        self.assertIn("project-update-milestones.html", server)
        self.assertIn("sendView(res", server)
        self.assertIn("router.get('/project-update-test/reports'", api)
        self.assertIn("router.get('/project-update-test/milestones'", api)
        self.assertIn("router.post('/project-update-test/milestones'", api)
        self.assertIn("listProjectReports", db)
        self.assertIn("getProjectMilestoneDetail", db)
        self.assertIn("createProjectMilestone", db)

        reports_page = (REPO_DIR / "views" / "project-update-reports.html").read_text(encoding="utf-8")
        milestones_page = (REPO_DIR / "views" / "project-update-milestones.html").read_text(encoding="utf-8")
        self.assertIn("/api/project-update-test/reports", reports_page)
        self.assertIn("/api/project-update-test/milestones", milestones_page)
        self.assertIn("/project-update-test/milestones", reports_page)
        self.assertIn("/project-update-test/reports", milestones_page)
        self.assertIn('id="milestoneForm"', milestones_page)
        self.assertIn("Create milestone", milestones_page)
        self.assertIn("baselineFinishDate", milestones_page)

    def test_project_update_save_path_stores_milestone_deadlines(self):
        db = (REPO_DIR / "utils" / "db.js").read_text(encoding="utf-8")

        self.assertIn("function qDate", db)
        self.assertIn("baseline_finish_date = COALESCE", db)
        self.assertIn("project_report_milestone_assessments", db)
        self.assertIn("forecast_finish_date)", db)


if __name__ == "__main__":
    unittest.main()
