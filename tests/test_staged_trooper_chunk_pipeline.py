import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "staged_trooper_chunk_pipeline.py"
SPEC = importlib.util.spec_from_file_location("staged_trooper_chunk_pipeline", SCRIPT)
PIPELINE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = PIPELINE
SPEC.loader.exec_module(PIPELINE)


class StagedTrooperChunkPipelineTests(unittest.TestCase):
    def test_numbering_is_one_based_and_preserves_turn_text(self):
        turns, numbered = PIPELINE.numbered_turns("Alice: First\n\nBob: Second")
        self.assertEqual(turns, ["Alice: First", "Bob: Second"])
        self.assertEqual(numbered, "[1] Alice: First\n[2] Bob: Second")

    def test_boundaries_are_contiguous_and_force_the_45_turn_limit(self):
        chunks = PIPELINE.safe_boundaries([{"number": 1, "start": 1, "end": 100}], 100)
        self.assertEqual([(row["start"], row["end"]) for row in chunks], [(1, 45), (46, 90), (91, 100)])

    def test_action_normalisation_tolerates_missing_and_null_evidence_arrays(self):
        result = {"actionCandidates": [{
            "action": "Email the revised plan", "status": "COMMITTED", "owner": "Alex",
            "deadline": "Friday", "taskEvidenceTurns": [2, None, 99], "ownerEvidenceTurns": None,
        }]}
        actions = PIPELINE.normalise_actions(result, {"number": 1, "start": 1, "end": 10})
        self.assertEqual(actions[0]["evidenceIds"], ["turn_2"])
        self.assertEqual(actions[0]["status"], "COMMITTED")

    def test_live_prompt_is_the_short_verb_sweep(self):
        for verb in ("Review", "Resolve", "Arrange", "Plan", "Email"):
            self.assertIn(f"- {verb}", PIPELINE.ACTION_PROMPT)
        self.assertNotIn("Work through", PIPELINE.ACTION_PROMPT)


if __name__ == "__main__":
    unittest.main()
