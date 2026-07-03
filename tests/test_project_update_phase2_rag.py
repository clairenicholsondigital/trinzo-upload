import json
import unittest
from pathlib import Path

from scripts.project_update_minilm import build_project_update_output


REPO_DIR = Path(__file__).resolve().parents[1]
CONTEXT_FIXTURE = REPO_DIR / "tests" / "fixtures" / "project_update_phase2_context.json"


class ProjectUpdatePhase2RagTests(unittest.TestCase):
    def test_retrieved_knowledge_supplements_context_without_becoming_evidence(self):
        transcript = """
        Ciara: The phase 1 data cutover is blocked because nobody owns the migration handoff.
        Connor: Training can still start if we name a single owner this week.
        Ciara: Risk is migration ownership and the mitigation is to assign one accountable owner.
        """
        context = json.loads(CONTEXT_FIXTURE.read_text(encoding="utf-8"))

        result = build_project_update_output(transcript, use_minilm=False, use_rewrite=False, project_context=context)
        report = result["projectReport"]
        diagnostics = result["modelDiagnostics"]["projectKnowledge"]

        self.assertEqual(diagnostics["retrievalMode"], "semantic")
        self.assertFalse(diagnostics["usedAsTranscriptEvidence"])
        self.assertGreaterEqual(diagnostics["chunksConsidered"], 1)
        self.assertIn(report["retrievedKnowledge"]["retrievalMode"], {"semantic", "none"})
        risk_trends = {risk.get("trend") for risk in report.get("risks", [])}
        self.assertIn("known_background_risk", risk_trends)


if __name__ == "__main__":
    unittest.main()
