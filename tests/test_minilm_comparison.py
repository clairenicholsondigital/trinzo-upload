import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT))

from scripts.meeting_minutes_minilm_experiment import (
    build_minilm_variant,
    collect_experiment_context,
    normalize_text_fragment,
)
SCRIPT = ROOT / "scripts" / "run_minilm_comparison.py"


class FakeMiniLMBackend:
    available = True
    reason = ""
    model_name = "fake-minilm"

    def _vector(self, text: str) -> list[float]:
        lowered = normalize_text_fragment(text).lower()
        groups = [
            ("workshop", "change management", "engages the team", "people in the room", "pain points", "solutions"),
            ("complaints", "triage", "gemba", "ipo", "bottleneck", "process", "workflow"),
            ("slides", "text-heavy", "people-focused", "imagery", "visuals", "photos"),
            ("glaxosmithkline", "gsk", "training", "evaluation"),
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
            if any(term in lowered for term in ("workshop", "complaints", "triage", "slides", "imagery", "gemba", "ipo", "workflow")):
                return 0.9
            return 0.2
        if prototype_group in {"status", "blocker", "milestone"}:
            if any(term in lowered for term in ("workflow", "process", "slides", "workshop", "complaints", "triage")):
                return 0.82
            return 0.18
        if prototype_group == "action":
            return 0.2
        if prototype_group == "decision":
            return 0.2
        return 0.0


class MiniLMComparisonSmokeTest(unittest.TestCase):
    def test_comparison_script_exists(self):
        self.assertTrue(SCRIPT.exists(), f"Expected comparison script at {SCRIPT}")

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
        self.assertTrue(any("change-management method" in point or "engages employees" in point for point in lowered_points))
        self.assertTrue(any("complaints-handling workflow" in point or "triage analysis" in point for point in lowered_points))
        self.assertTrue(any("slides need less text" in point or "people-focused workshop imagery" in point for point in lowered_points))
        self.assertIn("Refine the webinar slides.", variant["meetingActionPoint"])
        self.assertTrue(
            set(baseline.get("meetingActionPoint", [])).issubset(set(variant.get("meetingActionPoint", [])))
        )
        self.assertTrue(_diagnostics["discussionClusters"])
        self.assertTrue(_diagnostics["rejectedDiscussionCandidates"])


if __name__ == "__main__":
    unittest.main()
