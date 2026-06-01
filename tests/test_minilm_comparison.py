import json
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "run_minilm_comparison.py"


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


if __name__ == "__main__":
    unittest.main()
