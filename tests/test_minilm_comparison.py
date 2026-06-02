import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT))

from scripts.meeting_minutes_minilm_experiment import (
    LocalMinutesRewriter,
    _sanitize_rewritten_minutes_text,
    build_minilm_only_output,
    build_minilm_variant,
    collect_experiment_context,
    collect_minilm_only_context,
    normalize_text_fragment,
    rewrite_minutes_output_payload,
    summarize_objectives_for_output,
)
SCRIPT = ROOT / "scripts" / "run_minilm_comparison.py"
MINILM_ONLY_SCRIPT = ROOT / "scripts" / "meeting_minutes_minilm_only.py"


class FakeMiniLMBackend:
    available = True
    reason = ""
    model_name = "fake-minilm"

    def _vector(self, text: str) -> list[float]:
        lowered = normalize_text_fragment(text).lower()
        groups = [
            ("workshop", "change management", "engages the team", "people in the room", "pain points", "solutions"),
            ("complaints", "triage", "gemba", "ipo", "bottleneck", "process", "workflow"),
            ("slides", "text-heavy", "people-focused", "imagery", "visuals", "photos", "content", "screen", "messaging", "tone"),
            ("stage gate", "templates", "reviews", "finalised"),
            ("routing", "intake", "request funnel", "operational"),
            ("sales", "pipeline", "keone", "june", "blocked"),
            ("vendor strategy", "interviews", "document", "produced"),
            ("innovation grant", "follow up", "pending", "feedback"),
            ("governance", "leadership review", "version one", "blue"),
            ("webinars", "booked", "delivered", "sessions"),
        ]
        vector = [0.0] * len(groups)
        for index, keywords in enumerate(groups):
            hits = sum(1 for keyword in keywords if keyword in lowered)
            vector[index] = float(hits)
        norm = sum(value * value for value in vector) ** 0.5
        if not norm:
            return [0.0] * len(groups)
        return [value / norm for value in vector]

    def encode_many(self, texts: list[str]) -> dict[str, list[float]]:
        return {normalize_text_fragment(text): self._vector(text) for text in texts}

    def similarity(self, left: str, right: str) -> float:
        left_vec = self._vector(left)
        right_vec = self._vector(right)
        return round(sum(a * b for a, b in zip(left_vec, right_vec)), 4)

    def score_against_prototypes(self, text: str, prototype_group: str) -> float:
        lowered = normalize_text_fragment(text).lower()
        if prototype_group == "discussion":
            if any(term in lowered for term in (
                "workshop", "complaints", "triage", "slides", "imagery", "gemba", "ipo", "workflow",
                "stage gate", "routing", "pipeline", "vendor strategy", "innovation grant", "governance", "webinars",
                "content", "screen", "messaging", "tone"
            )):
                return 0.9
            return 0.2
        if prototype_group in {"status", "blocker", "milestone"}:
            if any(term in lowered for term in (
                "workflow", "process", "slides", "workshop", "complaints", "triage",
                "stage gate", "routing", "pipeline", "vendor strategy", "innovation grant", "governance", "webinars",
                "content", "screen", "messaging", "tone"
            )):
                return 0.82
            return 0.18
        if prototype_group == "action":
            if ("refine" in lowered and "slides" in lowered) or any(
                lowered.startswith(prefix) for prefix in ("review ", "confirm ", "draft ", "follow up ", "validate ")
            ) or any(term in lowered for term in ("double down", "upskilled", "adoption considerations", "continue work")):
                return 0.9
            return 0.2
        if prototype_group == "decision":
            if any(term in lowered for term in ("marked complete", "was marked complete", "approved", "agreed", "status amber", "status green", "status blue")):
                return 0.75
            return 0.2
        return 0.0


class FakeLocalRewriter:
    available = True
    reason = ""
    model_name = "fake-qwen"
    model_path = "/fake/qwen"

    def rewrite_items(self, items):
        return [
            {
                "rewritten": f"{ {'discussion': 'Formal discussion', 'action': 'Formal action', 'decision': 'Formal decision'}[item['category']] }: {normalize_text_fragment(item['text'])}",
                "meta": {"category": item["category"], "rewritten": True, "reason": "ok", "raw": normalize_text_fragment(item["text"])},
            }
            for item in items
        ]

    def rewrite_item(self, category: str, text: str):
        item = self.rewrite_items([{"category": category, "text": text}])[0]
        return item["rewritten"], item["meta"]


class MiniLMComparisonSmokeTest(unittest.TestCase):
    def setUp(self):
        LocalMinutesRewriter._singleton = None

    def tearDown(self):
        LocalMinutesRewriter._singleton = None
        os.environ.pop("MINUTES_LOCAL_REWRITER_URL", None)
        os.environ.pop("MINUTES_MINILM_WORKER_URL", None)

    def test_comparison_script_exists(self):
        self.assertTrue(SCRIPT.exists(), f"Expected comparison script at {SCRIPT}")

    def test_minilm_only_script_exists(self):
        self.assertTrue(MINILM_ONLY_SCRIPT.exists(), f"Expected MiniLM-only script at {MINILM_ONLY_SCRIPT}")

    def test_comparison_script_runs_in_dry_run_mode(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            output = Path(tmpdir) / "comparison.json"
            summary = Path(tmpdir) / "comparison.md"
            result = subprocess.run(
                [
                    "python3",
                    str(SCRIPT),
                    "--limit",
                    "1",
                    "--dry-run",
                    "--output",
                    str(output),
                    "--summary-output",
                    str(summary),
                ],
                capture_output=True,
                text=True,
                cwd=ROOT,
            )
            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            self.assertTrue(output.exists())
            self.assertTrue(summary.exists())
            payload = json.loads(output.read_text(encoding="utf-8"))
            self.assertIn("summary", payload)
            self.assertEqual(payload["summary"]["totalFixtures"], 1)
            self.assertFalse(payload["summary"]["modelAvailable"])

    def test_minilm_variant_rejects_noise_and_promotes_clean_cluster_points(self):
        transcript = """Webinar rehearsal

2 June 2026

Claire:
Hey everybody.

Jack:
The AI discovery workshop really engages the team and starts the change management because people map their own processes and pain points.

Emma:
Glasses with kind of what's client, is it?

Jack:
We use Gemba observation and IPO diagrams to map the complaints handling process, understand the triage workflow and identify bottlenecks.

Claire:
Oh, say Conor didn't even read his emails.

Emma:
The slides are too text-heavy and should use more people-focused workshop imagery.

Claire:
Can you refine the webinar slides?

Emma:
I'll refine the webinar slides.
"""

        baseline, intermediate = collect_experiment_context(transcript)
        variant, _diagnostics = build_minilm_variant(baseline, intermediate, FakeMiniLMBackend())

        self.assertIsNotNone(variant)
        lowered_points = [point.lower() for point in variant["discussionPoints"]]
        self.assertFalse(any("hey everybody" in point for point in lowered_points))
        self.assertFalse(any("glasses with kind" in point for point in lowered_points))
        self.assertFalse(any("read his emails" in point for point in lowered_points))
        self.assertTrue(any("change management" in point or "pain points" in point for point in lowered_points))
        self.assertTrue(any("complaints handling process" in point or "triage workflow" in point for point in lowered_points))
        self.assertTrue(any("text-heavy" in point or "workshop imagery" in point for point in lowered_points))
        self.assertIn("Refine the webinar slides.", variant["meetingActionPoint"])
        self.assertTrue(
            set(baseline.get("meetingActionPoint", [])).issubset(set(variant.get("meetingActionPoint", [])))
        )
        self.assertEqual(len(variant["discussionPoints"]), 3)
        self.assertTrue(_diagnostics["discussionClusters"])
        self.assertTrue(_diagnostics["rejectedDiscussionCandidates"])

    def test_minilm_only_output_builds_standalone_minutes_payload(self):
        transcript = """Webinar rehearsal

2 June 2026

Claire:
Hey everybody.

Jack:
The AI discovery workshop really engages the team and starts the change management because people map their own processes and pain points.

Emma:
Glasses with kind of what's client, is it?

Jack:
We use Gemba observation and IPO diagrams to map the complaints handling process, understand the triage workflow and identify bottlenecks.

Claire:
Oh, say Conor didn't even read his emails.

Emma:
The slides are too text-heavy and should use more people-focused workshop imagery.

Claire:
Can you refine the webinar slides?

Emma:
I'll refine the webinar slides.
"""

        intermediate = collect_minilm_only_context(transcript)
        output, diagnostics = build_minilm_only_output(transcript, intermediate, FakeMiniLMBackend())

        self.assertIsNotNone(output)
        self.assertEqual(output["generator"], "minilm_only")
        self.assertEqual(output["meetingType"], "minilm_only_experiment")
        self.assertEqual(output["meetingTitle"], "Webinar rehearsal")
        self.assertEqual(output["meetingDate"], "2 June 2026")
        self.assertEqual(output["participants"]["client"], [])
        self.assertIn("Claire", output["participants"]["trinzo"])
        self.assertIn("Emma", output["participants"]["trinzo"])
        self.assertIn("Jack", output["participants"]["trinzo"])
        self.assertEqual(len(output["discussionPoints"]), 3)
        self.assertTrue(any("change management" in point.lower() or "pain points" in point.lower() for point in output["discussionPoints"]))
        self.assertTrue(any("complaints handling process" in point.lower() or "triage workflow" in point.lower() for point in output["discussionPoints"]))
        self.assertTrue(any("text-heavy" in point.lower() or "workshop imagery" in point.lower() for point in output["discussionPoints"]))
        self.assertTrue(output["meetingObjectives"])
        self.assertEqual(output["meetingActionPoint"], ["Refine the webinar slides."])
        self.assertEqual(output["meetingActionPointOwner"], ["Emma"])
        self.assertTrue(diagnostics["selectedDiscussionPoints"])
        self.assertEqual(diagnostics["mode"], "minilm_only")

    def test_minilm_only_output_can_rewrite_with_local_llm_backend(self):
        transcript = """Webinar rehearsal

2 June 2026

Claire:
Can you refine the webinar slides?

Emma:
I'll refine the webinar slides.
"""

        intermediate = collect_minilm_only_context(transcript)
        output, diagnostics = build_minilm_only_output(
            transcript,
            intermediate,
            FakeMiniLMBackend(),
            rewriter=FakeLocalRewriter(),
        )

        self.assertIsNotNone(output)
        self.assertEqual(output["meetingActionPoint"], ["Formal action: Refine the webinar slides."])
        self.assertTrue(any(item["category"] == "action" and item["rewritten"] for item in diagnostics["rewriteEdits"]))
        self.assertGreaterEqual(diagnostics["rewriteRuntimeMs"], 0.0)

    def test_objectives_can_be_summarised_separately_from_main_rewrite(self):
        output = {
            "discussionPoints": [
                "The team discussed simplifying the material by reducing text on screen and making the content easier to follow.",
                "The presentation should avoid an overly sales-focused tone.",
                "The team discussed whether all of the current content was necessary and what could be removed or simplified.",
            ]
        }

        objectives, diagnostics = summarize_objectives_for_output(output, rewriter=FakeLocalRewriter())

        self.assertTrue(objectives)
        self.assertLessEqual(len(objectives), 2)
        self.assertTrue(diagnostics["objectiveSummaryApplied"])
        self.assertGreaterEqual(diagnostics["objectiveSourceCount"], 2)

    def test_minilm_only_output_promotes_soft_style_and_content_feedback(self):
        transcript = """Webinar content review

2 June 2026

Claire:
I think we just want to make sure that it's not salesy, like at all.

Emma:
What you're showing is here's a lot of text on the screen.

Jack:
It's not absolutely necessary, really.

Claire:
Is all the content here necessary?
"""

        intermediate = collect_minilm_only_context(transcript)
        output, diagnostics = build_minilm_only_output(transcript, intermediate, FakeMiniLMBackend())

        self.assertIsNotNone(output)
        self.assertTrue(any("sales-focused tone" in decision.lower() for decision in output["decisions"]))
        self.assertTrue(
            any(
                "text on the screen" in point.lower() or "current content was necessary" in point.lower()
                for point in output["discussionPoints"]
            )
        )
        self.assertTrue(
            any(item.get("source") == "record_discussion_fallback" for item in diagnostics.get("discussionCandidates", []))
        )
        self.assertTrue(
            any(item.get("source") == "record_decision_fallback" for item in diagnostics.get("decisionCandidates", []))
        )
        self.assertFalse(any("sales-focused tone" in objective.lower() for objective in output.get("meetingObjectives", [])))

    def test_minilm_only_output_avoids_repeated_generic_objectives_from_weak_discussion(self):
        transcript = """Programme review

2 June 2026

Claire:
We have a good plan for the next meetings, and then two after that, we'll have plans for the next three.

Emma:
Ws and the EI grant were so were rule takers...

Jack:
Ad hoc SOW delivery is active, with work scheduled, underway and still awaiting scope definition.

Claire:
The stage gate review still needs the templates to be finalised.
"""

        intermediate = collect_minilm_only_context(transcript)
        output, _diagnostics = build_minilm_only_output(transcript, intermediate, FakeMiniLMBackend())

        self.assertIsNotNone(output)
        objectives_blob = " ".join(output.get("meetingObjectives", [])).lower()
        self.assertNotIn("we have a plan for the next meetings", objectives_blob)
        self.assertNotIn("rule takers", objectives_blob)

    def test_objectives_prefer_explicit_meeting_purpose_over_generic_status(self):
        transcript = """Process planning

2 June 2026

Claire:
The objective for this meeting is to agree the next workshop priorities and identify the right AI opportunities.

Emma:
Ad hoc SOW delivery is active, with work scheduled, underway and still awaiting scope definition.

Jack:
The complaints workflow review should help us understand where automation is actually suitable.
"""

        intermediate = collect_minilm_only_context(transcript)
        output, _diagnostics = build_minilm_only_output(transcript, intermediate, FakeMiniLMBackend())

        self.assertIsNotNone(output)
        objectives_blob = " ".join(output.get("meetingObjectives", [])).lower()
        self.assertIn("next workshop priorities", objectives_blob)
        self.assertIn("ai opportunities", objectives_blob)
        self.assertNotIn("sow delivery is active", objectives_blob)

    def test_greeting_fragment_is_rejected_from_discussion_output(self):
        transcript = """Team sync

2 June 2026

Claire:
Hey there.

Emma:
The workflow review is focused on identifying routing gaps before automation.
"""

        intermediate = collect_minilm_only_context(transcript)
        output, diagnostics = build_minilm_only_output(transcript, intermediate, FakeMiniLMBackend())

        self.assertIsNotNone(output)
        discussion_blob = " ".join(output.get("discussionPoints", [])).lower()
        self.assertNotIn("hey there", discussion_blob)
        self.assertTrue(any(item.get("reason") == "context_dependent_fragment" or item.get("reason") == "too_short" for item in diagnostics.get("rejectedDiscussionCandidates", [])))

    def test_window_discussion_candidate_promotes_coherent_gemba_thread_and_keeps_action_separate(self):
        transcript = """Gemba workshop planning

2 June 2026

Claire:
We were talking about using Gemba observation on the complaints handling workflow.

Jack:
It helps us see the real frustrations in the process and where tribal knowledge is carrying the team.

Emma:
That gives us a better way to identify improvement opportunities and filter which AI use cases are actually suitable.

Claire:
We should double down with the Upskilled team on adoption considerations next.
"""

        intermediate = collect_minilm_only_context(transcript)
        output, diagnostics = build_minilm_only_output(transcript, intermediate, FakeMiniLMBackend())

        self.assertIsNotNone(output)
        self.assertTrue(
            any(
                "process assessment approach" in point.lower()
                or ("complaints" in point.lower() and "ai use cases" in point.lower())
                for point in output["discussionPoints"]
            )
        )
        self.assertTrue(
            any("double down with the upskilled team on adoption considerations" in action.lower() for action in output["meetingActionPoint"])
        )
        self.assertFalse(
            any(
                "double down with the upskilled team" in point.lower()
                for point in output["discussionPoints"]
            )
        )
        self.assertTrue(any(item.get("candidateType") == "window" for item in diagnostics.get("discussionCandidates", [])))

    def test_window_discussion_candidate_captures_cultural_understanding_and_ai_opportunities(self):
        transcript = """Process discovery

2 June 2026

Claire:
Through a structured two-part cultural understanding approach, we can observe how the complaints process really works.

Jack:
That helps uncover hidden frustrations and tribal knowledge that do not always show up in process mapping.

Emma:
It also gives us a better way to identify which AI opportunities are actually suitable for implementation.
"""

        intermediate = collect_minilm_only_context(transcript)
        output, _diagnostics = build_minilm_only_output(transcript, intermediate, FakeMiniLMBackend())

        self.assertIsNotNone(output)
        discussion_blob = " ".join(output.get("discussionPoints", [])).lower()
        self.assertIn("cultural understanding", discussion_blob)
        self.assertIn("tribal knowledge", discussion_blob)
        self.assertIn("ai use cases", discussion_blob)

    def test_gemba_discussion_is_not_used_as_whole_objective_when_decision_exists(self):
        transcript = """AI process review

2 June 2026

Claire:
The objective for this meeting is to agree the next workshop priorities.

Jack:
We were using Gemba observation on the complaints process to surface tribal knowledge and frustrations.

Emma:
That also helped identify which AI opportunities were actually suitable for the team.

Claire:
Agreed, the next workshop should focus on those priorities.
"""

        intermediate = collect_minilm_only_context(transcript)
        output, _diagnostics = build_minilm_only_output(transcript, intermediate, FakeMiniLMBackend())

        self.assertIsNotNone(output)
        objectives_blob = " ".join(output.get("meetingObjectives", [])).lower()
        self.assertIn("next workshop", objectives_blob)
        self.assertNotIn("tribal knowledge", objectives_blob)

    def test_weak_single_line_messy_fragment_is_rejected(self):
        transcript = """AI review

2 June 2026

Claire:
Ws and the EI grant were so were rule takers...

Emma:
Yeah.
"""

        intermediate = collect_minilm_only_context(transcript)
        output, diagnostics = build_minilm_only_output(transcript, intermediate, FakeMiniLMBackend())

        self.assertIsNotNone(output)
        self.assertFalse(any("rule takers" in point.lower() for point in output["discussionPoints"]))
        self.assertTrue(any(item.get("reason") in ("single_turn_fallback", "single_turn_low_confidence", "weak_density_and_support", "insufficient_substantive_turns", "weak_window_coherence", "weak_parser_single_turn") for item in diagnostics.get("rejectedDiscussionCandidates", [])))

    def test_weak_single_turn_parser_status_line_is_rejected(self):
        transcript = """Status check

2 June 2026

Claire:
Work scheduled, underway and active.

Emma:
The workshop review is focused on understanding complaints handling gaps before automation decisions are made.
"""

        intermediate = collect_minilm_only_context(transcript)
        output, diagnostics = build_minilm_only_output(transcript, intermediate, FakeMiniLMBackend())

        self.assertIsNotNone(output)
        discussion_blob = " ".join(output.get("discussionPoints", [])).lower()
        self.assertNotIn("work scheduled, underway and active", discussion_blob)
        self.assertTrue(any(item.get("reason") in ("weak_parser_single_turn", "too_short", "malformed_progress_fragment", "generic_status_like_discussion") for item in diagnostics.get("rejectedDiscussionCandidates", [])))

    def test_generic_status_like_discussion_is_preferably_dropped_over_promoted(self):
        transcript = """Delivery check

2 June 2026

Claire:
The delivery workstream is active and underway.

Emma:
The delivery workstream review identified bottlenecks in complaint routing and where automation could help.

Jack:
That assessment also highlighted where the current process creates avoidable delays for the team.
"""

        intermediate = collect_minilm_only_context(transcript)
        output, diagnostics = build_minilm_only_output(transcript, intermediate, FakeMiniLMBackend())

        self.assertIsNotNone(output)
        discussion_blob = " ".join(output.get("discussionPoints", [])).lower()
        self.assertNotIn("active and underway", discussion_blob)
        self.assertTrue(
            any(item.get("reason") in ("generic_status_like_discussion", "too_short", "insufficient_substantive_turns") for item in diagnostics.get("rejectedDiscussionCandidates", []))
        )

    def test_coordination_chatter_is_not_promoted_as_action(self):
        transcript = """Follow-up chat

2 June 2026

Claire:
Send him on this recording after.

Emma:
Double down with the Upskilled team on adoption considerations next.
"""

        intermediate = collect_minilm_only_context(transcript)
        output, diagnostics = build_minilm_only_output(transcript, intermediate, FakeMiniLMBackend())

        self.assertIsNotNone(output)
        actions_blob = " ".join(output.get("meetingActionPoint", [])).lower()
        self.assertNotIn("send him on this recording after", actions_blob)
        self.assertIn("double down with the upskilled team on adoption considerations", actions_blob)

    def test_self_referential_fragment_is_rejected_from_discussion_output(self):
        transcript = """Quick discussion

2 June 2026

Claire:
And I'm easy right here...

Emma:
The complaints workflow still needs clearer triage rules before automation is scoped.
"""

        intermediate = collect_minilm_only_context(transcript)
        output, diagnostics = build_minilm_only_output(transcript, intermediate, FakeMiniLMBackend())

        self.assertIsNotNone(output)
        discussion_blob = " ".join(output.get("discussionPoints", [])).lower()
        self.assertNotIn("easy right here", discussion_blob)
        self.assertIn("complaints", discussion_blob)
        self.assertTrue(any(item.get("reason") == "self_referential_fragment" for item in diagnostics.get("rejectedDiscussionCandidates", [])))

    def test_rewrite_sanitiser_strips_chat_template_tokens(self):
        rewritten = _sanitize_rewritten_minutes_text(
            "Refine the webinar slides. <|user|> <|assistant|>",
            "Refine the webinar slides.",
        )
        self.assertEqual(rewritten, "Refine the webinar slides.")

    def test_local_rewriter_prompt_requests_varied_minutes_style(self):
        rewriter = LocalMinutesRewriter(
            available=False,
            reason="test",
        )
        prompt = rewriter._batch_prompt(
            [
                {"category": "discussion", "text": "The team discussed simplifying the complaints workflow."},
                {"category": "decision", "text": "The content should avoid an overly sales-focused tone."},
                {"category": "action", "text": "Refine the webinar slides."},
            ]
        )
        self.assertIn("avoid repeating the same opening", prompt.lower())
        self.assertIn("do not keep starting sentences with the same stem", prompt.lower())
        self.assertIn("for discussion items, prefer concise topic-led wording", prompt.lower())
        self.assertIn("for decisions, prefer clear agreed-direction wording", prompt.lower())
        self.assertIn("for actions, prefer direct action wording", prompt.lower())

    def test_rewrite_sanitiser_strips_signature_placeholder_tail(self):
        rewritten = _sanitize_rewritten_minutes_text(
            "Refine the webinar slides. [Signature] [Date] [Name of approver] [Email]",
            "Refine the webinar slides.",
        )
        self.assertEqual(rewritten, "Refine the webinar slides.")

    def test_rewrite_sanitiser_keeps_only_first_sentence(self):
        rewritten = _sanitize_rewritten_minutes_text(
            "The stage gate review process is active. This update will ensure that all stakeholders have access to accurate information.",
            "The stage gate review process is active.",
        )
        self.assertEqual(rewritten, "The stage gate review process is active.")

    def test_rewrite_sanitiser_strips_signoff_tail(self):
        rewritten = _sanitize_rewritten_minutes_text(
            "Confirm AI pipeline dependencies with sales. [Sign off] [End of Meeting]",
            "Confirm AI pipeline dependencies with sales.",
        )
        self.assertEqual(rewritten, "Confirm AI pipeline dependencies with sales.")

    def test_rewrite_sanitiser_falls_back_when_qwen_expands_into_commentary(self):
        fallback = "Ad hoc SOW delivery is active, with work scheduled, underway, and still awaiting scope definition."
        rewritten = _sanitize_rewritten_minutes_text(
            "Ad hoc SOW delivery is active, with work scheduled, underway, and still awaiting scope definition. This meets the criteria of rewriting the extracted meeting-minute item into concise, formal UK business English while maintaining the original meaning without adding or removing any information.",
            fallback,
        )
        self.assertEqual(rewritten, fallback)

    def test_local_rewriter_can_use_remote_worker(self):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format, *args):
                return

            def do_GET(self):
                if self.path != "/health":
                    self.send_response(404)
                    self.end_headers()
                    return
                payload = json.dumps(
                    {
                        "ok": True,
                        "reason": "",
                        "modelName": "fake-remote-qwen",
                        "modelPath": "/tmp/fake-remote-qwen",
                    }
                ).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                if self.path == "/rewrite":
                    rewritten = f"Remote rewrite: {payload['text']}"
                    body = json.dumps(
                        {
                            "ok": True,
                            "rewritten": rewritten,
                            "meta": {"category": payload["category"], "reason": "ok", "rewritten": True},
                            "modelName": "fake-remote-qwen",
                            "modelPath": "/tmp/fake-remote-qwen",
                        }
                    ).encode("utf-8")
                elif self.path == "/rewrite-batch":
                    body = json.dumps(
                        {
                            "ok": True,
                            "items": [
                                {
                                    "rewritten": f"Remote batch rewrite: {item['text']}",
                                    "meta": {"category": item["category"], "reason": "ok", "rewritten": True},
                                }
                                for item in payload["items"]
                            ],
                            "modelName": "fake-remote-qwen",
                            "modelPath": "/tmp/fake-remote-qwen",
                        }
                    ).encode("utf-8")
                else:
                    self.send_response(404)
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            os.environ["MINUTES_LOCAL_REWRITER_URL"] = f"http://127.0.0.1:{server.server_port}"
            rewriter = LocalMinutesRewriter.load(enabled=True)
            rewritten, meta = rewriter.rewrite_item("action", "Refine the webinar slides.")
            self.assertTrue(rewriter.available)
            self.assertEqual(rewriter.worker_url, f"http://127.0.0.1:{server.server_port}")
            self.assertEqual(rewritten, "Remote batch rewrite: Refine the webinar slides.")
            self.assertTrue(meta["rewritten"])
            batch = rewriter.rewrite_items(
                [
                    {"category": "discussion", "text": "Routing remains blocked."},
                    {"category": "action", "text": "Validate the intake workflow routing."},
                ]
            )
            self.assertEqual(batch[0]["rewritten"], "Remote batch rewrite: Routing remains blocked.")
            self.assertEqual(batch[1]["rewritten"], "Remote batch rewrite: Validate the intake workflow routing.")
        finally:
            server.shutdown()
            server.server_close()

    def test_minilm_backend_can_use_remote_worker(self):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format, *args):
                return

            def do_GET(self):
                if self.path != "/health":
                    self.send_response(404)
                    self.end_headers()
                    return
                payload = json.dumps(
                    {
                        "ok": True,
                        "reason": "",
                        "modelName": "fake-remote-minilm",
                    }
                ).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def do_POST(self):
                if self.path != "/encode":
                    self.send_response(404)
                    self.end_headers()
                    return
                length = int(self.headers.get("Content-Length", "0"))
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                body = json.dumps(
                    {
                        "ok": True,
                        "embeddings": {text: [1.0, 0.0, 0.0] for text in payload["texts"]},
                        "modelName": "fake-remote-minilm",
                    }
                ).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            os.environ["MINUTES_MINILM_WORKER_URL"] = f"http://127.0.0.1:{server.server_port}"
            from scripts.meeting_minutes_minilm_experiment import MiniLMBackend

            backend = MiniLMBackend.load(enabled=True)
            embeddings = backend.encode_many(["alpha", "beta"])
            self.assertTrue(backend.available)
            self.assertEqual(backend.worker_url, f"http://127.0.0.1:{server.server_port}")
            self.assertEqual(backend.model_name, "fake-remote-minilm")
            self.assertEqual(embeddings["alpha"], [1.0, 0.0, 0.0])
            self.assertEqual(round(backend.similarity("alpha", "beta"), 4), 1.0)
        finally:
            server.shutdown()
            server.server_close()

    def test_minilm_only_status_review_fixture_promotes_clusters_actions_and_decisions(self):
        transcript = (ROOT / "scripts" / "transcript-tests" / "001_status_review" / "transcript.txt").read_text(encoding="utf-8")
        baseline, _baseline_intermediate = collect_experiment_context(transcript)
        intermediate = collect_minilm_only_context(transcript)

        output, diagnostics = build_minilm_only_output(transcript, intermediate, FakeMiniLMBackend())

        self.assertIsNotNone(output)
        self.assertGreaterEqual(len(output["discussionPoints"]), 6)
        self.assertTrue(any("stage gate review process" in point.lower() for point in output["discussionPoints"]))
        self.assertTrue(any("routing is not yet working properly" in point.lower() for point in output["discussionPoints"]))
        self.assertTrue(any("sales input is still required" in point.lower() for point in output["discussionPoints"]))
        self.assertTrue(any("vendor strategy rollout remains in progress" in point.lower() for point in output["discussionPoints"]))
        self.assertTrue(any("governance framework draft is in review pending leadership input" in point.lower() for point in output["discussionPoints"]))
        self.assertTrue(any("webinar delivery remains on track" in point.lower() for point in output["discussionPoints"]))

        actions = output["meetingActionPoint"]
        self.assertIn("Review stage gate templates.", actions)
        self.assertIn("Confirm AI pipeline dependencies with sales.", actions)
        self.assertIn("Draft vendor strategy document.", actions)
        self.assertIn("Follow up innovation grant feedback.", actions)
        self.assertIn("Validate intake workflow routing.", actions)

        self.assertTrue(output["decisions"])
        self.assertTrue(any("marked complete" in decision.lower() for decision in output["decisions"]))
        self.assertTrue(any(item["accepted"] for item in diagnostics["discussionClusters"]))
        self.assertTrue(any(item["accepted"] for item in diagnostics["actionSelections"]))
        self.assertTrue(any(item["accepted"] for item in diagnostics["decisionSelections"]))
        self.assertGreaterEqual(len(output["meetingActionPoint"]), len(baseline.get("meetingActionPoint", [])))

    def test_rewrite_minutes_output_payload_rewrites_existing_output_only(self):
        output = {
            "meetingTitle": "Daily AI Check In",
            "meetingDate": "2 June 2026",
            "meetingLocation": "Online",
            "participants": {"client": [], "trinzo": ["Ciara Griffin"]},
            "discussionPoints": ["intake workflow remains in progress due to routing issues."],
            "discussionPointDetails": [{"discussionPoint": "intake workflow remains in progress due to routing issues."}],
            "decisions": ["mark that complete."],
            "decisionDetails": [{"decision": "mark that complete."}],
            "actions": [
                {
                    "meetingActionPoint": "refine the webinar slides.",
                    "meetingActionPointOwner": "Emma",
                    "meetingActionPointDeadline": "7 June 2026",
                }
            ],
            "meetingActionPoint": ["refine the webinar slides."],
            "meetingActionPointOwner": ["Emma"],
            "meetingActionPointDeadline": ["7 June 2026"],
        }

        rewritten, diagnostics = rewrite_minutes_output_payload(output, FakeLocalRewriter())

        self.assertEqual(rewritten["discussionPoints"], ["Formal discussion: intake workflow remains in progress due to routing issues."])
        self.assertEqual(rewritten["decisions"], ["Formal decision: mark that complete."])
        self.assertEqual(rewritten["meetingActionPoint"], ["Formal action: refine the webinar slides."])
        self.assertEqual(rewritten["actions"][0]["meetingActionPoint"], "Formal action: refine the webinar slides.")
        self.assertGreaterEqual(len(diagnostics["rewriteEdits"]), 3)
        self.assertGreaterEqual(diagnostics["rewriteRuntimeMs"], 0.0)


if __name__ == "__main__":
    unittest.main()
