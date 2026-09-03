import unittest

from scripts.finetune_trooper_action_pipeline import (
    Chunk,
    numbered_turns,
    parse_action_candidates,
    parse_boundaries,
)


class FinetuneTrooperActionPipelineTests(unittest.TestCase):
    def test_numbers_only_nonempty_turns(self):
        turns, numbered = numbered_turns("Alice: Hello\n\n Bob: I will send it. \n")
        self.assertEqual(turns, ["Alice: Hello", "Bob: I will send it."])
        self.assertEqual(numbered, "[1] Alice: Hello\n[2] Bob: I will send it.")

    def test_accepts_complete_contiguous_boundaries(self):
        turns = ["one", "two", "three", "four"]
        chunks = parse_boundaries("Chunk 1: 1-2\nChunk 2: 3-4", turns)
        self.assertEqual([(chunk.start, chunk.end, chunk.text) for chunk in chunks], [
            (1, 2, "one\ntwo"),
            (3, 4, "three\nfour"),
        ])

    def test_rejects_boundary_gap(self):
        with self.assertRaisesRegex(ValueError, "Non-contiguous"):
            parse_boundaries("Chunk 1: 1-2\nChunk 2: 4-4", ["one", "two", "three", "four"])

    def test_parses_action_and_validates_verbatim_evidence(self):
        chunk = Chunk(1, 1, 2, "Alice: Can you send it?\nBob: Yes, I will send it tomorrow.")
        rows = parse_action_candidates(
            "ACTION: Send the document\nOWNER: Bob\nDEADLINE: Tomorrow\nEVIDENCE: I will send it tomorrow.",
            chunk,
        )
        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]["evidenceValid"])

    def test_marks_nonverbatim_evidence_invalid(self):
        chunk = Chunk(1, 1, 1, "Bob: I will send it tomorrow.")
        rows = parse_action_candidates(
            "ACTION: Send it\nOWNER: Bob\nDEADLINE: Tomorrow\nEVIDENCE: Bob promised to send it tomorrow.",
            chunk,
        )
        self.assertFalse(rows[0]["evidenceValid"])


if __name__ == "__main__":
    unittest.main()
