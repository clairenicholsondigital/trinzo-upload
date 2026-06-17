import json
import subprocess
import sys
import unittest
from pathlib import Path

from scripts.project_update_minilm import build_project_update_output
from scripts.project_update_minilm import annotate_report_with_project_context, build_minilm_first_context, build_report_payload, is_valid_risk_mitigation_candidate, normalise_report_payload, ranked_project_signals, rewrite_report_summary, select_risk_mitigations, split_action_candidates


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
        self.assertEqual(result["modelDiagnostics"]["pipelineOrder"][:2], ["minilm_first_context", "rules_structuring"])
        self.assertTrue(result["modelDiagnostics"]["minilmFirstContext"]["runsBeforeRules"])
        json.dumps(result)

    def test_unmatched_general_context_is_not_rendered_as_unclassified_milestone(self):
        transcript = """
        Ciara: Overall status is green across scope, schedule, financials and resources.
        Connor: The nuance is delivery pressure. Capacity versus SOW commitments is becoming more real.
        Ciara: Stage-Gate is now live and webinar delivered, conference presentation done.
        Connor: Actions are enforce capacity sign-off and assign clear owner for vendor governance.
        """
        result = build_project_update_output(transcript, use_minilm=False, use_rewrite=False)
        milestones = result["projectReport"]["milestones"]
        keys = {(item.get("comparison_key") or item.get("milestone") or "").lower() for item in milestones}

        self.assertNotIn("unclassified", keys)
        self.assertNotIn("unknown", keys)
        self.assertTrue(keys)

    def test_build_project_update_loads_minilm_before_rules(self):
        source = (REPO_DIR / "scripts" / "project_update_minilm.py").read_text(encoding="utf-8")
        body = source.split("def build_project_update_output", 1)[1].split("def parse_args", 1)[0]

        self.assertLess(body.index("MiniLMBackend.load"), body.index("analyse_project_update"))
        self.assertLess(body.index("build_minilm_first_context"), body.index("analyse_project_update"))

    def test_minilm_first_context_selects_actions_before_rule_structuring(self):
        class FakeBackend:
            available = True
            model_name = "fake-minilm"
            reason = ""

            def encode_many(self, texts):
                lookup = {}
                for text in texts:
                    cleaned = " ".join(str(text or "").split()).strip()
                    if not cleaned:
                        continue
                    if "enforce capacity" in cleaned.lower() or "specific follow-up task" in cleaned.lower():
                        lookup[cleaned] = [1.0, 0.0]
                    else:
                        lookup[cleaned] = [0.0, 1.0]
                return lookup

        context = build_minilm_first_context(
            "Claire 0:01 Actions from this: enforce capacity sign-off before SOW approval.",
            FakeBackend(),
        )

        self.assertTrue(context["diagnostics"]["runsBeforeRules"])
        self.assertEqual(context["actions"][0]["action"], "Enforce capacity sign-off before SOW approval.")
        self.assertEqual(context["actions"][0]["_source"], "minilm_first")

    def test_minilm_first_context_prioritises_explicit_action_list_over_chatter(self):
        class FakeBackend:
            available = True
            model_name = "fake-minilm"
            reason = ""

            def encode_many(self, texts):
                lookup = {}
                for text in texts:
                    cleaned = " ".join(str(text or "").split()).strip()
                    if not cleaned:
                        continue
                    if "Product Build" in cleaned or "status" in cleaned:
                        lookup[cleaned] = [1.0, 0.0]
                    elif any(phrase in cleaned.lower() for phrase in ["enforce capacity", "accelerate cross-training", "assign clear owner", "explore leading"]):
                        lookup[cleaned] = [0.0, 1.0]
                    else:
                        lookup[cleaned] = [0.2, 0.8]
                return lookup

        context = build_minilm_first_context(
            """
            Ciara: Let's start with Product Build.
            Ciara: Alright, actions from this:
            enforce capacity sign-off before SOW approval
            accelerate cross-training and documentation
            assign clear owner for vendor governance
            explore leading indicators for delivery health
            """,
            FakeBackend(),
        )
        actions = [item["action"] for item in context["actions"]]

        self.assertNotIn("Start with Product Build.", actions)
        self.assertEqual(actions[:4], [
            "Enforce capacity sign-off before SOW approval.",
            "Accelerate cross-training and documentation.",
            "Assign clear owner for vendor governance.",
            "Explore leading indicators for delivery health.",
        ])
        self.assertGreaterEqual(context["diagnostics"]["selectedActionWindowCount"], 4)
        self.assertIn("selectedActionWindows", context["diagnostics"])

    def test_minilm_first_context_exposes_project_signal_windows(self):
        class FakeBackend:
            available = True
            model_name = "fake-minilm"
            reason = ""

            def encode_many(self, texts):
                lookup = {}
                for text in texts:
                    cleaned = " ".join(str(text or "").split()).strip()
                    if not cleaned:
                        continue
                    if any(phrase in cleaned.lower() for phrase in ["delivery pressure", "capacity", "governance", "leading indicators"]):
                        lookup[cleaned] = [1.0, 0.0]
                    else:
                        lookup[cleaned] = [0.0, 1.0]
                return lookup

        context = build_minilm_first_context(
            """
            Ciara: Hey Connor, can you hear me alright?
            Connor: Yeah, loud and clear.
            Ciara: The nuance is in delivery pressure though.
            Connor: Delivery capacity versus SOW commitments is becoming more real.
            Ciara: We need to assign a clear owner for vendor governance.
            Connor: We should track leading indicators before things turn amber or red.
            """,
            FakeBackend(),
        )
        signal_texts = [item["text"] for item in context["projectSignals"]]

        self.assertGreaterEqual(context["diagnostics"]["selectedProjectSignalCount"], 2)
        self.assertTrue(any("delivery pressure" in text.lower() or "capacity" in text.lower() for text in signal_texts))
        self.assertFalse(any("hear me" in text.lower() or "loud and clear" in text.lower() for text in signal_texts))
        self.assertIn("selectedProjectSignalWindows", context["diagnostics"])

    def test_rewrite_keeps_minilm_key_update_evidence_unchanged(self):
        class FakeRewriter:
            available = True
            model_name = "fake-qwen"
            model_path = "fake"
            reason = ""

            def rewrite_items(self, items):
                return [{"rewritten": "Is this a rewritten question?", "meta": {}} for _ in items]

        report = {
            "summary": "No blocked workstreams were detected.",
            "keyUpdates": [
                "Yeah, it’s one of those where the dashboard looks calm, but the system underneath is working hard.",
                "So overall status is still green across scope, schedule, financials, resources.",
            ],
            "healthAreas": {},
            "milestones": [],
            "risks": [],
            "actions": [],
        }
        rewritten, diagnostics = rewrite_report_summary(report, FakeRewriter())

        self.assertEqual(rewritten["summary"], "Is this a rewritten question?")
        self.assertEqual(rewritten["keyUpdates"], report["keyUpdates"])
        self.assertEqual([edit["field"] for edit in diagnostics["rewriteEdits"]], ["summary"])

    def test_project_signal_ranking_prioritises_material_risk_over_soft_pipeline_context(self):
        signals = [
            {"category": "delivery_pressure", "score": 0.49, "text": "It’s more about converting that into pipeline now."},
            {"category": "delivery_pressure", "score": 0.40, "text": "I think the nuance is in delivery pressure though."},
            {"category": "delivery_pressure", "score": 0.74, "text": "So we’ve got a mismatch between pipeline and execution."},
            {"category": "capability_risk", "score": 0.77, "text": "AI delivery and technical architecture."},
            {"category": "governance_risk", "score": 0.68, "text": "Assign clear owner for vendor governance."},
        ]

        ranked = ranked_project_signals(signals, limit=5, per_category=2)
        ranked_texts = [item["text"] for item in ranked]

        self.assertIn("So we’ve got a mismatch between pipeline and execution.", ranked_texts)
        self.assertIn("I think the nuance is in delivery pressure though.", ranked_texts)
        self.assertIn("AI delivery and technical architecture.", ranked_texts)
        self.assertNotIn("It’s more about converting that into pipeline now.", ranked_texts)

    def test_report_key_updates_use_ranked_minilm_project_signals(self):
        report = build_report_payload(
            {"project_health_summary": {"overall_health": "green", "overall_health_reason": "Green, but pressure exists."}, "actions": [], "comparison_snapshot": {}},
            [],
            {"healthAreaMatches": {}},
            minilm_first_context={
                "rankedProjectSignals": ranked_project_signals([
                    {"category": "delivery_pressure", "score": 0.49, "text": "It’s more about converting that into pipeline now."},
                    {"category": "delivery_pressure", "score": 0.74, "text": "So we’ve got a mismatch between pipeline and execution."},
                    {"category": "capability_risk", "score": 0.77, "text": "AI delivery and technical architecture."},
                ], limit=3, per_category=2),
                "actions": [],
            },
        )

        self.assertEqual(report["keyUpdates"][:2], [
            "So we’ve got a mismatch between pipeline and execution.",
            "AI delivery and technical architecture.",
        ])

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
        self.assertIn("['improving', 'stable', 'deteriorating', 'replanned'", shared_js)
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

    def test_project_report_backfills_actions_from_transcript_when_baseline_actions_are_weak(self):
        transcript = "\n".join(
            [
                "Claire 0:01 I'll keep this to about twenty minutes, just want to run through status, risks, and anything we need to escalate.",
                "Claire 0:05 Repeatable AI use cases.",
                "Conor 0:08 webinar delivered, conference presentation done.",
                "Claire 0:12 Actions from this: enforce capacity sign-off before SOW approval accelerate cross-training and documentation assign clear owner for vendor governance explore leading indicators for delivery health First risk, delivery capacity versus SOW commitments.",
            ]
        )
        report = build_project_update_output(transcript, use_minilm=False, use_rewrite=False)["projectReport"]
        action_text = " ".join(action["action"] for action in report["actions"])

        self.assertNotIn("keep this to about twenty minutes", json.dumps(report).lower())
        self.assertIn("Webinar delivered, conference presentation done.", json.dumps(report))
        self.assertIn("Enforce capacity sign-off before SOW approval.", action_text)
        self.assertIn("Accelerate cross-training and documentation.", action_text)
        self.assertNotEqual([action["action"] for action in report["actions"]], ["Complete."])

    def test_project_action_backfill_rejects_spoken_fragments_from_actions_table(self):
        sample = " ".join(
            [
                "Delivered, but adoption is still variable.",
                "Complete, which is good.",
                "Accelerate, even if it impacts short-term delivery.",
                "Assign that properly.",
                "Add, we might want to start tracking leading indicators, not just status.",
                "Add that as a.",
                "Follow-up.",
                "Enforce capacity sign-off before SOW approval.",
            ]
        )

        self.assertEqual(
            split_action_candidates(sample),
            [
                "Start tracking leading indicators, not just status.",
                "Enforce capacity sign-off before SOW approval.",
            ],
        )

    def test_project_risk_mitigation_rejects_reported_speech_evidence(self):
        self.assertFalse(is_valid_risk_mitigation_candidate("She said she'd follow up this week."))
        self.assertFalse(is_valid_risk_mitigation_candidate("Yeah she said she'd follow up this week."))
        self.assertTrue(is_valid_risk_mitigation_candidate("Follow up innovation grant feedback."))

        self.assertEqual(
            select_risk_mitigations(["She said she'd follow up this week.", "Follow up innovation grant feedback."]),
            "Follow up innovation grant feedback.",
        )

    def test_project_report_rejects_reported_speech_as_risk_mitigation(self):
        transcript = FIXTURE.read_text(encoding="utf-8")
        report = build_project_update_output(transcript, use_minilm=False, use_rewrite=False)["projectReport"]
        mitigation_text = " ".join(risk.get("suggestedMitigation", "") for risk in report.get("risks", [])).lower()
        milestone_next_steps = json.dumps([milestone.get("next_steps", []) for milestone in report.get("milestones", [])], ensure_ascii=False).lower()

        self.assertNotIn("she said she'd follow up this week", mitigation_text)
        self.assertIn("follow up innovation grant feedback", mitigation_text)
        self.assertNotIn("she said she'd follow up this week", milestone_next_steps)

    def test_project_action_split_removes_trailing_conjunction_before_next_action(self):
        self.assertEqual(
            split_action_candidates("Actions from this: enforce capacity sign-off before SOW approval and start tracking leading indicators, not just status."),
            [
                "Enforce capacity sign-off before SOW approval.",
                "Start tracking leading indicators, not just status.",
            ],
        )

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
        self.assertIn("router.post('/project-update-test/context/mark-official'", api)
        self.assertIn("router.post('/project-update-test/context/cleanup-tests'", api)
        self.assertIn("router.delete('/project-update-test/milestones/:milestoneId'", api)
        self.assertIn("saveProjectReportDetail", db)
        self.assertIn("deleteProjectReport", db)
        self.assertIn("updateProjectMilestone", db)
        self.assertIn("deleteProjectMilestone", db)
        self.assertIn("listProjectReports", db)
        self.assertIn("getProjectMilestoneDetail", db)
        self.assertIn("createProjectMilestone", db)
        self.assertIn("activeRisks", db)
        self.assertIn("project_core_risks", db)
        self.assertIn("markProjectContextOfficial", db)
        self.assertIn("cleanupProjectUpdateTestContext", db)
        self.assertIn("isOfficial", db)

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
        context_page = (REPO_DIR / "views" / "project-update-context.html").read_text(encoding="utf-8")
        self.assertIn("Active core risks", context_page)
        self.assertIn("activeRisks", context_page)
        self.assertIn("Mark active context official", context_page)
        self.assertIn("Clear test clutter", context_page)
        self.assertIn("/api/project-update-test/context/mark-official", context_page)
        self.assertIn("/api/project-update-test/context/cleanup-tests", context_page)

    def test_project_context_updates_health_milestone_and_risk_trends(self):
        report = {
            "healthAreas": {"schedule": {"status": "on_track", "trend": "stable", "evidence": []}},
            "milestones": [{"milestone": "ai_pipeline_strategy", "delivery_status": "on_track", "trend": "stable"}],
            "risks": [{"riskTitle": "Capacity needs attention", "description": "Capacity pressure remains.", "suggestedMitigation": "Review ownership."}],
            "comparisonSnapshot": {},
        }
        context = {
            "found": True,
            "generatedAt": "2026-06-17T17:00:00Z",
            "activeMilestones": [
                {
                    "milestoneName": "ai_pipeline_strategy",
                    "comparisonKey": "ai_pipeline_strategy",
                    "latestAssessment": {"status": "blocked", "summary": "Blocked by dependency.", "reportId": 10, "reportVersionId": 20},
                }
            ],
            "healthHistory": [{"area": "schedule", "status": "at_risk", "reportId": 10, "reportVersionId": 20}],
            "activeRisks": [],
            "riskSuggestions": [],
            "latestSnapshot": {"snapshotId": 3},
        }

        annotated, diagnostics = annotate_report_with_project_context(report, context)

        self.assertEqual(annotated["milestones"][0]["trend"], "improving")
        self.assertEqual(annotated["milestones"][0]["previous_status"], "blocked")
        self.assertEqual(annotated["healthAreas"]["schedule"]["trend"], "improving")
        self.assertEqual(annotated["risks"][0]["trend"], "new_risk")
        self.assertEqual(annotated["comparisonSnapshot"]["latestContextSnapshotId"], 3)
        self.assertEqual(diagnostics["milestonesCompared"], 1)
        self.assertEqual(diagnostics["healthAreasCompared"], 1)

    def test_completed_to_active_again_is_replanned_not_deteriorating(self):
        report = {
            "healthAreas": {},
            "milestones": [{"milestone": "webinars", "delivery_status": "in_progress", "trend": "stable"}],
            "risks": [],
            "comparisonSnapshot": {},
        }
        context = {
            "found": True,
            "activeMilestones": [
                {
                    "milestoneName": "webinars",
                    "comparisonKey": "webinars",
                    "latestAssessment": {"status": "completed", "summary": "Previously delivered.", "reportId": 10, "reportVersionId": 20},
                }
            ],
            "healthHistory": [],
            "activeRisks": [],
            "riskSuggestions": [],
        }

        annotated, diagnostics = annotate_report_with_project_context(report, context)

        self.assertEqual(annotated["milestones"][0]["previous_status"], "completed")
        self.assertEqual(annotated["milestones"][0]["trend"], "replanned")
        self.assertEqual(diagnostics["milestonesCompared"], 1)

    def test_active_core_risk_matches_as_stable_existing_risk(self):
        report = {
            "healthAreas": {},
            "milestones": [],
            "risks": [{"riskTitle": "Delivery Capacity vs SOW Commitments Risk", "description": "Capacity pressure remains."}],
            "comparisonSnapshot": {},
        }
        context = {
            "found": True,
            "activeMilestones": [],
            "activeRisks": [{"riskId": 7, "riskTitle": "Delivery Capacity vs SOW Commitments Risk", "description": "Baseline risk."}],
            "healthHistory": [],
            "riskSuggestions": [],
        }

        annotated, diagnostics = annotate_report_with_project_context(report, context)

        self.assertEqual(annotated["risks"][0]["trend"], "stable")
        self.assertEqual(annotated["risks"][0]["core_risk_id"], 7)
        self.assertEqual(diagnostics["riskTitlesCompared"], 1)

    def test_project_update_save_path_stores_milestone_deadlines_and_trends(self):
        db = (REPO_DIR / "utils" / "db.js").read_text(encoding="utf-8")

        self.assertIn("function qDate", db)
        self.assertIn("baseline_finish_date = COALESCE", db)
        self.assertIn("project_report_milestone_assessments", db)
        self.assertIn("forecast_finish_date)", db)
        self.assertIn("normaliseProjectTrend(milestoneDraft.trend || segment.trend || 'stable')", db)


if __name__ == "__main__":
    unittest.main()
