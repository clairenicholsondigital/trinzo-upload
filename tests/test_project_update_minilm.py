import json
import subprocess
import sys
import unittest
from pathlib import Path

from scripts.project_update_minilm import build_project_update_output
from scripts.project_update_minilm import normalise_report_payload


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
        self.assertIn("title: 'Project Progress Reporting Tool'", page)
        self.assertIn("buttonText: 'Process meeting'", page)
        self.assertIn("resetButtonText: 'Clear and restart'", page)
        self.assertIn("confirmReset: true", page)
        self.assertIn("loadingMessage: 'Analysing transcript...'", page)
        self.assertIn("config.loadingMessage || 'Analysing transcript with local Python logic...'", shared_js)
        self.assertIn(".project-tabs", page)
        self.assertIn("renderProjectReport", shared_js)
        self.assertIn("Open in full screen", shared_js)
        self.assertIn("openProjectReportFullScreenBtn", shared_js)
        self.assertIn("Are you sure you want to reset the page and start again?", shared_js)
        self.assertIn("projectReportPersistence", shared_js)
        self.assertIn("/project-update-test/reports/", shared_js)
        self.assertIn("Copy report JSON", shared_js)
        self.assertIn("renderSelectField", shared_js)
        self.assertIn("['draft', 'in_review', 'approved', 'archived']", shared_js)
        self.assertIn("statusOptionsForPath", shared_js)
        self.assertIn("['improving', 'stable', 'deteriorating'", shared_js)
        self.assertIn("Download PDF", shared_js)
        self.assertNotIn("Download branded PDF", shared_js)
        self.assertIn("/static/trinzo-logo.svg", shared_js)
        self.assertIn("project-report-logo print-only", shared_js)
        self.assertIn(".print-only { display:none; }", page)
        self.assertIn("window.print()", shared_js)
        self.assertIn("@media print", page)
        self.assertIn("#projectReportOutput { display:none !important; }", page)
        self.assertIn("#projectReportPrintOutput { display:block; }", page)
        self.assertIn("table-layout:fixed", page)
        self.assertIn("word-break:normal", page)
        self.assertIn("hyphens:none", page)
        self.assertIn("renderStaticProjectReport", shared_js)
        self.assertIn("renderStaticColour", shared_js)
        self.assertIn("combinedNextSteps", shared_js)
        self.assertIn("<strong>Overall status</strong>", shared_js)
        self.assertNotIn("Overall colour", shared_js)
        self.assertNotIn("<th>Blockers</th>", shared_js)
        self.assertNotIn("<th>Colour</th>", shared_js)
        self.assertIn("print-color-adjust:exact", page)
        self.assertTrue((REPO_DIR / "public" / "trinzo-logo.svg").read_text(encoding="utf-8").startswith("<svg"))
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
        self.assertIn("Use this field for the executive summary and key updates.", shared_js)
        self.assertNotIn("Key updates\n          <textarea", shared_js)
        self.assertIn("<th>Status</th><th>AI health assessment</th>", shared_js)
        self.assertNotIn("<th>Agreed colour</th>", shared_js)
        self.assertNotIn("<th>Risk</th><th>Description</th><th>Mitigation</th><th>Milestone</th><th>Confidence</th>", shared_js)
        self.assertNotIn("<th>Action</th><th>Owner</th><th>Deadline</th><th>Related milestone</th><th>Confidence</th>", shared_js)

    def test_project_risk_titles_are_human_friendly(self):
        transcript = FIXTURE.read_text(encoding="utf-8")
        result = build_project_update_output(transcript, use_minilm=False, use_rewrite=False)
        risk_titles = [risk["riskTitle"] for risk in result["projectReport"]["risks"]]

        self.assertGreater(len(risk_titles), 0)
        self.assertTrue(any("AI Pipeline Strategy needs attention" == title for title in risk_titles))
        self.assertFalse(any("_" in title for title in risk_titles))

    def test_unknown_generated_statuses_are_blank_in_project_report(self):
        transcript = FIXTURE.read_text(encoding="utf-8")
        result = build_project_update_output(transcript, use_minilm=False, use_rewrite=False)
        report = result["projectReport"]

        self.assertFalse(any(area["status"] == "unknown" for area in report["healthAreas"].values()))
        self.assertFalse(any(item.get("delivery_status") == "unknown" for item in report["milestones"]))

    def test_project_report_post_processing_filters_openers_cases_sentences_and_backfills_actions(self):
        report = normalise_report_payload(
            {
                "summary": "I'll keep this to about twenty minutes, just want to run through status, risks, and anything we need to escalate. delivered, but adoption is still variable.",
                "keyUpdates": [
                    "webinar delivered, conference presentation done.",
                    "Alright, actions from this: enforce capacity sign-off before SOW approval accelerate cross-training and documentation assign clear owner for vendor governance explore leading indicators for delivery health First risk, delivery capacity versus SOW commitments.",
                ],
                "milestones": [],
                "risks": [],
                "actions": [],
            }
        )

        self.assertNotIn("keep this to about twenty minutes", report["summary"].lower())
        self.assertIn("Delivered, but adoption is still variable.", report["summary"])
        self.assertIn("Webinar delivered, conference presentation done.", report["keyUpdates"])
        self.assertGreaterEqual(len(report["actions"]), 4)
        action_text = " ".join(action["action"] for action in report["actions"])
        self.assertIn("Enforce capacity sign-off before SOW approval.", action_text)
        self.assertIn("Accelerate cross-training and documentation.", action_text)
        self.assertIn("Assign clear owner for vendor governance.", action_text)
        self.assertIn("Explore leading indicators for delivery health.", action_text)
        self.assertNotIn("First risk", action_text)
        self.assertNotIn("Alright", action_text)
        self.assertNotIn("actions from this", action_text.lower())

    def test_project_update_browsing_routes_are_registered(self):
        server = (REPO_DIR / "server.js").read_text(encoding="utf-8")
        api = (REPO_DIR / "routes" / "api.js").read_text(encoding="utf-8")
        db = (REPO_DIR / "utils" / "db.js").read_text(encoding="utf-8")

        self.assertIn("project-update-reports.html", server)
        self.assertIn("project-update-milestones.html", server)
        self.assertIn("sendView(res", server)
        self.assertIn("router.get('/project-update-test/reports'", api)
        self.assertIn("router.patch('/project-update-test/reports/:reportId'", api)
        self.assertIn("router.delete('/project-update-test/reports/:reportId'", api)
        self.assertIn("router.get('/project-update-test/milestones'", api)
        self.assertIn("router.post('/project-update-test/milestones'", api)
        self.assertIn("router.patch('/project-update-test/milestones/:milestoneId'", api)
        self.assertIn("router.delete('/project-update-test/milestones/:milestoneId'", api)
        self.assertIn("saveProjectReportDetail", db)
        self.assertIn("deleteProjectReport", db)
        self.assertIn("updateProjectMilestone", db)
        self.assertIn("deleteProjectMilestone", db)
        self.assertIn("listProjectReports", db)
        self.assertIn("getProjectMilestoneDetail", db)
        self.assertIn("createProjectMilestone", db)

        reports_page = (REPO_DIR / "views" / "project-update-reports.html").read_text(encoding="utf-8")
        milestones_page = (REPO_DIR / "views" / "project-update-milestones.html").read_text(encoding="utf-8")
        self.assertIn("/api/project-update-test/reports", reports_page)
        self.assertIn("/api/project-update-test/milestones", milestones_page)
        self.assertIn("/project-update-test/milestones", reports_page)
        self.assertIn("/project-update-test/reports", milestones_page)
        self.assertIn("Edit Report", reports_page)
        self.assertIn('id="projectReportJsonEditor"', reports_page)
        self.assertIn('id="reportNameEditor"', reports_page)
        self.assertIn("data-delete-report", reports_page)
        self.assertIn("The report detail is table-first", reports_page)
        self.assertIn("Report Settings", reports_page)
        self.assertIn('id="copySavedProjectReportBtn"', reports_page)
        self.assertIn("Overall status", reports_page)
        self.assertNotIn("Overall colour", reports_page)
        self.assertNotIn("<th>Blockers</th>", reports_page)
        self.assertIn('id="saveReportBtn"', reports_page)
        self.assertIn("Autosaving report", reports_page)
        self.assertIn('id="exportReportPdfBtn"', reports_page)
        self.assertIn("window.print()", reports_page)
        self.assertIn(".colour-swatch {", reports_page)
        self.assertIn("print-color-adjust:exact", reports_page)
        self.assertIn("forced-color-adjust:none", reports_page)
        self.assertIn("Latest payload JSON", reports_page)
        self.assertIn("<h2>Milestones</h2>", reports_page)
        self.assertIn('id="milestoneForm"', milestones_page)
        self.assertIn('id="milestoneDeadlineForm"', milestones_page)
        self.assertIn('id="deleteMilestoneBtn"', milestones_page)
        self.assertIn("Delete milestone", milestones_page)
        self.assertIn("Save milestone", milestones_page)
        self.assertIn('name="description"', milestones_page)
        self.assertIn("milestone.description", milestones_page)
        self.assertIn("method: 'PATCH'", milestones_page)
        self.assertIn("Create milestone", milestones_page)
        self.assertIn("baselineFinishDate", milestones_page)
        self.assertIn("friendlyLabel(milestone.milestoneName)", milestones_page)
        self.assertIn("['ai', 'rag', 'sow', 'ei']", milestones_page)
        self.assertIn("toLocaleString('en-GB'", reports_page)
        self.assertIn("toLocaleString('en-GB'", milestones_page)

    def test_project_update_save_path_stores_milestone_deadlines(self):
        db = (REPO_DIR / "utils" / "db.js").read_text(encoding="utf-8")

        self.assertIn("function qDate", db)
        self.assertIn("baseline_finish_date = COALESCE", db)
        self.assertIn("project_report_milestone_assessments", db)
        self.assertIn("forecast_finish_date)", db)


if __name__ == "__main__":
    unittest.main()
