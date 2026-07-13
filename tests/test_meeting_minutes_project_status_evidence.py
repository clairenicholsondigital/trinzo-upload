import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_DIR = Path(__file__).resolve().parents[1]
TROOPER_SCRIPT = REPO_DIR / "scripts" / "meeting_minutes_trooper.py"
EVIDENCE_SCRIPT = REPO_DIR / "scripts" / "project_status_evidence_pack.py"


def load_trooper_module():
    spec = importlib.util.spec_from_file_location("meeting_minutes_trooper", TROOPER_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class MeetingMinutesProjectStatusEvidenceTest(unittest.TestCase):
    def test_prompt_uses_project_status_evidence_as_guidance_only(self):
        module = load_trooper_module()
        prompt = module.prompt_for_transcript(
            "Claire said the client approval is still pending, so launch cannot proceed.",
            {
                "available": True,
                "items": [
                    {
                        "priority": 0.82,
                        "status": [{"label": "blocked", "score": 0.71}],
                        "actionState": [{"label": "dependency", "score": 0.62}],
                        "signals": [{"label": "approval_needed", "score": 0.82}],
                        "transcriptSnippet": "client approval is still pending, so launch cannot proceed",
                    }
                ],
            },
        )

        self.assertIn("[PROJECT_STATUS_EVIDENCE]", prompt)
        self.assertIn("project_update_status_model", prompt)
        self.assertIn("attention guide", prompt)
        self.assertIn("transcript remains the source of truth", prompt)
        self.assertIn("approval_needed", prompt)

    def test_evidence_pack_cli_fails_open_when_model_is_missing(self):
        with tempfile.NamedTemporaryFile("w", suffix=".txt", encoding="utf-8") as transcript:
            transcript.write("The API access is missing, so the team cannot continue the rollout.")
            transcript.flush()
            completed = subprocess.run(
                [
                    sys.executable,
                    str(EVIDENCE_SCRIPT),
                    transcript.name,
                    "--model",
                    "/tmp/definitely-missing-project-status-classifier.joblib",
                ],
                cwd=REPO_DIR,
                check=True,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )

        payload = json.loads(completed.stdout)
        self.assertTrue(payload["enabled"])
        self.assertFalse(payload["available"])
        self.assertEqual(payload["items"], [])
        self.assertIn("not found", payload["reason"])


if __name__ == "__main__":
    unittest.main()
